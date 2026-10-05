import type { Timestamp } from 'firebase-admin/firestore';

import { type Role } from '@materia/domain';

import { dispatchAllOrgs, dispatchOrg, HEARTBEAT_PATH, taskReminderDate } from './dispatch';
import { onOrgUpdate } from './on-org-write';
import { reminderCalendar, scheduleChanged } from './schedule';
import { createLog } from '../core/log';
import type { TriggerChange, TriggerContext } from '../core/trigger';
import { onDeadlineWrite } from '../deadlines/on-write';
import { memoryFirestore } from '../orgs/testing';
import { FakeClock, fakePorts } from '../ports/fakes';

/** Unit tests for reminders and escalation (CORE-11). Every org, person and matter is fictional. */

const ORG = 'org-a';
const MATTER = `orgs/${ORG}/matters/m1`;
const DEADLINE = `${MATTER}/deadlines/d1`;
const meta = { createdBy: 'user-lawyer', updatedBy: 'user-lawyer', schemaVersion: 1 };
const member = (role: Role, extra: Record<string, unknown> = {}) => ({ ...meta, role, status: 'active', ...extra });

type Data = Record<string, unknown>;

const HOUR = 3_600_000;
/** 08:00 Melbourne daylight time (UTC+11) on a date, as an instant. */
const at8 = (date: string) => new Date(new Date(`${date}T08:00:00+11:00`).getTime());

function world(deadline: Data = {}, extra: Record<string, Data> = {}) {
  const store = memoryFirestore({
    [`orgs/${ORG}`]: { name: 'Fictional Bayside Legal', timezone: 'Australia/Melbourne' },
    [`orgs/${ORG}/members/user-lawyer`]: member('lawyer', { supervisorUid: 'user-partner' }),
    [`orgs/${ORG}/members/user-partner`]: member('lawyer'),
    [`orgs/${ORG}/members/user-admin`]: member('admin'),
    [`orgs/${ORG}/members/user-paralegal`]: member('paralegal'),
    [MATTER]: {
      ...meta,
      number: 'BL-2026-0042',
      title: 'Estate of Fictional Person',
      status: 'active',
      responsibleUid: 'user-lawyer',
      deletedAt: null,
    },
    [DEADLINE]: {
      ...meta,
      orgId: ORG,
      matterId: 'm1',
      title: 'File the fictional affidavit',
      // Thursday 26 November 2026: 30 days → Tue 27 Oct, 14 → Thu 12 Nov, 7 → Thu 19 Nov,
      // 3 → Mon 23 Nov, 1 → Wed 25 Nov; escalation 3 business days before: Mon 23 Nov.
      dueDate: '2026-11-26',
      kind: 'court',
      critical: true,
      status: 'upcoming',
      assigneeUid: 'user-paralegal',
      reminders: [],
      pastOnCreation: false,
      ...deadline,
    },
    ...extra,
  });
  const clock = new FakeClock(new Date('2026-10-26T00:00:00.000Z'));
  const ports = fakePorts();
  const log = createLog({ fn: 'test' }, () => undefined);
  const doc = (path: string) => store.docs.get(path) as Data | undefined;
  const notifications = () =>
    [...store.docs.entries()]
      .filter(([path]) => path.startsWith(`orgs/${ORG}/notifications/`))
      .map(([path, data]): Data & { id: string } => ({ ...(data as Data), id: path.split('/').at(-1) as string }));
  /** Runs deadlines-onWrite as the trigger would for a write from `before` to the stored deadline. */
  const written = async (before: Data | undefined, path = DEADLINE) => {
    const ref = store.db.doc(path);
    const after = await ref.get();
    const change = {
      before: before ? { exists: true, data: () => before, ref } : undefined,
      after,
    } as unknown as TriggerChange;
    const ctx = {
      eventId: 'e',
      time: clock.now(),
      params: { orgId: ORG, matterId: 'm1', deadlineId: path.split('/').at(-1) },
      log,
      clock,
      db: store.db,
      ports,
    } as unknown as TriggerContext;
    await onDeadlineWrite(ctx, change);
  };
  const dispatch = () => dispatchOrg(store.db, ORG, clock, log, ports);
  return { ...store, clock, ports, log, doc, notifications, written, dispatch };
}

