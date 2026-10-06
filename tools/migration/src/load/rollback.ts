import type * as z from 'zod';

import { domain } from '../domain.ts';
import { syncClaims } from './claims.ts';
import { docPathPattern, PHASES } from './entities.ts';
import { readAll, writeAudit, writeReport, writeRunRecord, type Env, type Mode } from './load.ts';
import { readRun } from './run-files.ts';
import type { AuthPort, Doc, TargetDb, WriteOp } from './target.ts';
import { editedAfterLoad, provenanceOf, type Data } from './values.ts';
import type { RunSink } from '../export/sink.ts';
import { MIGRATION_QUARANTINE } from '../files/copy.ts';
import type { ObjectStore } from '../files/gcs.ts';

/**
 * `materia-migrate rollback` (MIG-06): removes everything one run loaded.
 *
 * - Every document whose `migration.runId` is the run's (a collection-group query per kind), the
 *   matter numbers it reserved, and what v2 hung under them itself (audit entries, activity,
 *   ingestion chunks, note revisions).
 * - Its files: the copies in the files bucket that carry the run's id, its quarantine, and the
 *   profile photo.
 * - The org too, when the run created it (`--keep-org` keeps it).
 *
 * It refuses, deleting nothing, while something it would delete holds a record it didn't load
 * (made in v2 since, or by a later run: roll that back first), and lists them. Documents changed
 * in v2 after the load are deleted with the rest and counted. Prod needs `--confirm-prod` and the
 * org's name typed back. While it runs, the run's record says `rolling_back`, so the audit trigger
 * leaves its deletes out; the record ends `rolled_back` with one audit entry, or goes with the org.
 * Triggers can still be finishing when it ends: a second run sweeps what they left under a deleted org.
 */

export interface RollbackArgs {
  runId: string;
  env: Env;
  dryRun: boolean;
  confirmProd: boolean;
  keepOrg: boolean;
  operator: string;
  toolVersion: string;
}

export interface RollbackDeps {
  sink: RunSink;
  db: TargetDb;
  auth: AuthPort;
  files: { store: ObjectStore; bucket: string };
  now: () => Date;
  log: (line: string) => void;
  ask: (question: string) => Promise<string>;
}

export interface RollbackReport {
  version: 1;
  runId: string;
  env: Env;
  orgId: string;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  /** Documents deleted (or to delete, in a dry run), by collection. */
  deleted: Record<string, number>;
  orgDeleted: boolean;
  /** Of those, documents someone changed in v2 after the load. */
  editedInV2: number;
  filesDeleted: number;
  /** Records the run didn't load, under ones it did: the rollback refuses while there are any. */
  blocked: string[];
  failures: { path: string; message: string }[];
  complete: boolean;
}

export class RollbackRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RollbackRefusedError';
  }
}

/** Every entity's document paths, and whether its documents carry `migration`. */
const KINDS = (Object.values(domain) as unknown[]).flatMap((value) => {
  const entity = value as { schema?: z.ZodObject; path?: unknown; create?: unknown };
  if (!entity?.schema || typeof entity.path !== 'string' || !entity.create || !('shape' in entity.schema)) return [];
  return [{ pattern: docPathPattern(entity.path), migratable: 'migration' in entity.schema.shape }];
});

/**
 * A document the run didn't load: `own` (it did), `system` (an entity v2 writes itself, that
 * never carries `migration`), or `foreign` (a record made in v2 or by another run, or one no entity
 * describes).
 */
export function classify(doc: Doc, runId: string): 'own' | 'system' | 'foreign' {
  if (provenanceOf(doc.data)?.runId === runId) return 'own';
  const kinds = KINDS.filter((candidate) => candidate.pattern.test(doc.path));
  return kinds.length && kinds.every((kind) => !kind.migratable) ? 'system' : 'foreign';
}

const GROUPS = [...new Set(PHASES.flatMap((phase) => (phase.group ? [phase.group] : [])))];
const depth = (path: string) => path.split('/').length;

