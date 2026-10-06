import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { parseArgs, promisify } from 'node:util';

import { tokenSource } from './audit.ts';
import { EMULATOR_FILES_BUCKET, FILES_BUCKETS, RUN_ID, storageEmulator } from './copy-files.ts';
import { gcsSink, type RunSink } from './export/sink.ts';
import { DESTINATIONS, toolVersion } from './export.ts';
import { gcsStore, type ObjectStore } from './files/gcs.ts';
import { GOOGLE_APIS, type RestDeps } from './legacy/rest.ts';
import { adminTarget } from './load/admin.ts';
import { runDelta } from './load/delta.ts';
import { LoadRefusedError, runLoad, type Env, type Mode } from './load/load.ts';
import { RollbackRefusedError, runRollback } from './load/rollback.ts';
import type { AuthPort, TargetDb } from './load/target.ts';
import { runVerify, type VerifyDeps } from './load/verify.ts';

/**
 * `materia-migrate load | verify | rollback | delta` (MIG-06): write a transformed run into its v2
 * org, prove it, take it out again, and apply later changes. Runbook:
 * docs/runbooks/migration-load.md; decision D-20.
 */

/** The v2 project per environment; the emulator's is a demo- project. */
export const PROJECTS = { dev: 'materia-v2-dev', prod: 'materia-v2-prod', emulator: 'demo-materia' } as const;

const ENVS = `  --run <runId>            The run (gs://materia-v2-<env>-migration/runs/<runId>/), transformed (MIG-03)
                           and its files copied (MIG-05)
  --env dev|prod|emulator  dev for rehearsals, prod at cutover; emulator under \`firebase emulators:exec\``;

const CREDENTIALS = `Firestore, Auth, the run and the files bucket are reached with Application Default Credentials:
your account in Cloud Shell, or \`gcloud auth application-default login\`. MIGRATION_TARGET_ACCESS_TOKEN,
when set, is used for the run and the files bucket. Behind an HTTPS proxy, set NODE_USE_ENV_PROXY=1.`;

const LOAD_USAGE = `Usage: materia-migrate load --run <runId> --env dev|prod|emulator [options]

Writes the run's records into its v2 org in dependency order, leaving alone anything changed in v2
since it was loaded (reported as MIG_C_USER_EDITED), then syncs the members' claims. A re-run writes
only what differs. Writes the run's record, one audit entry and load/report.json.

${ENVS}
  --mode rehearsal|cutover (default: cutover in prod, else rehearsal)
  --dry-run                Print what it would write, and write nothing
  --confirm-prod           Required in prod, with the org's name typed back
  --skip-unfinished-files  Load documents whose copy is unscanned or failed, as files to review

${CREDENTIALS}

Exit codes: 0 loaded (conflicts are reported, not errors); 1 refused or an error, nothing written
when refused; 5 some writes failed: see load/report.json, then run it again.`;

const VERIFY_USAGE = `Usage: materia-migrate verify --run <runId> --env dev|prod|emulator

Reads back every record the run loaded and compares it field by field, checks each copied file's
size and hashes, each member's claims, and that nothing is privileged; on the emulator, it also reads
every record as the member through the security rules. Writes verify/report.json and
verify/verify-report.md to the run.

${ENVS}

${CREDENTIALS}

Exit codes: 0 passed; 1 an error; 5 failed: see verify/verify-report.md.`;

const ROLLBACK_USAGE = `Usage: materia-migrate rollback --run <runId> --env dev|prod|emulator [options]

Deletes everything the run loaded (found by migration.runId), what v2 hung under it, its matter
numbers and files, and the org when the run created it. Refuses, deleting nothing, while records it
didn't load sit under ones it did, and lists them.

${ENVS}
  --dry-run                Count what it would delete, and delete nothing
  --keep-org               Keep the org even when the run created it
  --confirm-prod           Required in prod, with the org's name typed back

${CREDENTIALS}

Exit codes: 0 rolled back; 1 refused or an error; 5 some deletes failed: run it again.`;

