import { PersonalTask, Task } from './schemas/matter-records';
import {
  asksToCompleteDeadline,
  assigneeState,
  BulkUpdateTasksInput,
  byOrder,
  chunkWrites,
  compareMyTasks,
  endOfWeek,
  isOpenTask,
  matterTaskPath,
  MatterTaskCreateInput,
  myTaskSection,
  openChecklistItems,
  ORDER_STEP,
  orderBetween,
  personalTaskPath,
  PersonalTaskCreateInput,
  planMove,
  rebalanceOrders,
  sectionMyTasks,
  tasksWithFormerAssignee,
  taskRefKey,
  toggledStatus,
  type OrderedItem,
} from './tasks';
import { dateOnly } from './values/date-only';

const d = dateOnly;
const requestId = '00000000-0000-4000-8000-000000000001';

describe('task schema (CORE-08)', () => {
  it('whitelists exactly the client-editable fields', () => {
    const fields = ['title', 'status', 'priority', 'assigneeUid', 'dueDate', 'checklist', 'order', 'group'];
    expect(Object.keys(Task.update.shape).sort()).toEqual([...fields].sort());
    expect(Object.keys(PersonalTask.update.shape).sort()).toEqual([...fields].sort());
  });

  it('keeps completion, counting and template fields server-owned', () => {
    for (const field of ['completedAt', 'countedOpen', 'templateTaskKey', 'duePending', 'orgId', 'matterId']) {
      expect(Object.keys(Task.create.shape)).not.toContain(field);
    }
  });

  it('personal tasks carry matterId null', () => {
    const parsed = PersonalTask.schema.parse({
      orgId: 'o',
      title: 'Personal',
      status: 'todo',
      order: 1,
      createdAt: new Date(),
      createdBy: 'u',
      updatedAt: new Date(),
      updatedBy: 'u',
      schemaVersion: 1,
    });
    expect(parsed.matterId).toBeNull();
  });

  it('client create inputs add org and matter, and only manual tasks', () => {
    const task = MatterTaskCreateInput.parse({ orgId: 'o', matterId: 'm', title: 'Call', status: 'todo', order: 1 });
    expect(task).toMatchObject({ orgId: 'o', matterId: 'm', source: 'manual', priority: 'none', checklist: [] });
    expect(() => MatterTaskCreateInput.parse({ ...task, source: 'template' })).toThrow();
    expect(() => MatterTaskCreateInput.parse({ ...task, completedAt: new Date() })).toThrow();
    const personal = PersonalTaskCreateInput.parse({
      orgId: 'o',
      assigneeUid: 'u',
      title: 'Mine',
      status: 'todo',
      order: 1,
    });
    expect(personal.matterId).toBeNull();
    expect(() => PersonalTaskCreateInput.parse({ orgId: 'o', title: 'Mine', status: 'todo', order: 1 })).toThrow();
  });

  it('builds paths', () => {
    expect(matterTaskPath('o', 'm')).toBe('orgs/o/matters/m/tasks');
    expect(matterTaskPath('o', 'm', 't')).toBe('orgs/o/matters/m/tasks/t');
    expect(personalTaskPath('o', 'u', 't')).toBe('orgs/o/members/u/tasks/t');
    expect(personalTaskPath('o', 'u')).toBe('orgs/o/members/u/tasks');
  });
});

