import { randomUUID } from 'node:crypto';

import { FieldValue, Timestamp } from 'firebase-admin/firestore';

import { dateOnly, taskSearchTokens, type Role } from '@materia/domain';

import { bulkPatch, bulkUpdateDefinition } from './bulk-update';
import {
  onPersonalWriteDefinition,
  onWriteDefinition,
  syncPersonalTask,
  syncTask,
  type TaskWriteOutcome,
} from './on-write';
import {
  activitySummary,
  actorOf,
  assignmentRecipient,
  completionPatch,
  planTaskSync,
  REMOVE,
  taskActivityKinds,
  wasCounted,
  type TaskActivityKind,
} from './shared';
import { runCallable, type CallableDeps } from '../core/callable';
import { createLog } from '../core/log';
import type { TriggerChange, TriggerContext } from '../core/trigger';
import { memoryFirestore } from '../orgs/testing';
import { FakeClock, fakePorts } from '../ports/fakes';

/** Unit tests for the tasks functions (CORE-08). Every person, matter and task is fictional. */

const ORG = 'org-a';
const M = `orgs/${ORG}/matters/m1`;
const T = `${M}/tasks`;
const NOW = new Date('2026-10-09T00:00:00Z');
const meta = { createdBy: 'user-lawyer', updatedBy: 'user-lawyer', schemaVersion: 1 };
const task = (extra: Record<string, unknown> = {}) => ({
  ...meta,
  orgId: ORG,
  matterId: 'm1',
  title: 'Lodge the inventory',
  status: 'todo',
  priority: 'high',
  checklist: [],
  order: 1024,
  source: 'manual',
  countedOpen: false,
  ...extra,
});
/** A task written before CORE-08: no `countedOpen`. */
const legacyTask = (): Record<string, unknown> => {
  const data: Record<string, unknown> = task();
  delete data['countedOpen'];
  return data;
};

describe('planTaskSync', () => {
  it('counts a new open task once, and marks it', () => {
    expect(planTaskSync(task(), undefined, NOW)).toEqual({ countDelta: 1, patch: { countedOpen: true } });
    expect(planTaskSync(task({ countedOpen: true }), undefined, NOW)).toEqual({ countDelta: 0, patch: {} });
  });

  it('uncounts a completed, cancelled or deleted task and stamps completion', () => {
    expect(planTaskSync(task({ status: 'done', countedOpen: true }), task(), NOW)).toEqual({
      countDelta: -1,
      patch: { countedOpen: false, completedAt: NOW },
    });
    expect(planTaskSync(task({ status: 'cancelled', countedOpen: true }), task(), NOW).countDelta).toBe(-1);
    expect(planTaskSync(task({ deletedAt: NOW, countedOpen: true }), task(), NOW).countDelta).toBe(-1);
  });

  it('reopening counts again and removes completedAt', () => {
    expect(planTaskSync(task({ status: 'todo', completedAt: NOW, countedOpen: false }), undefined, NOW)).toEqual({
      countDelta: 1,
      patch: { countedOpen: true, completedAt: REMOVE },
    });
  });

  it('a task created done is never counted', () => {
    expect(planTaskSync(task({ status: 'done' }), undefined, NOW)).toEqual({
      countDelta: 0,
      patch: { completedAt: NOW },
    });
  });

  it('treats a task without the marker as counted when it was open (written before CORE-08)', () => {
    const legacy = legacyTask();
    expect(wasCounted(legacy, legacy)).toBe(true);
    expect(wasCounted(legacy, undefined)).toBe(false);
    expect(planTaskSync({ ...legacy, status: 'done' }, legacy, NOW).countDelta).toBe(-1);
    expect(planTaskSync({ ...legacy, priority: 'low' }, legacy, NOW)).toEqual({
      countDelta: 0,
      patch: { countedOpen: true },
    });
  });

  it('a hard-deleted task gives back its count', () => {
    expect(planTaskSync(undefined, task({ countedOpen: true }), NOW).countDelta).toBe(-1);
    expect(planTaskSync(undefined, task({ countedOpen: false }), NOW).countDelta).toBe(0);
    expect(planTaskSync(undefined, legacyTask(), NOW).countDelta).toBe(-1);
    expect(planTaskSync(undefined, undefined, NOW).countDelta).toBe(0);
  });

  it('completedAt follows the status', () => {
    expect(completionPatch({ status: 'done', completedAt: NOW }, NOW)).toEqual({});
    expect(completionPatch({ status: 'todo' }, NOW)).toEqual({});
    expect(completionPatch({ status: 'done', completedAt: null }, NOW)).toEqual({ completedAt: NOW });
  });
});

