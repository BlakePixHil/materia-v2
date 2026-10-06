import { domain } from '../domain.ts';
import type { ExportRecord } from '../export/jsonl.ts';
import { FIXTURE_DIR, FIXTURE_UIDS, loadLegacyFixtures } from '../legacy/fixtures.ts';
import { docId } from '../legacy/snapshot.ts';
import { loadProfile, type MappingProfile } from '../profile.ts';
import { migId, Warnings, type TransformContext, type WarningCode } from './context.ts';
import { mapDashboardItems, personalTaskPath, UNTITLED_TASK } from './dashboard.ts';

const UID = FIXTURE_UIDS.subject;
const AS_OF = new Date('2026-10-06T21:00:00.123Z');
const ITEMS = `profiles/${UID}/dashboard-checklist-items`;

let profile: MappingProfile;
beforeAll(async () => {
  profile = await loadProfile(`${FIXTURE_DIR}mapping-profile.json`);
});

function makeCtx(over: Partial<TransformContext> = {}): TransformContext {
  return {
    runId: 'run1',
    uid: UID,
    orgId: 'org1',
    profile,
    timeZone: 'Australia/Melbourne',
    asOf: AS_OF,
    people: new Map(),
    members: new Set([UID]),
    warnings: new Warnings(),
    ...over,
  };
}

function warned(ctx: TransformContext): Partial<Record<WarningCode, string[]>> {
  return Object.fromEntries(
    Object.entries(ctx.warnings.summary())
      .filter(([, entry]) => entry.count > 0)
      .map(([code, entry]) => [code, entry.paths]),
  );
}

function item(id: string, over: Record<string, unknown> = {}): ExportRecord {
  const path = `${ITEMS}/${id}`;
  return {
    path,
    data: {
      id,
      name: `Task ${id}`,
      checked: false,
      dueDate: null,
      doneOnDate: null,
      priority: 0,
      order: 0,
      createdOn: '2025-01-01T00:00:00.000Z',
      updatedOn: '2025-02-01T00:00:00.000Z',
      ...over,
    },
  } as ExportRecord;
}

const fixtureItems = (): ExportRecord[] =>
  loadLegacyFixtures()
    .docs.filter((doc) => doc.path.startsWith(`${ITEMS}/`))
    .map((doc) => ({ path: doc.path, data: doc.data }) as ExportRecord);

describe('personalTaskPath', () => {
  it("is under the user's membership, with a deterministic id", () => {
    const path = `${ITEMS}/d1`;
    expect(personalTaskPath(makeCtx(), path)).toBe(`orgs/org1/members/${UID}/tasks/${migId(path)}`);
  });
});

