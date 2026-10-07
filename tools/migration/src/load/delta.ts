import {
  LoadRefusedError,
  runLoad,
  writeAudit,
  writeReport,
  writeRunRecord,
  type LoadArgs,
  type LoadDeps,
  type LoadReport,
} from './load.ts';
import { classify } from './rollback.ts';
import { readRun } from './run-files.ts';
import type { Doc, WriteOp } from './target.ts';
import { editedAfterLoad, provenanceOf, type Data } from './values.ts';

/**
 * `materia-migrate delta` (MIG-06): applies a delta run (exported with `export --since`,
 * transformed with `--base-run`, copied) to the org an earlier run loaded.
 *
 * - **Load:** the delta's records go in under the conflict rule, like any load: changes made in
 *   legacy since reach v2, and anything the user changed in v2 since is left alone and reported.
 * - **Deletions:** the export lists every card and attachment still in legacy (`raw/paths.jsonl`).
 *   A migrated matter whose card is gone, a document whose attachment is gone, or a record of a
 *   changed card the delta no longer has (a removed comment or checklist item) was deleted in
 *   legacy. They are reported in `delta/deletions.json` and deleted from v2 only with
 *   `--apply-deletes`, and never when changed in v2 or holding records made in v2.
 */

export interface DeltaArgs extends Omit<LoadArgs, 'mode'> {
  applyDeletes: boolean;
}

export type DeletionAction = 'reported' | 'deleted' | 'kept_edited' | 'kept_has_v2_records';

export interface Deletion {
  path: string;
  legacyPath: string;
  action: DeletionAction;
}

export interface DeltaReport {
  version: 1;
  runId: string;
  load: LoadReport;
  /** Cards and attachments the export found still in legacy. */
  inLegacy: number;
  deletions: Deletion[];
  failures: { path: string; message: string }[];
}

const CARD = /^workflows\/[^/]+\/cards\/[^/]+$/;
const ATTACHMENT = /^workflows\/[^/]+\/cards\/[^/]+\/attachments\/[^/]+$/;
const depth = (path: string) => path.split('/').length;

