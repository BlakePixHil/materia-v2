import { randomUUID } from 'node:crypto';

import type { Role, StopTimerResult } from '@materia/domain';

import { checkForgottenTimers } from './forgotten';
import { serverElapsedMs, stopTimerDefinition, timerPath } from './stop-timer';
import { runCallable, type CallableDeps } from '../core/callable';
import { createLog } from '../core/log';
import { memoryFirestore } from '../orgs/testing';
import { FakeClock, FakeTaskQueue, fakePorts } from '../ports/fakes';

/** Unit tests for the global timer's functions (BILL-02). Every person, matter and timer is fictional. */

const ORG = 'org-a';
const M = `orgs/${ORG}/matters/m1`;
const MIN = 60_000;
const HOUR = 60 * MIN;
// 10:00 Melbourne (AEDT) on Tuesday 6 October 2026.
const NOW = new Date('2026-10-05T23:00:00Z');
const meta = { createdBy: 'user-lawyer', updatedBy: 'user-lawyer', schemaVersion: 1 };

const timer = (extra: Record<string, unknown> = {}) => ({
  ...meta,
  orgId: ORG,
  matterId: 'm1',
  matterNumber: 'M-2026-0042',
  startedAt: new Date(NOW.getTime() - 24 * MIN),
  accumulatedMs: 0,
  running: true,
  narrativeDraft: 'Perusing the will',
  lastHeartbeatAt: NOW,
  ...extra,
});

function world(initial: Record<string, Record<string, unknown>> = {}) {
  const store = memoryFirestore({
    [`orgs/${ORG}`]: {
      ...meta,
      name: 'Fictional Practice',
      timezone: 'Australia/Melbourne',
      billing: { unitMinutes: 6, rounding: 'up', defaultRateCents: 30000, gstRegistered: true },
    },
    [`orgs/${ORG}/members/user-lawyer`]: {
      ...meta,
      role: 'lawyer',
      status: 'active',
      rates: [{ effectiveFrom: '2026-07-01', rateCents: 44000 }],
    },
    [`orgs/${ORG}/members/user-para`]: { ...meta, role: 'paralegal', status: 'active', defaultRateCents: 22000 },
    [M]: { ...meta, number: 'M-2026-0042', privileged: false, fee: { arrangement: 'hourly' }, deletedAt: null },
    [`orgs/${ORG}/matters/m-fixed`]: {
      ...meta,
      number: 'M-2026-0043',
      privileged: false,
      fee: { arrangement: 'fixed' },
      deletedAt: null,
    },
    [`orgs/${ORG}/matters/m-gone`]: { ...meta, number: 'M-2026-0044', privileged: false, deletedAt: NOW },
    [`orgs/${ORG}/matters/m-priv`]: { ...meta, number: 'M-2026-0045', privileged: true, deletedAt: null },
    ...initial,
  });
  const clock = new FakeClock(NOW);
  const doc = (path: string) => store.docs.get(path);
  const entries = (matter = M) =>
    [...store.docs.entries()].filter(([path]) => path.startsWith(`${matter}/timeEntries/`)).map(([, data]) => data);
  return { ...store, clock, doc, entries };
}

