import { runDelta, type DeltaArgs } from './delta.ts';
import {
  FIXTURE_ATTACHMENT,
  FIXTURE_CARD,
  FIXTURE_ORG,
  FIXTURE_PATHS,
  FIXTURE_UID,
  fixtureRun,
  type FixtureLine,
} from './fixture.ts';
import { LoadRefusedError, runLoad } from './load.ts';
import { memoryAuth, memoryDb } from './testing.ts';
import { memorySink } from '../export/sink.ts';

const NOW = new Date('2026-10-06T10:00:00.000Z');
const P = FIXTURE_PATHS;
const DELTA = 'run-delta-1';
const CARD_FILES = new Set([
  'matters',
  'parties',
  'tasks',
  'notes',
  'documents',
  'files/documents.jsonl',
  'matter-numbers',
]);

/** The base run loaded; then a delta run with the card's records as `edit` leaves them. */
async function setup(
  edit: (file: string, lines: FixtureLine[]) => FixtureLine[],
  inLegacy = [FIXTURE_CARD, FIXTURE_ATTACHMENT],
) {
  const target = memoryDb();
  const { auth } = memoryAuth({ [FIXTURE_UID]: {} });
  let clock = NOW.getTime();
  const deps = (runId: string, files: Map<string, string>) => ({
    sink: memorySink(runId, files),
    db: target.db,
    auth,
    now: () => new Date(clock),
    log: (line: string) => void logs.push(line),
    ask: async () => '',
  });
  const logs: string[] = [];
  const args = {
    env: 'dev' as const,
    dryRun: false,
    confirmProd: false,
    skipUnfinishedFiles: false,
    toolVersion: 'test',
    operator: 'operator@example.com',
  };
  await runLoad({ ...args, runId: 'run-fixture', mode: 'rehearsal' }, deps('run-fixture', fixtureRun()));
  clock += 86_400_000;
  const files = fixtureRun({ runId: DELTA, edit });
  files.set('raw/paths.jsonl', inLegacy.map((path) => `${JSON.stringify({ path, data: null })}\n`).join(''));
  const delta = (overrides: Partial<DeltaArgs> = {}) =>
    runDelta({ ...args, runId: DELTA, applyDeletes: false, ...overrides }, deps(DELTA, files));
  return { target, files, logs, delta };
}

/** The card changed in legacy: a new title, and its comment deleted. Its attachment didn't change. */
const commentDeleted = (file: string, lines: FixtureLine[]) => {
  if (file === 'notes' || file === 'documents' || file === 'files/documents.jsonl') return [];
  if (file !== 'matters') return lines;
  return lines.map((item) => ({ ...item, data: { ...item.data, title: 'Estate of Q. Quill (fictional)' } }));
};