describe('mapDashboardItems', () => {
  it("maps the fixtures' dashboard checklist to personal tasks", () => {
    const ctx = makeCtx();
    const [renew, cpd, ...rest] = mapDashboardItems(ctx, fixtureItems());
    expect(rest).toEqual([]);
    const renewPath = `${ITEMS}/d0000000-0000-4000-8000-000000000001`;
    expect(renew?.entity).toBe('personal-tasks');
    expect(renew?.legacyPath).toBe(renewPath);
    expect(renew?.path).toBe(`orgs/org1/members/${UID}/tasks/${migId(renewPath)}`);
    expect(renew?.data).toEqual({
      orgId: 'org1',
      matterId: null,
      title: 'Renew practising certificate',
      status: 'todo',
      priority: 'medium',
      assigneeUid: UID,
      // Melbourne midnight stored as UTC.
      dueDate: '2025-06-30',
      checklist: [],
      order: 1000,
      source: 'migration',
      search: [],
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      createdBy: UID,
      updatedAt: new Date('2025-01-01T00:00:00.000Z'),
      updatedBy: UID,
      schemaVersion: 1,
      migration: { runId: 'run1', legacyPath: renewPath, loadedAt: AS_OF },
    });
    expect(cpd?.data).toMatchObject({
      title: 'CPD points',
      status: 'done',
      priority: 'none',
      order: 2000,
      completedAt: new Date('2025-02-01T00:00:00.000Z'),
    });
    expect(cpd?.data).not.toHaveProperty('dueDate');
    for (const task of [renew, cpd]) expect(domain.PersonalTaskSchema.parse(task?.data)).toEqual(task?.data);
    expect(warned(ctx)).toEqual({});
  });

  it("keeps the dashboard's order, then the path, with unordered items last", () => {
    const tasks = mapDashboardItems(makeCtx(), [
      item('e', { order: 'first' }),
      item('d', { order: 2 }),
      item('c', { order: 0 }),
      item('b', { order: 2 }),
      item('a', { order: undefined }),
      item('f', { order: Number.NaN }),
      item('g', { order: -1 }),
    ]);
    expect(tasks.map((task) => [docId(task.legacyPath), task.data?.['order']])).toEqual([
      ['g', 1000],
      ['c', 2000],
      ['b', 3000],
      ['d', 4000],
      ['a', 5000],
      ['e', 6000],
      ['f', 7000],
    ]);
  });

  it.each([
    [0, 'none'],
    [1, 'high'],
    [2, 'medium'],
    [3, 'low'],
    [null, 'none'],
  ])('maps priority %j to %s', (priority, expected) => {
    expect(mapDashboardItems(makeCtx(), [item('a', { priority })])[0]?.data?.['priority']).toBe(expected);
  });

  it('reads a priority outside 0 to 3 as none, with a warning', () => {
    const ctx = makeCtx();
    expect(mapDashboardItems(ctx, [item('a', { priority: 4 })])[0]?.data?.['priority']).toBe('none');
    expect(warned(ctx)).toEqual({ MIG_W_PRIORITY_UNKNOWN: [`${ITEMS}/a`] });
  });

  it('reads the due date as the Melbourne day, and drops an invalid one with a warning', () => {
    const ctx = makeCtx();
    const tasks = mapDashboardItems(ctx, [
      item('a', { order: 1, dueDate: '2025-03-13T13:00:00.000Z' }),
      item('b', { order: 2, dueDate: '2025-06-01T00:00:00.000Z' }),
      item('c', { order: 3, dueDate: 'tomorrow' }),
      item('d', { order: 4, dueDate: '' }),
    ]);
    expect(tasks.map((task) => task.data?.['dueDate'])).toEqual(['2025-03-14', '2025-06-01', undefined, undefined]);
    expect(warned(ctx)).toEqual({ MIG_W_DATE_INVALID: [`${ITEMS}/c`] });
  });

  it('completes a done item at its doneOnDate, else at its last update', () => {
    const ctx = makeCtx();
    const tasks = mapDashboardItems(ctx, [
      item('a', { order: 1, checked: true, doneOnDate: '2025-01-15T00:00:00.000Z' }),
      item('b', { order: 2, checked: true, doneOnDate: null }),
      item('c', { order: 3, checked: true, doneOnDate: 'yesterday' }),
      item('d', { order: 4, checked: false, doneOnDate: '2025-01-15T00:00:00.000Z' }),
    ]);
    expect(tasks.map((task) => [task.data?.['status'], task.data?.['completedAt']])).toEqual([
      ['done', new Date('2025-01-15T00:00:00.000Z')],
      ['done', new Date('2025-02-01T00:00:00.000Z')],
      ['done', new Date('2025-02-01T00:00:00.000Z')],
      ['todo', undefined],
    ]);
    expect(warned(ctx)).toEqual({ MIG_W_DATE_INVALID: [`${ITEMS}/c`] });
    for (const task of tasks) expect(() => domain.PersonalTaskSchema.parse(task.data)).not.toThrow();
  });

  it('titles an item with no name as untitled, with a warning', () => {
    const ctx = makeCtx();
    const [task] = mapDashboardItems(ctx, [item('a', { name: '  ' })]);
    expect(task?.data?.['title']).toBe(UNTITLED_TASK);
    expect(UNTITLED_TASK).toBe('Untitled task (imported)');
    expect(warned(ctx)).toEqual({ MIG_W_UNTITLED: [`${ITEMS}/a`] });
  });

  it('cuts a title longer than v2 allows', () => {
    const ctx = makeCtx();
    const [task] = mapDashboardItems(ctx, [item('a', { name: 'x'.repeat(domain.TASK_TITLE_MAX + 1) })]);
    expect(task?.data?.['title']).toHaveLength(domain.TASK_TITLE_MAX);
    expect(warned(ctx)).toEqual({ MIG_W_TEXT_TRUNCATED: [`${ITEMS}/a`] });
  });

  it('dates an item with no readable dates at the export time, with a warning', () => {
    const ctx = makeCtx();
    const [task] = mapDashboardItems(ctx, [item('a', { createdOn: undefined, updatedOn: undefined })]);
    expect(task?.data).toMatchObject({ createdAt: AS_OF, updatedAt: AS_OF });
    expect(warned(ctx)).toEqual({ MIG_W_DATE_INVALID: [`${ITEMS}/a`] });
  });

  it('skips items whose document is gone', () => {
    const tasks = mapDashboardItems(makeCtx(), [{ path: `${ITEMS}/gone`, data: null } as ExportRecord, item('a')]);
    expect(tasks.map((task) => task.legacyPath)).toEqual([`${ITEMS}/a`]);
    expect(tasks[0]?.data?.['order']).toBe(1000);
  });

  it('maps nothing for no items', () => {
    expect(mapDashboardItems(makeCtx(), [])).toEqual([]);
  });
});