describe('time-stopTimer', () => {
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
  const call = (
    w: ReturnType<typeof world>,
    data: Record<string, unknown> = {},
    role: Role = 'lawyer',
  ): Promise<StopTimerResult> =>
    runCallable(
      stopTimerDefinition,
      {
        data: { requestId: randomUUID(), narrative: 'Perusing the will', ...data },
        auth: { uid: `user-${role}`, token: { orgId: ORG, role } },
      },
      deps(w),
    ) as Promise<StopTimerResult>;

  it('saves a draft timer entry with the rounded units and deletes the timer', async () => {
    const w = world({ [timerPath('user-lawyer')]: timer({ taskId: 'task-1' }) });
    const result = await call(w, { narrative: '  Perusing the will  ' });
    expect(result).toMatchObject({ matterId: 'm1', minutes: 24 });
    expect(result.entryIds).toHaveLength(1);
    expect(w.entries()).toEqual([
      expect.objectContaining({
        orgId: ORG,
        matterId: 'm1',
        uid: 'user-lawyer',
        date: '2026-10-06',
        minutes: 24,
        units: 4,
        rateCents: 44000,
        amountCents: 17600,
        narrative: 'Perusing the will',
        billable: true,
        status: 'draft',
        source: 'timer',
        taskId: 'task-1',
        wipCountedCents: 0,
        createdBy: 'user-lawyer',
      }),
    ]);
    expect(w.doc(timerPath('user-lawyer'))).toBeUndefined();
  });

  it('adds a paused timer’s accumulated time only, and follows the matter’s billable default', async () => {
    const w = world({
      [timerPath('user-lawyer')]: timer({ matterId: 'm-fixed', running: false, accumulatedMs: 7 * MIN + 31_000 }),
    });
    await call(w);
    expect(w.entries(`orgs/${ORG}/matters/m-fixed`)).toEqual([
      expect.objectContaining({ minutes: 8, units: 2, billable: false }),
    ]);
    const v = world({ [timerPath('user-lawyer')]: timer() });
    await call(v, { billable: false });
    expect(v.entries()[0]).toMatchObject({ billable: false });
  });

  it('keeps the timer when its matter was deleted or is no longer visible, and saves to another matter', async () => {
    const w = world({ [timerPath('user-lawyer')]: timer({ matterId: 'm-gone' }) });
    await expect(call(w)).rejects.toMatchObject({
      code: 'failed-precondition',
      details: expect.objectContaining({ reason: 'timer_matter_unavailable', matterId: 'm-gone' }),
    });
    expect(w.doc(timerPath('user-lawyer'))).toBeDefined();
    // Moved to a live matter: saved there, without the old matter's task.
    const result = await call(w, { matterId: 'm1' });
    expect(result.matterId).toBe('m1');
    expect(w.entries()).toHaveLength(1);
    expect(w.doc(timerPath('user-lawyer'))).toBeUndefined();

    const p = world({ [timerPath('user-paralegal')]: timer({ matterId: 'm-priv', taskId: 't' }) });
    await expect(call(p, {}, 'paralegal')).rejects.toMatchObject({ code: 'failed-precondition' });
    await expect(call(p, { matterId: 'm-missing' }, 'paralegal')).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });

  it('splits a timer over 24 hours into one entry per day, on request', async () => {
    // Started 08:00 on Monday 5 October (Melbourne), 26 hours ago.
    const started = new Date(NOW.getTime() - 26 * HOUR);
    const w = world({ [timerPath('user-lawyer')]: timer({ startedAt: started }) });
    const result = await call(w, { split: true });
    expect(result.entryIds).toHaveLength(2);
    expect(result.minutes).toBe(26 * 60);
    const days = w
      .entries()
      .map((entry) => [entry['date'], entry['minutes']])
      .sort();
    expect(days).toEqual([
      ['2026-10-05', 16 * 60],
      ['2026-10-06', 10 * 60],
    ]);
  });

  it('refuses a single entry over 100 hours, a timer in another org and no timer at all', async () => {
    const w = world({ [timerPath('user-lawyer')]: timer({ running: false, accumulatedMs: 101 * HOUR }) });
    await expect(call(w)).rejects.toMatchObject({ code: 'invalid-argument' });
    const o = world({ [timerPath('user-lawyer')]: timer({ orgId: 'org-b' }) });
    await expect(call(o)).rejects.toMatchObject({ code: 'failed-precondition' });
    await expect(call(world())).rejects.toMatchObject({ code: 'not-found' });
  });

  it('needs time.record', async () => {
    const w = world({ [timerPath('user-readonly')]: timer() });
    await expect(call(w, {}, 'readonly')).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('reads elapsed time from Timestamps, ignoring a start in the future', () => {
    const at = { toDate: () => new Date(NOW.getTime() - 5 * MIN) };
    expect(serverElapsedMs({ startedAt: at, accumulatedMs: MIN, running: true }, NOW)).toBe(6 * MIN);
    expect(serverElapsedMs({ startedAt: new Date(NOW.getTime() + MIN), running: true }, NOW)).toBe(0);
    expect(serverElapsedMs({ running: false }, NOW)).toBe(0);
  });
});

describe('time-flagForgottenTimers', () => {
  const log = createLog({ fn: 'test' }, () => undefined);

  it('flags timers over 10 hours or across midnight once, and notifies their owners', async () => {
    const w = world({
      // Running since 23:00 yesterday (11 hours).
      [timerPath('user-lawyer')]: timer({ startedAt: new Date(NOW.getTime() - 11 * HOUR) }),
      // Running since 08:30 today: fine.
      [timerPath('user-para')]: timer({ startedAt: new Date(NOW.getTime() - 90 * MIN), matterNumber: 'M-2026-0043' }),
      // Paused since yesterday: not running, so not forgotten.
      [timerPath('user-other')]: timer({ running: false, startedAt: new Date(NOW.getTime() - 30 * HOUR) }),
    });
    const tasks = new FakeTaskQueue();
    const first = await checkForgottenTimers(w.db, w.clock, log, { tasks });
    expect(first).toEqual({ checked: 2, flagged: ['user-lawyer'] });
    expect(w.doc(timerPath('user-lawyer'))?.['forgotten']).toMatchObject({ reason: 'long' });
    const notices = [...w.docs.entries()].filter(([path]) => path.startsWith(`orgs/${ORG}/notifications/`));
    expect(notices).toHaveLength(1);
    expect(notices[0]?.[1]).toMatchObject({
      kind: 'system',
      recipientUid: 'user-lawyer',
      title: 'Your timer is still running',
      link: '/matters/m1/time',
    });
    expect(String(notices[0]?.[1]['body'])).toContain('M-2026-0042');

    // Past midnight, the paralegal's timer started yesterday; the lawyer's isn't flagged again.
    w.clock.set(new Date('2026-10-06T13:10:00Z')); // 00:10 Wednesday
    const second = await checkForgottenTimers(w.db, w.clock, log, { tasks });
    expect(second.flagged).toEqual(['user-para']);
    expect(w.doc(timerPath('user-para'))?.['forgotten']).toMatchObject({ reason: 'long' });
    expect(await checkForgottenTimers(w.db, w.clock, log, { tasks })).toMatchObject({ flagged: [] });
  });

  it('flags a short timer that ran across midnight as midnight', async () => {
    const w = world({ [timerPath('user-lawyer')]: timer({ startedAt: new Date('2026-10-06T12:30:00Z') }) });
    w.clock.set(new Date('2026-10-06T13:05:00Z')); // 23:30 to 00:05 Melbourne
    expect((await checkForgottenTimers(w.db, w.clock, log, { tasks: new FakeTaskQueue() })).flagged).toEqual([
      'user-lawyer',
    ]);
    expect(w.doc(timerPath('user-lawyer'))?.['forgotten']).toMatchObject({ reason: 'midnight' });
  });

  it('skips timers without an org and carries on past a failing one', async () => {
    const w = world({
      [timerPath('user-a')]: timer({ orgId: '' }),
      [timerPath('user-lawyer')]: timer({ startedAt: new Date(NOW.getTime() - 11 * HOUR) }),
    });
    const outcome = await checkForgottenTimers(w.db, w.clock, log, {
      tasks: {
        enqueue: async () => {
          throw new Error('queue down');
        },
      },
    });
    expect(outcome.checked).toBe(2);
  });
});