export async function runRollback(args: RollbackArgs, deps: RollbackDeps): Promise<RollbackReport> {
  const { db, log } = deps;
  const startedAt = deps.now();
  const input = await readRun(deps.sink, args.runId, { now: startedAt, skipUnfinishedFiles: true }).catch(
    (err: unknown) => {
      throw new RollbackRefusedError(err instanceof Error ? err.message : String(err));
    },
  );
  const { orgId } = input;
  const orgPath = `orgs/${orgId}`;
  const org = (await db.getAll([orgPath])).get(orgPath);
  const orgName = String(org?.['name'] ?? input.orgLine?.data['name'] ?? '');
  if (args.env === 'prod' && !args.dryRun) {
    if (!args.confirmProd) throw new RollbackRefusedError('Deleting from prod needs --confirm-prod.');
    const typed = await deps.ask(`Type the org's name (${orgName}) to delete run ${args.runId} from prod: `);
    if (typed.trim() !== orgName)
      throw new RollbackRefusedError('The name typed is not the org name: nothing deleted.');
  }

  // What the run loaded, found by its id rather than by its files.
  const userPaths = new Set(input.memberUids.map((uid) => `users/${uid}`));
  const targets = new Map<string, Data>();
  for (const group of GROUPS) {
    for (const doc of await db.loadedBy(group, args.runId)) {
      if (doc.path === orgPath || doc.path.startsWith(`${orgPath}/`) || userPaths.has(doc.path)) {
        targets.set(doc.path, doc.data);
      }
    }
  }
  // The org goes when the run created it. Once it has gone, a second run sweeps what triggers
  // still finishing wrote under it afterwards (counts, metrics).
  const orgGone = !org && !!input.orgLine && !args.keepOrg;
  const orgDeleted = (!!org && provenanceOf(org)?.runId === args.runId && !args.keepOrg) || orgGone;
  // A kept org stays, with whatever else is in it; only the run's records under it go.
  if (!orgDeleted) targets.delete(orgPath);

  // What lies under them: v2's own records go with them; anything else stops the rollback.
  const extra = new Map<string, Data>();
  const blocked: string[] = [];
  const roots = orgDeleted ? [orgPath] : [...targets.keys()].filter((path) => !userPaths.has(path));
  const seen = new Set<string>();
  for (const root of roots) {
    for (const doc of await db.descendants(root)) {
      if (seen.has(doc.path) || targets.has(doc.path)) continue;
      seen.add(doc.path);
      const kind = classify(doc, args.runId);
      if (kind === 'foreign') blocked.push(doc.path);
      else extra.set(doc.path, doc.data);
    }
  }
  if (!orgDeleted) {
    // The run's matter numbers, which carry no `migration` (the transform's paths name them).
    const matterIds = new Set(
      [...targets.keys()]
        .filter((path) => /^orgs\/[^/]+\/matters\/[^/]+$/.test(path))
        .map((path) => path.split('/')[3]),
    );
    const numbers = input.phases.find((item) => item.phase.file === 'matter-numbers')?.lines ?? [];
    for (const [path, data] of await readAll(
      db,
      numbers.map((line) => line.path),
    )) {
      if (matterIds.has(String(data['matterId']))) extra.set(path, data);
    }
  } else if (org) {
    targets.set(orgPath, org);
  }

  // The person's users/{uid} goes only when no other org is theirs.
  const keptUsers = [...targets.entries()].filter(([path, data]) => {
    if (!userPaths.has(path)) return false;
    const others = ((data['orgIds'] as string[] | undefined) ?? []).filter((id) => id !== orgId);
    return others.length > 0;
  });
  for (const [path] of keptUsers) targets.delete(path);

  const deleted: Record<string, number> = {};
  for (const path of [...targets.keys(), ...extra.keys()]) {
    const collection = path.split('/').at(-2) ?? path;
    deleted[collection] = (deleted[collection] ?? 0) + 1;
  }
  const editedInV2 = [...targets.values()].filter((data) => editedAfterLoad(data)).length;
  const report: RollbackReport = {
    version: 1,
    runId: args.runId,
    env: args.env,
    orgId,
    dryRun: args.dryRun,
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    deleted,
    orgDeleted,
    editedInV2,
    filesDeleted: 0,
    blocked: blocked.sort().slice(0, 200),
    failures: [],
    complete: false,
  };
  log(
    `Run ${args.runId} in ${orgPath} (${args.env}${args.dryRun ? ', dry run' : ''}): ` +
      `${targets.size + extra.size} documents to delete${orgDeleted ? ', the org with them' : ''}, ` +
      `${editedInV2} of them changed in v2 since the load.`,
  );
  if (blocked.length) {
    const message =
      `${blocked.length} records under this run's weren't loaded by it (made in v2 since, or by a later run: ` +
      `roll that back first), for example ${blocked[0]}. Nothing deleted.`;
    if (args.dryRun) log(message);
    else throw new RollbackRefusedError(message);
  }
  const objects = await filesOf(args.runId, orgId, input.memberUids, deps.files);
  report.filesDeleted = objects.length;
  if (args.dryRun) {
    log(`Dry run: nothing deleted (${objects.length} files would go).`);
    return report;
  }

  const runPath = `${orgPath}/migrations/${args.runId}`;
  const run = (await db.getAll([runPath])).get(runPath);
  const record = (status: 'rolling_back' | 'rolled_back', finishedAt?: Date) =>
    writeRunRecord(
      db,
      runPath,
      run,
      {
        runId: args.runId,
        mode: (run?.['mode'] as Mode | undefined) ?? (args.env === 'prod' ? 'cutover' : 'rehearsal'),
        status,
        startedAt: (run?.['startedAt'] as Date | undefined) ?? startedAt,
        ...(finishedAt ? { finishedAt } : {}),
        counts: (run?.['counts'] as Record<string, number> | undefined) ?? {},
        warnings: [],
        operator: args.operator,
        toolVersion: args.toolVersion,
      },
      deps.now(),
    );
  await record('rolling_back');

  // Deepest first, so a trigger on a task still finds its matter where it can.
  const ops: WriteOp[] = [...targets.keys(), ...extra.keys()]
    .filter((path) => path !== runPath)
    .map((path) => ({ op: 'delete' as const, path }));
  const levels = [...new Set(ops.map((op) => depth(op.path)))].sort((a, b) => b - a);
  for (const level of levels) {
    report.failures.push(...(await db.apply(ops.filter((op) => depth(op.path) === level))));
  }
  for (const object of objects) await deps.files.store.remove(deps.files.bucket, object);
  for (const uid of input.memberUids) {
    await syncClaims(db, deps.auth, uid, { alsoOrgIds: [orgId], now: deps.now() });
  }

  const finishedAt = deps.now();
  report.finishedAt = finishedAt.toISOString();
  report.complete = !report.failures.length;
  if (orgDeleted) {
    if (report.complete) report.failures.push(...(await db.apply([{ op: 'delete', path: runPath }])));
  } else {
    await record(report.complete ? 'rolled_back' : 'rolling_back', finishedAt);
    await writeAudit(db, orgId, `migration-${args.runId}-rolled-back`, {
      action: 'migration.rolled_back',
      runId: args.runId,
      at: finishedAt,
      summary: `Legacy migration run ${args.runId} rolled back`,
      data: { deleted, filesDeleted: objects.length, editedInV2, failed: report.failures.length },
      retentionYears: Number(org?.['retentionYears'] ?? 7),
    });
  }
  await writeReport(deps.sink, 'rollback/report.json', report);
  log(
    `${report.complete ? 'Rolled back' : 'Stopped'}: ${ops.length - report.failures.length} documents and ` +
      `${objects.length} files deleted${orgDeleted ? ', the org with them' : ''}; ${report.failures.length} failed.`,
  );
  return report;
}

/** The run's files: copies carrying its id, its quarantine, and the profile photo it copied. */
async function filesOf(
  runId: string,
  orgId: string,
  uids: readonly string[],
  files: RollbackDeps['files'],
): Promise<string[]> {
  const ours = (object: { metadata: Record<string, string> }) => object.metadata['migrationRunId'] === runId;
  const names = [
    ...(await files.store.list(files.bucket, `orgs/${orgId}/`)).filter(ours).map((object) => object.name),
    ...(await files.store.list(files.bucket, `${MIGRATION_QUARANTINE}/${runId}/`)).map((object) => object.name),
  ];
  for (const uid of uids) {
    const avatar = await files.store.stat(files.bucket, `users/${uid}/avatar.png`);
    if (avatar && ours(avatar)) names.push(avatar.name);
  }
  return names;
}
