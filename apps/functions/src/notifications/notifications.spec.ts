import { Notification, NOTIFICATION_BURST_LIMIT, notificationExpiry } from '@materia/domain';

import { DELIVERY_MAX_ATTEMPTS, deliverNotification, RetryDelivery } from './deliver';
import { digestContent, digestModel, runDigests } from './digest';
import { DELIVER_QUEUE, notify, type NotifyInput } from './notify';
import { authorised, classifyPostmarkEvent, handlePostmarkWebhook, WEBHOOK_USER } from './webhook';
import { createLog } from '../core/log';
import { memoryFirestore } from '../orgs/testing';
import { MailError, type MailMessage, type MailPort } from '../ports';
import { FakeClock, FakeMail, FakePush, FakeTaskQueue } from '../ports/fakes';

/** Unit tests for notify(), delivery, the digest and the Postmark webhook (FND-20). All fictional. */

const ORG = 'org-n';
const N = `orgs/${ORG}/notifications`;
// 11:00 on Monday 5 October 2026 in Melbourne (daylight time, UTC+11).
const MORNING = new Date('2026-10-05T00:00:00.000Z');
// 21:00 the same day in Melbourne: quiet hours (19:00–07:00).
const EVENING = new Date('2026-10-05T10:00:00.000Z');
// 07:00 the next morning in Melbourne, when the evening's email may go.
const NEXT_MORNING = new Date('2026-10-05T20:00:00.000Z');

type Data = Record<string, unknown>;
const meta = { createdAt: MORNING, createdBy: 'seed', updatedAt: MORNING, updatedBy: 'seed', schemaVersion: 1 };
const member = (status = 'active', extra: Data = {}) => ({ ...meta, role: 'lawyer', status, ...extra });
const user = (email: string, prefs?: Data, extra: Data = {}) => ({
  ...meta,
  email,
  displayName: 'Fictional Person',
  orgIds: [ORG],
  ...(prefs ? { prefs: { notifications: prefs } } : {}),
  ...extra,
});

function world(docs: Record<string, Data> = {}, now = MORNING) {
  const store = memoryFirestore({
    [`orgs/${ORG}`]: { name: 'Fictional Harbour Legal', timezone: 'Australia/Melbourne' },
    [`orgs/${ORG}/members/user-ada`]: member(),
    [`users/user-ada`]: user('ada.fictional@example.com'),
    [`orgs/${ORG}/members/user-ben`]: member(),
    [`users/user-ben`]: user('ben.fictional@example.com'),
    [`orgs/${ORG}/members/user-gone`]: member('removed'),
    [`users/user-gone`]: user('gone.fictional@example.com'),
    ...docs,
  });
  const clock = new FakeClock(now);
  const tasks = new FakeTaskQueue();
  const mail = new FakeMail();
  const push = new FakePush();
  const logged: { message: string; entry: Data }[] = [];
  const log = createLog({ fn: 'test' }, (_severity, message, entry) => void logged.push({ message, entry }));
  const ctx = { db: store.db, orgId: ORG, clock, log, ports: { tasks } };
  const doc = (path: string) => store.docs.get(path);
  const notifications = () =>
    [...store.docs.entries()]
      .filter(([path]) => path.startsWith(`${N}/`))
      .map(([path, data]): Data => ({ id: path.split('/').at(-1) as string, ...data }));
  const deliver = (notificationId: string, channel: 'email' | 'push', attempt = 0, mailPort: MailPort = mail) =>
    deliverNotification(
      { orgId: ORG, notificationId, channel },
      { db: store.db, ports: { mail: mailPort, push, clock }, log, attempt },
    );
  return { ...store, clock, tasks, mail, push, logged, log, ctx, doc, notifications, deliver };
}

const assigned = (extra: Partial<NotifyInput> = {}): NotifyInput =>
  ({
    kind: 'task_assigned',
    taskId: 't1',
    matterId: 'm1',
    recipients: ['user-ada'],
    title: 'Task assigned to you',
    body: 'Lodge the inventory · BL-2026-0042',
    link: '/matters/m1/tasks',
    ...extra,
  }) as NotifyInput;

/** Nothing personal or from a notification's text reaches the logs. */
function expectCleanLogs(logged: { message: string; entry: Data }[], ...secrets: string[]) {
  const text = JSON.stringify(logged);
  for (const secret of secrets) expect(text).not.toContain(secret);
}

