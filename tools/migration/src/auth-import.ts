import { parseArgs } from 'node:util';

import type { Credential } from 'firebase-admin/app';

import { assertAuthReadable, NotReadOnlyError } from './audit/iam.ts';
import { LEGACY_PROJECT, LEGACY_READER, tokenSource } from './audit.ts';
import { HASH_PARAMS_SECRET, parseHashParams, scryptImportOptions, type HashParams } from './auth/hash.ts';
import {
  checkImported,
  describeUser,
  planAuthImport,
  planRollback,
  toUserImport,
  type ImportPlan,
} from './auth/plan.ts';
import { parseAuthUser, readAuthRecordFile, type LegacyAuthRecord } from './auth/record.ts';
import { adminTarget, enabledProviders, readSecret, readTargetState, type TargetAuth } from './auth/target.ts';
import { lookupAuthUser, restIamTester, type RestDeps } from './legacy/rest.ts';
import { loadProfile } from './profile.ts';

/**
 * `materia-migrate auth-import` (MIG-04): moves one legacy Firebase Auth account into a v2
 * Identity Platform project with the same uid, the Auth record's email, every sign-in identity
 * with its provider uid (so Google sign-in finds the same account), and its password hash with
 * the legacy scrypt parameters when it has one. It plans before it writes, aborts for a person
 * on anything the ticket says to stop for, and skips an account that is already there, so a
 * re-run is a no-op. It never writes to the legacy project, and it never logs emails or hashes.
 * Runbook: docs/runbooks/migration-auth-import.md.
 */

export const PROD_PROJECT = 'materia-v2-prod';
/** Legacy projects: the import reads from them and must never write to them. */
const LEGACY_PROJECTS = [LEGACY_PROJECT, 'materia-dev-26bf0'];

export interface AuthImportArgs {
  uid: string;
  target: string;
  dryRun: boolean;
  rollback: boolean;
  replaceUids: string[];
  confirmProd: boolean;
}

export interface AuthImportDeps {
  /** The legacy account, from the read-only legacy lookup or a filtered export file. */
  record: () => Promise<LegacyAuthRecord>;
  target: TargetAuth;
  enabledProviders: () => Promise<ReadonlySet<string> | 'any'>;
  /** The legacy scrypt parameters, or null if the target doesn't have them. */
  hashParams: () => Promise<HashParams | null>;
  log: (line: string) => void;
}

export type AuthImportOutcome = 'imported' | 'would-import' | 'skipped' | 'rolled-back' | 'would-roll-back';

/** The plan stopped for a person to decide (exit 4). */
export class ImportAbortedError extends Error {
  constructor(readonly reasons: string[]) {
    super(['Stopped, for a person to decide:', ...reasons.map((reason) => `  - ${reason}`)].join('\n'));
    this.name = 'ImportAbortedError';
  }
}

/** Throws unless `args` may change `args.target`. */
export function guardTarget(args: AuthImportArgs): void {
  if (LEGACY_PROJECTS.includes(args.target)) {
    throw new Error(`${args.target} is a legacy project. The migration only reads from it.`);
  }
  if (args.target === PROD_PROJECT && !args.dryRun && !args.confirmProd) {
    throw new Error(
      `Changing ${PROD_PROJECT} needs --confirm-prod. The import into prod runs at cutover (MIG-07); rehearse on dev.`,
    );
  }
}

function describeRecord(record: LegacyAuthRecord): string {
  const providers = [
    ...record.identities.map((i) => i.providerId),
    ...(record.password === 'none' ? [] : ['password']),
  ];
  return (
    `Legacy account ${record.uid}: ${providers.join(', ') || 'no providers'}; ` +
    `email ${record.email ? (record.emailVerified ? 'verified' : 'not verified') : 'missing'}; ` +
    `${record.mfaFactors} second factors; ${record.disabled ? 'disabled' : 'enabled'}.`
  );
}

function logPlan(plan: ImportPlan, log: (line: string) => void): void {
  for (const note of plan.notes) log(`Note: ${note}`);
  for (const user of plan.replace) log(`Replacing v2 user ${describeUser(user)}, as asked.`);
}