export async function runDelta(args: DeltaArgs, deps: LoadDeps): Promise<DeltaReport> {
  const pathsText = await deps.sink.read('raw/paths.jsonl');
  if (pathsText === null) {
    throw new LoadRefusedError(`Run ${args.runId} has no raw/paths.jsonl: a delta needs an export made with --since.`);
  }
  const inLegacy = new Set(
    pathsText
      .split('\n')
      .filter((row) => row.trim())
      .map((row) => String((JSON.parse(row) as { path?: unknown }).path)),
  );

  const load = await runLoad({ ...args, mode: 'delta' }, deps);
  const input = await readRun(deps.sink, args.runId, {
    now: deps.now(),
    skipUnfinishedFiles: args.skipUnfinishedFiles,
  });
  const inDelta = new Set(input.phases.flatMap((item) => item.lines.map((line) => line.path)));
  const changedMatters = new Set(
    (input.phases.find((item) => item.phase.file === 'matters')?.lines ?? []).map((line) => line.path),
  );

  // Roots: matters whose card is gone, documents whose attachment is gone, and records of a
  // changed card that its new transform no longer has.
  const roots: Doc[] = [];
  const matters = (await deps.db.collection(`orgs/${input.orgId}/matters`)).filter((doc) => provenanceOf(doc.data));
  for (const matter of matters) {
    const legacyPath = provenanceOf(matter.data)?.legacyPath ?? '';
    if (CARD.test(legacyPath) && !inLegacy.has(legacyPath)) {
      roots.push(matter);
      continue;
    }
    const records = changedMatters.has(matter.path)
      ? await deps.db.descendants(matter.path)
      : await deps.db.collection(`${matter.path}/documents`);
    for (const doc of records) {
      const loaded = provenanceOf(doc.data);
      if (!loaded) continue;
      // Attachments are exported by their own change time, so only the export's list says one is gone.
      const attachment = ATTACHMENT.test(loaded.legacyPath);
      const attachmentGone = attachment && !inLegacy.has(loaded.legacyPath);
      const dropped =
        !attachment && changedMatters.has(matter.path) && !inDelta.has(doc.path) && loaded.runId !== args.runId;
      if (attachmentGone || dropped) roots.push(doc);
    }
  }

  const deletions: Deletion[] = [];
  const ops: WriteOp[] = [];
  const taken = new Set<string>();
  for (const root of roots.sort((a, b) => (a.path < b.path ? -1 : 1))) {
    if ([...taken].some((path) => root.path.startsWith(`${path}/`))) continue;
    const legacyPath = provenanceOf(root.data)?.legacyPath ?? '';
    const below = await deps.db.descendants(root.path);
    let action: DeletionAction = args.applyDeletes ? 'deleted' : 'reported';
    if ([root, ...below].some((doc) => provenanceOf(doc.data) && editedAfterLoad(doc.data))) action = 'kept_edited';
    else if (below.some((doc) => !provenanceOf(doc.data) && classify(doc, '') === 'foreign')) {
      action = 'kept_has_v2_records';
    }
    deletions.push({ path: root.path, legacyPath, action });
    if (action === 'deleted') {
      taken.add(root.path);
      ops.push(...[root, ...below].map((doc) => ({ op: 'delete' as const, path: doc.path })));
    }
  }

  const failures: { path: string; message: string }[] = [];
  if (!args.dryRun && ops.length && !load.complete) {
    deps.log('The load did not finish, so nothing deleted: run the delta again.');
    for (const item of deletions) if (item.action === 'deleted') item.action = 'reported';
  } else if (!args.dryRun && ops.length) {
    // The run reads `running` while it deletes, so the audit trigger leaves the deletes to its one entry.
    const runPath = `orgs/${input.orgId}/migrations/${args.runId}`;
    const status = async (value: 'running' | 'succeeded' | 'failed') => {
      const run = (await deps.db.getAll([runPath])).get(runPath);
      if (!run) return;
      await writeRunRecord(
        deps.db,
        runPath,
        run,
        {
          runId: args.runId,
          mode: 'delta',
          status: value,
          startedAt: run['startedAt'] as Date,
          ...(run['finishedAt'] ? { finishedAt: run['finishedAt'] as Date } : {}),
          counts: run['counts'] as Record<string, number>,
          warnings: run['warnings'] as { code: string; path: string; message: string }[],
          operator: args.operator,
          toolVersion: args.toolVersion,
        },
        deps.now(),
      );
    };
    await status('running');
    for (const level of [...new Set(ops.map((op) => depth(op.path)))].sort((a, b) => b - a)) {
      failures.push(...(await deps.db.apply(ops.filter((op) => depth(op.path) === level))));
    }
    await status(failures.length ? 'failed' : 'succeeded');
    const org = (await deps.db.getAll([`orgs/${input.orgId}`])).get(`orgs/${input.orgId}`) as Data | undefined;
    await writeAudit(deps.db, input.orgId, `migration-${args.runId}-deletions`, {
      action: 'migration.deleted',
      runId: args.runId,
      at: deps.now(),
      summary: `Records deleted in legacy removed by delta run ${args.runId}`,
      data: { deleted: deletions.filter((item) => item.action === 'deleted').length, failed: failures.length },
      retentionYears: Number(org?.['retentionYears'] ?? 7),
    });
  }

  const report: DeltaReport = { version: 1, runId: args.runId, load, inLegacy: inLegacy.size, deletions, failures };
  if (!args.dryRun) await writeReport(deps.sink, 'delta/deletions.json', report);
  const count = (action: DeletionAction) => deletions.filter((item) => item.action === action).length;
  deps.log(
    `Deleted in legacy: ${deletions.length} records (${count('deleted')} deleted from v2, ${count('reported')} reported ` +
      `for --apply-deletes, ${count('kept_edited') + count('kept_has_v2_records')} kept as changed in v2).`,
  );
  return report;
}
