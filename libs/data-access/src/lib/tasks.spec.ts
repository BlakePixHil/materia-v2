import { TestBed } from '@angular/core/testing';

import { planMove, TASK_CALLABLES } from '@materia/domain';

import { CallableClient } from './callable-client';
import { OrgContext } from './org-context';
import {
  MATTER_TASKS_QUERY,
  matterTaskRepository,
  myOpenTasksQuery,
  personalTaskRepository,
  taskCallables,
  taskGroupRepository,
  writeTaskOrders,
} from './tasks';
import { InMemoryFirestore, provideInMemoryFirestore } from './testing/in-memory-firestore';

/** Tasks reads, client-direct writes and the bulk callable (CORE-08). Fictional data only. */

const meta = {
  createdAt: new Date('2026-10-01T00:00:00Z'),
  createdBy: 'u-jordan',
  updatedAt: new Date('2026-10-01T00:00:00Z'),
  updatedBy: 'u-jordan',
  schemaVersion: 1,
};
const M = 'orgs/org-a/matters/m-1/tasks';

function task(title: string, extra: Record<string, unknown> = {}) {
  return {
    orgId: 'org-a',
    matterId: 'm-1',
    title,
    status: 'todo',
    priority: 'none',
    checklist: [],
    order: 1024,
    source: 'manual',
    countedOpen: true,
    ...meta,
    ...extra,
  };
}

function setup() {
  const fs = new InMemoryFirestore();
  TestBed.configureTestingModule({ providers: [provideInMemoryFirestore(fs)] });
  TestBed.inject(OrgContext).setSession({ uid: 'u-jordan', orgId: 'org-a', role: 'lawyer' });
  const run = <T>(fn: () => T) => TestBed.runInInjectionContext(fn);
  return { fs, run };
}

describe('matterTaskRepository', () => {
  it('lists a matter’s tasks in order and hides deleted ones', async () => {
    const { fs, run } = setup();
    fs.set(`${M}/t-2`, task('Second', { order: 2048 }));
    fs.set(`${M}/t-1`, task('First', { checklist: [{ id: 'c1', text: 'Fictional item', done: false }] }));
    fs.set(`${M}/t-3`, task('Gone', { order: 10, deletedAt: new Date('2026-10-02T00:00:00Z') }));
    const rows = await run(() => matterTaskRepository(() => 'm-1')).query(MATTER_TASKS_QUERY);
    expect(rows.map((r) => r.title)).toEqual(['First', 'Second']);
    expect(rows[0]?.checklist).toEqual([{ id: 'c1', text: 'Fictional item', done: false }]);
  });

  it('creates a manual task with the org, matter and countedOpen the rules require', async () => {
    const { fs, run } = setup();
    const tasks = run(() => matterTaskRepository(() => 'm-1'));
    const id = await tasks.create({
      title: 'Call the executor',
      status: 'todo',
      order: 1024,
      dueDate: '2026-10-20' as never,
    });
    expect(fs.get(`${M}/${id}`)).toMatchObject({
      orgId: 'org-a',
      matterId: 'm-1',
      source: 'manual',
      countedOpen: false,
      priority: 'none',
      checklist: [],
      createdBy: 'u-jordan',
    });
    await expect(tasks.create({ title: '', status: 'todo', order: 1 })).rejects.toBeTruthy();
    await expect(
      run(() => matterTaskRepository(() => null)).create({ title: 'x', status: 'todo', order: 1 }),
    ).rejects.toThrow();
  });

  it('updates whitelisted fields only, and clears a due date', async () => {
    const { fs, run } = setup();
    fs.set(`${M}/t-1`, task('First', { dueDate: '2026-10-20' }));
    const tasks = run(() => matterTaskRepository(() => 'm-1'));
    await tasks.update('t-1', { status: 'done' }, { remove: ['dueDate'] });
    expect(fs.get(`${M}/t-1`)).toMatchObject({ status: 'done' });
    expect(fs.get(`${M}/t-1`)).not.toHaveProperty('dueDate');
    await expect(tasks.update('t-1', { completedAt: new Date() })).rejects.toBeTruthy();
    await expect(tasks.update('t-1', { descriptionMd: 'x' })).rejects.toBeTruthy();
  });

  it('writes a rebalance in chunks', async () => {
    const { fs, run } = setup();
    for (let i = 0; i < 120; i++) fs.set(`${M}/t-${i}`, task(`Task ${i}`, { order: 5 }));
    const tasks = run(() => matterTaskRepository(() => 'm-1'));
    const items = (await tasks.query(MATTER_TASKS_QUERY)).map((t) => ({ id: t.id, order: t.order }));
    const updates = planMove(items, ['t-119'], 60);
    expect(updates.length).toBe(120);
    await writeTaskOrders(tasks, updates, 25);
    const orders = (await tasks.query(MATTER_TASKS_QUERY)).map((t) => t.id);
    expect(orders[60]).toBe('t-119');
  });
});

describe('personalTaskRepository', () => {
  it('creates my personal task, assigned to me with no matter', async () => {
    const { fs, run } = setup();
    const id = await run(() => personalTaskRepository()).create({
      title: 'Renew practising certificate',
      status: 'todo',
      order: 1,
    });
    expect(fs.get(`orgs/org-a/members/u-jordan/tasks/${id}`)).toMatchObject({
      orgId: 'org-a',
      matterId: null,
      assigneeUid: 'u-jordan',
      source: 'manual',
    });
  });
});

describe('taskGroupRepository', () => {
  it('finds my open tasks across matters and my personal ones, in the active org', async () => {
    const { fs, run } = setup();
    fs.set(`${M}/t-1`, task('Mine', { assigneeUid: 'u-jordan' }));
    fs.set(`${M}/t-2`, task('Done', { assigneeUid: 'u-jordan', status: 'done' }));
    fs.set(`${M}/t-3`, task('Someone else’s', { assigneeUid: 'u-daniel' }));
    fs.set('orgs/org-a/members/u-jordan/tasks/p-1', task('Personal', { matterId: null, assigneeUid: 'u-jordan' }));
    fs.set('orgs/org-b/matters/m-9/tasks/t-9', task('Other org', { orgId: 'org-b', assigneeUid: 'u-jordan' }));
    const rows = await run(() => taskGroupRepository()).query(myOpenTasksQuery('u-jordan'));
    expect(rows.map((r) => [r.title, r.matterId]).sort()).toEqual([
      ['Mine', 'm-1'],
      ['Personal', null],
    ]);
  });
});

describe('taskCallables', () => {
  it('calls tasks-bulkUpdate with a request id', async () => {
    const calls: { name: string; data: unknown }[] = [];
    const client = new CallableClient(
      {
        call: async <T>(name: string, data: unknown) => {
          calls.push({ name, data });
          return { updated: 1, skipped: [] } as T;
        },
        refreshClaims: async () => undefined,
      },
      { newId: () => '00000000-0000-4000-8000-000000000001' },
    );
    const result = await taskCallables(client).bulkUpdate({
      tasks: [{ matterId: 'm-1', taskId: 't-1' }],
      change: { op: 'delete' },
    });
    expect(result).toEqual({ updated: 1, skipped: [] });
    expect(calls).toEqual([
      {
        name: TASK_CALLABLES.bulkUpdate,
        data: {
          tasks: [{ matterId: 'm-1', taskId: 't-1' }],
          change: { op: 'delete' },
          requestId: '00000000-0000-4000-8000-000000000001',
        },
      },
    ]);
  });
});