describe('status helpers', () => {
  it('open means live and todo, in progress or blocked', () => {
    expect(isOpenTask({ status: 'todo' })).toBe(true);
    expect(isOpenTask({ status: 'blocked', deletedAt: null })).toBe(true);
    expect(isOpenTask({ status: 'in_progress' })).toBe(true);
    expect(isOpenTask({ status: 'done' })).toBe(false);
    expect(isOpenTask({ status: 'cancelled' })).toBe(false);
    expect(isOpenTask({ status: 'todo', deletedAt: new Date() })).toBe(false);
    expect(isOpenTask(undefined)).toBe(false);
    expect(isOpenTask(null)).toBe(false);
  });

  it('Space toggles done', () => {
    expect(toggledStatus('todo')).toBe('done');
    expect(toggledStatus('blocked')).toBe('done');
    expect(toggledStatus('done')).toBe('todo');
    expect(toggledStatus('cancelled')).toBe('todo');
  });

  it('counts open checklist items for the completion confirm', () => {
    expect(openChecklistItems({ checklist: [{ done: true }, { done: false }, { done: false }] })).toBe(2);
    expect(openChecklistItems({})).toBe(0);
  });

  it('asks about the linked deadline only when completing', () => {
    expect(asksToCompleteDeadline({ deadlineId: 'dl-1' }, 'done')).toBe(true);
    expect(asksToCompleteDeadline({ deadlineId: 'dl-1' }, 'in_progress')).toBe(false);
    expect(asksToCompleteDeadline({}, 'done')).toBe(false);
  });
});

describe('fractional order', () => {
  it('takes the midpoint of its neighbours, or a step past the ends', () => {
    expect(orderBetween(1024, 2048)).toBe(1536);
    expect(orderBetween(2048, 1024)).toBe(1536);
    expect(orderBetween(undefined, 1024)).toBe(0);
    expect(orderBetween(1024, null)).toBe(2048);
    expect(orderBetween()).toBe(ORDER_STEP);
  });

  it('runs out of precision after repeated inserts at the same place, then rebalances', () => {
    let low = 1024;
    const high = 2048;
    let inserts = 0;
    for (;;) {
      const mid = orderBetween(low, high);
      if (mid === null) break;
      expect(mid).toBeGreaterThan(low);
      expect(mid).toBeLessThan(high);
      low = mid;
      inserts++;
    }
    // About 30 inserts into one gap before the 1e-6 floor.
    expect(inserts).toBeGreaterThan(25);
    expect(orderBetween(low, high)).toBeNull();
    expect(orderBetween(5, 5)).toBeNull();
  });

  it('rebalances to even steps', () => {
    expect(rebalanceOrders(['a', 'b', 'c'])).toEqual([
      { id: 'a', order: 1024 },
      { id: 'b', order: 2048 },
      { id: 'c', order: 3072 },
    ]);
  });

  it('sorts ties by id', () => {
    const items = [
      { id: 'b', order: 1 },
      { id: 'a', order: 1 },
      { id: 'c', order: 0 },
    ];
    expect([...items].sort(byOrder).map((i) => i.id)).toEqual(['c', 'a', 'b']);
  });

  const list = (n: number): OrderedItem[] =>
    Array.from({ length: n }, (_, i) => ({ id: `t${i}`, order: (i + 1) * 1024 }));
  const apply = (items: OrderedItem[], updates: { id: string; order: number }[]) => {
    const next = new Map(items.map((i) => [i.id, i.order]));
    for (const u of updates) next.set(u.id, u.order);
    return [...next]
      .map(([id, order]) => ({ id, order }))
      .sort(byOrder)
      .map((i) => i.id);
  };

  it('moves one task with a single write (Alt+Up/Down, drag)', () => {
    const items = list(4);
    const down = planMove(items, ['t0'], 1); // after t1
    expect(down).toEqual([{ id: 't0', order: 2560 }]);
    expect(apply(items, down)).toEqual(['t1', 't0', 't2', 't3']);
    expect(apply(items, planMove(items, ['t3'], 0))).toEqual(['t3', 't0', 't1', 't2']);
    expect(apply(items, planMove(items, ['t0'], 99))).toEqual(['t1', 't2', 't3', 't0']);
  });

  it('moves several tasks together, keeping their order', () => {
    const items = list(5);
    const updates = planMove(items, ['t4', 't0'], 2);
    expect(updates).toHaveLength(2);
    expect(apply(items, updates)).toEqual(['t1', 't2', 't4', 't0', 't3']);
  });

  it('into an empty list, and of unknown ids, is simple', () => {
    expect(planMove([{ id: 'a', order: 7 }], ['a'], 0)).toEqual([{ id: 'a', order: 1024 }]);
    expect(planMove(list(2), ['nope'], 0)).toEqual([]);
    // No write when nothing moves.
    expect(planMove([{ id: 'a', order: 1024 }], ['a'], 0)).toEqual([]);
  });

  it('rebalances the whole list when the gap is exhausted', () => {
    const items = [
      { id: 'a', order: 1 },
      { id: 'b', order: 1 + 1e-7 },
      { id: 'c', order: 2 },
    ];
    const updates = planMove(items, ['c'], 1);
    expect(apply(items, updates)).toEqual(['a', 'c', 'b']);
    expect(updates).toEqual([
      { id: 'a', order: 1024 },
      { id: 'c', order: 2048 },
      { id: 'b', order: 3072 },
    ]);
  });

  it('rebalances on tied orders (two offline inserts)', () => {
    const items = [
      { id: 'a', order: 5 },
      { id: 'b', order: 5 },
      { id: 'c', order: 9 },
    ];
    expect(apply(items, planMove(items, ['c'], 1))).toEqual(['a', 'c', 'b']);
  });

  it('reorders 500 tasks in batches of at most 500 writes', () => {
    const items = Array.from({ length: 500 }, (_, i) => ({ id: `t${String(i).padStart(3, '0')}`, order: 1 }));
    // Into the middle of 500 tied orders: no gap left, so every task gets a new order.
    const updates = planMove(items, ['t499'], 250);
    expect(updates.length).toBe(500);
    const batches = chunkWrites(updates, 450);
    expect(batches.map((b) => b.length)).toEqual([450, 50]);
    expect(apply(items, updates)[250]).toBe('t499');
    expect(chunkWrites([], 10)).toEqual([]);
    expect(() => chunkWrites([1], 0)).toThrow();
  });
});