describe('runDelta', () => {
  it('loads what changed and reports what legacy deleted, deleting nothing without --apply-deletes', async () => {
    const s = await setup(commentDeleted);
    const report = await s.delta();
    expect(report.load.complete).toBe(true);
    expect(s.target.get(P.matter)).toMatchObject({ title: 'Estate of Q. Quill (fictional)' });
    expect((s.target.get(P.matter)?.['migration'] as { runId: string }).runId).toBe(DELTA);
    // What the delta found unchanged keeps the run that loaded it.
    expect((s.target.get(P.task)?.['migration'] as { runId: string }).runId).toBe('run-fixture');
    expect(report.deletions).toEqual([
      { path: P.note, legacyPath: `${FIXTURE_CARD}#comment/cm-1`, action: 'reported' },
    ]);
    expect(s.target.get(P.note)).toBeDefined();
    // The attachment is still in legacy, so its document stays though the delta doesn't list it.
    expect(s.target.get(P.document)).toBeDefined();
    expect(JSON.parse(s.files.get('delta/deletions.json') ?? '')).toMatchObject({ runId: DELTA, inLegacy: 2 });
    expect(s.logs.at(-1)).toMatch(/1 records \(0 deleted from v2, 1 reported for --apply-deletes, 0 kept/);
  });

  it('with --apply-deletes deletes them, audited once, with the run marked running meanwhile', async () => {
    const s = await setup(commentDeleted);
    const runPath = `orgs/${FIXTURE_ORG}/migrations/${DELTA}`;
    const during: unknown[] = [];
    const apply = s.target.db.apply;
    s.target.db.apply = async (ops) => {
      if (ops.some((op) => op.op === 'delete')) during.push(s.target.get(runPath)?.['status']);
      return apply(ops);
    };
    const report = await s.delta({ applyDeletes: true });
    expect(report.deletions).toEqual([expect.objectContaining({ path: P.note, action: 'deleted' })]);
    expect(s.target.get(P.note)).toBeUndefined();
    expect(during).toEqual(['running']);
    expect(s.target.get(runPath)).toMatchObject({ status: 'succeeded', mode: 'delta' });
    expect(s.target.get(`orgs/${FIXTURE_ORG}/audit/migration-${DELTA}-deletions`)).toMatchObject({
      action: 'migration.deleted',
      data: { deleted: 1, failed: 0 },
    });
  });

  it('deletes a matter whose card legacy deleted, with everything under it', async () => {
    const s = await setup((file, lines) => (CARD_FILES.has(file) ? [] : lines), [FIXTURE_ATTACHMENT]);
    const report = await s.delta({ applyDeletes: true });
    expect(report.deletions).toEqual([{ path: P.matter, legacyPath: FIXTURE_CARD, action: 'deleted' }]);
    for (const path of [P.matter, P.party, P.task, P.note, P.document])
      expect(s.target.get(path), path).toBeUndefined();
    expect(s.target.get(P.contact)).toBeDefined();
  });

  it('deletes a document whose attachment legacy deleted', async () => {
    const s = await setup((file, lines) => (CARD_FILES.has(file) ? [] : lines), [FIXTURE_CARD]);
    const report = await s.delta({ applyDeletes: true });
    expect(report.deletions).toEqual([{ path: P.document, legacyPath: FIXTURE_ATTACHMENT, action: 'deleted' }]);
    expect(s.target.get(P.document)).toBeUndefined();
    expect(s.target.get(P.matter)).toBeDefined();
  });

  it('never deletes what was changed in v2 since, or what holds records made there', async () => {
    const edited = await setup(commentDeleted);
    const note = edited.target.get(P.note) ?? {};
    edited.target.docs.set(P.note, {
      ...note,
      bodyMd: 'Edited in v2',
      updatedAt: new Date(NOW.getTime() + 1000),
      updatedBy: FIXTURE_UID,
    });
    const kept = await edited.delta({ applyDeletes: true });
    expect(kept.deletions).toEqual([expect.objectContaining({ path: P.note, action: 'kept_edited' })]);
    expect(edited.target.get(P.note)).toBeDefined();

    const holding = await setup((file, lines) => (CARD_FILES.has(file) ? [] : lines), [FIXTURE_ATTACHMENT]);
    holding.target.docs.set(`${P.matter}/notes/n-made-in-v2`, { bodyMd: 'Typed in v2.' });
    const report = await holding.delta({ applyDeletes: true });
    expect(report.deletions).toEqual([expect.objectContaining({ path: P.matter, action: 'kept_has_v2_records' })]);
    expect(holding.target.get(P.matter)).toBeDefined();
  });

  it('a dry run changes nothing', async () => {
    const s = await setup(commentDeleted);
    const before = new Map(s.target.docs);
    const report = await s.delta({ applyDeletes: true, dryRun: true });
    expect(report.deletions).toHaveLength(1);
    expect(s.target.docs).toEqual(before);
    expect(s.files.has('delta/deletions.json')).toBe(false);
  });

  it('deletes nothing when the load did not finish', async () => {
    const s = await setup(commentDeleted);
    s.target.failOn.add(P.matter);
    const report = await s.delta({ applyDeletes: true });
    expect(report.load.complete).toBe(false);
    expect(report.deletions).toEqual([expect.objectContaining({ path: P.note, action: 'reported' })]);
    expect(s.target.get(P.note)).toBeDefined();
    expect(s.logs).toContain('The load did not finish, so nothing deleted: run the delta again.');
  });

  it('refuses a run exported without --since', async () => {
    const s = await setup(commentDeleted);
    s.files.delete('raw/paths.jsonl');
    await expect(s.delta()).rejects.toBeInstanceOf(LoadRefusedError);
  });
});