const DELTA_USAGE = `Usage: materia-migrate delta --run <deltaRunId> --env dev|prod|emulator [options]

Applies a delta run (export --since, transform --base-run, copy-files) to the org: loads it under
the conflict rule, then finds what was deleted in legacy since (cards, attachments, comments and
checklist items). They are listed in delta/deletions.json and deleted from v2 only with
--apply-deletes, and never when changed in v2 or holding records made there.

${ENVS}
  --apply-deletes          Delete from v2 what legacy deleted
  --dry-run                Print what it would write and delete, and change nothing
  --confirm-prod           Required in prod, with the org's name typed back
  --skip-unfinished-files  As for load

${CREDENTIALS}

Exit codes: 0 applied; 1 refused or an error; 5 some writes or deletes failed: run it again.`;

type Log = (line: string) => void;

interface Target {
  sink: RunSink;
  db: TargetDb;
  auth: AuthPort;
  files: { store: ObjectStore; bucket: string };
  operator: string;
  readAs?: VerifyDeps['readAs'];
  close: () => Promise<void>;
}

/** Everything a command reaches: the run's folder, v2's Firestore and Auth, and the files bucket. */
export type Connect = (runId: string, env: Env, processEnv: NodeJS.ProcessEnv) => Promise<Target>;

const EMULATOR_HOSTS = ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST'];

/** The emulator only with the emulators, and never a real project while one is set. */
export function checkEmulator(env: Env, processEnv: NodeJS.ProcessEnv): string | null {
  const set = EMULATOR_HOSTS.filter((name) => processEnv[name]);
  if (env === 'emulator' && set.length < EMULATOR_HOSTS.length) {
    const missing = EMULATOR_HOSTS.filter((name) => !processEnv[name]);
    return `${missing.join(', ')} not set: run under \`firebase emulators:exec --only auth,firestore,storage\`.`;
  }
  if (env !== 'emulator' && set.length) return `${set.join(', ')} is set: use --env emulator, or unset it.`;
  return null;
}

const connectAdmin: Connect = async (runId, env, processEnv) => {
  const emulator = env === 'emulator';
  const storage = emulator ? storageEmulator(processEnv) : GOOGLE_APIS.storage;
  const rest: RestDeps = {
    fetch,
    token: emulator
      ? async () => 'owner'
      : tokenSource({ adc: true, envVar: 'MIGRATION_TARGET_ACCESS_TOKEN' }, processEnv),
  };
  const sink = gcsSink(rest, { bucket: DESTINATIONS[emulator ? 'dev' : env].bucket, runId, storage });
  // The Storage emulator serves metadata patches only without the /storage/v1 prefix.
  const store = gcsStore(rest, { storage: emulator ? storage.replace(/\/storage\/v1$/, '') : storage });
  const target = await adminTarget(PROJECTS[env], emulator);
  return {
    sink,
    db: target.db,
    auth: target.auth,
    files: { store, bucket: emulator ? EMULATOR_FILES_BUCKET : FILES_BUCKETS[env] },
    operator: emulator ? 'emulator' : await gcloudAccount(),
    ...(emulator ? { readAs: emulatorReadAs(processEnv['FIRESTORE_EMULATOR_HOST'] ?? '', PROJECTS.emulator) } : {}),
    close: target.close,
  };
};

