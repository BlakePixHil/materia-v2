import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs, promisify } from 'node:util';

import { assertReadOnly, NotReadOnlyError, type ReadOnlyCheck } from './audit/iam.ts';
import type { AuditReport } from './audit/report.ts';
import { LEGACY_BUCKET, LEGACY_PROJECT, LEGACY_READER, tokenSource } from './audit.ts';
import { exportLine, sha256, type ExportRecord } from './export/jsonl.ts';
import {
  collectExport,
  EXPORT_FILES,
  SNAPSHOT_FILES,
  UnmappedWorkflowsError,
  type DeltaScope,
  type ExportFile,
} from './export/scope.ts';
import { gcsSink, type RunSink } from './export/sink.ts';
import type { LegacyReader } from './legacy/reader.ts';
import {
  emulatorEndpoints,
  GOOGLE_APIS,
  restIamTester,
  restReader,
  serverReadTime,
  type IamTester,
  type RestDeps,
} from './legacy/rest.ts';
import { MappingProfileSchema, type MappingProfile } from './profile.ts';

/**
 * `materia-migrate export` (MIG-02): reads one user's legacy data read-only, as one Firestore
 * snapshot (a single `readTime`), and writes it as JSONL to the v2 migration bucket:
 * `gs://materia-v2-<env>-migration/runs/{runId}/raw/{file}.jsonl`, then `manifest.json` with the
 * counts and a sha256 per file. It checks with IAM that the legacy credentials can't write before
 * it reads, never sends a write to the legacy project, and logs counts only. Runbook:
 * docs/runbooks/migration-export.md; decision D-17.
 */

/** Where each environment's runs go, and who writes them. Dev has no runner account (D-17). */
export const DESTINATIONS = {
  dev: { bucket: 'materia-v2-dev-migration', writer: undefined },
  prod: { bucket: 'materia-v2-prod-migration', writer: 'migration-runner@materia-v2-prod.iam.gserviceaccount.com' },
} as const;
type Destination = keyof typeof DESTINATIONS;

/** Firestore reads at most an hour back (without point-in-time recovery); resume leaves a margin. */
const RESUMABLE_FOR_MS = 55 * 60 * 1000;
/** Lines go to the sink in batches of about this many characters. */
const WRITE_BATCH = 1024 * 1024;

export interface ExportArgs {
  uid: string;
  profile: MappingProfile;
  /** sha256 of the profile file, so a run records exactly which decisions it was read under. */
  profileHash: string;
  source: { project: string; bucket: string };
  runId: string;
  since?: string;
  resume: boolean;
  toolVersion: string;
}

export interface ExportDeps {
  /** The read-only check; null for the emulator, which has no IAM. */
  iam: IamTester | null;
  /** The time Firestore reads at now (rest.ts `serverReadTime`). */
  serverReadTime: () => Promise<string>;
  /** A reader pinned to `readTime`. */
  reader: (readTime: string) => LegacyReader;
  /** Where the run goes; null for a dry run, which writes nothing. */
  sink: RunSink | null;
  now: () => Date;
  log: (line: string) => void;
}

export interface FileEntry {
  count: number;
  bytes: number;
  sha256: string;
}

export interface ExportManifest {
  version: 1;
  runId: string;
  kind: 'full' | 'delta';
  since?: string;
  sourceProject: string;
  sourceBucket: string;
  uid: string;
  startedAt: string;
  finishedAt: string;
  /** Every Firestore read is as of this time; Storage and Auth are read just after it. */
  readTime: string;
  toolVersion: string;
  profileHash: string;
  /** `gs://…/runs/{runId}/`, or `dry-run`. */
  location: string;
  workflows: { exported: number; excluded: number };
  /** Records per file, plus the notifications count (never exported). */
  counts: Partial<Record<ExportFile | 'paths' | 'notifications', number>>;
  /** Per file under the run: `raw/cards.jsonl`. */
  files: Record<string, FileEntry>;
  downloadTokensStripped: number;
  warnings: string[];
  delta?: Omit<DeltaScope, 'paths'>;
}

