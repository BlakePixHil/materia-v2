import { domain } from '../domain.ts';
import { FIXTURE_DIR, FIXTURE_UIDS } from '../legacy/fixtures.ts';
import { loadProfile, type MappingProfile } from '../profile.ts';
import { legacyCalendar, mapChecklists } from './checklists.ts';
import type { MatterRef } from './comments.ts';
import { migId, Warnings, type TransformContext, type WarningCode } from './context.ts';

const { TASK_GROUP_MAX, TASK_TITLE_MAX } = domain;
const UID = FIXTURE_UIDS.subject;
const COLLEAGUE = FIXTURE_UIDS.colleague;
const CARD = 'workflows/0b6f1c2e-5d4a-4c3b-9a8e-111111111111/cards/WillsCardAuto0000001';
const AS_OF = new Date('2026-10-06T21:00:00.123Z');
const CREATED = new Date('2025-01-10T00:30:00.000Z');
const UPDATED = new Date('2025-02-10T00:30:00.000Z');

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
    people: new Map([[COLLEAGUE, 'Jordan Ellis']]),
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

const matter: MatterRef = {
  orgId: 'org1',
  matterId: migId(CARD),
  cardPath: CARD,
  createdAt: CREATED,
  updatedAt: UPDATED,
};

/** The fixture card's intake checklist (WillsCardAuto0000001). */
const intake = {
  id: 'c1000000-0000-4000-8000-000000000001',
  title: 'Intake',
  templateExists: true,
  items: [
    {
      id: 'c7ec0000-0000-4000-8000-000000000001',
      name: 'Send engagement letter',
      checked: true,
      dueDate: '2025-03-13T13:00:00.000Z',
      doneOnDate: '2025-03-12T03:00:00.000Z',
      priority: 1,
      calendarSyncByUser: {
        [UID]: {
          isLinkedToCalendar: true,
          calendarProvider: 'google',
          calendarEventId: 'evt-1',
          lastSyncDate: '2025-03-01T00:00:00.000Z',
        },
      },
    },
    {
      id: 'c7ec0000-0000-4000-8000-000000000002',
      name: 'Run conflict check',
      checked: false,
      dueDate: '2025-06-01T00:00:00.000Z',
      doneOnDate: null,
      priority: 0,
    },
    {
      id: 'c7ec0000-0000-4000-8000-000000000003',
      name: 'Book signing',
      checked: false,
      dueDate: null,
      doneOnDate: null,
      priority: 0,
      calendarSync: { isLinkedToCalendar: false, calendarProvider: null },
    },
  ],
};
const itemPath = (list: string, item: string) => `${CARD}#checklist/${list}/item/${item}`;

