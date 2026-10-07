import { execFile } from 'node:child_process';
import { parseArgs, promisify } from 'node:util';

import { LEGACY_BUCKET, tokenSource } from './audit.ts';
import { gcsSink, type RunSink } from './export/sink.ts';
import { DESTINATIONS, toolVersion } from './export.ts';
import { runCopyFiles } from './files/copy.ts';
import { gcsStore, type ObjectStore } from './files/gcs.ts';
import { emulatorScanner, httpScanner, type Scanner } from './files/scanner.ts';
import { GOOGLE_APIS, type RestDeps } from './legacy/rest.ts';

/**
 * `materia-migrate copy-files` (MIG-05): copies every attachment the transform planned, and the
 * profile photo, from the legacy bucket into the v2 files bucket on the server, verifies each
 * copy against the export's checksums, records its sha256, scans it, and writes the results
 * beside the run (files/copy.ts). Runbook: docs/runbooks/migration-copy-files.md; decision D-18.
 */

/** The v2 files bucket per environment (infra/terraform/modules/firebase_env/data.tf). */
export const FILES_BUCKETS = { dev: 'materia-v2-dev-files', prod: 'materia-v2-prod-files' } as const;
const FILES_BUCKET = /^materia-v2-(dev|prod)-files$/;
/** The emulator's files bucket (apps/functions/src/documents/files.ts for a demo- project). */
export const EMULATOR_FILES_BUCKET = 'demo-materia.appspot.com';
/** The scanner service's region (all of v2 runs there). */
const REGION = 'australia-southeast1';

const USAGE = `Usage: materia-migrate copy-files --run <runId> --env dev|prod [options]

Copies the attachments the transform planned (transformed/documents.jsonl) and the profile photo
(transformed/avatars.jsonl) from the legacy bucket into the v2 files bucket, server to server.
Each copy is checked against the export's checksums, hashed (sha256), scanned for malware and
only then moved to its final path; infected ones stay in quarantine. Writes files/documents.jsonl,
files/avatars.jsonl and files/report.json to the run. A re-run skips files already copied.

  --run <runId>            The run (gs://materia-v2-<env>-migration/runs/<runId>/)
  --env dev|prod           dev for rehearsals (rolled back, D-15); prod at cutover.
                           emulator: the Storage emulator with a fake scanner (EICAR is infected)
  --concurrency <n>        Files at a time (default 8, at most 32)
  --source-bucket <name>   Legacy bucket (default: the export manifest's, else ${LEGACY_BUCKET})
  --files-bucket <name>    v2 files bucket (default materia-v2-<env>-files)
  --scanner-url <url>      ClamAV service (default: the clamav Cloud Run service in materia-v2-<env>)
  --impersonate <email>    Account that copies (default: migration-runner in prod, your gcloud
                           account in dev). It needs read on the legacy bucket and the run, and
                           object admin on the files bucket
  --adc                    Copy with Application Default Credentials instead
  --scanner-impersonate <email>
                           Account whose ID token calls the scanner (default: your gcloud account)

MIGRATION_WRITER_TOKEN and MIGRATION_SCANNER_TOKEN, when set, are used as the tokens. Behind an
HTTPS proxy, set NODE_USE_ENV_PROXY=1.

Exit codes: 0 every file copied, skipped, missing in legacy (reported) or infected (quarantined);
1 bad arguments or an error; 5 some files are unscanned or failed: see files/report.json, then
run it again.`;

export const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The Storage emulator's JSON API root, from the variable `firebase emulators:exec` sets. */
export function storageEmulator(env: NodeJS.ProcessEnv): string {
  const host = env['FIREBASE_STORAGE_EMULATOR_HOST'];
  if (!host) throw new Error('FIREBASE_STORAGE_EMULATOR_HOST is not set: run under `firebase emulators:exec`.');
  return `${host.includes('://') ? host : `http://${host}`}/storage/v1`;
}

type Exec = (file: string, args: string[]) => Promise<{ stdout: string }>;
const execGcloud: Exec = (file, args) => promisify(execFile)(file, args);

/** A Google ID token for the scanner, from gcloud (or MIGRATION_SCANNER_TOKEN). */
export function identityToken(
  url: string,
  impersonate: string | undefined,
  env: NodeJS.ProcessEnv,
  exec: Exec = execGcloud,
): () => Promise<string> {
  const fixed = env['MIGRATION_SCANNER_TOKEN'];
  if (fixed) return async () => fixed;
  let cached: { token: string; until: number } | undefined;
  return async () => {
    if (cached && cached.until > Date.now()) return cached.token;
    // A user account's token is for gcloud itself, which Cloud Run accepts; a service account's
    // (impersonated, or gcloud's own, as when an agent runs it) must name the service.
    const account = impersonate ?? (await exec('gcloud', ['config', 'get-value', 'account'])).stdout.trim();
    const { stdout } = await exec('gcloud', [
      'auth',
      'print-identity-token',
      ...(impersonate ? [`--impersonate-service-account=${impersonate}`] : []),
      ...(account.endsWith('.gserviceaccount.com') ? [`--audiences=${url}`] : []),
    ]);
    cached = { token: stdout.trim(), until: Date.now() + 45 * 60 * 1000 };
    return cached.token;
  };
}