/** Who is running it, for the run's record: gcloud's account. */
async function gcloudAccount(): Promise<string> {
  try {
    const { stdout } = await promisify(execFile)('gcloud', ['config', 'get-value', 'account']);
    return stdout.trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Reads documents through the Firestore emulator's rules as a person: an unsigned ID token with
 * their uid and claims, with the run's org active (as the app switches to it), signed in now.
 */
export function emulatorReadAs(
  host: string,
  projectId: string,
  fetcher: typeof fetch = fetch,
): NonNullable<VerifyDeps['readAs']> {
  const root = `${host.includes('://') ? host : `http://${host}`}/v1/projects/${projectId}/databases/(default)/documents`;
  return async (uid, claims, paths) => {
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const token = [
      encode({ alg: 'none', typ: 'JWT' }),
      encode({
        ...claims,
        iss: `https://securetoken.google.com/${projectId}`,
        aud: projectId,
        sub: uid,
        user_id: uid,
        iat: now,
        exp: now + 3600,
        auth_time: now,
        firebase: { sign_in_provider: 'password', identities: {} },
      }),
      '',
    ].join('.');
    const refused: string[] = [];
    for (let start = 0; start < paths.length; start += 20) {
      const chunk = paths.slice(start, start + 20);
      const results = await Promise.all(
        chunk.map(async (path) => {
          const res = await fetcher(`${root}/${path.split('/').map(encodeURIComponent).join('/')}`, {
            headers: { authorization: `Bearer ${token}` },
          });
          await res.arrayBuffer();
          return res.ok ? null : path;
        }),
      );
      refused.push(...results.filter((path): path is string => path !== null));
    }
    return refused;
  };
}

/** Asks on the terminal; refuses without one, so prod can't be confirmed by a pipe. */
async function askTerminal(question: string): Promise<string> {
  if (!process.stdin.isTTY) throw new LoadRefusedError('Confirming prod needs a terminal: run it interactively.');
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await terminal.question(question);
  } finally {
    terminal.close();
  }
}

interface Common {
  runId: string;
  env: Env;
}

/** The arguments every command takes, checked; or the exit code to return. */
function common(values: Values, usage: string, error: Log): Common | number {
  const { run: runId, env } = values;
  if (typeof runId !== 'string' || typeof env !== 'string') {
    error(usage);
    return 1;
  }
  if (!RUN_ID.test(runId)) {
    error(`--run "${runId}" may hold only letters, digits, ".", "_" and "-".`);
    return 1;
  }
  if (env !== 'dev' && env !== 'prod' && env !== 'emulator') {
    error('Pass --env dev, --env prod or --env emulator.');
    return 1;
  }
  return { runId, env };
}

interface Io {
  log?: Log;
  error?: Log;
  env?: NodeJS.ProcessEnv;
  connect?: Connect;
  ask?: (question: string) => Promise<string>;
}

type Values = Record<string, string | boolean | undefined>;
type Options = NonNullable<Parameters<typeof parseArgs>[0]>['options'];

/** Parses, connects, runs and maps the outcome to an exit code, closing the connection after. */
async function command(
  argv: string[],
  options: Options,
  usage: string,
  io: Io,
  body: (values: Values, base: Common, target: Target, ask: (question: string) => Promise<string>) => Promise<number>,
): Promise<number> {
  const log = io.log ?? console.log;
  const error = io.error ?? console.error;
  const processEnv = io.env ?? process.env;
  let values: Values;
  try {
    values = parseArgs({ args: argv, options: { ...options, help: { type: 'boolean', default: false } } }).values;
  } catch (err) {
    error(`${err instanceof Error ? err.message : String(err)}\n\n${usage}`);
    return 1;
  }
  if (values.help) {
    log(usage);
    return 0;
  }
  const base = common(values, usage, error);
  if (typeof base === 'number') return base;
  const problem = checkEmulator(base.env, processEnv);
  if (problem) {
    error(problem);
    return 1;
  }
  let target: Target | undefined;
  try {
    target = await (io.connect ?? connectAdmin)(base.runId, base.env, processEnv);
    return await body(values, base, target, io.ask ?? askTerminal);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    await target?.close();
  }
}

const RUN_OPTIONS = { run: { type: 'string' }, env: { type: 'string' } } as const;

export function loadCommand(argv: string[], io: Io = {}): Promise<number> {
  return command(
    argv,
    {
      ...RUN_OPTIONS,
      mode: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'confirm-prod': { type: 'boolean', default: false },
      'skip-unfinished-files': { type: 'boolean', default: false },
    },
    LOAD_USAGE,
    io,
    async (values, { runId, env }, target, ask) => {
      const mode = values['mode'] ?? (env === 'prod' ? 'cutover' : 'rehearsal');
      if (mode !== 'rehearsal' && mode !== 'cutover') {
        throw new LoadRefusedError(
          '--mode takes rehearsal or cutover (a delta run loads with `materia-migrate delta`).',
        );
      }
      try {
        const report = await runLoad(
          {
            runId,
            env,
            mode: mode as Mode,
            dryRun: values['dry-run'] === true,
            confirmProd: values['confirm-prod'] === true,
            skipUnfinishedFiles: values['skip-unfinished-files'] === true,
            toolVersion: await toolVersion(),
            operator: target.operator,
          },
          {
            sink: target.sink,
            db: target.db,
            auth: target.auth,
            now: () => new Date(),
            log: io.log ?? console.log,
            ask,
          },
        );
        return report.dryRun || report.complete ? 0 : 5;
      } catch (err) {
        if (err instanceof LoadRefusedError) throw new Error(`Refused, nothing written: ${err.message}`);
        throw err;
      }
    },
  );
}

export function verifyCommand(argv: string[], io: Io = {}): Promise<number> {
  return command(argv, RUN_OPTIONS, VERIFY_USAGE, io, async (_, base, target) => {
    const report = await runVerify(base, {
      sink: target.sink,
      db: target.db,
      auth: target.auth,
      files: target.files,
      ...(target.readAs ? { readAs: target.readAs } : {}),
      now: () => new Date(),
      log: io.log ?? console.log,
    });
    return report.passed ? 0 : 5;
  });
}

export function rollbackCommand(argv: string[], io: Io = {}): Promise<number> {
  return command(
    argv,
    {
      ...RUN_OPTIONS,
      'dry-run': { type: 'boolean', default: false },
      'keep-org': { type: 'boolean', default: false },
      'confirm-prod': { type: 'boolean', default: false },
    },
    ROLLBACK_USAGE,
    io,
    async (values, { runId, env }, target, ask) => {
      try {
        const report = await runRollback(
          {
            runId,
            env,
            dryRun: values['dry-run'] === true,
            keepOrg: values['keep-org'] === true,
            confirmProd: values['confirm-prod'] === true,
            operator: target.operator,
            toolVersion: await toolVersion(),
          },
          {
            sink: target.sink,
            db: target.db,
            auth: target.auth,
            files: target.files,
            now: () => new Date(),
            log: io.log ?? console.log,
            ask,
          },
        );
        return report.dryRun || report.complete ? 0 : 5;
      } catch (err) {
        if (err instanceof RollbackRefusedError) throw new Error(`Refused, nothing deleted: ${err.message}`);
        throw err;
      }
    },
  );
}

export function deltaCommand(argv: string[], io: Io = {}): Promise<number> {
  return command(
    argv,
    {
      ...RUN_OPTIONS,
      'apply-deletes': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'confirm-prod': { type: 'boolean', default: false },
      'skip-unfinished-files': { type: 'boolean', default: false },
    },
    DELTA_USAGE,
    io,
    async (values, { runId, env }, target, ask) => {
      try {
        const report = await runDelta(
          {
            runId,
            env,
            applyDeletes: values['apply-deletes'] === true,
            dryRun: values['dry-run'] === true,
            confirmProd: values['confirm-prod'] === true,
            skipUnfinishedFiles: values['skip-unfinished-files'] === true,
            toolVersion: await toolVersion(),
            operator: target.operator,
          },
          {
            sink: target.sink,
            db: target.db,
            auth: target.auth,
            now: () => new Date(),
            log: io.log ?? console.log,
            ask,
          },
        );
        return report.load.dryRun || (report.load.complete && !report.failures.length) ? 0 : 5;
      } catch (err) {
        if (err instanceof LoadRefusedError) throw new Error(`Refused, nothing written: ${err.message}`);
        throw err;
      }
    },
  );
}
