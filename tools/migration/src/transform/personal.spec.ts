import { domain } from '../domain.ts';
import type { ExportRecord } from '../export/jsonl.ts';
import { FIXTURE_DIR, FIXTURE_UIDS, loadLegacyFixtures } from '../legacy/fixtures.ts';
import { docId } from '../legacy/snapshot.ts';
import { loadProfile, type MappingProfile } from '../profile.ts';
import { migId, Warnings, type TransformContext, type WarningCode } from './context.ts';
import { mapPersonalCards } from './personal.ts';
import { mapWorkflow, type WorkflowPlan } from './workflow.ts';

const { TASK_CHECKLIST_MAX, TASK_GROUP_MAX } = domain;
const UID = FIXTURE_UIDS.subject;
const COLLEAGUE = FIXTURE_UIDS.colleague;
const DEPARTED = FIXTURE_UIDS.departed;
const BD = '0b6f1c2e-5d4a-4c3b-9a8e-333333333333';
const EVENTS = '5a1e0000-0000-4000-8000-000000000008';
const ARTICLES = '5a1e0000-0000-4000-8000-000000000009';
const DONE = '5a1e0000-0000-4000-8000-0000000000dd';
const AS_OF = new Date('2026-10-06T21:00:00.123Z');
const CREATED = new Date('2025-01-10T00:30:00.000Z');
const UPDATED = new Date('2025-02-10T00:30:00.000Z');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const { docs } = loadLegacyFixtures();

let profile: MappingProfile;
let plan: WorkflowPlan;
beforeAll(async () => {
  profile = await loadProfile(`${FIXTURE_DIR}mapping-profile.json`);
  const path = `workflows/${BD}`;
  const data = docs.find((doc) => doc.path === path)?.data ?? null;
  const fixturePlan = mapWorkflow(makeCtx(), { path, data });
  if (!fixturePlan) throw new Error('No plan for the Business development board');
  // The fixture board has no done column; this one adds it last.
  plan = { ...fixturePlan, lanes: new Map([...fixturePlan.lanes, [DONE, { title: 'Done', done: true }]]) };
});

