import { FORMER_MEMBER_LABEL } from '@materia/domain';

import {
  bulkSummary,
  clientWrite,
  formatDueInput,
  inOrder,
  moveAnnouncement,
  orderAfterLast,
  parseDueInput,
  sectionsByGroup,
  sectionsByStage,
  taskEntry,
  uniqueGroups,
  usesBulkCallable,
  type TaskRecord,
} from './task-view';

/** The task list's pure helpers (CORE-08). Fictional data only. */

const meta = {
  createdAt: new Date('2026-10-01T00:00:00Z'),
  createdBy: 'u-jordan',
  updatedAt: new Date('2026-10-01T00:00:00Z'),
  updatedBy: 'u-jordan',
  schemaVersion: 1,
};

function task(id: string, data: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    orgId: 'org-a',
    matterId: 'm-1',
    title: `Task ${id}`,
    status: 'todo',
    priority: 'none',
    checklist: [],
    order: 1024,
    source: 'manual',
    ...meta,
    ...data,
  } as TaskRecord;
}

const members = [
  { uid: 'u-jordan', name: 'Jordan Price', status: 'active' as const, role: 'lawyer' as const },
  { uid: 'u-sam', name: 'Sam Lee', status: 'removed' as const, role: 'readonly' as const },
];

describe('taskEntry', () => {
  it('builds a row with the assignee, due date and notes', () => {
    const entry = taskEntry(
      task('t1', {
        assigneeUid: 'u-jordan',
        dueDate: '2026-10-09' as never,
        status: 'blocked',
        checklist: [{ id: 'c', text: 'Fictional', done: true }],
      }),
      { members, canEdit: false, matter: { id: 'm-1', number: 'M-2026-0001', title: 'Estate of Ada Fictional' } },
    );
    expect(entry.key).toBe('m-1/t1');
    expect(entry.editable).toBe(false);
    expect(entry.vm).toMatchObject({
      assignee: { id: 'u-jordan', name: 'Jordan Price' },
      deadline: { due: '2026-10-09' },
      done: false,
      subtitle: 'M-2026-0001 · Estate of Ada Fictional · Blocked · Checklist 1/1',
    });
  });

  it('shows former members, and lets people edit their personal tasks', () => {
    const former = taskEntry(task('t1', { assigneeUid: 'u-gone' }), { members, canEdit: true });
    expect(former.vm.assignee).toBeNull();
    expect(former.vm.subtitle).toBe(FORMER_MEMBER_LABEL);
    const personal = taskEntry(task('p1', { matterId: null, status: 'done' }), {
      members,
      canEdit: false,
      matter: null,
    });
    expect(personal.key).toBe('~personal/p1');
    expect(personal.editable).toBe(true);
    expect(personal.vm.done).toBe(true);
    expect(personal.vm.subtitle).toBe('Personal');
  });
});

describe('sections', () => {
  const entries = inOrder([
    task('a', { group: 'grant', order: 3 }),
    task('b', { group: 'Intake', order: 1 }),
    task('c', { order: 2 }),
    task('d', { group: 'Letters', order: 4 }),
  ]).map((t) => taskEntry(t, { members, canEdit: true }));

  it('groups by stage, matching titles or ids without case, in stage order, then other groups', () => {
    const sections = sectionsByStage(entries, [
      { id: 'intake', title: 'Intake' },
      { id: 'grant', title: 'Grant application' },
      { id: 'admin', title: 'Administration' },
    ]);
    expect(sections.map((s) => [s.label, s.entries.map((e) => e.task.id), s.group])).toEqual([
      ['Intake', ['b'], 'Intake'],
      ['Grant application', ['a'], 'Grant application'],
      ['Letters', ['d'], 'Letters'],
      ['Other tasks', ['c'], null],
    ]);
  });

  it('groups by the free-text group, with No group last', () => {
    expect(sectionsByGroup(entries).map((s) => [s.label, s.entries.map((e) => e.task.id)])).toEqual([
      ['Intake', ['b']],
      ['grant', ['a']],
      ['Letters', ['d']],
      ['No group', ['c']],
    ]);
  });

  it('lists group names once each, ignoring case and blanks', () => {
    expect(uniqueGroups(['Letters', ' letters ', null, '', 'Intake', undefined, '  '])).toEqual(['Letters', 'Intake']);
  });
});