describe('notify()', () => {
  it('writes one in-app notification per recipient and queues email on the kind’s defaults', async () => {
    const w = world();
    const result = await notify(w.ctx, assigned({ key: 'task-e1' }));
    expect(result.ids).toEqual(['task-e1']);
    const stored = w.doc(`${N}/task-e1`);
    expect(stored).toMatchObject({
      kind: 'task_assigned',
      recipientUid: 'user-ada',
      channels: ['inapp', 'email'],
      priority: 'normal',
      readAt: null,
      createdBy: 'system',
      schemaVersion: Notification.version,
    });
    expect(stored?.['deliverAfter']).toBeUndefined();
    // Kept 90 days (CORE-22): Firestore TTL deletes it at `expireAt`.
    const { expireAt, ...payload } = stored ?? {};
    expect((expireAt as { toDate(): Date }).toDate()).toEqual(notificationExpiry(w.ctx.clock.now()));
    expect(Notification.create.safeParse(payload).success).toBe(true);
    expect(w.tasks.queued).toEqual([
      {
        queue: DELIVER_QUEUE,
        payload: { orgId: ORG, notificationId: 'task-e1', channel: 'email' },
        options: { dedupeKey: `notify/${ORG}/task-e1/email` },
      },
    ]);
    expectCleanLogs(w.logged, 'Lodge the inventory', 'ada.fictional@example.com');
  });

  it('leaves out anyone who is no longer an active member, and duplicate or empty recipients', async () => {
    const w = world();
    const result = await notify(
      w.ctx,
      assigned({ recipients: ['user-ada', 'user-gone', 'user-nobody', 'user-ada', ''] }),
    );
    expect(result.ids).toHaveLength(1);
    expect(result.skipped).toEqual([
      { uid: 'user-gone', reason: 'not_member' },
      { uid: 'user-nobody', reason: 'not_member' },
    ]);
    expect(w.notifications().map((n) => n['recipientUid'])).toEqual(['user-ada']);

    const none = await notify(w.ctx, assigned({ recipients: [] }));
    expect(none).toMatchObject({ ids: [], skipped: [], deliveries: [] });
  });

  it('gives several recipients their own id from the key', async () => {
    const w = world();
    const result = await notify(w.ctx, assigned({ recipients: ['user-ada', 'user-ben'], key: 'k1' }));
    expect(result.ids).toEqual(['k1-user-ada', 'k1-user-ben']);
    // Sending the same key again replaces rather than duplicates.
    await notify(w.ctx, assigned({ recipients: ['user-ada', 'user-ben'], key: 'k1' }));
    expect(w.notifications()).toHaveLength(2);
  });

  it('follows the recipient’s preferences: push on, email off, a kind turned off', async () => {
    const w = world({
      [`users/user-ada`]: user('ada.fictional@example.com', { email: false, push: true, digestHour: 7 }),
      [`users/user-ben`]: user('ben.fictional@example.com', {
        email: true,
        push: false,
        digestHour: 7,
        kinds: { task_assigned: { inapp: false, email: false } },
      }),
    });
    const result = await notify(
      w.ctx,
      assigned({ recipients: ['user-ada', 'user-ben'], channels: ['inapp', 'email', 'push'] }),
    );
    expect(result.skipped).toEqual([{ uid: 'user-ben', reason: 'no_channels' }]);
    expect(w.notifications()[0]?.['channels']).toEqual(['inapp', 'push']);
    expect(w.tasks.queued.map((q) => q.payload['channel'])).toEqual(['push']);
  });

  it('keeps to the caller’s channels', async () => {
    const w = world({
      [`users/user-ada`]: user('ada.fictional@example.com', { email: true, push: true, digestHour: 7 }),
    });
    await notify(w.ctx, assigned({ channels: ['inapp'] }));
    expect(w.notifications()[0]?.['channels']).toEqual(['inapp']);
    expect(w.tasks.queued).toEqual([]);
  });

  it('always emails a critical notification, whatever the preferences say', async () => {
    const w = world({
      [`users/user-ada`]: user('ada.fictional@example.com', {
        email: false,
        push: false,
        digestHour: 7,
        kinds: { deadline_escalation: { inapp: false, email: false } },
      }),
    });
    const result = await notify(w.ctx, {
      kind: 'deadline_escalation',
      matterId: 'm1',
      deadlineId: 'd1',
      recipients: ['user-ada'],
      title: 'A critical deadline is due tomorrow',
      body: 'Open the matter to act on it.',
      link: '/matters/m1/deadlines',
    });
    expect(result.ids).toHaveLength(1);
    expect(w.notifications()[0]).toMatchObject({ channels: ['inapp', 'email'], priority: 'critical' });
    expect(w.tasks.queued.map((q) => q.payload['channel'])).toEqual(['email']);
  });

  it('holds email and push until quiet hours end (the recipient’s zone, else the org’s), but not critical', async () => {
    const w = world(
      {
        [`users/user-ada`]: user('ada.fictional@example.com', { email: true, push: true, digestHour: 7 }),
        [`users/user-ben`]: user('ben.fictional@example.com', undefined, { prefs: { timezone: 'Europe/London' } }),
      },
      EVENING,
    );
    await notify(w.ctx, assigned({ channels: ['inapp', 'email', 'push'], key: 'quiet' }));
    expect(w.doc(`${N}/quiet`)?.['deliverAfter']).toEqual(expect.objectContaining({}));
    expect((w.doc(`${N}/quiet`)?.['deliverAfter'] as { toDate(): Date }).toDate()).toEqual(NEXT_MORNING);
    expect(w.tasks.queued.map((q) => [q.payload['channel'], q.options.scheduleTime])).toEqual([
      ['email', NEXT_MORNING],
      ['push', NEXT_MORNING],
    ]);

    // 11:00 in London: not quiet for Ben.
    await notify(w.ctx, assigned({ recipients: ['user-ben'], key: 'london' }));
    expect(w.doc(`${N}/london`)?.['deliverAfter']).toBeUndefined();
    expect(w.tasks.queued.at(-1)?.options.scheduleTime).toBeUndefined();

    await notify(w.ctx, assigned({ key: 'urgent', priority: 'critical' }));
    expect(w.doc(`${N}/urgent`)?.['deliverAfter']).toBeUndefined();
    expect(w.tasks.queued.at(-1)?.options).toEqual({ dedupeKey: `notify/${ORG}/urgent/email` });

    // Quiet hours turned off.
    const off = world(
      {
        [`users/user-ada`]: user('ada.fictional@example.com', {
          email: true,
          push: false,
          digestHour: 7,
          quietHours: null,
        }),
      },
      EVENING,
    );
    await notify(off.ctx, assigned({ key: 'loud' }));
    expect(off.tasks.queued[0]?.options.scheduleTime).toBeUndefined();
  });

  it('collapses more than the burst limit a minute into one summary, in-app only (critical aside)', async () => {
    const recent = Object.fromEntries(
      Array.from({ length: NOTIFICATION_BURST_LIMIT }, (_, i) => [
        `${N}/seed-${String(i).padStart(3, '0')}`,
        { recipientUid: 'user-ada', kind: 'system', createdAt: new Date(MORNING.getTime() - 30_000) },
      ]),
    );
    const w = world(recent);
    const first = await notify(w.ctx, assigned({ key: 'burst-1' }));
    const second = await notify(w.ctx, assigned({ key: 'burst-2' }));
    expect(first).toMatchObject({ ids: [], collapsed: ['burst-1'], deliveries: [] });
    expect(second.collapsed).toEqual(['burst-2']);
    const summaryId = 'burst-user-ada-202610050000';
    expect(w.doc(`${N}/burst-1`)).toMatchObject({ channels: ['inapp'], summaryId });
    expect(w.doc(`${N}/${summaryId}`)).toMatchObject({
      kind: 'system',
      recipientUid: 'user-ada',
      link: '/inbox',
      channels: ['inapp'],
      collapsedCount: 2,
      readAt: null,
    });
    expect(w.tasks.queued).toEqual([]);

    // Ben isn't in a burst; a critical notification to Ada is never collapsed.
    await notify(w.ctx, assigned({ recipients: ['user-ben'], key: 'calm' }));
    await notify(w.ctx, assigned({ key: 'critical', priority: 'critical' }));
    expect(w.doc(`${N}/calm`)?.['summaryId']).toBeNull();
    expect(w.doc(`${N}/critical`)?.['summaryId']).toBeNull();
    expect(w.tasks.queued.map((q) => q.payload['notificationId'])).toEqual(['calm', 'critical']);

    // A minute later the burst is over.
    w.clock.advance(61_000);
    await notify(w.ctx, assigned({ key: 'later' }));
    expect(w.doc(`${N}/later`)?.['summaryId']).toBeNull();
  });

  it('writes in a transaction and queues only when dispatched after it commits', async () => {
    const w = world();
    const result = await w.db.runTransaction((tx) => notify(w.ctx, assigned({ key: 'in-tx' }), { tx }));
    expect(w.doc(`${N}/in-tx`)).toBeDefined();
    expect(w.tasks.queued).toEqual([]);
    await result.dispatch();
    expect(w.tasks.queued).toHaveLength(1);
  });

  it('records a delivery that could not be queued instead of failing', async () => {
    const w = world();
    w.ctx.ports.tasks.enqueue = async () => {
      throw new Error('queue down');
    };
    const result = await notify(w.ctx, assigned({ key: 'unqueued' }));
    expect(result.ids).toEqual(['unqueued']);
    expect(w.doc(`${N}/unqueued`)?.['deliveries']).toEqual([
      expect.objectContaining({ channel: 'email', status: 'failed', reason: 'not_queued', attempt: 0 }),
    ]);
  });
});