/** What survives an interrupted run: the snapshot's readTime and the files already written. */
interface Checkpoint {
  version: 1;
  runId: string;
  uid: string;
  sourceProject: string;
  profileHash: string;
  since: string | null;
  readTime: string;
  startedAt: string;
  files: Record<string, FileEntry>;
}

/** The export can't go on as asked (a resume that doesn't match, a run id in use…). */
export class ExportRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportRefusedError';
  }
}

export async function runExport(args: ExportArgs, deps: ExportDeps): Promise<ExportManifest> {
  const { log, sink } = deps;
  // Before any read: refuse credentials that could write to the legacy project.
  let check: ReadOnlyCheck | undefined;
  if (deps.iam) {
    check = await assertReadOnly(deps.iam);
    log(`Read-only check passed: ${check.granted.join(', ')}.`);
  } else {
    log(`Reading ${args.source.project} on the emulator, which has no IAM to check.`);
  }

  const checkpoint = await startOrResume(args, deps);
  const { readTime } = checkpoint;
  if (args.since && !(Date.parse(args.since) < Date.parse(readTime))) {
    throw new ExportRefusedError(`--since ${args.since} is not before the snapshot (${readTime}).`);
  }
  log(`${args.resume ? 'Resuming' : 'Reading'} the snapshot at ${readTime}.`);

  const scope = await collectExport(deps.reader(readTime), {
    uid: args.uid,
    profile: args.profile,
    ...(args.since ? { since: args.since } : {}),
    readAuth: check ? check.authReadable : true,
  });
  log(
    `Workflows: ${scope.workflows.exported.length} to export, ${scope.workflows.excluded.length} excluded by the profile.`,
  );

  const files: Record<string, FileEntry> = {};
  const counts: ExportManifest['counts'] = {};
  const outputs = EXPORT_FILES.map((file): [ExportFile | 'paths', ExportRecord[]] => [file, scope.files[file]]);
  if (scope.delta) outputs.push(['paths', scope.delta.paths]);
  for (const [file, records] of outputs) {
    const name = `raw/${file}.jsonl`;
    const lines = records.map((record) => exportLine(record, readTime));
    const hash = createHash('sha256');
    let bytes = 0;
    for (const line of lines) {
      hash.update(line);
      bytes += Buffer.byteLength(line);
    }
    const entry: FileEntry = { count: lines.length, bytes, sha256: hash.digest('hex') };
    const done = checkpoint.files[name];
    if (done) {
      // Same readTime, same bytes: anything else means the resume isn't reading what the first attempt read.
      if ((file === 'paths' || SNAPSHOT_FILES.has(file)) && done.sha256 !== entry.sha256) {
        throw new Error(`${name} differs from the interrupted run's at the same readTime. Start a new run.`);
      }
      files[name] = done;
      counts[file] = done.count;
      log(`${name}: ${done.count} records, kept from the interrupted run.`);
      continue;
    }
    if (sink) {
      await writeLines(sink, name, lines, { once: !args.resume });
      checkpoint.files[name] = entry;
      await writeJson(sink, 'checkpoint.json', checkpoint);
    }
    files[name] = entry;
    counts[file] = entry.count;
    log(`${name}: ${entry.count} records.`);
  }
  if (scope.notifications !== null) counts.notifications = scope.notifications;

  const manifest: ExportManifest = {
    version: 1,
    runId: args.runId,
    kind: scope.delta ? 'delta' : 'full',
    ...(args.since ? { since: args.since } : {}),
    sourceProject: args.source.project,
    sourceBucket: args.source.bucket,
    uid: args.uid,
    startedAt: checkpoint.startedAt,
    finishedAt: deps.now().toISOString(),
    readTime,
    toolVersion: args.toolVersion,
    profileHash: args.profileHash,
    location: sink?.location ?? 'dry-run',
    workflows: { exported: scope.workflows.exported.length, excluded: scope.workflows.excluded.length },
    counts,
    files,
    downloadTokensStripped: scope.downloadTokensStripped,
    warnings: scope.warnings,
    ...(scope.delta
      ? { delta: { since: scope.delta.since, unchanged: scope.delta.unchanged, nonUniform: scope.delta.nonUniform } }
      : {}),
  };
  if (scope.notifications !== null) log(`Notifications: ${scope.notifications}, counted and not exported.`);
  if (scope.downloadTokensStripped) log(`Took ${scope.downloadTokensStripped} download tokens out of URLs.`);
  if (scope.delta) {
    log(
      `Delta since ${scope.delta.since}: ${scope.delta.unchanged.cards} cards and ` +
        `${scope.delta.unchanged.attachments} attachments unchanged.`,
    );
    for (const [file, n] of Object.entries(scope.delta.nonUniform)) {
      log(`  ${n} ${file} have no ISO updatedOn, so they went in.`);
    }
  }
  for (const warning of scope.warnings) log(`Warning: ${warning}`);

  const total = Object.values(files).reduce((sum, entry) => sum + entry.count, 0);
  if (!sink) {
    log(`Dry run: read ${total} records for ${Object.keys(files).length} files and wrote nothing.`);
    return manifest;
  }
  await writeJson(sink, 'manifest.json', manifest, { once: true });
  log(`Exported ${total} records in ${Object.keys(files).length} files to ${sink.location} (manifest.json).`);
  return manifest;
}