/** The deployed clamav service's URL in the v2 project. */
async function scannerUrl(env: 'dev' | 'prod'): Promise<string> {
  const { stdout } = await promisify(execFile)('gcloud', [
    'run',
    'services',
    'describe',
    'clamav',
    `--project=materia-v2-${env}`,
    `--region=${REGION}`,
    '--format=value(status.url)',
  ]);
  const url = stdout.trim();
  if (!url) throw new Error(`No clamav service in materia-v2-${env}: deploy the document services first.`);
  return url;
}

/** The legacy bucket the run was exported from, as its manifest says. */
async function exportedBucket(sink: RunSink): Promise<string | null> {
  const text = await sink.read('manifest.json');
  if (text === null) return null;
  const manifest = JSON.parse(text) as { sourceBucket?: unknown };
  return typeof manifest.sourceBucket === 'string' ? manifest.sourceBucket : null;
}

export async function copyFilesCommand(
  argv: string[],
  log = console.log,
  error = console.error,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        run: { type: 'string' },
        env: { type: 'string' },
        concurrency: { type: 'string', default: '8' },
        'source-bucket': { type: 'string' },
        'files-bucket': { type: 'string' },
        'scanner-url': { type: 'string' },
        impersonate: { type: 'string' },
        adc: { type: 'boolean', default: false },
        'scanner-impersonate': { type: 'string' },
        help: { type: 'boolean', default: false },
      },
    }));
  } catch (err) {
    error(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    return 1;
  }
  if (values.help) {
    log(USAGE);
    return 0;
  }
  const fail = (message: string) => {
    error(message);
    return 1;
  };
  const runId = values.run;
  const target = values.env;
  if (!runId || !target) return fail(USAGE);
  if (!RUN_ID.test(runId)) return fail(`--run "${runId}" may hold only letters, digits, ".", "_" and "-".`);
  if (target !== 'dev' && target !== 'prod' && target !== 'emulator') {
    return fail('Pass --env dev, --env prod or --env emulator.');
  }
  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    return fail('--concurrency takes a whole number from 1 to 32.');
  }
  const emulator = target === 'emulator';
  const filesBucket = values['files-bucket'] ?? (emulator ? EMULATOR_FILES_BUCKET : FILES_BUCKETS[target]);
  if (!emulator && !FILES_BUCKET.test(filesBucket)) {
    return fail(`Refusing to copy into gs://${filesBucket}: only a materia-v2 files bucket.`);
  }
  if (!emulator && filesBucket !== FILES_BUCKETS[target]) {
    return fail(`--files-bucket ${filesBucket} is not ${target}'s (${FILES_BUCKETS[target]}).`);
  }
  if (emulator && values['scanner-url']) return fail('The emulator uses the fake scanner, not --scanner-url.');

  let storage = GOOGLE_APIS.storage;
  try {
    if (emulator) storage = storageEmulator(env);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const destination = emulator ? 'dev' : target;
  const impersonate = values.impersonate ?? DESTINATIONS[destination].writer;
  const rest: RestDeps = {
    fetch,
    token: emulator
      ? async () => 'owner'
      : tokenSource(
          { adc: values.adc, ...(impersonate ? { impersonate } : {}), envVar: 'MIGRATION_WRITER_TOKEN' },
          env,
        ),
  };
  const sink = gcsSink(rest, { bucket: DESTINATIONS[destination].bucket, runId, storage });
  // The Storage emulator serves rewrites and metadata patches only without the /storage/v1 prefix.
  const store: ObjectStore = gcsStore(rest, { storage: emulator ? storage.replace(/\/storage\/v1$/, '') : storage });

  try {
    const sourceBucket = values['source-bucket'] ?? (await exportedBucket(sink)) ?? LEGACY_BUCKET;
    if (sourceBucket === filesBucket) return fail('The legacy bucket and the files bucket are the same.');
    if (emulator !== sourceBucket.startsWith('demo-')) {
      return fail(
        emulator
          ? `The emulator copies only from a demo- bucket, not gs://${sourceBucket}.`
          : 'Made-up data never goes to a real files bucket.',
      );
    }
    let scanner: Scanner = emulatorScanner;
    if (!emulator) {
      const url = values['scanner-url'] ?? (await scannerUrl(target as 'dev' | 'prod'));
      scanner = httpScanner({ url, idToken: identityToken(url, values['scanner-impersonate'], env) });
    }
    const report = await runCopyFiles(
      { runId, env: target, sourceBucket, filesBucket, concurrency, toolVersion: await toolVersion() },
      { sink, store, scanner, now: () => new Date(), log },
    );
    if (!report.complete) {
      error(
        `${report.counts.unscanned} files unscanned and ${report.counts.failed} failed: see files/report.json, then run it again.`,
      );
      return 5;
    }
    return 0;
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