function makeCtx(over: Partial<TransformContext> = {}): TransformContext {
  return {
    runId: 'run1',
    uid: UID,
    orgId: 'org1',
    profile,
    timeZone: 'Australia/Melbourne',
    asOf: AS_OF,
    people: new Map<string, string | null>([
      [COLLEAGUE, 'Jordan Ellis'],
      [DEPARTED, null],
    ]),
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

const cardPath = (id: string) => `workflows/${BD}/cards/${id}`;

function card(id: string, over: Record<string, unknown> = {}): ExportRecord {
  return {
    path: cardPath(id),
    data: {
      id,
      swimlaneId: EVENTS,
      workflowId: BD,
      order: 0,
      title: `Card ${id}`,
      description: '',
      priority: 0,
      assignee: UID,
      referrerId: '',
      dueDate: '',
      checklists: [],
      labelIds: [],
      linkedCardIds: [],
      history: [],
      comments: [],
      fee: null,
      matterReference: null,
      billable: null,
      archived: false,
      createdOn: '2025-01-10T00:30:00.000Z',
      updatedOn: '2025-02-10T00:30:00.000Z',
      ...over,
    },
  };
}

const map = (ctx: TransformContext, cards: ExportRecord[], attachments = new Map<string, ExportRecord[]>()) =>
  mapPersonalCards(ctx, plan, cards, attachments, 'Alex Rivers');

describe('mapPersonalCards', () => {
  it("maps the fixture board's cards to the user's personal tasks, grouped by column", () => {
    const ctx = makeCtx();
    const cards = docs
      .filter((doc) => doc.path.startsWith(`workflows/${BD}/cards/`))
      .map((doc) => ({ path: doc.path, data: doc.data }));
    const [seminar, article, ...rest] = map(ctx, cards);
    expect(rest).toEqual([]);
    const seminarPath = cardPath('BdCardAuto0000000001');
    expect(seminar?.entity).toBe('personal-tasks');
    expect(seminar?.legacyPath).toBe(seminarPath);
    expect(seminar?.path).toBe(`orgs/org1/members/${UID}/tasks/${migId(seminarPath)}`);
    expect(seminar?.data).toEqual({
      orgId: 'org1',
      matterId: null,
      title: 'Seminar at the fictional bowls club',
      status: 'todo',
      priority: 'none',
      assigneeUid: UID,
      group: 'Events',
      checklist: [],
      order: 1000,
      source: 'migration',
      search: [],
      createdAt: CREATED,
      createdBy: UID,
      updatedAt: UPDATED,
      updatedBy: UID,
      schemaVersion: 1,
      migration: { runId: 'run1', legacyPath: seminarPath, loadedAt: AS_OF },
    });
    expect(article?.data).toMatchObject({ title: 'Article on EPOAs', group: 'Articles', order: 2000 });
    for (const task of [seminar, article]) expect(domain.PersonalTaskSchema.parse(task?.data)).toEqual(task?.data);
    expect(warned(ctx)).toEqual({});
  });

  it('sorts by column, then legacy order, then path, with unknown columns last', () => {
    const ctx = makeCtx();
    const tasks = map(ctx, [
      card('Lost', { swimlaneId: 'gone-lane', order: 0 }),
      card('ArticleB', { swimlaneId: ARTICLES, order: 1 }),
      card('EventZ', { swimlaneId: EVENTS, order: 5 }),
      card('ArticleA', { swimlaneId: ARTICLES, order: 1 }),
      card('EventY', { swimlaneId: EVENTS, order: 2 }),
      card('EventX', { swimlaneId: EVENTS, order: null }),
      card('Finished', { swimlaneId: DONE, order: 0 }),
    ]);
    expect(tasks.map((task) => [docId(task.legacyPath), task.data?.['group'], task.data?.['order']])).toEqual([
      ['EventY', 'Events', 1000],
      ['EventZ', 'Events', 2000],
      ['EventX', 'Events', 3000],
      ['ArticleA', 'Articles', 4000],
      ['ArticleB', 'Articles', 5000],
      ['Finished', 'Done', 6000],
      ['Lost', undefined, 7000],
    ]);
    expect(warned(ctx)).toEqual({ MIG_W_SWIMLANE_UNKNOWN: [cardPath('Lost')] });
  });

  it('reads a card with no column as in an unknown one', () => {
    const ctx = makeCtx();
    const tasks = map(ctx, [card('NoLane', { swimlaneId: null }), card('A', { swimlaneId: ARTICLES })]);
    expect(tasks.map((task) => [docId(task.legacyPath), task.data?.['group']])).toEqual([
      ['A', 'Articles'],
      ['NoLane', undefined],
    ]);
    expect(warned(ctx)).toEqual({ MIG_W_SWIMLANE_UNKNOWN: [cardPath('NoLane')] });
  });

  it('skips cards whose document is gone', () => {
    const tasks = map(makeCtx(), [{ path: cardPath('Gone'), data: null }, card('A')]);
    expect(tasks.map((task) => task.legacyPath)).toEqual([cardPath('A')]);
  });

  it('is done in the done column or when archived, completed at its last update', () => {
    const tasks = map(makeCtx(), [
      card('A', { swimlaneId: DONE }),
      card('B', { archived: true }),
      card('C', { archived: 'yes' }),
    ]);
    // Sorted: Events (B, C), then Done (A).
    expect(tasks.map((task) => [docId(task.legacyPath), task.data?.['status'], task.data?.['completedAt']])).toEqual([
      ['B', 'done', UPDATED],
      ['C', 'todo', undefined],
      ['A', 'done', UPDATED],
    ]);
  });

  it('titles a card with no title as untitled, with a warning', () => {
    const ctx = makeCtx();
    const [task] = map(ctx, [card('A', { title: '  ' })]);
    expect(task?.data?.['title']).toBe('Untitled task (imported)');
    expect(warned(ctx)).toEqual({ MIG_W_UNTITLED: [cardPath('A')] });
  });

  it('cuts a column title longer than a group allows', () => {
    const ctx = makeCtx();
    const long: WorkflowPlan = {
      ...plan,
      lanes: new Map([[EVENTS, { title: 'L'.repeat(TASK_GROUP_MAX + 3), done: false }]]),
    };
    const [task] = mapPersonalCards(ctx, long, [card('A')], new Map(), 'Alex Rivers');
    expect(task?.data?.['group']).toBe('L'.repeat(TASK_GROUP_MAX));
    expect(warned(ctx)).toEqual({ MIG_W_TEXT_TRUNCATED: [cardPath('A')] });
  });

  it('leaves out the group of a column with no title', () => {
    const untitled: WorkflowPlan = { ...plan, lanes: new Map([[EVENTS, { title: '', done: false }]]) };
    const [task] = mapPersonalCards(makeCtx(), untitled, [card('A')], new Map(), 'Alex Rivers');
    expect(task?.data).not.toHaveProperty('group');
  });

  it('maps priority and the due date (as the Melbourne day)', () => {
    const ctx = makeCtx();
    const [task] = map(ctx, [card('A', { priority: 3, dueDate: '2025-05-01T14:00:00.000Z' })]);
    expect(task?.data).toMatchObject({ priority: 'low', dueDate: '2025-05-02' });
    const [invalid] = map(ctx, [card('B', { dueDate: '2025-13-01T00:00:00.000Z' })]);
    expect(invalid?.data).not.toHaveProperty('dueDate');
    expect(warned(ctx)).toEqual({ MIG_W_DATE_INVALID: [cardPath('B')] });
  });

  describe('description', () => {
    it('keeps the description, then the comments, each headed by author and day', () => {
      const ctx = makeCtx();
      const [task] = map(ctx, [
        card('A', {
          description: '<p>Book the <strong>hall</strong>.</p>',
          comments: [
            { id: 'c1', uid: UID, comment: '<p>Called the club.</p>', date: '2025-01-11T14:30:00.000Z' },
            { id: 'c2', uid: COLLEAGUE, comment: 'Can help on the day', date: '2025-01-12T05:00:00.000Z' },
            { id: 'c3', uid: DEPARTED, comment: '<p>Old note</p>', date: '2025-01-13T05:00:00.000Z' },
            { id: 'c4', uid: COLLEAGUE, comment: '<p><br></p>', date: '2025-01-14T05:00:00.000Z' },
            'not a comment',
          ],
        }),
      ]);
      expect(task?.data?.['descriptionMd']).toBe(
        [
          'Book the **hall**.',
          '**Comments (imported)**',
          // 14:30 UTC on the 11th is the 12th in Melbourne.
          '**Alex Rivers, 2025-01-12**',
          'Called the club.',
          '**Jordan Ellis, 2025-01-12**',
          'Can help on the day',
          '**A former colleague, 2025-01-13**',
          'Old note',
        ].join('\n\n'),
      );
      expect(domain.PersonalTaskSchema.parse(task?.data)).toEqual(task?.data);
      expect(warned(ctx)).toEqual({});
    });

    it('names a comment with no author "A former colleague"', () => {
      const [task] = map(makeCtx(), [card('A', { comments: [{ comment: 'Anon', date: '2025-01-11T00:00:00Z' }] })]);
      expect(task?.data?.['descriptionMd']).toBe(
        '**Comments (imported)**\n\n**A former colleague, 2025-01-11**\n\nAnon',
      );
    });

    it('has only the comments when there is no description', () => {
      const [task] = map(makeCtx(), [
        card('A', { comments: [{ uid: UID, comment: 'Done', date: '2025-01-11T00:00:00Z' }] }),
      ]);
      expect(task?.data?.['descriptionMd']).toBe('**Comments (imported)**\n\n**Alex Rivers, 2025-01-11**\n\nDone');
    });

    it('has no description when there is neither', () => {
      const [task] = map(makeCtx(), [card('A', { description: '<p><br></p>', comments: [] })]);
      expect(task?.data).not.toHaveProperty('descriptionMd');
    });

    it("dates a comment with an invalid date at the export time's day, with a warning", () => {
      const ctx = makeCtx();
      const [task] = map(ctx, [card('A', { comments: [{ uid: UID, comment: 'Hi', date: 'never' }] })]);
      // 21:00 UTC on 6 October is 7 October in Melbourne.
      expect(task?.data?.['descriptionMd']).toBe('**Comments (imported)**\n\n**Alex Rivers, 2026-10-07**\n\nHi');
      expect(warned(ctx)).toEqual({ MIG_W_DATE_INVALID: [`${cardPath('A')}#comment/0`] });
    });

    it("never lets an author's name read as a mention", () => {
      const ctx = makeCtx({ people: new Map([[COLLEAGUE, `@[${UID}]`]]) });
      const [task] = map(ctx, [
        card('A', { comments: [{ uid: COLLEAGUE, comment: 'Hi', date: '2025-01-11T00:00:00Z' }] }),
      ]);
      expect(domain.parseMentions(String(task?.data?.['descriptionMd'])).uids).toEqual([]);
    });

    it('replaces embedded images with "[Image not migrated]", with a warning', () => {
      const ctx = makeCtx();
      const image = `<p><img src="data:image/png;base64,${PNG}"></p>`;
      const [task] = map(ctx, [
        card('A', {
          description: `<p>Flyer:</p>${image}`,
          comments: [{ id: 'c1', uid: UID, comment: `<p>Photo</p>${image}`, date: '2025-01-11T00:00:00Z' }],
        }),
      ]);
      expect(task?.data?.['descriptionMd']).toBe(
        'Flyer:\n[Image not migrated]\n\n**Comments (imported)**\n\n**Alex Rivers, 2025-01-11**\n\nPhoto\n[Image not migrated]',
      );
      expect(warned(ctx)).toEqual({ MIG_W_ATTACHMENT_NOT_MIGRATED: [cardPath('A')] });
    });

    it('warns once when only a comment embedded an image', () => {
      const ctx = makeCtx();
      const comment = `<p><img src="data:image/png;base64,${PNG}"></p>`;
      map(ctx, [card('A', { comments: [{ id: 'c1', uid: UID, comment, date: '2025-01-11T00:00:00Z' }] })]);
      expect(warned(ctx)).toEqual({ MIG_W_ATTACHMENT_NOT_MIGRATED: [cardPath('A')] });
    });

    it('records sanitising warnings against the card and the comment', () => {
      const ctx = makeCtx();
      map(ctx, [
        card('A', {
          description: '<p>Hi<script>x()</script></p>',
          comments: [
            {
              id: 'c1',
              uid: UID,
              comment: '<p><img src="https://tracker.example.com/p.gif">Yo</p>',
              date: '2025-01-11T00:00:00Z',
            },
          ],
        }),
      ]);
      expect(warned(ctx)).toEqual({
        MIG_W_HTML_UNSAFE_REMOVED: [cardPath('A')],
        MIG_W_REMOTE_IMAGE_DROPPED: [`${cardPath('A')}#comment/c1`],
      });
    });
  });

  it('reports every attachment of these cards as not migrated', () => {
    const ctx = makeCtx();
    const attachments = new Map([
      [
        cardPath('A'),
        [
          { path: `${cardPath('A')}/attachments/a1`, data: { originalFileName: 'flyer.pdf' } },
          { path: `${cardPath('A')}/attachments/a2`, data: { originalFileName: 'map.png' } },
        ],
      ],
      [cardPath('Other'), [{ path: `${cardPath('Other')}/attachments/a3`, data: {} }]],
    ]);
    const tasks = map(ctx, [card('A')], attachments);
    expect(tasks).toHaveLength(1);
    expect(warned(ctx)).toEqual({
      MIG_W_ATTACHMENT_NOT_MIGRATED: [`${cardPath('A')}/attachments/a1`, `${cardPath('A')}/attachments/a2`],
    });
  });

  describe('checklist', () => {
    const items = (prefix: string, count: number, over: Record<string, unknown> = {}) =>
      Array.from({ length: count }, (_, i) => ({
        id: `${prefix}${i}`,
        name: `${prefix} item ${i}`,
        checked: false,
        ...over,
      }));

    it("flattens one checklist into the task's checklist, without a heading", () => {
      const ctx = makeCtx();
      const [task] = map(ctx, [
        card('A', {
          checklists: [
            {
              id: 'l1',
              title: 'Prep',
              items: [
                { id: 'i1', name: 'Book hall', checked: true },
                { id: 'i2', name: '  Print   flyers ', checked: false },
                { id: 'i3', name: '', checked: false },
                null,
              ],
            },
          ],
        }),
      ]);
      expect(task?.data?.['checklist']).toEqual([
        { id: 'i1', text: 'Book hall', done: true },
        { id: 'i2', text: 'Print flyers', done: false },
      ]);
      expect(domain.PersonalTaskSchema.parse(task?.data)).toEqual(task?.data);
      expect(warned(ctx)).toEqual({});
    });

    it('prefixes items with their checklist when there are several', () => {
      const [task] = map(makeCtx(), [
        card('A', {
          checklists: [
            { id: 'l1', title: 'Before', items: [{ id: 'i1', name: 'Book hall' }] },
            'not a list',
            { id: 'l2', title: 'After', items: [{ id: 'i2', name: 'Thank the club', checked: true }] },
            { id: 'l3', title: '', items: [{ id: 'i3', name: 'Loose end' }] },
          ],
        }),
      ]);
      expect(task?.data?.['checklist']).toEqual([
        { id: 'i1', text: 'Before: Book hall', done: false },
        { id: 'i2', text: 'After: Thank the club', done: true },
        { id: 'i3', text: 'Loose end', done: false },
      ]);
    });

    it('makes item ids unique, and gives items without one their position', () => {
      const [task] = map(makeCtx(), [
        card('A', {
          checklists: [
            { id: 'l1', title: 'One', items: [{ id: 'x', name: 'A' }, { name: 'B' }] },
            {
              id: 'l2',
              title: 'Two',
              items: [
                { id: 'x', name: 'C' },
                { id: 'x', name: 'D' },
              ],
            },
          ],
        }),
      ]);
      const ids = (task?.data?.['checklist'] as { id: string }[]).map((item) => item.id);
      expect(ids).toEqual(['x', '0-1', 'x-1-0', 'x-1-1']);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it(`keeps the first ${TASK_CHECKLIST_MAX} items, with a warning`, () => {
      const ctx = makeCtx();
      const [task] = map(ctx, [
        card('A', {
          checklists: [
            { id: 'l1', title: 'One', items: items('a', 60) },
            { id: 'l2', title: 'Two', items: items('b', 60) },
          ],
        }),
      ]);
      const checklist = task?.data?.['checklist'] as { text: string }[];
      expect(checklist).toHaveLength(TASK_CHECKLIST_MAX);
      expect(checklist.at(-1)?.text).toBe('Two: b item 39');
      expect(warned(ctx)).toEqual({ MIG_W_CHECKLIST_TRUNCATED: [cardPath('A')] });
      expect(() => domain.PersonalTaskSchema.parse(task?.data)).not.toThrow();
    });

    it(`keeps exactly ${TASK_CHECKLIST_MAX} items without a warning`, () => {
      const ctx = makeCtx();
      const [task] = map(ctx, [card('A', { checklists: [{ id: 'l1', items: items('a', TASK_CHECKLIST_MAX) }] })]);
      expect(task?.data?.['checklist']).toHaveLength(TASK_CHECKLIST_MAX);
      expect(warned(ctx)).toEqual({});
    });

    it('cuts an item longer than 500 characters', () => {
      const ctx = makeCtx();
      const [task] = map(ctx, [
        card('A', { checklists: [{ id: 'l1', items: [{ id: 'i1', name: 'z'.repeat(600) }] }] }),
      ]);
      expect((task?.data?.['checklist'] as { text: string }[])[0]?.text).toBe('z'.repeat(500));
      expect(warned(ctx)).toEqual({ MIG_W_TEXT_TRUNCATED: [cardPath('A')] });
    });

    it("warns when an item had a calendar event of the user's", () => {
      const ctx = makeCtx();
      map(ctx, [
        card('A', {
          checklists: [
            {
              id: 'l1',
              items: [
                {
                  id: 'i1',
                  name: 'Seminar',
                  calendarSyncByUser: {
                    [UID]: { isLinkedToCalendar: true, calendarProvider: 'google', calendarEventId: 'e1' },
                  },
                },
              ],
            },
          ],
        }),
        card('B', {
          checklists: [
            {
              id: 'l1',
              items: [
                {
                  id: 'i1',
                  name: 'Not mine',
                  calendarSyncByUser: { [COLLEAGUE]: { isLinkedToCalendar: true, calendarProvider: 'google' } },
                },
              ],
            },
          ],
        }),
      ]);
      expect(warned(ctx)).toEqual({ MIG_W_CALENDAR_EVENTS_EXIST: [cardPath('A')] });
    });

    it.each([undefined, null, 'lists', {}])('is empty for checklists that are not a list (%j)', (checklists) => {
      expect(map(makeCtx(), [card('A', { checklists })])[0]?.data?.['checklist']).toEqual([]);
    });
  });

  it('drops labels, fee and history', () => {
    const [task] = map(makeCtx(), [
      card('A', {
        labelIds: ['l1'],
        fee: { billingType: 'fixed', value: 100 },
        history: [{ id: 'h1', action: { name: 'Created card' }, uid: UID }],
      }),
    ]);
    expect(Object.keys(task?.data ?? {})).not.toEqual(expect.arrayContaining(['labels', 'fee', 'legacy']));
    expect(domain.PersonalTaskSchema.parse(task?.data)).toEqual(task?.data);
  });

  it('maps nothing for no cards', () => {
    expect(map(makeCtx(), [])).toEqual([]);
  });
});