const millis = (value: unknown) => (value as Timestamp | undefined)?.toMillis();

describe('scheduling', () => {
  it('sets nextReminderAt to the first reminder still ahead when a deadline is written', async () => {
    const w = world();
    await w.written(undefined);
    expect(millis(w.doc(DEADLINE)?.['nextReminderAt'])).toBe(at8('2026-10-27').getTime());
  });

  it('removes it when the deadline is done, and ignores edits that don’t touch the schedule', async () => {
    const w = world();
    await w.written(undefined);
    const before = w.doc(DEADLINE) as Data;
    expect(scheduleChanged(before, { ...before, title: 'Renamed' })).toBe(false);
    await w.db.doc(DEADLINE).update({ status: 'done' });
    await w.written(before);
    expect(w.doc(DEADLINE)?.['nextReminderAt']).toBeUndefined();
  });

  it('reschedules every upcoming deadline when the org’s time zone changes', async () => {
    const w = world();
    await w.written(undefined);
    const before = w.doc(`orgs/${ORG}`) as Data;
    await w.db.doc(`orgs/${ORG}`).update({ timezone: 'Australia/Perth' });
    const after = await w.db.doc(`orgs/${ORG}`).get();
    await onOrgUpdate(
      { before: { data: () => before }, after } as unknown as TriggerChange,
      { params: { orgId: ORG }, db: w.db, clock: w.clock, log: w.log } as unknown as TriggerContext,
    );
    // 08:00 in Perth (UTC+8).
    expect(millis(w.doc(DEADLINE)?.['nextReminderAt'])).toBe(new Date('2026-10-27T08:00:00+08:00').getTime());
  });
});

describe('reminders-dispatch over 31 days', () => {
  it('sends exactly the five reminders and one escalation for a critical deadline', async () => {
    const w = world();
    await w.written(undefined);
    for (let t = w.clock.now().getTime(); t <= new Date('2026-11-27T00:00:00Z').getTime(); t += HOUR) {
      w.clock.set(new Date(t));
      await w.dispatch();
    }
    const sent = w.notifications().filter((n) => n['kind'] === 'deadline_reminder');
    // The assignee and the responsible lawyer each get every reminder.
    expect(sent.map((n) => n.id).sort()).toEqual(
      [30, 14, 7, 3, 1].flatMap((o) => [`dlrem-m1-d1-${o}-user-lawyer`, `dlrem-m1-d1-${o}-user-paralegal`]).sort(),
    );
    const times = Object.fromEntries(
      sent.filter((n) => n['recipientUid'] === 'user-paralegal').map((n) => [n.id, millis(n['createdAt'])]),
    );
    expect(times).toEqual({
      'dlrem-m1-d1-30-user-paralegal': at8('2026-10-27').getTime(),
      'dlrem-m1-d1-14-user-paralegal': at8('2026-11-12').getTime(),
      'dlrem-m1-d1-7-user-paralegal': at8('2026-11-19').getTime(),
      'dlrem-m1-d1-3-user-paralegal': at8('2026-11-23').getTime(),
      'dlrem-m1-d1-1-user-paralegal': at8('2026-11-25').getTime(),
    });
    const first = sent.find((n) => n.id === 'dlrem-m1-d1-30-user-paralegal') as Data;
    expect(first).toMatchObject({
      title: 'Deadline in 30 days: BL-2026-0042',
      priority: 'critical',
      link: '/matters/m1/deadlines',
    });

    const escalations = w.notifications().filter((n) => n['kind'] === 'deadline_escalation');
    // The responsible lawyer's supervisor and the admins.
    expect(escalations.map((n) => n['recipientUid']).sort()).toEqual(['user-admin', 'user-partner']);
    expect(escalations.every((n) => millis(n['createdAt']) === at8('2026-11-23').getTime())).toBe(true);
    expect(w.doc(DEADLINE)).toMatchObject({ escalatedTo: ['user-admin', 'user-partner'] });
    expect(w.doc(DEADLINE)?.['nextReminderAt']).toBeUndefined();
    expect((w.doc(DEADLINE)?.['reminders'] as Data[]).every((r) => r['sentAt'])).toBe(true);
  });
});

