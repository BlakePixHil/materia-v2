import { domain } from '../domain.ts';
import { syncClaims } from './claims.ts';
import { CONFLICT_CODES, planLine, type Decision, type Planned } from './plan.ts';
import { readRun, type PhaseInput, type RunInput } from './run-files.ts';
import type { AuthPort, TargetDb, WriteFailure } from './target.ts';
import type { Data } from './values.ts';
import type { RunSink } from '../export/sink.ts';

/**
 * `materia-migrate load` (MIG-06): writes one transformed run into its v2 org, in dependency
 * order (org, users, members, counters, numbers, contacts, templates, matters, parties, tasks,
 * notes, activity, documents, personal tasks), each phase finished before the next starts.
 *
 * - **Idempotent:** every path is deterministic, so a re-run writes only what differs, and an
 *   interrupted load is finished by running it again.
 * - **Conflict rule:** a document someone changed in v2 after it was loaded is left alone and
 *   reported (`MIG_C_USER_EDITED`); so is anything v2 made itself at a migration path.
 * - **Side effects:** every document carries `migration {runId, legacyPath, loadedAt}`; the v2
 *   triggers see a write that set it and skip their notifications, ingestion and per-document
 *   audit entries, while the denormalising triggers still run.
 * - **Records:** the run's record at `orgs/{orgId}/migrations/{runId}`, one `migration.loaded`
 *   audit entry with the counts, and `load/report.json` in the run's folder. Logs carry counts and
 *   paths only, never client data.
 */

export type Env = 'dev' | 'prod' | 'emulator';
export type Mode = 'rehearsal' | 'cutover' | 'delta';

export interface LoadArgs {
  runId: string;
  env: Env;
  mode: Mode;
  dryRun: boolean;
  confirmProd: boolean;
  skipUnfinishedFiles: boolean;
  toolVersion: string;
  /** Who ran it (their gcloud account), for the run record. */
  operator: string;
}

export interface LoadDeps {
  sink: RunSink;
  db: TargetDb;
  auth: AuthPort;
  now: () => Date;
  log: (line: string) => void;
  /** Asks the operator a question on the terminal (the prod confirmation). */
  ask: (question: string) => Promise<string>;
}

export interface FileCounts {
  lines: number;
  create: number;
  update: number;
  unchanged: number;
  user_edited: number;
  not_migrated: number;
  raise: number;
  keep: number;
  failed: number;
}

export interface Conflict {
  code: string;
  path: string;
  legacyPath: string;
}

export interface LoadReport {
  version: 1;
  runId: string;
  env: Env;
  mode: Mode;
  orgId: string;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  toolVersion: string;
  counts: Record<string, FileCounts>;
  conflicts: Conflict[];
  failures: WriteFailure[];
  /** Documents whose file isn't in v2 (lost in legacy, or loaded for review with --skip-unfinished-files). */
  documentsWithoutFile: number;
  /** Whether every phase was written (nothing failed). */
  complete: boolean;
}

/** The load stopped before writing anything: what to fix is in the message. */
export class LoadRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoadRefusedError';
  }
}

/** The most conflicts the run record keeps; `load/report.json` has them all. */
const RECORD_WARNINGS_MAX = 200;
/** Paths read per `getAll`. */
const READ_CHUNK = 300;