describe('activity and notifications', () => {
  it.each([
    [undefined, task(), ['task.created']],
    [undefined, task({ source: 'template' }), []],
    [undefined, task({ source: 'migration' }), []],
    [undefined, task({ deletedAt: NOW }), []],
    [task(), undefined, []],
    [task(), task({ status: 'done' }), ['task.completed']],
    [task({ status: 'done' }), task({ status: 'in_progress' }), ['task.reopened']],
    [task({ status: 'done' }), task({ status: 'cancelled' }), []],
    [task(), task({ assigneeUid: 'user-para' }), ['task.assigned']],
    [task({ assigneeUid: 'user-para' }), task(), ['task.unassigned']],
    [task(), task({ deletedAt: NOW }), ['task.deleted']],
    [task({ deletedAt: NOW }), task({ deletedAt: null }), ['task.restored']],
    [task({ deletedAt: NOW }), task({ deletedAt: NOW, title: 'x' }), []],
    [task(), task({ order: 5, title: 'Renamed', checklist: [{ id: 'a', text: 'b', done: true }] }), []],
  ] as const)('%# lists the right kinds', (before, after, kinds) => {
    expect(taskActivityKinds(before, after)).toEqual(kinds);
  });

  it('summarises each kind with the title', () => {
    const kinds: TaskActivityKind[] = [
      'task.created',
      'task.completed',
      'task.reopened',
      'task.assigned',
      'task.unassigned',
      'task.deleted',
      'task.restored',
    ];
    expect(kinds.map((kind) => activitySummary(kind, 'Call bank'))).toEqual([
      'Added task “Call bank”',
      'Completed “Call bank”',
      'Reopened “Call bank”',
      'Assigned “Call bank”',
      'Unassigned “Call bank”',
      'Deleted task “Call bank”',
      'Restored task “Call bank”',
    ]);
  });

  it('notifies a new assignee of a live open task, not the person who assigned themselves', () => {
    expect(assignmentRecipient(undefined, task({ assigneeUid: 'user-para' }))).toBe('user-para');
    expect(assignmentRecipient(task(), task({ assigneeUid: 'user-para' }))).toBe('user-para');
    expect(assignmentRecipient(task({ assigneeUid: 'user-x' }), task({ assigneeUid: 'user-para' }))).toBe('user-para');
    expect(assignmentRecipient(task({ assigneeUid: 'user-para' }), task({ assigneeUid: 'user-para' }))).toBeNull();
    expect(assignmentRecipient(task(), task({ assigneeUid: 'user-lawyer' }))).toBeNull();
    expect(assignmentRecipient(task(), task({ assigneeUid: 'user-para', status: 'done' }))).toBeNull();
    expect(assignmentRecipient(task(), task({ assigneeUid: 'user-para', deletedAt: NOW }))).toBeNull();
    expect(assignmentRecipient(task(), task())).toBeNull();
    expect(assignmentRecipient(task(), undefined)).toBeNull();
    expect(assignmentRecipient(undefined, task({ assigneeUid: 'user-para', source: 'template' }))).toBeNull();
    expect(assignmentRecipient(task(), task({ assigneeUid: 'user-para', source: 'template' }))).toBe('user-para');
  });

  it('names the actor', () => {
    expect(actorOf(undefined, { createdBy: 'a' })).toBe('a');
    expect(actorOf({ updatedBy: 'b' }, undefined)).toBe('b');
    expect(actorOf(undefined, undefined)).toBe('system');
  });
});