describe('reminders-dispatch edge cases', () => {
  it('catches up once, marked late, after the scheduler was down, with no duplicates', async () => {
    const w = world();
    await w.written(undefined);
    w.clock.set(new Date('2026-11-20T03:00:00Z')); // after the 30-, 14- and 7-day reminders
    const outcome = await w.dispatch();
    expect(outcome.reminders).toEqual(['m1/d1']);
    const sent = w.notifications().filter((n) => n['kind'] === 'deadline_reminder');
    expect(sent.map((n) => n.id).sort()).toEqual(['dlrem-m1-d1-7-user-lawyer', 'dlrem-m1-d1-7-user-paralegal']);
    expect(sent[0]?.['title']).toBe('Late reminder: deadline in 6 days: BL-2026-0042');
    expect((await w.dispatch()).reminders).toEqual([]);
    expect(millis(w.doc(DEADLINE)?.['nextReminderAt'])).toBe(at8('2026-11-23').getTime());
  });

  it('a deadline moved earlier sends what is left and never resends', async () => {
    const w = world();
    await w.written(undefined);
    for (const day of ['2026-10-27', '2026-11-12']) {
      w.clock.set(at8(day)); // the 30- and 14-day reminders go out
      await w.dispatch();
    }
    w.clock.set(new Date('2026-11-12T00:00:00Z'));
    const before = w.doc(DEADLINE) as Data;
    // Moved to Thursday 19 November: its 7-day reminder (08:00 Thu 12 Nov) is already past.
    await w.db.doc(DEADLINE).update({ dueDate: '2026-11-19' });
    await w.written(before);
    expect(millis(w.doc(DEADLINE)?.['nextReminderAt'])).toBe(at8('2026-11-16').getTime());
    w.clock.set(new Date('2026-11-21T00:00:00Z'));
    await w.dispatch();
    const offsets = w
      .notifications()
      .filter((n) => n['kind'] === 'deadline_reminder' && n['recipientUid'] === 'user-paralegal')
      .map((n) => n.id.split('-')[3]);
    // 30 and 14 once each; then the 3- and 1-day ones, both past, as one late reminder.
    expect(offsets.sort()).toEqual(['1', '14', '30']);
  });

  it('sends to the responsible lawyer and admins when nobody is assigned', async () => {
    const w = world({ assigneeUid: 'user-gone', critical: false });
    await w.written(undefined);
    w.clock.set(at8('2026-11-19'));
    await w.dispatch();
    expect(
      w
        .notifications()
        .map((n) => n['recipientUid'])
        .sort(),
    ).toEqual(['user-admin', 'user-lawyer']);
    expect(w.notifications()[0]).toMatchObject({ priority: 'normal', title: 'Deadline in 7 days: BL-2026-0042' });
  });

  it('skips a closed matter’s reminders but keeps the schedule moving', async () => {
    const w = world();
    await w.written(undefined);
    await w.db.doc(MATTER).update({ status: 'closed' });
    w.clock.set(at8('2026-10-27'));
    const outcome = await w.dispatch();
    expect(outcome.skipped).toEqual(['m1/d1']);
    expect(w.notifications()).toEqual([]);
    expect(millis(w.doc(DEADLINE)?.['nextReminderAt'])).toBe(at8('2026-11-12').getTime());
  });

  it('doesn’t escalate an acknowledged deadline', async () => {
    const w = world({ ackBy: 'user-paralegal', ackAt: new Date('2026-11-20T00:00:00Z') });
    w.clock.set(at8('2026-11-23'));
    expect((await w.dispatch()).escalations).toEqual([]);
  });

  it('doesn’t escalate before its time, or a deadline already past', async () => {
    const w = world();
    w.clock.set(new Date(at8('2026-11-23').getTime() - 60_000));
    expect((await w.dispatch()).escalations).toEqual([]);
    const past = world({ dueDate: '2026-10-20' });
    past.clock.set(new Date('2026-10-26T00:00:00Z'));
    expect((await past.dispatch()).escalations).toEqual([]);
  });
});