describe('mapChecklists', () => {
  it("maps a card's checklist items to matter tasks grouped by the checklist's title", () => {
    const ctx = makeCtx();
    const tasks = mapChecklists(ctx, matter, [intake]);
    expect(tasks).toHaveLength(3);
    const [first, second, third] = tasks;
    const firstPath = itemPath(intake.id, 'c7ec0000-0000-4000-8000-000000000001');
    expect(first?.entity).toBe('tasks');
    expect(first?.legacyPath).toBe(firstPath);
    expect(first?.path).toBe(`orgs/org1/matters/${matter.matterId}/tasks/${migId(firstPath)}`);
    expect(first?.data).toEqual({
      orgId: 'org1',
      matterId: matter.matterId,
      title: 'Send engagement letter',
      status: 'done',
      priority: 'high',
      assigneeUid: UID,
      // Melbourne midnight stored as UTC is the next day in Melbourne.
      dueDate: '2025-03-14',
      group: 'Intake',
      checklist: [],
      order: 1000,
      source: 'migration',
      completedAt: new Date('2025-03-12T03:00:00.000Z'),
      search: [],
      countedOpen: false,
      legacyCalendar: [{ provider: 'google', eventId: 'evt-1' }],
      createdAt: CREATED,
      createdBy: UID,
      updatedAt: UPDATED,
      updatedBy: UID,
      schemaVersion: 1,
      migration: { runId: 'run1', legacyPath: firstPath, loadedAt: AS_OF },
    });
    expect(second?.data).toMatchObject({
      title: 'Run conflict check',
      status: 'todo',
      priority: 'none',
      // UTC midnight is 10 am the same day in Melbourne.
      dueDate: '2025-06-01',
      order: 2000,
    });
    expect(second?.data).not.toHaveProperty('completedAt');
    expect(second?.data).not.toHaveProperty('legacyCalendar');
    expect(third?.data).toMatchObject({ title: 'Book signing', status: 'todo', order: 3000 });
    expect(third?.data).not.toHaveProperty('dueDate');
    // The unlinked single calendarSync isn't an event.
    expect(third?.data).not.toHaveProperty('legacyCalendar');
    for (const task of tasks) {
      expect(task.data).not.toHaveProperty('templateExists');
      expect(domain.TaskSchema.parse(task.data)).toEqual(task.data);
    }
    expect(warned(ctx)).toEqual({ MIG_W_CALENDAR_EVENTS_EXIST: [firstPath] });
  });

  it('spaces orders 1000 apart within a list and a million apart between lists', () => {
    const lists = [
      {
        id: 'l1',
        title: 'One',
        items: [
          { id: 'a', name: 'A' },
          { id: 'b', name: 'B' },
        ],
      },
      { id: 'l2', title: 'Two', items: [{ id: 'c', name: 'C' }] },
      {
        id: 'l3',
        title: 'Three',
        items: [
          { id: 'd', name: 'D' },
          { id: 'e', name: 'E' },
        ],
      },
    ];
    const tasks = mapChecklists(makeCtx(), matter, lists);
    expect(tasks.map((task) => [task.data?.['group'], task.data?.['title'], task.data?.['order']])).toEqual([
      ['One', 'A', 1000],
      ['One', 'B', 2000],
      ['Two', 'C', 1_001_000],
      ['Three', 'D', 2_001_000],
      ['Three', 'E', 2_002_000],
    ]);
  });

  it("completes a done item without a doneOnDate at the card's last update", () => {
    const ctx = makeCtx();
    const [task] = mapChecklists(ctx, matter, [{ id: 'l1', items: [{ id: 'a', name: 'Done', checked: true }] }]);
    expect(task?.data).toMatchObject({ status: 'done', completedAt: UPDATED });
    expect(warned(ctx)).toEqual({});
  });

  it("completes a done item with an invalid doneOnDate at the card's last update, with a warning", () => {
    const ctx = makeCtx();
    const [task] = mapChecklists(ctx, matter, [
      { id: 'l1', items: [{ id: 'a', name: 'Done', checked: true, doneOnDate: 'last week' }] },
    ]);
    expect(task?.data).toMatchObject({ status: 'done', completedAt: UPDATED });
    expect(warned(ctx)).toEqual({ MIG_W_DATE_INVALID: [itemPath('l1', 'a')] });
  });

  it('ignores a doneOnDate on an item that is not checked', () => {
    const [task] = mapChecklists(makeCtx(), matter, [
      { id: 'l1', items: [{ id: 'a', name: 'Open', checked: 'true', doneOnDate: '2025-03-12T03:00:00.000Z' }] },
    ]);
    expect(task?.data?.['status']).toBe('todo');
    expect(task?.data).not.toHaveProperty('completedAt');
  });

  it('keeps a due date that is already a day, and drops an invalid one with a warning', () => {
    const ctx = makeCtx();
    const tasks = mapChecklists(ctx, matter, [
      {
        id: 'l1',
        items: [
          { id: 'a', name: 'A', dueDate: '2025-03-14' },
          { id: 'b', name: 'B', dueDate: '2025-02-30T13:00:00.000Z' },
          { id: 'c', name: 'C', dueDate: '' },
        ],
      },
    ]);
    expect(tasks.map((task) => task.data?.['dueDate'])).toEqual(['2025-03-14', undefined, undefined]);
    expect(warned(ctx)).toEqual({ MIG_W_DATE_INVALID: [itemPath('l1', 'b')] });
  });

  it('maps checklist priorities 0 and 1, and warns on one outside 0 to 3', () => {
    const ctx = makeCtx();
    const tasks = mapChecklists(ctx, matter, [
      {
        id: 'l1',
        items: [
          { id: 'a', name: 'A', priority: 0 },
          { id: 'b', name: 'B', priority: 1 },
          { id: 'c', name: 'C' },
          { id: 'd', name: 'D', priority: 7 },
        ],
      },
    ]);
    expect(tasks.map((task) => task.data?.['priority'])).toEqual(['none', 'high', 'none', 'none']);
    expect(warned(ctx)).toEqual({ MIG_W_PRIORITY_UNKNOWN: [itemPath('l1', 'd')] });
  });

  it('drops templateExists from the checklist', () => {
    const [task] = mapChecklists(makeCtx(), matter, [
      { id: 'l1', title: 'Intake', templateExists: true, items: [{ id: 'a', name: 'A', templateExists: false }] },
    ]);
    expect(JSON.stringify(task?.data)).not.toContain('templateExists');
    expect(() => domain.TaskSchema.parse(task?.data)).not.toThrow();
  });

  it('titles an item with no name "Untitled task (imported)", with a warning', () => {
    const ctx = makeCtx();
    const tasks = mapChecklists(ctx, matter, [
      {
        id: 'l1',
        items: [
          { id: 'a', name: '' },
          { id: 'b', name: '   ' },
          { id: 'c', name: null },
        ],
      },
    ]);
    expect(tasks.map((task) => task.data?.['title'])).toEqual([
      'Untitled task (imported)',
      'Untitled task (imported)',
      'Untitled task (imported)',
    ]);
    expect(warned(ctx)).toEqual({
      MIG_W_UNTITLED: [itemPath('l1', 'a'), itemPath('l1', 'b'), itemPath('l1', 'c')],
    });
  });

  it('tidies the spacing of titles and groups', () => {
    const [task] = mapChecklists(makeCtx(), matter, [
      { id: 'l1', title: '  Pre   signing ', items: [{ id: 'a', name: ' Book \n room ' }] },
    ]);
    expect(task?.data).toMatchObject({ title: 'Book room', group: 'Pre signing' });
  });

  it('leaves out the group of a checklist with no title', () => {
    const [task] = mapChecklists(makeCtx(), matter, [{ id: 'l1', title: '', items: [{ id: 'a', name: 'A' }] }]);
    expect(task?.data).not.toHaveProperty('group');
  });

  it('cuts titles and groups longer than v2 allows', () => {
    const ctx = makeCtx();
    const [task] = mapChecklists(ctx, matter, [
      { id: 'l1', title: 'G'.repeat(TASK_GROUP_MAX + 5), items: [{ id: 'a', name: 'T'.repeat(TASK_TITLE_MAX + 5) }] },
    ]);
    expect(task?.data?.['title']).toBe('T'.repeat(TASK_TITLE_MAX));
    expect(task?.data?.['group']).toBe('G'.repeat(TASK_GROUP_MAX));
    expect(warned(ctx)).toEqual({ MIG_W_TEXT_TRUNCATED: [itemPath('l1', 'a')] });
    expect(() => domain.TaskSchema.parse(task?.data)).not.toThrow();
  });

  it("is never counted open yet: tasks-onWrite counts it into the matter's openTaskCount", () => {
    const tasks = mapChecklists(makeCtx(), matter, [intake]);
    expect(tasks.map((task) => task.data?.['countedOpen'])).toEqual([false, false, false]);
  });

  it("keys lists and items without ids by their index, and skips entries that aren't objects", () => {
    const tasks = mapChecklists(makeCtx(), matter, [
      null,
      { title: 'Second', items: [null, { name: 'A' }, { id: '', name: 'B' }] },
      { id: 'l3', items: 'none' },
    ]);
    expect(tasks.map((task) => task.legacyPath)).toEqual([`${CARD}#checklist/1/item/1`, `${CARD}#checklist/1/item/2`]);
    expect(tasks.map((task) => task.data?.['order'])).toEqual([1_002_000, 1_003_000]);
  });

  it.each([undefined, null, {}, 'checklists'])('makes no tasks of checklists that are not a list (%j)', (lists) => {
    expect(mapChecklists(makeCtx(), matter, lists)).toEqual([]);
  });

  it('assigns every task to the user, with the card dates', () => {
    const [task] = mapChecklists(makeCtx(), matter, [{ id: 'l1', items: [{ id: 'a', name: 'A' }] }]);
    expect(task?.data).toMatchObject({
      assigneeUid: UID,
      createdAt: CREATED,
      updatedAt: UPDATED,
      createdBy: UID,
      updatedBy: UID,
    });
  });
});