export async function runAuthImport(args: AuthImportArgs, deps: AuthImportDeps): Promise<AuthImportOutcome> {
  guardTarget(args);
  const record = await deps.record();
  if (record.uid !== args.uid) throw new Error(`The legacy account is ${record.uid}, not ${args.uid}.`);
  deps.log(describeRecord(record));
  const prefix = args.dryRun ? 'Dry run: would' : 'Will';

  if (args.rollback) {
    const rollback = planRollback(record, await deps.target.getUser(record.uid), {
      signedInMayGo: args.target !== PROD_PROJECT,
    });
    if (rollback.action === 'abort') throw new ImportAbortedError([rollback.reason]);
    deps.log(rollback.reason);
    if (rollback.action === 'skip') return 'skipped';
    if (args.dryRun) {
      deps.log(`Dry run: would delete ${record.uid} from ${args.target}.`);
      return 'would-roll-back';
    }
    await deps.target.deleteUser(record.uid);
    deps.log(`Deleted ${record.uid} from ${args.target}.`);
    return 'rolled-back';
  }

  const state = await readTargetState(deps.target, record, await deps.enabledProviders());
  const plan = planAuthImport(record, state, { replaceUids: args.replaceUids });
  logPlan(plan, deps.log);
  if (plan.action === 'abort') throw new ImportAbortedError(plan.reasons);
  if (plan.action === 'skip') {
    deps.log(plan.reasons.join(' '));
    return 'skipped';
  }

  let params: HashParams | null = null;
  if (plan.needsHashParams) {
    params = await deps.hashParams();
    if (!params) {
      throw new ImportAbortedError([
        `The account has a password hash, but ${args.target} has no ${HASH_PARAMS_SECRET} secret (runbook step 2).`,
      ]);
    }
  }
  const user = toUserImport(record);
  const identities = (user.providerData ?? []).map((p) => p.providerId);
  deps.log(
    `${prefix} import ${record.uid} into ${args.target} with ` +
      `${identities.length ? `${identities.join(', ')} (provider uids kept)` : 'no other provider'}` +
      `${user.passwordHash ? ' and the password hash (scrypt)' : ' and no password'}.`,
  );
  if (args.dryRun) return 'would-import';

  for (const conflict of plan.replace) {
    await deps.target.deleteUser(conflict.uid);
    deps.log(`Deleted v2 user ${conflict.uid}.`);
  }
  await deps.target.importUser(user, params ? scryptImportOptions(params) : undefined);
  const problems = checkImported(record, await deps.target.getUser(record.uid));
  if (problems.length) throw new Error(`Imported ${record.uid}, but ${problems.join(', ')}.`);
  deps.log(`Imported ${record.uid} into ${args.target}, and checked it.`);
  return 'imported';
}

// ---------- command ----------

const USAGE = `Usage: materia-migrate auth-import --target <project> (--uid <legacyUid> | --profile <profile.json>) [options]

Moves one legacy Firebase Auth account into a v2 project with the same uid, its sign-in identities
(Google…) and, if it has one, its password hash. Re-running it is a no-op.
Runbook: docs/runbooks/migration-auth-import.md.

  --target <project>       The v2 project (materia-v2-dev; demo-materia on the emulator)
  --uid <uid>              The legacy uid (or take it from --profile)
  --profile <path>         A mapping profile: the uid is its subject
  --record <path>          An auth:export file filtered to this one user, needed for a password hash.
                           Without it the account is read from the legacy project, read-only
  --dry-run                Plan and check everything, change nothing
  --rollback               Rehearsals: delete the imported account (in prod, only if it never signed in)
  --replace-user <uid>     Delete this v2 user first, when it holds the account's email or identity.
                           Only with a person's approval (repeatable)
  --confirm-prod           Required to change ${PROD_PROJECT}
  --target-adc             Application Default Credentials for the target (default: gcloud's account)
  --project <id>           Legacy project (default ${LEGACY_PROJECT})
  --impersonate <email>    Legacy read-only account (default ${LEGACY_READER})
  --adc                    Application Default Credentials for the legacy read

MIGRATION_TARGET_ACCESS_TOKEN and MIGRATION_ACCESS_TOKEN, when set, are the target and legacy
tokens. With FIREBASE_AUTH_EMULATOR_HOST set the target is the Auth emulator, and the scrypt
parameters come from LEGACY_SCRYPT_PARAMS in the environment. Behind an HTTPS proxy, set
NODE_USE_ENV_PROXY=1.

Exit codes: 0 done (or nothing to do), 1 bad arguments, a refused target or an error, 3 legacy
credentials not read-only, 4 stopped for a person to decide.`;