describe('My tasks sections', () => {
  // Wednesday 14 October 2026.
  const today = d('2026-10-14');

  it('ends the week on Sunday', () => {
    expect(endOfWeek(today)).toBe('2026-10-18');
    expect(endOfWeek(d('2026-10-18'))).toBe('2026-10-18');
    expect(endOfWeek(d('2026-10-19'))).toBe('2026-10-25');
  });

  it.each([
    [undefined, 'no_date'],
    ['2026-10-13', 'overdue'],
    ['2025-12-31', 'overdue'],
    ['2026-10-14', 'today'],
    ['2026-10-15', 'this_week'],
    ['2026-10-18', 'this_week'],
    ['2026-10-19', 'later'],
    ['2027-01-02', 'later'],
  ] as const)('%s is %s', (due, section) => {
    expect(myTaskSection(due ? d(due) : undefined, today)).toBe(section);
  });

  it('on a Sunday, This week is empty and tomorrow is Later', () => {
    expect(myTaskSection(d('2026-10-19'), d('2026-10-18'))).toBe('later');
  });

  it('groups into every section, sorted by date, priority, then order', () => {
    const tasks = [
      { id: 'a', dueDate: d('2026-10-15'), priority: 'low' as const, order: 1 },
      { id: 'b', dueDate: d('2026-10-15'), priority: 'urgent' as const, order: 2 },
      { id: 'c', dueDate: d('2026-10-10') },
      { id: 'd' },
      { id: 'e', dueDate: d('2026-10-14'), order: 2 },
      { id: 'f', dueDate: d('2026-10-14'), order: 1 },
      { id: 'g', dueDate: d('2026-11-01') },
    ];
    const sections = sectionMyTasks(tasks, today);
    expect(sections.map((s) => [s.label, s.tasks.map((t) => t.id)])).toEqual([
      ['Overdue', ['c']],
      ['Today', ['f', 'e']],
      ['This week', ['b', 'a']],
      ['Later', ['g']],
      ['No date', ['d']],
    ]);
    expect(sectionMyTasks([], today).every((s) => s.tasks.length === 0)).toBe(true);
  });

  it('compares undated tasks after dated ones, and ties by id', () => {
    expect(compareMyTasks({ id: 'a' }, { id: 'b', dueDate: d('2026-01-01') })).toBe(1);
    expect(compareMyTasks({ id: 'a', dueDate: d('2026-01-01') }, { id: 'b' })).toBe(-1);
    expect(compareMyTasks({ id: 'a' }, { id: 'b' })).toBe(-1);
    expect(compareMyTasks({ id: 'b' }, { id: 'a' })).toBe(1);
    expect(compareMyTasks({ id: 'a' }, { id: 'a' })).toBe(0);
  });
});