function world(initial: Record<string, Record<string, unknown>> = {}) {
  const store = memoryFirestore({
    [`orgs/${ORG}`]: { name: 'Fictional Bayside Legal', timezone: 'Australia/Melbourne' },
    [`orgs/${ORG}/members/user-lawyer`]: { ...meta, role: 'lawyer', status: 'active' },
    [`orgs/${ORG}/members/user-para`]: { ...meta, role: 'paralegal', status: 'active' },
    [`orgs/${ORG}/members/user-read`]: { ...meta, role: 'readonly', status: 'active' },
    [`orgs/${ORG}/members/user-gone`]: { ...meta, role: 'lawyer', status: 'removed' },
    [M]: { ...meta, number: 'M-2026-0042', title: 'Estate of Fictional Quill', openTaskCount: 0, deletedAt: null },
    [`orgs/${ORG}/matters/m-priv`]: { ...meta, number: 'M-2026-0043', privileged: true, openTaskCount: 0 },
    [`orgs/${ORG}/matters/m-gone`]: { ...meta, number: 'M-2026-0044', deletedAt: NOW, openTaskCount: 0 },
    ...initial,
  });
  const clock = new FakeClock(NOW);
  const log = createLog({ fn: 'test' }, () => undefined);
  let event = 0;
  const doc = (path: string) => store.docs.get(path);
  /** Writes a task (as a client would), then runs the trigger for that write. */
  const write = async (id: string, data: Record<string, unknown> | undefined, base = T) => {
    const path = `${base}/${id}`;
    const before = doc(path);
    if (data) store.docs.set(path, { ...before, ...data });
    else store.docs.delete(path);
    return fire(path, before);
  };
  const fire = (path: string, before: Record<string, unknown> | undefined) => {
    const current = doc(path);
    const change = {
      before: before ? { ref: { path }, data: () => before } : undefined,
      after: current ? { ref: { path }, data: () => current } : undefined,
    } as unknown as TriggerChange;
    const parts = path.split('/');
    const ctx = {
      eventId: `e${++event}`,
      time: NOW,
      params:
        parts[2] === 'members'
          ? { orgId: ORG, uid: parts[3], taskId: parts[5] }
          : { orgId: ORG, matterId: parts[3], taskId: parts[5] },
      log,
      clock,
      db: store.db,
      ports: fakePorts(),
    } as unknown as TriggerContext;
    return parts[2] === 'members' ? syncPersonalTask(change, ctx) : syncTask(change, ctx);
  };
  const count = (matter = M) => doc(matter)?.['openTaskCount'];
  const under = (prefix: string) =>
    [...store.docs.entries()].filter(([path]) => path.startsWith(prefix)).map(([, data]) => data);
  const writeTask = (...args: Parameters<typeof write>) => write(...args) as Promise<TaskWriteOutcome>;
  return { ...store, clock, log, doc, write, writeTask, fire, count, under };
}