describe('task reminders', () => {
  const TASK = `orgs/${ORG}/members/user-lawyer/tasks/t1`;
  const task = (extra: Data = {}) => ({
    [TASK]: {
      ...meta,
      orgId: ORG,
      matterId: null,
      title: 'Call the fictional executor',
      status: 'todo',
      priority: 'none',
      assigneeUid: 'user-lawyer',
      dueDate: '2026-10-29',
      checklist: [],
      order: 1,
      ...extra,
    },
  });

  it('reminds the assignee one business day before, from 08:00, once per due date', async () => {
    const w = world({ status: 'done' }, task());
    w.clock.set(new Date(at8('2026-10-28').getTime() - 60_000));
    expect((await w.dispatch()).taskReminders).toEqual([]);
    w.clock.set(at8('2026-10-28'));
    expect((await w.dispatch()).taskReminders).toEqual(['t1']);
    expect(w.notifications()).toEqual([
      expect.objectContaining({
        id: 'taskrem-t1-2026-10-29',
        kind: 'task_reminder',
        title: 'Task due tomorrow',
        body: 'Call the fictional executor',
        recipientUid: 'user-lawyer',
        link: '/tasks',
      }),
    ]);
    expect(w.doc(TASK)?.['reminderSentFor']).toBe('2026-10-29');
    w.clock.advance(HOUR);
    expect((await w.dispatch()).taskReminders).toEqual([]);
    // A new due date gets its own reminder.
    await w.db.doc(TASK).update({ dueDate: '2026-10-28' });
    expect((await w.dispatch()).taskReminders).toEqual(['t1']);
  });

  it('follows the assignee’s taskReminderDays, on business days', async () => {
    const w = world(
      { status: 'done' },
      {
        ...task({ dueDate: '2026-11-02' }),
        'users/user-lawyer': { prefs: { notifications: { taskReminderDays: 2 } } },
      },
    );
    const cal = await reminderCalendar(w.db, ORG);
    // Two days before Monday 2 November is Saturday: the reminder goes out on Friday.
    expect(taskReminderDate(cal, '2026-11-02' as never, 2)).toBe('2026-10-30');
    w.clock.set(at8('2026-10-30'));
    expect((await w.dispatch()).taskReminders).toEqual(['t1']);
  });

  it('skips done tasks', async () => {
    const w = world({ status: 'done' }, task({ status: 'done' }));
    w.clock.set(at8('2026-10-28'));
    expect((await w.dispatch()).taskReminders).toEqual([]);
  });
});

describe('heartbeat', () => {
  it('records each run for the "reminders not running" alert', async () => {
    const w = world();
    w.clock.set(at8('2026-10-27'));
    expect(await dispatchAllOrgs(w.db, w.clock, w.log, w.ports)).toEqual({ orgs: 1, sent: 0, failed: 0 });
    expect(w.doc(HEARTBEAT_PATH)).toMatchObject({ orgs: 1, sent: 0, failed: 0 });
    expect(millis(w.doc(HEARTBEAT_PATH)?.['lastOkAt'])).toBe(at8('2026-10-27').getTime());
  });
});