describe('writes', () => {
  it('plans the direct write for each bulk change, skipping no-ops', () => {
    const t = task('t1', { assigneeUid: 'u-jordan', dueDate: '2026-10-09' as never, priority: 'high' });
    expect(clientWrite(t, { op: 'status', status: 'todo' })).toBeNull();
    expect(clientWrite(t, { op: 'status', status: 'blocked' })).toEqual({
      kind: 'update',
      patch: { status: 'blocked' },
      remove: [],
    });
    expect(clientWrite(t, { op: 'priority', priority: 'high' })).toBeNull();
    expect(clientWrite(t, { op: 'assignee', assigneeUid: null })).toEqual({
      kind: 'update',
      patch: {},
      remove: ['assigneeUid'],
    });
    expect(clientWrite(task('p', { matterId: null }), { op: 'assignee', assigneeUid: 'u-x' })).toBeNull();
    expect(clientWrite(t, { op: 'dueDate', dueDate: null })).toEqual({
      kind: 'update',
      patch: {},
      remove: ['dueDate'],
    });
    expect(clientWrite(t, { op: 'dueDate', dueDate: '2026-10-10' as never })).toMatchObject({
      patch: { dueDate: '2026-10-10' },
    });
    expect(clientWrite(t, { op: 'delete' })).toEqual({ kind: 'delete' });
    const grouped = task('g', { group: 'Letters' });
    expect(clientWrite(grouped, { op: 'group', group: ' Letters ' })).toBeNull();
    expect(clientWrite(grouped, { op: 'group', group: ' Intake ' })).toEqual({
      kind: 'update',
      patch: { group: 'Intake' },
      remove: [],
    });
    expect(clientWrite(grouped, { op: 'group', group: '  ' })).toEqual({
      kind: 'update',
      patch: {},
      remove: ['group'],
    });
    expect(clientWrite(task('n'), { op: 'group', group: null })).toBeNull();
  });

  it('uses the callable above 50 tasks', () => {
    expect(usesBulkCallable(50)).toBe(false);
    expect(usesBulkCallable(51)).toBe(true);
  });

  it('orders a new task after the last', () => {
    expect(orderAfterLast([])).toBe(1024);
    expect(orderAfterLast([{ order: 5000 }, { order: 10 }])).toBe(6024);
  });
});

describe('words', () => {
  it('summarises bulk changes', () => {
    expect(bulkSummary({ op: 'status', status: 'done' }, 3)).toBe('3 tasks marked done');
    expect(bulkSummary({ op: 'status', status: 'in_progress' }, 1)).toBe('1 task set to In progress');
    expect(bulkSummary({ op: 'priority', priority: 'none' }, 2)).toBe('2 tasks set to no priority');
    expect(bulkSummary({ op: 'assignee', assigneeUid: 'u' }, 2, 'Priya Shah')).toBe('2 tasks assigned to Priya Shah');
    expect(bulkSummary({ op: 'assignee', assigneeUid: null }, 1)).toBe('1 task unassigned');
    expect(bulkSummary({ op: 'dueDate', dueDate: null }, 2)).toBe('Due date cleared on 2 tasks');
    expect(bulkSummary({ op: 'dueDate', dueDate: '2026-10-10' as never }, 1)).toBe('Due date changed on 1 task');
    expect(bulkSummary({ op: 'delete' }, 4)).toBe('4 tasks deleted');
    expect(bulkSummary({ op: 'group', group: 'Letters' }, 2)).toBe('2 tasks moved to Letters');
    expect(bulkSummary({ op: 'group', group: null }, 1)).toBe('1 task taken out of its group');
  });

  it('announces moves', () => {
    expect(moveAnnouncement('Lodge the inventory', 1, 5, 'Grant application')).toBe(
      'Moved Lodge the inventory to position 2 of 5 in Grant application.',
    );
  });

  it('reads and writes due dates as DD/MM/YYYY', () => {
    expect(parseDueInput('9/10/2026')).toBe('2026-10-09');
    expect(parseDueInput(' 2026-10-09 ')).toBe('2026-10-09');
    expect(parseDueInput('31/02/2026')).toBeNull();
    expect(parseDueInput('next friday')).toBeNull();
    expect(formatDueInput('2026-10-09' as never)).toBe('09/10/2026');
    expect(formatDueInput(null)).toBe('');
  });
});