describe('tasks-onWrite', () => {
  it('is declared on matter tasks and personal tasks', () => {
    expect(onWriteDefinition).toMatchObject({ name: 'tasks-onWrite', on: 'written' });
    expect(onWriteDefinition.document).toBe('orgs/{orgId}/matters/{matterId}/tasks/{taskId}');
    expect(onPersonalWriteDefinition.document).toBe('orgs/{orgId}/members/{uid}/tasks/{taskId}');
  });

  it('keeps openTaskCount through create, complete, reopen, cancel, delete and restore', async () => {
    const w = world();
    await w.write('t1', task());
    await w.write('t2', task({ title: 'Second' }));
    expect(w.count()).toBe(2);
    expect(w.doc(`${T}/t1`)?.['countedOpen']).toBe(true);
    await w.write('t1', { status: 'done' });
    expect(w.count()).toBe(1);
    expect((w.doc(`${T}/t1`)?.['completedAt'] as Timestamp).toDate()).toEqual(NOW);
    await w.write('t1', { status: 'in_progress' });
    expect(w.count()).toBe(2);
    expect(w.doc(`${T}/t1`)).not.toHaveProperty('completedAt');
    await w.write('t2', { status: 'cancelled' });
    expect(w.count()).toBe(1);
    await w.write('t1', { deletedAt: NOW, deletedBy: 'user-lawyer' });
    expect(w.count()).toBe(0);
    await w.write('t1', { deletedAt: null, deletedBy: null });
    expect(w.count()).toBe(1);
    await w.write('t1', undefined);
    expect(w.count()).toBe(0);
  });

  it('a redelivered or late event changes nothing (it reconciles the current state)', async () => {
    const w = world();
    await w.write('t1', task());
    const before = w.doc(`${T}/t1`);
    await w.write('t1', { status: 'done' });
    // The first event again, after the second was handled.
    await w.fire(`${T}/t1`, undefined);
    await w.fire(`${T}/t1`, before);
    expect(w.count()).toBe(0);
  });

  it('leaves template tasks counted by their writer alone', async () => {
    const w = world({ [M]: { ...meta, number: 'M-1', openTaskCount: 1 } });
    const outcome = await w.writeTask(
      'tpl-x',
      task({
        source: 'template',
        countedOpen: true,
        assigneeUid: 'user-para',
        search: taskSearchTokens('Lodge the inventory'),
      }),
    );
    expect(outcome).toEqual({ countDelta: 0, patched: [], notified: null, activity: [] });
    expect(w.count()).toBe(1);
  });

  it('skips the count when the matter is gone', async () => {
    const w = world();
    await w.write('t1', task(), `orgs/${ORG}/matters/m-missing/tasks`);
    expect(w.doc(`orgs/${ORG}/matters/m-missing`)).toBeUndefined();
  });

  it('notifies the assignee once, with the matter number and a link', async () => {
    const w = world();
    const outcome = await w.writeTask('t1', task({ assigneeUid: 'user-para' }));
    expect(outcome.notified).toBe('user-para');
    const [notification] = w.under(`orgs/${ORG}/notifications/`);
    expect(notification).toMatchObject({
      kind: 'task_assigned',
      taskId: 't1',
      matterId: 'm1',
      recipientUid: 'user-para',
      title: 'Task assigned to you',
      body: 'Lodge the inventory · M-2026-0042',
      link: '/matters/m1/tasks',
      channels: ['inapp', 'email'],
      priority: 'normal',
      readAt: null,
      createdBy: 'system',
    });
    // Editing something else doesn't notify again.
    await w.write('t1', { priority: 'low', updatedBy: 'user-lawyer' });
    expect(w.under(`orgs/${ORG}/notifications/`)).toHaveLength(1);
  });

  it('does not notify a removed member or someone assigning themselves', async () => {
    const w = world();
    expect((await w.writeTask('t1', task({ assigneeUid: 'user-gone' }))).notified).toBeNull();
    expect((await w.writeTask('t2', task({ assigneeUid: 'user-lawyer' }))).notified).toBeNull();
    expect(w.under(`orgs/${ORG}/notifications/`)).toHaveLength(0);
  });

  it('writes the matter’s activity and moves lastActivityAt', async () => {
    const w = world();
    await w.write('t1', task({ assigneeUid: 'user-para' }));
    await w.write('t1', { status: 'done', updatedBy: 'user-para' });
    const activity = w.under(`${M}/activity/`);
    expect(activity.map((a) => [a['kind'], a['summary'], a['actorUid']])).toEqual([
      ['task.created', 'Added task “Lodge the inventory”', 'user-lawyer'],
      ['task.completed', 'Completed “Lodge the inventory”', 'user-para'],
    ]);
    expect(activity[0]?.['refs']).toEqual({ taskId: 't1' });
    expect((w.doc(M)?.['lastActivityAt'] as Timestamp).toDate()).toEqual(NOW);
    await w.write('t1', { assigneeUid: 'user-lawyer', status: 'todo' });
    expect(w.under(`${M}/activity/`).at(-1)?.['refs']).toEqual({ taskId: 't1', assigneeUid: 'user-lawyer' });
  });

  it('the migration load (MIG-06) notifies nobody and writes no activity, but the count follows', async () => {
    const w = world();
    const loaded = (at: Date) => ({
      runId: 'run-1',
      legacyPath: 'workflows/w/cards/c#checklist/l/item/i',
      loadedAt: at,
    });
    const created = await w.writeTask(
      't1',
      task({ source: 'migration', assigneeUid: 'user-para', migration: loaded(new Date('2026-10-05T00:00:00Z')) }),
    );
    expect(created).toMatchObject({ countDelta: 1, notified: null, activity: [] });
    // A delta reload that reassigns and completes it in one go.
    const reloaded = await w.writeTask('t1', {
      assigneeUid: 'user-read',
      status: 'done',
      updatedBy: 'user-para',
      migration: loaded(new Date('2026-10-06T00:00:00Z')),
    });
    expect(reloaded).toMatchObject({ countDelta: -1, notified: null, activity: [] });
    expect(w.under(`orgs/${ORG}/notifications/`)).toHaveLength(0);
    expect(w.under(`${M}/activity/`)).toHaveLength(0);
    expect(w.doc(M)).not.toHaveProperty('lastActivityAt');
    // A person's later edit of the migrated task is an ordinary one.
    const edited = await w.writeTask('t1', { assigneeUid: 'user-para', status: 'todo', updatedBy: 'user-lawyer' });
    expect(edited).toMatchObject({
      countDelta: 1,
      notified: 'user-para',
      activity: ['task.reopened', 'task.assigned'],
    });
  });

  it('keeps search in step with the title, writing it only when it changed (CORE-15)', async () => {
    const w = world();
    const first = await w.writeTask('t1', task({ title: 'Lodge the Inventory of Assets' }));
    expect(first.patched).toEqual(['countedOpen', 'search', 'matter']);
    expect(w.doc(`${T}/t1`)?.['search']).toEqual(taskSearchTokens('Lodge the Inventory of Assets'));
    expect((await w.writeTask('t1', { status: 'in_progress' })).patched).toEqual([]);
    expect((await w.writeTask('t1', { title: 'Publish the notice' })).patched).toEqual(['search']);
    expect(w.doc(`${T}/t1`)?.['search']).toEqual(expect.arrayContaining(['publish', 'notice']));
    expect(w.doc(`${T}/t1`)?.['search']).not.toContain('inventory');
  });

  it('copies the matter onto a live task, a privileged one without its name, then stops (SEC-07e)', async () => {
    const w = world();
    await w.writeTask('t1', task());
    expect(w.doc(`${T}/t1`)?.['matter']).toEqual({
      number: 'M-2026-0042',
      title: 'Estate of Fictional Quill',
      privileged: false,
    });
    expect((await w.writeTask('t1', { status: 'in_progress' })).patched).toEqual([]);
    // Renamed meanwhile (matters-denormalise rewrites it too): the next write catches up.
    await w.db.doc(M).update({ title: 'Estate of Fictional Quill (renamed)' });
    expect((await w.writeTask('t1', { priority: 'low' })).patched).toEqual(['matter']);
    // Its assignee may not read a privileged matter (ADR-026): only the flag.
    const P = 'orgs/org-a/matters/m-priv/tasks';
    await w.write('t2', task({ matterId: 'm-priv' }), P);
    expect(w.doc(`${P}/t2`)?.['matter']).toEqual({ privileged: true });
    // A deleted matter's task is marked; a deleted task is left as it is.
    const G = 'orgs/org-a/matters/m-gone/tasks';
    await w.db.doc('orgs/org-a/matters/m-gone').update({ title: 'Will for Fictional Ostler' });
    await w.write('t3', task({ matterId: 'm-gone' }), G);
    expect(w.doc(`${G}/t3`)?.['matter']).toMatchObject({ number: 'M-2026-0044', deleted: true });
    await w.db.doc(`${T}/t1`).update({ matter: { number: 'Old' } });
    await w.writeTask('t1', { deletedAt: NOW });
    expect(w.doc(`${T}/t1`)?.['matter']).toEqual({ number: 'Old' });
  });

  it('personal tasks: completedAt and search only', async () => {
    const w = world();
    const P = `orgs/${ORG}/members/user-lawyer/tasks`;
    expect(await w.write('p1', task({ matterId: null, status: 'done' }), P)).toEqual(['completedAt', 'search']);
    expect(w.doc(`${P}/p1`)).toHaveProperty('completedAt');
    expect(await w.write('p1', { status: 'todo' }, P)).toEqual(['completedAt']);
    expect(w.doc(`${P}/p1`)).not.toHaveProperty('completedAt');
    expect(await w.write('p1', { title: 'Renamed' }, P)).toEqual(['search']);
    expect(await w.write('p1', { status: 'blocked' }, P)).toEqual([]);
    expect(await w.write('p1', undefined, P)).toEqual([]);
    expect(w.count()).toBe(0);
  });
});