/** A new run's checkpoint with a fresh readTime, or the interrupted run's when resuming. */
async function startOrResume(args: ExportArgs, deps: ExportDeps): Promise<Checkpoint> {
  const { sink } = deps;
  const fresh = async (): Promise<Checkpoint> => ({
    version: 1,
    runId: args.runId,
    uid: args.uid,
    sourceProject: args.source.project,
    profileHash: args.profileHash,
    since: args.since ?? null,
    readTime: await deps.serverReadTime(),
    startedAt: deps.now().toISOString(),
    files: {},
  });
  if (!sink) return fresh();

  const [saved, manifest] = await Promise.all([sink.read('checkpoint.json'), sink.read('manifest.json')]);
  if (!args.resume) {
    if (saved || manifest) {
      throw new ExportRefusedError(
        `Run ${args.runId} already exists in ${sink.location}: pass --resume, or a new --run-id.`,
      );
    }
    return fresh();
  }
  if (manifest) throw new ExportRefusedError(`Run ${args.runId} is already complete (${sink.location}manifest.json).`);
  if (!saved) throw new ExportRefusedError(`Nothing to resume: ${sink.location} has no checkpoint.json.`);
  const checkpoint = JSON.parse(saved) as Checkpoint;
  const mismatch = [
    checkpoint.uid !== args.uid ? 'uid' : '',
    checkpoint.sourceProject !== args.source.project ? 'source project' : '',
    checkpoint.profileHash !== args.profileHash ? 'mapping profile' : '',
    (checkpoint.since ?? null) !== (args.since ?? null) ? '--since' : '',
  ].filter(Boolean);
  if (mismatch.length) {
    throw new ExportRefusedError(
      `Can't resume run ${args.runId}: the ${mismatch.join(', ')} differ from the first attempt's.`,
    );
  }
  if (deps.now().getTime() - Date.parse(checkpoint.readTime) > RESUMABLE_FOR_MS) {
    throw new ExportRefusedError(
      `Run ${args.runId}'s snapshot (${checkpoint.readTime}) is nearly an hour old, and Firestore can't read further ` +
        'back than an hour. Start a new run.',
    );
  }
  return checkpoint;
}

async function writeLines(sink: RunSink, name: string, lines: string[], options: { once: boolean }): Promise<void> {
  const file = await sink.create(name, 'application/x-ndjson', options);
  let batch = '';
  for (const line of lines) {
    batch += line;
    if (batch.length >= WRITE_BATCH) {
      await file.write(batch);
      batch = '';
    }
  }
  if (batch) await file.write(batch);
  await file.close();
}

async function writeJson(sink: RunSink, name: string, value: unknown, options: { once?: boolean } = {}): Promise<void> {
  const file = await sink.create(name, 'application/json', options);
  await file.write(`${JSON.stringify(value, null, 2)}\n`);
  await file.close();
}

// ---------- the audit's counts ----------

export interface CountComparison {
  name: string;
  exported: number;
  audit: number;
}