describe('legacyCalendar', () => {
  const linked = (provider: unknown, eventId?: unknown) => ({
    isLinkedToCalendar: true,
    calendarProvider: provider,
    ...(eventId === undefined ? {} : { calendarEventId: eventId }),
  });

  it("keeps only the user's own calendarSyncByUser entry", () => {
    const item = {
      calendarSyncByUser: { [UID]: linked('google', 'evt-own'), [COLLEAGUE]: linked('microsoft', 'evt-theirs') },
    };
    expect(legacyCalendar(item, UID)).toEqual([{ provider: 'google', eventId: 'evt-own' }]);
    expect(legacyCalendar(item, 'SomeoneElseLegacyUid00000009')).toEqual([]);
  });

  it('reads the older single calendarSync', () => {
    expect(legacyCalendar({ calendarSync: linked('microsoft', 'evt-2') }, UID)).toEqual([
      { provider: 'microsoft', eventId: 'evt-2' },
    ]);
  });

  it('keeps both, the per-user entry first', () => {
    expect(
      legacyCalendar(
        { calendarSyncByUser: { [UID]: linked('google', 'a') }, calendarSync: linked('google', 'b') },
        UID,
      ),
    ).toEqual([
      { provider: 'google', eventId: 'a' },
      { provider: 'google', eventId: 'b' },
    ]);
  });

  it('keeps only linked events', () => {
    expect(
      legacyCalendar(
        {
          calendarSyncByUser: { [UID]: { isLinkedToCalendar: false, calendarProvider: 'google' } },
          calendarSync: { isLinkedToCalendar: 'true', calendarProvider: 'google' },
        },
        UID,
      ),
    ).toEqual([]);
  });

  it('reads a missing provider as unknown and leaves out a missing event id', () => {
    expect(legacyCalendar({ calendarSync: linked(null) }, UID)).toEqual([{ provider: 'unknown' }]);
    expect(legacyCalendar({ calendarSync: linked('  ', '  ') }, UID)).toEqual([{ provider: 'unknown' }]);
    expect(legacyCalendar({ calendarSync: linked(' google ', ' evt ') }, UID)).toEqual([
      { provider: 'google', eventId: 'evt' },
    ]);
  });

  it('cuts the provider and event id to what v2 holds', () => {
    const [event] = legacyCalendar({ calendarSync: linked('p'.repeat(50), 'e'.repeat(1100)) }, UID);
    expect(event).toEqual({ provider: 'p'.repeat(40), eventId: 'e'.repeat(1024) });
    expect(domain.LegacyCalendarEventSchema.parse(event)).toEqual(event);
  });

  it('ignores entries that are not objects', () => {
    expect(legacyCalendar({ calendarSyncByUser: { [UID]: 'linked' }, calendarSync: ['linked'] }, UID)).toEqual([]);
    expect(legacyCalendar({ calendarSyncByUser: 'linked' }, UID)).toEqual([]);
    expect(legacyCalendar({}, UID)).toEqual([]);
  });
});