describe('deliverNotification()', () => {
  async function sent(w: ReturnType<typeof world>, extra: Partial<NotifyInput> = {}) {
    const result = await notify(w.ctx, assigned({ key: 'n1', ...extra }));
    expect(result.ids).toEqual(['n1']);
    return 'n1';
  }
  const deliveries = (w: ReturnType<typeof world>, id = 'n1') => w.doc(`${N}/${id}`)?.['deliveries'] as Data[];

  it('emails the recipient with the notification template and records it once', async () => {
    const w = world();
    const id = await sent(w);
    expect(await w.deliver(id, 'email')).toEqual({ status: 'sent' });
    expect(w.mail.sent).toEqual([
      {
        to: 'ada.fictional@example.com',
        template: 'notification',
        model: expect.objectContaining({
          title: 'Task assigned to you',
          link: expect.stringMatching(/^https?:\/\/.+\/matters\/m1\/tasks$/),
          kindLabel: 'tasks assigned to you',
          critical: false,
        }),
        idempotencyKey: `notification-${ORG}-n1`,
      },
    ]);
    expect(deliveries(w)).toEqual([
      expect.objectContaining({ channel: 'email', status: 'sent', providerId: 'mail-1', attempt: 0 }),
    ]);
    // A retry of a delivered task does nothing.
    expect(await w.deliver(id, 'email', 1)).toEqual({ status: 'done' });
    expect(w.mail.sent).toHaveLength(1);
    expectCleanLogs(w.logged, 'ada.fictional@example.com', 'Lodge the inventory', 'Task assigned to you');
  });

  it('drops a recipient removed from the org before delivery', async () => {
    const w = world();
    const id = await sent(w);
    await w.db.doc(`orgs/${ORG}/members/user-ada`).update({ status: 'removed' });
    expect(await w.deliver(id, 'email')).toEqual({ status: 'dropped', reason: 'not_member' });
    expect(w.mail.sent).toEqual([]);
    expect(deliveries(w)).toEqual([expect.objectContaining({ status: 'dropped', reason: 'not_member' })]);
  });

  it('skips one already read in-app, unless it is critical', async () => {
    const w = world();
    const id = await sent(w);
    await w.db.doc(`${N}/${id}`).update({ readAt: MORNING });
    expect(await w.deliver(id, 'email')).toEqual({ status: 'skipped', reason: 'read' });

    await notify(w.ctx, assigned({ key: 'n2', priority: 'critical' }));
    await w.db.doc(`${N}/n2`).update({ readAt: MORNING });
    expect(await w.deliver('n2', 'email')).toEqual({ status: 'sent' });
    expect(w.mail.sent[0]?.model['critical']).toBe(true);
  });

  it('skips an account without an address or marked undeliverable, and a missing notification', async () => {
    const w = world({
      [`users/user-ada`]: { ...meta, displayName: 'No Address' },
      [`users/user-ben`]: user('ben.fictional@example.com', undefined, {
        emailDeliverability: { status: 'undeliverable', reason: 'hard_bounce', at: MORNING },
      }),
    });
    await sent(w);
    expect(await w.deliver('n1', 'email')).toEqual({ status: 'skipped', reason: 'no_address' });
    await notify(w.ctx, assigned({ recipients: ['user-ben'], key: 'n2' }));
    expect(await w.deliver('n2', 'email')).toEqual({ status: 'skipped', reason: 'undeliverable' });
    expect(await w.deliver('n-missing', 'email')).toEqual({ status: 'missing' });
    expect(w.mail.sent).toEqual([]);
  });

  it('uses the member’s address when the account has none', async () => {
    const w = world({
      [`users/user-ada`]: { ...meta, displayName: 'Member Only' },
      [`orgs/${ORG}/members/user-ada`]: member('active', { email: 'ada.member@example.com' }),
    });
    await sent(w);
    expect(await w.deliver('n1', 'email')).toEqual({ status: 'sent' });
    expect(w.mail.sent[0]?.to).toBe('ada.member@example.com');
  });

  it('records not_configured as skipped and a rejection as failed, without retrying', async () => {
    const failing = (failure: MailError['failure']): MailPort => ({
      send: async () => {
        throw new MailError(failure);
      },
    });
    const w = world();
    await sent(w);
    expect(await w.deliver('n1', 'email', 0, failing('not_configured'))).toEqual({
      status: 'skipped',
      reason: 'not_configured',
    });
    await notify(w.ctx, assigned({ key: 'n2' }));
    expect(await w.deliver('n2', 'email', 0, failing('inactive_recipient'))).toEqual({
      status: 'failed',
      reason: 'inactive_recipient',
    });
    // A retry after a permanent failure does nothing.
    expect(await w.deliver('n2', 'email', 1)).toEqual({ status: 'done' });
  });

  it('retries a transient failure with backoff, recording each attempt, then gives up', async () => {
    let calls = 0;
    const flaky: MailPort = {
      send: async (message: MailMessage) => {
        calls += 1;
        if (calls < 3) throw calls === 1 ? new MailError('transient') : new Error('socket hang up');
        return { id: `pm-${message.template}` };
      },
    };
    const w = world();
    await sent(w);
    await expect(w.deliver('n1', 'email', 0, flaky)).rejects.toBeInstanceOf(RetryDelivery);
    await expect(w.deliver('n1', 'email', 1, flaky)).rejects.toBeInstanceOf(RetryDelivery);
    expect(await w.deliver('n1', 'email', 2, flaky)).toEqual({ status: 'sent' });
    expect(deliveries(w).map((d) => [d['status'], d['reason'] ?? null, d['attempt']])).toEqual([
      ['failed', 'transient', 0],
      ['failed', 'transient', 1],
      ['sent', null, 2],
    ]);

    const down: MailPort = {
      send: async () => {
        throw new MailError('transient');
      },
    };
    await notify(w.ctx, assigned({ key: 'n2' }));
    expect(await w.deliver('n2', 'email', DELIVERY_MAX_ATTEMPTS - 1, down)).toEqual({
      status: 'failed',
      reason: 'transient',
    });
  });

  it('pushes to every device, prunes invalid tokens and retries only the devices that failed', async () => {
    const w = world({
      [`users/user-ada`]: user('ada.fictional@example.com', { email: true, push: true, digestHour: 7 }),
      [`users/user-ada/devices/d-good`]: { token: 'fake-fcm-token-good', platform: 'web', lastSeenAt: MORNING },
      [`users/user-ada/devices/d-gone`]: { token: 'invalid-fcm-token', platform: 'ios', lastSeenAt: MORNING },
      [`users/user-ada/devices/d-flaky`]: { token: 'flaky-fcm-token', platform: 'android', lastSeenAt: MORNING },
    });
    await sent(w, { channels: ['inapp', 'push'] });
    await expect(w.deliver('n1', 'push')).rejects.toBeInstanceOf(RetryDelivery);
    expect(w.push.sent).toEqual([
      {
        token: 'fake-fcm-token-good',
        message: { title: 'Task assigned to you', body: expect.any(String), link: '/matters/m1/tasks' },
      },
    ]);
    expect(w.doc('users/user-ada/devices/d-gone')).toBeUndefined();
    expect(w.doc('users/user-ada/devices/d-good')).toBeDefined();
    expect(deliveries(w).map((d) => [d['deviceId'], d['status'], d['reason'] ?? null])).toEqual([
      ['d-flaky', 'failed', 'transient'],
      ['d-gone', 'failed', 'invalid_token'],
      ['d-good', 'sent', null],
    ]);

    // The last attempt: the good device isn't pushed again; the flaky one still fails.
    expect(await w.deliver('n1', 'push', DELIVERY_MAX_ATTEMPTS - 1)).toEqual({ status: 'failed', reason: 'transient' });
    expect(w.push.sent).toHaveLength(1);
    expectCleanLogs(w.logged, 'fake-fcm-token-good', 'invalid-fcm-token');
  });

  it('records push with no devices as skipped', async () => {
    const w = world();
    await sent(w, { channels: ['inapp', 'push'] });
    expect(await w.deliver('n1', 'push')).toEqual({ status: 'skipped', reason: 'no_devices' });
  });

  it('records push with only dead tokens as failed, and the devices are gone', async () => {
    const w = world({
      [`users/user-ada/devices/d-1`]: { token: 'invalid-1', platform: 'web', lastSeenAt: MORNING },
      [`users/user-ada/devices/d-2`]: { token: '', platform: 'web', lastSeenAt: MORNING },
    });
    await sent(w);
    expect(await w.deliver('n1', 'push')).toEqual({ status: 'failed', reason: 'no_device_reached' });
    expect(w.doc('users/user-ada/devices/d-1')).toBeUndefined();
    expect(w.doc('users/user-ada/devices/d-2')).toBeUndefined();
  });
});

