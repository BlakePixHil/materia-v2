import { parseArgs } from 'node:util';

import { checkReadOnly } from './audit/iam.ts';
import { LEGACY_BUCKET, LEGACY_PROJECT, LEGACY_READER, tokenSource } from './audit.ts';
import { enabledProviders } from './auth/target.ts';
import { FILES_BUCKETS } from './copy-files.ts';
import { DESTINATIONS } from './export.ts';
import { GOOGLE_APIS, restIamTester } from './legacy/rest.ts';

/**
 * `materia-migrate preflight` (MIG-07): before a rehearsal or the cutover moves any real data,
 * asks IAM whether the accounts the steps run as hold what each step needs, so a run doesn't stop
 * halfway with the user's data already in the bucket. It reads IAM and the sign-in config only:
 * never a record, a file or an account. Runbook: docs/runbooks/migration-cutover.md.
 */

type Env = keyof typeof DESTINATIONS;
const ENVS = Object.keys(DESTINATIONS) as Env[];
const REGION = 'australia-southeast1';
const RESOURCE_MANAGER = 'https://cloudresourcemanager.googleapis.com/v1';
const IAM = 'https://iam.googleapis.com/v1';
const RUN = 'https://run.googleapis.com/v2';

/** export, transform and copy-files write the run; rollback deletes it. */
export const RUN_BUCKET = [
  'storage.objects.create',
  'storage.objects.get',
  'storage.objects.list',
  'storage.objects.delete',
] as const;
/** copy-files writes the copies and their metadata; rollback deletes them. */
export const FILES_BUCKET = [...RUN_BUCKET, 'storage.objects.update'] as const;
/** copy-files copies from the legacy bucket on the server, so the copying account reads it. */
export const LEGACY_FILES = ['storage.objects.get', 'storage.objects.list'] as const;
/** auth-import imports the account; load, verify and rollback read and write Firestore. */
export const TARGET_PROJECT = [
  'firebaseauth.configs.get',
  'firebaseauth.users.create',
  'firebaseauth.users.get',
  'firebaseauth.users.update',
  'firebaseauth.users.delete',
  'datastore.entities.create',
  'datastore.entities.get',
  'datastore.entities.list',
  'datastore.entities.update',
  'datastore.entities.delete',
] as const;

export interface PreflightCheck {
  name: string;
  ok: boolean;
  /** What was checked, or what is missing and how to grant it. */
  detail: string;
  /** Not needed until this step, so it doesn't fail the preflight (the cutover's legacy bucket grant). */
  later?: string;
}

export interface PreflightDeps {
  fetch: typeof fetch;
  /** The account running the commands (gcloud's, or Application Default Credentials). */
  operator: () => Promise<string>;
  /** The account that writes the run and copies the files (migration-runner in prod). */
  writer: () => Promise<string>;
  /** The legacy read-only account, impersonated. */
  reader: () => Promise<string>;
}

export interface PreflightArgs {
  env: Env;
  /** The writer's email, when it isn't the operator. */
  writerAccount?: string;
}