describe('former members', () => {
  const members = [
    { uid: 'u-1', status: 'active' },
    { uid: 'u-2', status: 'suspended' },
    { uid: 'u-3', status: 'removed' },
  ];

  it('flags removed and unknown assignees', () => {
    expect(assigneeState(undefined, members)).toBe('unassigned');
    expect(assigneeState('u-1', members)).toBe('member');
    expect(assigneeState('u-2', members)).toBe('member');
    expect(assigneeState('u-3', members)).toBe('former_member');
    expect(assigneeState('u-9', members)).toBe('former_member');
  });

  it('lists the tasks to reassign', () => {
    const tasks = [{ assigneeUid: 'u-1' }, { assigneeUid: 'u-3' }, {}, { assigneeUid: 'u-9' }];
    expect(tasksWithFormerAssignee(tasks, members)).toEqual([{ assigneeUid: 'u-3' }, { assigneeUid: 'u-9' }]);
  });
});

describe('BulkUpdateTasksInput', () => {
  const tasks = [
    { matterId: 'm-1', taskId: 't-1' },
    { matterId: null, taskId: 'p-1' },
  ];

  it.each([
    { op: 'status', status: 'done' },
    { op: 'assignee', assigneeUid: 'u-1' },
    { op: 'assignee', assigneeUid: null },
    { op: 'dueDate', dueDate: '2026-10-20' },
    { op: 'dueDate', dueDate: null },
    { op: 'priority', priority: 'urgent' },
    { op: 'delete' },
  ])('accepts %j', (change) => {
    expect(BulkUpdateTasksInput.safeParse({ requestId, tasks, change }).success).toBe(true);
  });

  it('rejects bad input', () => {
    const ok = { requestId, tasks, change: { op: 'delete' } };
    expect(BulkUpdateTasksInput.safeParse({ ...ok, requestId: 'x' }).success).toBe(false);
    expect(BulkUpdateTasksInput.safeParse({ ...ok, tasks: [] }).success).toBe(false);
    expect(BulkUpdateTasksInput.safeParse({ ...ok, tasks: [...tasks, tasks[0]] }).success).toBe(false);
    expect(
      BulkUpdateTasksInput.safeParse({
        ...ok,
        tasks: Array.from({ length: 501 }, (_, i) => ({ matterId: 'm', taskId: `t${i}` })),
      }).success,
    ).toBe(false);
    expect(BulkUpdateTasksInput.safeParse({ ...ok, change: { op: 'status', status: 'nope' } }).success).toBe(false);
    expect(BulkUpdateTasksInput.safeParse({ ...ok, change: { op: 'dueDate', dueDate: '14/10/2026' } }).success).toBe(
      false,
    );
    expect(BulkUpdateTasksInput.safeParse({ ...ok, change: { op: 'archive' } }).success).toBe(false);
  });

  it('keys task refs by matter', () => {
    expect(taskRefKey({ matterId: 'm', taskId: 't' })).toBe('m/t');
    expect(taskRefKey({ matterId: null, taskId: 't' })).toBe('~personal/t');
  });
});