describe('digest', () => {
  // 07:30 on Tuesday 6 October 2026 in Melbourne.
  const DIGEST_TIME = new Date('2026-10-05T20:30:00.000Z');
  const matter = (number: string, extra: Data = {}) => ({
    ...meta,
    number,
    title: 'Estate of Fictional Person',
    ...extra,
  });
  const deadline = (dueDate: string, extra: Data = {}) => ({
    ...meta,
    orgId: ORG,
    matterId: 'm1',
    assigneeUid: 'user-ada',
    status: 'upcoming',
    title: 'File the inventory',
    dueDate,
    critical: false,
    ...extra,
  });
  const task = (dueDate: string, extra: Data = {}) => ({
    ...meta,
    orgId: ORG,
    matterId: 'm1',
    assigneeUid: 'user-ada',
    status: 'todo',
    title: 'Call the executor',
    dueDate,
    ...extra,
  });
  const M = `orgs/${ORG}/matters`;
  const fixture = {
    [`${M}/m1`]: matter('BL-2026-0042'),
    [`${M}/m2`]: matter('BL-2026-0043', { privileged: true }),
    [`${M}/m3`]: matter('BL-2026-0044', { deletedAt: MORNING }),
    [`${M}/m1/deadlines/d-today`]: deadline('2026-10-06', { critical: true }),
    [`${M}/m1/deadlines/d-late`]: deadline('2026-10-01'),
    [`${M}/m1/deadlines/d-later`]: deadline('2026-10-20'),
    [`${M}/m1/deadlines/d-done`]: deadline('2026-10-06', { status: 'done' }),
    [`${M}/m1/deadlines/d-ben`]: deadline('2026-10-06', { assigneeUid: 'user-ben' }),
    [`${M}/m1/deadlines/d-deleted`]: deadline('2026-10-06', { deletedAt: MORNING }),
    [`${M}/m2/deadlines/d-privileged`]: deadline('2026-10-06', { matterId: 'm2', title: 'Privileged step' }),
    [`${M}/m3/deadlines/d-deleted-matter`]: deadline('2026-10-06', { matterId: 'm3' }),
    [`${M}/m1/tasks/t-late`]: task('2026-10-02'),
    [`${M}/m1/tasks/t-done`]: task('2026-10-02', { status: 'done' }),
    [`orgs/${ORG}/members/user-ada/tasks/t-personal`]: task('2026-10-06', {
      matterId: null,
      title: 'Renew practising certificate',
    }),
    [`${N}/mention-1`]: { recipientUid: 'user-ada', kind: 'mention', readAt: null },
    [`${N}/mention-2`]: { recipientUid: 'user-ada', kind: 'mention', readAt: MORNING },
  };
  const deps = (w: ReturnType<typeof world>, mail: MailPort = w.mail) => ({
    db: w.db,
    clock: w.clock,
    ports: { mail },
    log: w.log,
  });

  it('collects today’s and overdue items and unread mentions, hiding privileged titles', async () => {
    const w = world(fixture, DIGEST_TIME);
    const content = await digestContent(w.db, ORG, 'user-ada', '2026-10-06' as never);
    expect(content.unreadMentions).toBe(1);
    expect(content.dueToday.map((i) => [i.kind, i.title, i.matterNumber, i.critical, i.link])).toEqual([
      ['deadline', 'File the inventory', 'BL-2026-0042', true, '/matters/m1/deadlines'],
      ['deadline', null, 'BL-2026-0043', false, '/matters/m2/deadlines'],
      ['task', 'Renew practising certificate', null, false, '/tasks'],
    ]);
    expect(content.overdue.map((i) => [i.kind, i.dueDate])).toEqual([
      ['deadline', '2026-10-01'],
      ['task', '2026-10-02'],
    ]);
    const model = digestModel(content, '2026-10-06' as never, 'Subject');
    expect(model).toMatchObject({ dateLabel: 'Tuesday 6 October', unreadMentionsLabel: '1 unread mention' });
    expect((model['dueToday'] as Data[])[1]).toMatchObject({ label: 'Deadline on a privileged matter' });
  });

  it('emails each person once on their local day, when their digest hour has come', async () => {
    const w = world(fixture, new Date('2026-10-05T19:00:00.000Z')); // 06:00 in Melbourne
    expect(await runDigests(deps(w))).toEqual({ checked: 2, outcomes: {} });
    expect(w.mail.sent).toEqual([]);

    w.clock.set(DIGEST_TIME);
    const run = await runDigests(deps(w));
    expect(run.outcomes).toEqual({ sent: 2 });
    const ada = w.mail.sent.find((m) => m.to === 'ada.fictional@example.com');
    expect(ada).toMatchObject({ template: 'digest', idempotencyKey: 'digest-user-ada-2026-10-06' });
    expect(ada?.model['subject']).toBe('Your day in Materia: 3 due today, 2 overdue, 1 unread mention');
    expect(w.doc(`orgs/${ORG}/digests/digest-user-ada-2026-10-06`)).toMatchObject({
      uid: 'user-ada',
      date: '2026-10-06',
      status: 'sent',
      counts: { dueToday: 3, overdue: 2, mentions: 1 },
    });

    // The next run (and any after it that day) sends nothing more.
    w.clock.advance(15 * 60_000);
    expect((await runDigests(deps(w))).outcomes).toEqual({});
    expect(w.mail.sent).toHaveLength(2);
    expectCleanLogs(w.logged, 'ada.fictional@example.com', 'File the inventory', 'BL-2026-0042');
  });

  it('sends nothing when there is nothing to report, or the person turned digests or email off', async () => {
    const w = world(
      {
        [`users/user-ben`]: user('ben.fictional@example.com', {
          email: true,
          push: false,
          digestHour: 7,
          digest: false,
        }),
        [`orgs/${ORG}/members/user-cy`]: member(),
        [`users/user-cy`]: user('cy.fictional@example.com', { email: false, push: false, digestHour: 7 }),
      },
      DIGEST_TIME,
    );
    expect(await runDigests(deps(w))).toEqual({ checked: 3, outcomes: { empty: 1 } });
    expect(w.mail.sent).toEqual([]);
    expect(w.doc(`orgs/${ORG}/digests/digest-user-ada-2026-10-06`)).toMatchObject({ status: 'empty' });
  });

  it('uses the person’s time zone over the org’s', async () => {
    const w = world(
      {
        ...fixture,
        [`users/user-ada`]: user('ada.fictional@example.com', undefined, { prefs: { timezone: 'Europe/London' } }),
      },
      DIGEST_TIME, // 21:30 on Monday in London: Monday's digest, with Tuesday's items not yet due.
    );
    await runDigests(deps(w));
    expect(w.doc(`orgs/${ORG}/digests/digest-user-ada-2026-10-05`)).toMatchObject({
      counts: { dueToday: 0, overdue: 2, mentions: 1 },
    });
  });

  it('tries again next run after a transient failure, and records a permanent one', async () => {
    const w = world(fixture, DIGEST_TIME);
    const down: MailPort = {
      send: async () => {
        throw new MailError('transient');
      },
    };
    await runDigests(deps(w, down));
    expect(w.doc(`orgs/${ORG}/digests/digest-user-ada-2026-10-06`)).toBeUndefined();
    const unconfigured: MailPort = {
      send: async () => {
        throw new MailError('not_configured');
      },
    };
    expect((await runDigests(deps(w, unconfigured))).outcomes).toEqual({ skipped: 2 });
    expect(w.doc(`orgs/${ORG}/digests/digest-user-ada-2026-10-06`)).toMatchObject({
      status: 'skipped',
      reason: 'not_configured',
    });

    const other = world(fixture, DIGEST_TIME);
    const rejecting: MailPort = {
      send: async () => {
        throw new MailError('rejected');
      },
    };
    expect((await runDigests(deps(other, rejecting))).outcomes).toEqual({ failed: 2 });
  });

  it('skips accounts without an address or marked undeliverable, and deleted orgs', async () => {
    const w = world(
      {
        ...fixture,
        [`users/user-ada`]: user('ada.fictional@example.com', undefined, {
          emailDeliverability: { status: 'undeliverable', reason: 'spam_complaint', at: MORNING },
        }),
        [`users/user-ben`]: { ...meta, displayName: 'No Address' },
        [`orgs/org-closed`]: { name: 'Closed Fictional Practice', deletedAt: MORNING },
        [`orgs/org-closed/members/user-ada`]: member(),
      },
      DIGEST_TIME,
    );
    expect(await runDigests(deps(w))).toEqual({ checked: 2, outcomes: { skipped: 2 } });
    expect(w.mail.sent).toEqual([]);
  });
});