async function send(
  deps: PreflightDeps,
  token: () => Promise<string>,
  url: string,
  body?: unknown,
  project?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await deps.fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${await token()}`,
      'content-type': 'application/json',
      ...(project ? { 'x-goog-user-project': project } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (res.ok) return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  // The body can name the resource but never data; keep it short.
  return { status: res.status, json: { error: (await res.text()).slice(0, 200) } };
}

/** The permissions IAM says the token's account holds on `url` (a bucket's or a `:testIamPermissions`). */
async function held(
  deps: PreflightDeps,
  token: () => Promise<string>,
  url: string,
  permissions: readonly string[],
): Promise<{ held: string[] } | { status: number }> {
  const bucket = url.startsWith(GOOGLE_APIS.storage);
  const target = bucket
    ? `${url}/iam/testPermissions?${new URLSearchParams(permissions.map((p): [string, string] => ['permissions', p]))}`
    : `${url}:testIamPermissions`;
  const res = await send(deps, token, target, bucket ? undefined : { permissions });
  if (res.status !== 200) return { status: res.status };
  return { held: Array.isArray(res.json['permissions']) ? (res.json['permissions'] as string[]) : [] };
}

async function permissionCheck(
  deps: PreflightDeps,
  name: string,
  account: string,
  token: () => Promise<string>,
  url: string,
  resource: string,
  permissions: readonly string[],
  grant: string,
): Promise<PreflightCheck> {
  try {
    const res = await held(deps, token, url, permissions);
    if ('status' in res) {
      const why = res.status === 404 ? "doesn't exist" : `answered ${res.status}`;
      return { name, ok: false, detail: `${resource} ${why}` };
    }
    const missing = permissions.filter((p) => !res.held.includes(p));
    if (!missing.length) return { name, ok: true, detail: `${account} can use ${resource}` };
    return { name, ok: false, detail: `${account} lacks ${missing.join(', ')} on ${resource}: ${grant}` };
  } catch (error) {
    return { name, ok: false, detail: `${resource}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Every check, in the order the steps run. A failure in one never stops the others. */
export async function runPreflight(deps: PreflightDeps, args: PreflightArgs): Promise<PreflightCheck[]> {
  const project = `materia-v2-${args.env}`;
  const runBucket = DESTINATIONS[args.env].bucket;
  const filesBucket = FILES_BUCKETS[args.env];
  const writer = args.writerAccount ?? 'your account';
  const bucketUrl = (name: string) => `${GOOGLE_APIS.storage}/b/${encodeURIComponent(name)}`;
  const serviceAccountUrl = (email: string) => `${IAM}/projects/-/serviceAccounts/${email}`;
  const checks: PreflightCheck[] = [];

  if (args.writerAccount) {
    checks.push(
      await permissionCheck(
        deps,
        'act as the writer',
        'your account',
        deps.operator,
        serviceAccountUrl(args.writerAccount),
        args.writerAccount,
        ['iam.serviceAccounts.getAccessToken'],
        'grant it roles/iam.serviceAccountTokenCreator on that account',
      ),
    );
  }

  const reader = await permissionCheck(
    deps,
    'act as the legacy reader',
    'your account',
    deps.operator,
    serviceAccountUrl(LEGACY_READER),
    LEGACY_READER,
    ['iam.serviceAccounts.getAccessToken'],
    `grant it roles/iam.serviceAccountTokenCreator on ${LEGACY_READER} (in ${LEGACY_PROJECT})`,
  );
  checks.push(reader);
  if (reader.ok) {
    try {
      const iam = await checkReadOnly(
        restIamTester({ fetch: deps.fetch, token: deps.reader }, { project: LEGACY_PROJECT, bucket: LEGACY_BUCKET }),
      );
      const problems = [
        iam.writes.length ? `it can write (${iam.writes.join(', ')})` : '',
        iam.missingReads.length ? `it can't read (${iam.missingReads.join(', ')})` : '',
        iam.authReadable ? '' : "it can't read Auth (firebaseauth.users.get), which auth-import needs",
      ].filter(Boolean);
      checks.push({
        name: 'legacy reader is read-only',
        ok: !problems.length,
        detail: problems.length
          ? `${LEGACY_READER}: ${problems.join('; ')}`
          : `${LEGACY_READER} reads Firestore, Storage and Auth in ${LEGACY_PROJECT}, and writes nothing`,
      });
    } catch (error) {
      checks.push({
        name: 'legacy reader is read-only',
        ok: false,
        detail: `${LEGACY_READER}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  checks.push(
    await permissionCheck(
      deps,
      'write the run',
      writer,
      deps.writer,
      bucketUrl(runBucket),
      runBucket,
      RUN_BUCKET,
      'grant roles/storage.objectAdmin on the bucket',
    ),
  );

  const legacyFiles = await permissionCheck(
    deps,
    'read the legacy files',
    writer,
    deps.writer,
    bucketUrl(LEGACY_BUCKET),
    LEGACY_BUCKET,
    LEGACY_FILES,
    `grant roles/storage.objectViewer on the bucket in ${LEGACY_PROJECT}, and remove it after the last copy`,
  );
  // Prod's runner gets the legacy grant only for the cutover (docs/runbooks/migration-copy-files.md).
  checks.push(args.env === 'prod' && !legacyFiles.ok ? { ...legacyFiles, later: 'the cutover copy' } : legacyFiles);

  checks.push(
    await permissionCheck(
      deps,
      'write the files',
      writer,
      deps.writer,
      bucketUrl(filesBucket),
      filesBucket,
      FILES_BUCKET,
      'grant roles/storage.objectAdmin on the bucket',
    ),
  );

  checks.push(
    await permissionCheck(
      deps,
      'call the scanner',
      'your account',
      deps.operator,
      `${RUN}/projects/${project}/locations/${REGION}/services/clamav`,
      `clamav (${project})`,
      ['run.routes.invoke'],
      'grant roles/run.invoker on the service',
    ),
  );

  // load, verify and rollback read the run and the files as you (Application Default Credentials),
  // not as the writer, so in prod your account needs both buckets too. In dev the writer is you.
  if (args.writerAccount) {
    checks.push(
      await permissionCheck(
        deps,
        'load and roll back the run',
        'your account',
        deps.operator,
        bucketUrl(runBucket),
        runBucket,
        RUN_BUCKET,
        'grant roles/storage.objectAdmin on the bucket (an owner has it)',
      ),
      await permissionCheck(
        deps,
        'roll back the files',
        'your account',
        deps.operator,
        bucketUrl(filesBucket),
        filesBucket,
        FILES_BUCKET,
        'grant roles/storage.objectAdmin on the bucket (an owner has it)',
      ),
    );
  }

  checks.push(
    await permissionCheck(
      deps,
      'import the account and load',
      'your account',
      deps.operator,
      `${RESOURCE_MANAGER}/projects/${project}`,
      project,
      TARGET_PROJECT,
      'grant roles/firebaseauth.admin and roles/datastore.user (an owner has both)',
    ),
  );

  try {
    const providers = await enabledProviders({ fetch: deps.fetch, token: deps.operator }, project);
    checks.push({
      name: 'Google sign-in',
      ok: providers.has('google.com'),
      detail: providers.has('google.com')
        ? `Google sign-in is on in ${project}`
        : `Google sign-in is off in ${project}: turn it on (Authentication › Sign-in method)`,
    });
  } catch (error) {
    checks.push({
      name: 'Google sign-in',
      ok: false,
      detail: `${project}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  return checks;
}

/** One line per check: ✓, ✗, or "later" for a grant only a later step needs. */
export function formatChecks(checks: readonly PreflightCheck[]): string[] {
  return checks.map((check) => {
    const mark = check.ok ? '✓' : check.later ? '·' : '✗';
    const later = !check.ok && check.later ? ` (needed for ${check.later})` : '';
    return `${mark} ${check.name.padEnd(30)} ${check.detail}${later}`;
  });
}

const USAGE = `Usage: materia-migrate preflight --env <dev|prod> [options]

Checks that the accounts the migration runs as can do every step (export, transform, copy-files,
auth-import, load, verify, rollback) against the v2 environment, before any real data moves. It
asks IAM and reads the sign-in config only: no records, files or accounts.

  --env <dev|prod>        The v2 environment to rehearse in or cut over to
  --impersonate <email>   The account that writes the run and copies the files
                          (default: migration-runner in prod, your gcloud account in dev)
  --adc                   Check Application Default Credentials instead of gcloud's account

MIGRATION_OPERATOR_TOKEN, MIGRATION_WRITER_TOKEN and MIGRATION_ACCESS_TOKEN (the legacy reader's),
when set, are used as the tokens. Behind an HTTPS proxy, set NODE_USE_ENV_PROXY=1.
Exit 0 when every check passes, 5 when one fails.`;

export async function preflightCommand(
  argv: string[],
  log = console.log,
  error = console.error,
  makeDeps: (options: { adc: boolean; writer?: string }) => PreflightDeps = defaultDeps,
): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        env: { type: 'string' },
        impersonate: { type: 'string' },
        adc: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    }));
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  if (values.help) {
    log(USAGE);
    return 0;
  }
  const env = values.env as Env | undefined;
  if (!env || !ENVS.includes(env)) {
    error(`--env must be one of ${ENVS.join(', ')}.\n\n${USAGE}`);
    return 1;
  }
  const writer = values.impersonate ?? DESTINATIONS[env].writer;
  const checks = await runPreflight(makeDeps({ adc: values.adc, ...(writer ? { writer } : {}) }), {
    env,
    ...(writer ? { writerAccount: writer } : {}),
  });
  for (const line of formatChecks(checks)) log(line);
  const failed = checks.filter((check) => !check.ok && !check.later);
  if (failed.length) {
    error(`\n${failed.length} of ${checks.length} checks failed: fix them before the run moves any data.`);
    return 5;
  }
  log(`\nReady: every step can run against materia-v2-${env}.`);
  return 0;
}

function defaultDeps({ adc, writer }: { adc: boolean; writer?: string }): PreflightDeps {
  return {
    fetch: globalThis.fetch,
    operator: tokenSource({ adc, envVar: 'MIGRATION_OPERATOR_TOKEN' }),
    writer: tokenSource({
      adc: adc && !writer,
      ...(writer ? { impersonate: writer } : {}),
      envVar: 'MIGRATION_WRITER_TOKEN',
    }),
    // MIGRATION_ACCESS_TOKEN is the legacy reader's, as in the export and the audit.
    reader: tokenSource({ adc: false, impersonate: LEGACY_READER }),
  };
}