export async function runLoad(args: LoadArgs, deps: LoadDeps): Promise<LoadReport> {
  const { db, log } = deps;
  const startedAt = deps.now();
  const input = await readRun(deps.sink, args.runId, {
    now: startedAt,
    skipUnfinishedFiles: args.skipUnfinishedFiles,
  }).catch((err: unknown) => {
    throw new LoadRefusedError(err instanceof Error ? err.message : String(err));
  });
  const orgPath = `orgs/${input.orgId}`;
  const existingOrg = (await db.getAll([orgPath])).get(orgPath);
  if (!input.orgLine && !existingOrg) {
    throw new LoadRefusedError(`Org ${input.orgId} doesn't exist in ${args.env}, and the run doesn't create it.`);
  }
  const org = (existingOrg ?? input.orgLine?.data) as Data;
  await confirmTarget(args, deps, String(org['name'] ?? ''));

  for (const uid of input.memberUids) {
    if ((await deps.auth.claimsOf(uid)) === null) {
      throw new LoadRefusedError(`There is no v2 account ${uid}: run auth-import (MIG-04) before the load.`);
    }
  }

  const plans = await planAll(db, input, startedAt);
  const clashes = plans.flatMap(({ planned }) => planned.filter((item) => item.decision === 'clash'));
  if (clashes.length) {
    throw new LoadRefusedError(
      `${clashes.length} matter numbers are already held by other matters in ${input.orgId}, for example ` +
        `${clashes[0]?.path}. Transform again against this org, or load into a new one.`,
    );
  }

  const counts = Object.fromEntries(plans.map(({ input: phase, planned }) => [phase.phase.file, tally(planned)]));
  const conflicts = plans.flatMap(({ planned }) =>
    planned.flatMap((item) => {
      const code = CONFLICT_CODES[item.decision];
      return code ? [{ code, path: item.path, legacyPath: item.legacyPath }] : [];
    }),
  );
  log(`Run ${args.runId} into ${orgPath} (${args.env}${args.dryRun ? ', dry run' : ''}):`);
  for (const [file, count] of Object.entries(counts)) {
    if (count.lines) log(`  ${file.padEnd(20)}${summary(count)}`);
  }
  const report: LoadReport = {
    version: 1,
    runId: args.runId,
    env: args.env,
    mode: args.mode,
    orgId: input.orgId,
    dryRun: args.dryRun,
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    toolVersion: args.toolVersion,
    counts,
    conflicts,
    failures: [],
    documentsWithoutFile: input.documentsWithoutFile,
    complete: !args.dryRun,
  };
  if (args.dryRun) {
    log('Dry run: nothing written.');
    return report;
  }

  const runPath = `${orgPath}/migrations/${args.runId}`;
  const priorRun = (await db.getAll([runPath])).get(runPath);
  await writeRunRecord(
    db,
    runPath,
    priorRun,
    {
      runId: args.runId,
      mode: args.mode,
      status: 'running',
      startedAt,
      counts: {},
      warnings: [],
      operator: args.operator,
      toolVersion: args.toolVersion,
    },
    startedAt,
  );

  for (const { input: phase, planned } of plans) {
    const ops = planned.flatMap((item) => (item.op ? [item.op] : []));
    if (!ops.length) continue;
    const failures = await db.apply(ops);
    counts[phase.phase.file] = { ...tally(planned), failed: failures.length };
    if (failures.length) {
      report.failures = failures;
      report.complete = false;
      log(`  ${phase.phase.file}: ${failures.length} writes failed; later phases not written.`);
      break;
    }
  }

  if (report.complete) {
    for (const uid of input.memberUids) {
      await syncClaims(db, deps.auth, uid, { alsoOrgIds: [input.orgId], now: deps.now() });
    }
  }

  const finishedAt = deps.now();
  report.finishedAt = finishedAt.toISOString();
  const present = Object.fromEntries(
    Object.entries(counts).map(([file, count]) => [
      file,
      count.create + count.update + count.unchanged + count.raise + count.keep,
    ]),
  );
  await writeRunRecord(
    db,
    runPath,
    priorRun,
    {
      runId: args.runId,
      mode: args.mode,
      status: report.complete ? 'succeeded' : 'failed',
      startedAt,
      finishedAt,
      counts: present,
      warnings: [
        ...report.failures.map((failure) => ({
          code: 'MIG_E_WRITE_FAILED',
          path: failure.path,
          message: 'not written',
        })),
        ...conflicts.map((conflict) => ({
          code: conflict.code,
          path: conflict.path,
          message: conflictMessage(conflict),
        })),
      ].slice(0, RECORD_WARNINGS_MAX),
      operator: args.operator,
      toolVersion: args.toolVersion,
    },
    finishedAt,
  );
  await writeAudit(db, input.orgId, `migration-${args.runId}-loaded`, {
    action: 'migration.loaded',
    runId: args.runId,
    at: finishedAt,
    summary: `Legacy migration run ${args.runId} loaded`,
    data: { counts: present, conflicts: conflicts.length, failed: report.failures.length, mode: args.mode },
    retentionYears: Number(org['retentionYears'] ?? 7),
  });
  await writeReport(deps.sink, 'load/report.json', report);

  const written = Object.values(counts).reduce((sum, count) => sum + count.create + count.update + count.raise, 0);
  log(
    `${report.complete ? 'Loaded' : 'Stopped'}: ${written} documents written, ${conflicts.length} left alone ` +
      `(see load/report.json), ${report.failures.length} failed.`,
  );
  return report;
}

/** Prod needs `--confirm-prod` and the org's name typed back. */
async function confirmTarget(args: LoadArgs, deps: Pick<LoadDeps, 'ask'>, orgName: string): Promise<void> {
  if (args.env !== 'prod' || args.dryRun) return;
  if (!args.confirmProd) throw new LoadRefusedError('Writing to prod needs --confirm-prod.');
  const typed = await deps.ask(`Type the org's name (${orgName}) to write run ${args.runId} into prod: `);
  if (typed.trim() !== orgName) throw new LoadRefusedError('The name typed is not the org name: nothing written.');
}