describe('tasks-bulkUpdate', () => {
  const deps = (w: ReturnType<typeof world>): CallableDeps => ({
    db: () => w.db,
    clock: w.clock,
    ports: () => fakePorts(),
    memberLookup: async () => true,
    idempotency: {
      begin: async () => ({ replay: false }),
      complete: async () => undefined,
      abandon: async () => undefined,
    },
    sink: () => undefined,
  });
  const call = (w: ReturnType<typeof world>, data: Record<string, unknown>, role: Role = 'paralegal') =>
    runCallable(
      bulkUpdateDefinition,
      {
        data: { requestId: randomUUID(), ...data },
        auth: { uid: `user-${role === 'paralegal' ? 'para' : role}`, token: { orgId: ORG, role } },
      },
      deps(w),
    );
  const seeded = () =>
    world({
      [`${T}/t1`]: task(),
      [`${T}/t2`]: task({ status: 'done' }),
      [`${T}/t3`]: task({ deletedAt: NOW }),
      [`orgs/${ORG}/matters/m-priv/tasks/t1`]: task({ matterId: 'm-priv' }),
      [`orgs/${ORG}/matters/m-gone/tasks/t1`]: task({ matterId: 'm-gone' }),
      [`orgs/${ORG}/members/user-para/tasks/p1`]: task({ matterId: null, assigneeUid: 'user-para' }),
      [`orgs/${ORG}/members/user-lawyer/tasks/p1`]: task({ matterId: null, assigneeUid: 'user-lawyer' }),
    });
  const refs = [
    { matterId: 'm1', taskId: 't1' },
    { matterId: 'm1', taskId: 't2' },
    { matterId: 'm1', taskId: 't3' },
    { matterId: 'm1', taskId: 'missing' },
    { matterId: 'm-priv', taskId: 't1' },
    { matterId: 'm-gone', taskId: 't1' },
    { matterId: null, taskId: 'p1' },
  ];

  it('changes the status of every reachable task in one call and lists the rest', async () => {
    const w = seeded();
    const result = await call(w, { tasks: refs, change: { op: 'status', status: 'done' } });
    expect(result).toEqual({
      updated: 2,
      skipped: [
        { matterId: 'm1', taskId: 't2', reason: 'unchanged' },
        { matterId: 'm1', taskId: 't3', reason: 'deleted' },
        { matterId: 'm1', taskId: 'missing', reason: 'not_found' },
        { matterId: 'm-priv', taskId: 't1', reason: 'matter_unavailable' },
        { matterId: 'm-gone', taskId: 't1', reason: 'matter_unavailable' },
      ],
    });
    expect(w.doc(`${T}/t1`)).toMatchObject({ status: 'done', updatedBy: 'user-para', _requestId: expect.any(String) });
    // The caller's own personal task, not the lawyer's.
    expect(w.doc(`orgs/${ORG}/members/user-para/tasks/p1`)).toMatchObject({ status: 'done' });
    expect(w.doc(`orgs/${ORG}/members/user-lawyer/tasks/p1`)).toMatchObject({ status: 'todo' });
  });

  it('a lawyer reaches privileged matters', async () => {
    const w = seeded();
    const result = await call(
      w,
      { tasks: [{ matterId: 'm-priv', taskId: 't1' }], change: { op: 'priority', priority: 'urgent' } },
      'lawyer',
    );
    expect(result).toEqual({ updated: 1, skipped: [] });
    expect(w.doc(`orgs/${ORG}/matters/m-priv/tasks/t1`)).toMatchObject({ priority: 'urgent' });
    expect(
      await call(
        w,
        { tasks: [{ matterId: 'm-priv', taskId: 't1' }], change: { op: 'priority', priority: 'urgent' } },
        'lawyer',
      ),
    ).toEqual({ updated: 0, skipped: [{ matterId: 'm-priv', taskId: 't1', reason: 'unchanged' }] });
  });

  it('assigns to an active member, unassigns, and never reassigns a personal task', async () => {
    const w = seeded();
    const tasks = [
      { matterId: 'm1', taskId: 't1' },
      { matterId: null, taskId: 'p1' },
    ];
    expect(await call(w, { tasks, change: { op: 'assignee', assigneeUid: 'user-lawyer' } })).toEqual({
      updated: 1,
      skipped: [{ matterId: null, taskId: 'p1', reason: 'personal_assignee' }],
    });
    expect(w.doc(`${T}/t1`)?.['assigneeUid']).toBe('user-lawyer');
    await call(w, { tasks: [tasks[0]], change: { op: 'assignee', assigneeUid: null } });
    expect(w.doc(`${T}/t1`)).not.toHaveProperty('assigneeUid');
    const error = await call(w, { tasks, change: { op: 'assignee', assigneeUid: 'user-gone' } }).catch((e) => e);
    expect(error).toMatchObject({ code: 'invalid-argument' });
    expect(error.details).toMatchObject({ code: 'INVALID_ARGUMENT', field: 'change.assigneeUid' });
  });

  it('sets and clears due dates', async () => {
    const w = seeded();
    const tasks = [{ matterId: 'm1', taskId: 't1' }];
    await call(w, { tasks, change: { op: 'dueDate', dueDate: '2026-10-20' } });
    expect(w.doc(`${T}/t1`)?.['dueDate']).toBe('2026-10-20');
    await call(w, { tasks, change: { op: 'dueDate', dueDate: null } });
    expect(w.doc(`${T}/t1`)).not.toHaveProperty('dueDate');
  });

  it('soft deletes, stamped by the caller', async () => {
    const w = seeded();
    const result = await call(w, { tasks: refs.slice(0, 3), change: { op: 'delete' } });
    expect(result.updated).toBe(2);
    expect(w.doc(`${T}/t1`)).toMatchObject({ deletedBy: 'user-para' });
    expect((w.doc(`${T}/t1`)?.['deletedAt'] as Timestamp).toDate()).toEqual(NOW);
  });

  it('writes 500 tasks in batches', async () => {
    const initial = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`${T}/b${i}`, task({ order: i })]));
    const w = world(initial);
    const tasks = Array.from({ length: 500 }, (_, i) => ({ matterId: 'm1', taskId: `b${i}` }));
    expect(await call(w, { tasks, change: { op: 'status', status: 'in_progress' } })).toEqual({
      updated: 500,
      skipped: [],
    });
    expect(w.under(`${T}/`).every((t) => t['status'] === 'in_progress')).toBe(true);
  });

  it('needs task.edit for matter tasks, not for your own personal tasks', async () => {
    const w = seeded();
    const denied = await call(
      w,
      { tasks: [{ matterId: 'm1', taskId: 't1' }], change: { op: 'delete' } },
      'readonly',
    ).catch((e) => e);
    expect(denied).toMatchObject({ code: 'permission-denied' });
    const own = world({
      [`orgs/${ORG}/members/user-readonly/tasks/p1`]: task({ matterId: null, assigneeUid: 'user-readonly' }),
    });
    expect(
      await call(
        own,
        { tasks: [{ matterId: null, taskId: 'p1' }], change: { op: 'status', status: 'done' } },
        'readonly',
      ),
    ).toEqual({
      updated: 1,
      skipped: [],
    });
  });

  it('validates its input', async () => {
    const w = seeded();
    const error = await call(w, { tasks: [], change: { op: 'delete' } }).catch((e) => e);
    expect(error).toMatchObject({ code: 'invalid-argument' });
  });

  it('bulkPatch plans one change', () => {
    expect(bulkPatch(task(), { op: 'delete' }, false)).toEqual({ patch: {} });
    expect(bulkPatch(task({ deletedAt: NOW }), { op: 'delete' }, false)).toEqual({ skip: 'deleted' });
    expect(
      bulkPatch(task({ dueDate: '2026-10-20' }), { op: 'dueDate', dueDate: dateOnly('2026-10-20') }, false),
    ).toEqual({
      skip: 'unchanged',
    });
    expect(bulkPatch(task(), { op: 'assignee', assigneeUid: null }, false)).toEqual({ skip: 'unchanged' });
    expect(bulkPatch(task({ group: 'Letters' }), { op: 'group', group: ' Letters ' }, true)).toEqual({
      skip: 'unchanged',
    });
    expect(bulkPatch(task(), { op: 'group', group: ' Letters ' }, true)).toEqual({ patch: { group: 'Letters' } });
    expect(bulkPatch(task({ group: 'Letters' }), { op: 'group', group: null }, false)).toEqual({
      patch: { group: FieldValue.delete() },
    });
  });
});