describe('Postmark webhook', () => {
  const SECRET = 'fictional-webhook-secret';
  const basic = (credentials: string) => `Basic ${Buffer.from(credentials).toString('base64')}`;
  const good = basic(`${WEBHOOK_USER}:${SECRET}`);
  const bounce = (extra: Data = {}) => ({
    RecordType: 'Bounce',
    Type: 'HardBounce',
    Email: 'Ada.Fictional@example.com',
    ID: 42,
    ...extra,
  });
  const call = (
    w: ReturnType<typeof world>,
    body: unknown,
    authorization: string | undefined = good,
    secret = SECRET,
  ) =>
    handlePostmarkWebhook(
      { method: 'POST', authorization, body },
      { db: w.db, clock: w.clock, log: w.log, ports: { tasks: w.tasks }, secret },
    );

  it('checks basic auth against the secret', () => {
    expect(authorised(good, SECRET)).toBe(true);
    expect(authorised(basic(`${WEBHOOK_USER}:wrong`), SECRET)).toBe(false);
    expect(authorised(basic(`someone:${SECRET}`), SECRET)).toBe(false);
    expect(authorised(`Bearer ${SECRET}`, SECRET)).toBe(false);
    expect(authorised(undefined, SECRET)).toBe(false);
    expect(authorised(good, '')).toBe(false);
  });

  it('classifies hard bounces and spam complaints; soft bounces and others mean nothing', () => {
    expect(classifyPostmarkEvent({ RecordType: 'SpamComplaint' })).toBe('spam_complaint');
    expect(classifyPostmarkEvent({ RecordType: 'Bounce', Type: 'HardBounce' })).toBe('hard_bounce');
    expect(classifyPostmarkEvent({ RecordType: 'Bounce', Type: 'BadEmailAddress' })).toBe('hard_bounce');
    expect(classifyPostmarkEvent({ RecordType: 'Bounce', Type: 'SoftBounce', Inactive: true })).toBe('hard_bounce');
    expect(classifyPostmarkEvent({ RecordType: 'Bounce', Type: 'SoftBounce' })).toBeNull();
    expect(classifyPostmarkEvent({ RecordType: 'Delivery' })).toBeNull();
  });

  it('refuses other methods, an unconfigured secret, bad credentials and bad bodies', async () => {
    const w = world();
    expect(
      await handlePostmarkWebhook(
        { method: 'GET', authorization: good, body: {} },
        { db: w.db, clock: w.clock, log: w.log, ports: { tasks: w.tasks }, secret: SECRET },
      ),
    ).toEqual({ status: 405, body: { ok: false } });
    expect((await call(w, bounce(), good, '')).status).toBe(503);
    expect((await call(w, bounce(), basic('postmark:nope'))).status).toBe(401);
    expect((await call(w, bounce(), '')).status).toBe(401);
    expect((await call(w, { nothing: true })).status).toBe(400);
    expect(w.doc('users/user-ada')?.['emailDeliverability']).toBeUndefined();
  });

  it('marks the address undeliverable and tells the person in-app, once', async () => {
    const w = world();
    expect(await call(w, bounce())).toEqual({ status: 200, body: { ok: true, result: 'hard_bounce', users: 1 } });
    expect(w.doc('users/user-ada')?.['emailDeliverability']).toMatchObject({
      status: 'undeliverable',
      reason: 'hard_bounce',
    });
    const [told] = w.notifications();
    expect(told).toMatchObject({
      kind: 'system',
      recipientUid: 'user-ada',
      channels: ['inapp'],
      priority: 'high',
      link: '/settings',
    });
    expect(w.tasks.queued).toEqual([]);
    // Postmark retries and repeats: nothing more.
    expect((await call(w, bounce())).body).toMatchObject({ users: 0 });
    expect(w.notifications()).toHaveLength(1);
    expectCleanLogs(w.logged, 'ada.fictional@example.com', 'Ada.Fictional');
  });

  it('handles spam complaints and acknowledges soft bounces without changing anything', async () => {
    const w = world();
    expect((await call(w, bounce({ Type: 'SoftBounce' }))).body).toEqual({ ok: true, result: 'ignored' });
    expect(w.doc('users/user-ben')?.['emailDeliverability']).toBeUndefined();
    expect((await call(w, { RecordType: 'SpamComplaint', Email: 'ben.fictional@example.com' })).body).toMatchObject({
      result: 'spam_complaint',
      users: 1,
    });
    expect(w.doc('users/user-ben')?.['emailDeliverability']).toMatchObject({ reason: 'spam_complaint' });
    expect((await call(w, { RecordType: 'SpamComplaint', Email: 'nobody@example.com' })).body).toMatchObject({
      users: 0,
    });
  });
});