/** The export's counts beside the MIG-01 audit's, for the in-scope data both read. */
export function compareWithAudit(manifest: ExportManifest, report: AuditReport): CountComparison[] {
  const c = report.counts;
  const n = (file: ExportFile) => manifest.counts[file] ?? 0;
  return [
    { name: 'workflows', exported: manifest.workflows.exported, audit: c.workflows.inScope },
    { name: 'cards', exported: n('cards'), audit: c.cards.total },
    { name: 'attachments', exported: n('attachments'), audit: c.attachments.count },
    { name: 'checklist-templates', exported: n('checklist-templates'), audit: c.checklistTemplates },
    { name: 'referrers', exported: n('referrers'), audit: c.referrers },
    { name: 'integrations', exported: n('integrations'), audit: c.integrations },
    { name: 'workspaces', exported: n('workspaces'), audit: c.workspaces },
    { name: 'dashboard-checklist-items', exported: n('dashboard-checklist-items'), audit: c.dashboardItems },
  ];
}

// ---------- command ----------

const USAGE = `Usage: materia-migrate export --profile <profile.json> --env dev|prod [options]
       materia-migrate export --profile <profile.json> --dry-run [--compare-audit <audit-report.json>]

Reads one user's legacy data read-only, as one Firestore snapshot, and writes it as JSONL with a
manifest to gs://materia-v2-<env>-migration/runs/<runId>/.

  --profile <path>              The mapping profile: the uid, and which workflows to leave out
  --env dev|prod                Where the run goes. dev is for rehearsals (rolled back, D-15)
  --dry-run                     Read and count everything, write nothing
  --compare-audit <path>        Compare the counts with a MIG-01 audit report
  --since <iso>                 A delta: only cards and attachments changed after this time
  --run-id <id>                 Name the run (default: the time and a random suffix)
  --resume                      Finish an interrupted run (--run-id), within the hour
  --uid <uid>                   Must match the profile's subject when given
  --source-project <id>         Legacy project (default ${LEGACY_PROJECT}). A demo- project reads
                                the Firestore, Storage and Auth emulators, and --env emulator
                                writes to the Storage emulator
  --source-bucket <name>        Legacy bucket (default ${LEGACY_BUCKET})
  --impersonate <email>         Read-only legacy account (default ${LEGACY_READER})
  --adc                         Read with Application Default Credentials instead
  --writer-impersonate <email>  Account that writes the run (default: migration-runner in prod,
                                your gcloud account in dev)
  --writer-adc                  Write with Application Default Credentials instead

MIGRATION_ACCESS_TOKEN and MIGRATION_WRITER_TOKEN, when set, are used as the tokens. Behind an
HTTPS proxy, set NODE_USE_ENV_PROXY=1.

Exit codes: 0 exported (or dry run), 1 bad arguments, a refused run or an error, 3 legacy
credentials not read-only, 4 the profile doesn't map every workflow.`;

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function defaultRunId(now: Date): string {
  return `${now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')}-${randomBytes(2).toString('hex')}`;
}

async function toolVersion(): Promise<string> {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  try {
    const { stdout } = await promisify(execFile)('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: new URL('.', import.meta.url),
    });
    return `${pkg.version}+${stdout.trim()}`;
  } catch {
    return pkg.version;
  }
}