async function planAll(db: TargetDb, input: RunInput, now: Date) {
  const plans: { input: PhaseInput; planned: Planned[] }[] = [];
  for (const phaseInput of input.phases) {
    const existing = await readAll(
      db,
      phaseInput.lines.map((line) => line.path),
    );
    plans.push({
      input: phaseInput,
      planned: phaseInput.lines.map((line) => planLine(phaseInput.phase, line, existing.get(line.path), now)),
    });
  }
  return plans;
}

/** Documents by path, read in chunks. */
export async function readAll(db: TargetDb, paths: readonly string[]): Promise<Map<string, Data>> {
  const found = new Map<string, Data>();
  for (let i = 0; i < paths.length; i += READ_CHUNK) {
    for (const [path, data] of await db.getAll(paths.slice(i, i + READ_CHUNK))) found.set(path, data);
  }
  return found;
}

function tally(planned: readonly Planned[]): FileCounts {
  const counts: FileCounts = {
    lines: planned.length,
    create: 0,
    update: 0,
    unchanged: 0,
    user_edited: 0,
    not_migrated: 0,
    raise: 0,
    keep: 0,
    failed: 0,
  };
  for (const item of planned) {
    if (item.decision !== 'clash') counts[item.decision as Exclude<Decision, 'clash'>] += 1;
  }
  return counts;
}

function summary(count: FileCounts): string {
  const parts = Object.entries(count).filter(([key, value]) => key !== 'lines' && value > 0);
  return `${count.lines} lines: ${parts.map(([key, value]) => `${value} ${key.replace('_', ' ')}`).join(', ') || 'nothing to do'}`;
}

function conflictMessage(conflict: Conflict): string {
  return conflict.code === 'MIG_C_USER_EDITED'
    ? 'Changed in v2 after the load, so left as it is.'
    : 'Made in v2, not by the migration, so left as it is.';
}

interface RunRecordFields {
  runId: string;
  mode: Mode;
  status: 'running' | 'succeeded' | 'failed' | 'rolling_back' | 'rolled_back';
  startedAt: Date;
  finishedAt?: Date;
  counts: Record<string, number>;
  warnings: { code: string; path: string; message: string }[];
  operator: string;
  toolVersion: string;
}

/** `orgs/{orgId}/migrations/{runId}` (MigrationRun), checked against its schema. */
export async function writeRunRecord(
  db: TargetDb,
  path: string,
  prior: Data | undefined,
  fields: RunRecordFields,
  now: Date,
): Promise<void> {
  const record = domain.MigrationRun.schema.parse({
    ...fields,
    createdAt: prior?.['createdAt'] ?? now,
    createdBy: 'system',
    updatedAt: now,
    updatedBy: 'system',
    schemaVersion: domain.MigrationRun.version,
  });
  const failures = await db.apply([{ op: 'set', path, data: record }]);
  if (failures.length) throw new Error(`Could not write ${path}: ${failures[0]?.message}`);
}

/** One audit entry for the run (not one per document), as the audit trigger would shape it. */
export async function writeAudit(
  db: TargetDb,
  orgId: string,
  id: string,
  entry: { action: string; runId: string; at: Date; summary: string; data: Data; retentionYears: number },
): Promise<void> {
  const expireAt = new Date(entry.at);
  expireAt.setUTCFullYear(expireAt.getUTCFullYear() + entry.retentionYears);
  const audit = domain.AuditEntry.schema.parse({
    at: entry.at,
    actor: 'system',
    action: entry.action,
    entity: { path: `orgs/${orgId}/migrations/${entry.runId}`, collection: 'migrations', id: entry.runId },
    summary: entry.summary,
    data: entry.data,
    runId: entry.runId,
    source: 'migration',
    expireAt,
    createdAt: entry.at,
    createdBy: 'system',
    updatedAt: entry.at,
    updatedBy: 'system',
    schemaVersion: domain.AuditEntry.version,
  });
  const path = `orgs/${orgId}/audit/${id}`;
  const failures = await db.apply([{ op: 'set', path, data: audit }]);
  if (failures.length) throw new Error(`Could not write ${path}: ${failures[0]?.message}`);
}

export async function writeReport(sink: RunSink, name: string, value: unknown): Promise<void> {
  const file = await sink.create(name, 'application/json');
  await file.write(`${JSON.stringify(value, null, 2)}\n`);
  await file.close();
}