function legacyRecord(
  values: { record?: string | undefined; project: string; impersonate: string; adc: boolean },
  uid: string,
): () => Promise<LegacyAuthRecord> {
  if (values.record) {
    const path = values.record;
    return () => readAuthRecordFile(path, uid);
  }
  return async () => {
    const rest: RestDeps = { fetch, token: tokenSource({ adc: values.adc, impersonate: values.impersonate }) };
    await assertAuthReadable(
      restIamTester(rest, { project: values.project, bucket: `${values.project}.firebasestorage.app` }),
    );
    const raw = await lookupAuthUser(rest, values.project, uid);
    if (!raw) throw new ImportAbortedError([`${values.project} has no Auth account ${uid}.`]);
    return parseAuthUser(raw);
  };
}

export async function authImportCommand(
  argv: string[],
  log = console.log,
  error = console.error,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      target: { type: 'string' },
      uid: { type: 'string' },
      profile: { type: 'string' },
      record: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      rollback: { type: 'boolean', default: false },
      'replace-user': { type: 'string', multiple: true, default: [] },
      'confirm-prod': { type: 'boolean', default: false },
      'target-adc': { type: 'boolean', default: false },
      project: { type: 'string', default: LEGACY_PROJECT },
      impersonate: { type: 'string', default: LEGACY_READER },
      adc: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    log(USAGE);
    return 0;
  }
  const uid = values.uid ?? (values.profile ? (await loadProfile(values.profile)).subject.legacyUid : undefined);
  if (!uid || !values.target) {
    error(USAGE);
    return 1;
  }
  const target = values.target;
  const emulator = Boolean(env['FIREBASE_AUTH_EMULATOR_HOST']);
  if (emulator !== target.startsWith('demo-')) {
    error(
      emulator
        ? `FIREBASE_AUTH_EMULATOR_HOST is set, so the target must be a demo- project, not ${target}.`
        : `${target} only exists on the emulator: set FIREBASE_AUTH_EMULATOR_HOST.`,
    );
    return 1;
  }
  const args: AuthImportArgs = {
    uid,
    target,
    dryRun: values['dry-run'],
    rollback: values.rollback,
    replaceUids: values['replace-user'],
    confirmProd: values['confirm-prod'],
  };
  try {
    guardTarget(args);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const targetRest: RestDeps = {
    fetch,
    token: tokenSource({ adc: values['target-adc'], envVar: 'MIGRATION_TARGET_ACCESS_TOKEN' }, env),
  };
  const credential: Credential = {
    getAccessToken: async () => ({ access_token: await targetRest.token(), expires_in: 45 * 60 }),
  };
  // A token from another project's account bills the target's quota, as Terraform's calls do (the
  // Admin SDK reads this from the process environment).
  if (!emulator) process.env['GOOGLE_CLOUD_QUOTA_PROJECT'] ??= target;
  const { deleteApp, initializeApp } = await import('firebase-admin/app');
  const { getAuth } = await import('firebase-admin/auth');
  const app = initializeApp({ projectId: target, ...(emulator ? {} : { credential }) }, `auth-import-${Date.now()}`);
  try {
    await runAuthImport(args, {
      record: legacyRecord(values, uid),
      target: adminTarget(getAuth(app)),
      enabledProviders: async () => (emulator ? 'any' : enabledProviders(targetRest, target)),
      hashParams: async () => {
        const json = emulator ? env[HASH_PARAMS_SECRET] : await readSecret(targetRest, target, HASH_PARAMS_SECRET);
        return json ? parseHashParams(json) : null;
      },
      log,
    });
    return 0;
  } catch (err) {
    if (err instanceof NotReadOnlyError) {
      error(err.message);
      return 3;
    }
    if (err instanceof ImportAbortedError) {
      error(err.message);
      return 4;
    }
    error(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    await deleteApp(app);
  }
}