export async function exportCommand(
  argv: string[],
  log = console.log,
  error = console.error,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      profile: { type: 'string' },
      env: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'compare-audit': { type: 'string' },
      since: { type: 'string' },
      'run-id': { type: 'string' },
      resume: { type: 'boolean', default: false },
      uid: { type: 'string' },
      'source-project': { type: 'string', default: LEGACY_PROJECT },
      'source-bucket': { type: 'string' },
      impersonate: { type: 'string', default: LEGACY_READER },
      adc: { type: 'boolean', default: false },
      'writer-impersonate': { type: 'string' },
      'writer-adc': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    log(USAGE);
    return 0;
  }
  const fail = (message: string) => {
    error(message);
    return 1;
  };
  if (!values.profile) return fail(USAGE);
  const dryRun = values['dry-run'];
  const destination = values.env;
  if (!dryRun && destination !== 'dev' && destination !== 'prod' && destination !== 'emulator') {
    return fail('Pass --env dev, --env prod (or --env emulator with a demo- source), or --dry-run.');
  }
  if (dryRun && values.resume) return fail('--dry-run writes nothing, so there is nothing to resume.');
  if (values.resume && !values['run-id']) return fail('--resume needs the --run-id of the interrupted run.');
  const runId = values['run-id'] ?? defaultRunId(new Date());
  if (!RUN_ID.test(runId)) return fail(`--run-id "${runId}" may hold only letters, digits, ".", "_" and "-".`);
  if (values.since !== undefined && Number.isNaN(Date.parse(values.since))) {
    return fail(`--since "${values.since}" is not a date and time (use ISO 8601, such as the last run's readTime).`);
  }

  const profileText = await readFile(values.profile, 'utf8');
  let profile: MappingProfile;
  try {
    profile = MappingProfileSchema.parse(JSON.parse(profileText));
  } catch (err) {
    return fail(
      `${values.profile} is not a valid mapping profile: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const uid = profile.subject.legacyUid;
  if (values.uid && values.uid !== uid) return fail(`--uid ${values.uid} is not the profile's subject (${uid}).`);

  const project = values['source-project'];
  const emulator = project.startsWith('demo-');
  if (destination === 'emulator' && !emulator) return fail('--env emulator takes only a demo- source project.');
  if (destination === 'prod' && emulator) return fail('Made-up data never goes to the prod migration bucket.');
  const bucket =
    values['source-bucket'] ?? (project === LEGACY_PROJECT ? LEGACY_BUCKET : `${project}.firebasestorage.app`);

  let endpoints = GOOGLE_APIS;
  try {
    if (emulator) endpoints = emulatorEndpoints(env);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const source = { project, bucket };
  const legacy: RestDeps = {
    fetch,
    token: emulator ? async () => 'owner' : tokenSource({ adc: values.adc, impersonate: values.impersonate }, env),
  };

  let sink: RunSink | null = null;
  if (!dryRun) {
    const target: Destination = destination === 'prod' ? 'prod' : 'dev';
    const writer = values['writer-impersonate'] ?? DESTINATIONS[target].writer;
    const writerRest: RestDeps = {
      fetch,
      token:
        destination === 'emulator'
          ? async () => 'owner'
          : tokenSource(
              {
                adc: values['writer-adc'],
                ...(writer ? { impersonate: writer } : {}),
                envVar: 'MIGRATION_WRITER_TOKEN',
              },
              env,
            ),
    };
    sink = gcsSink(writerRest, {
      bucket: DESTINATIONS[target].bucket,
      runId,
      storage: destination === 'emulator' ? endpoints.storage : GOOGLE_APIS.storage,
    });
  }

  try {
    const manifest = await runExport(
      {
        uid,
        profile,
        profileHash: sha256(profileText),
        source,
        runId,
        ...(values.since ? { since: new Date(values.since).toISOString() } : {}),
        resume: values.resume,
        toolVersion: await toolVersion(),
      },
      {
        iam: emulator ? null : restIamTester(legacy, source),
        serverReadTime: () => serverReadTime(legacy, project, uid, endpoints),
        reader: (readTime) => restReader(legacy, source, { endpoints, readTime, lossless: true }),
        sink,
        now: () => new Date(),
        log,
      },
    );
    if (values['compare-audit']) {
      const report = JSON.parse(await readFile(values['compare-audit'], 'utf8')) as AuditReport;
      const rows = compareWithAudit(manifest, report);
      const differ = rows.filter((row) => row.exported !== row.audit);
      for (const row of rows) {
        log(`  ${row.name}: ${row.exported} (audit ${row.audit}${row.exported === row.audit ? '' : ', differs'})`);
      }
      log(
        differ.length
          ? `${differ.length} counts differ from the audit of ${report.generatedAt}: the data or the profile changed since.`
          : `Every count matches the audit of ${report.generatedAt}.`,
      );
    }
    return 0;
  } catch (err) {
    if (err instanceof NotReadOnlyError) {
      error(err.message);
      return 3;
    }
    if (err instanceof UnmappedWorkflowsError) {
      error(err.message);
      return 4;
    }
    error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
