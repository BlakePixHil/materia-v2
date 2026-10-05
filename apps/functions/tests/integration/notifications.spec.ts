import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore as getAdminFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';

import { NOTIFICATION_BURST_LIMIT } from '@materia/domain';

import { createLog } from '../../src/core/log';
import { deliverNotification, RetryDelivery } from '../../src/notifications/deliver';
import { runOrgDigests } from '../../src/notifications/digest';
import { DELIVER_QUEUE, notify, type NotifyInput } from '../../src/notifications/notify';
import { handlePostmarkWebhook, WEBHOOK_USER } from '../../src/notifications/webhook';
import { FakeClock, FakeMail, FakePush, FakeTaskQueue } from '../../src/ports/fakes';

/**
 * FND-20 against the emulators. notify(), delivery, the digest and the Postmark webhook run here
 * against the emulator's Firestore (real queries, count aggregations, transforms and transactions)
 * with fake mail, push and task ports and an injected clock; one task assignment goes all the way
 * through the deployed trigger, Cloud Tasks and `notifications-deliver` to the emulator's outbox.
 * Everyone and everything is fictional.
 */
const PROJECT_ID = 'demo-materia';
const ORG = 'org-notify';
const N = `orgs/${ORG}/notifications`;
const M = `orgs/${ORG}/matters`;
// 11:00 on Monday 5 October 2026 in Melbourne.
const MORNING = new Date('2026-10-05T00:00:00.000Z');
// 21:00 the same day: quiet hours; email waits until 07:00 the next morning (20:00 UTC).
const EVENING = new Date('2026-10-05T10:00:00.000Z');
const NEXT_MORNING = new Date('2026-10-05T20:00:00.000Z');
// 07:30 on Tuesday 6 October in Melbourne: digests at the default hour (7) are due.
const DIGEST_TIME = new Date('2026-10-05T20:30:00.000Z');

let admin: App;
let db: Firestore;

const uid = (name: string) => `notify-${name}`;
const emailOf = (name: string) => `${uid(name)}@example.test`;
const PEOPLE = ['ada', 'ben', 'cy', 'gone', 'e2e'] as const;

const data = async (path: string) => (await db.doc(path).get()).data() ?? {};

async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 45_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    value = await read();
  }
  return value;
}

function world(now = MORNING) {
  const clock = new FakeClock(now);
  const tasks = new FakeTaskQueue();
  const mail = new FakeMail();
  const push = new FakePush();
  const logged: string[] = [];
  const log = createLog({ fn: 'integration' }, (_severity, message, entry) => {
    logged.push(JSON.stringify({ message, entry }));
  });
  const ctx = { db, orgId: ORG, clock, log, ports: { tasks } };
  /** Runs every queued delivery once, as Cloud Tasks would. */
  const drain = async (attempt = 0) => {
    const outcomes = [];
    for (const { payload } of tasks.queued.splice(0)) {
      outcomes.push(
        await deliverNotification(payload as never, { db, ports: { mail, push, clock }, log, attempt }).catch(
          (error: unknown) => (error instanceof RetryDelivery ? { status: 'retry' } : Promise.reject(error)),
        ),
      );
    }
    return outcomes;
  };
  return { clock, tasks, mail, push, logged, log, ctx, drain };
}

const assigned = (extra: Partial<NotifyInput> = {}): NotifyInput =>
  ({
    kind: 'task_assigned',
    taskId: 't-1',
    matterId: 'm-1',
    recipients: [uid('ada')],
    title: 'Task assigned to you',
    body: 'Lodge the inventory · NT-2026-0001',
    link: '/matters/m-1/tasks',
    ...extra,
  }) as NotifyInput;

async function setPrefs(name: string, notifications: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  await db
    .doc(`users/${uid(name)}`)
    .set(
      { prefs: { theme: 'system', density: 'comfortable', shortcuts: true, notifications, ...extra } },
      { merge: true },
    );
}

beforeAll(async () => {
  admin = initializeAdminApp({ projectId: PROJECT_ID }, 'notifications-integration-admin');
  db = getAdminFirestore(admin);
  await db.recursiveDelete(db.doc(`orgs/${ORG}`));
  for (const name of PEOPLE) await db.recursiveDelete(db.doc(`users/${uid(name)}`));
  // Real accounts, so auth-syncClaims (which runs on member writes) finds them.
  const adminAuth = getAdminAuth(admin);
  for (const name of PEOPLE) {
    await adminAuth.deleteUser(uid(name)).catch(() => undefined);
    await adminAuth.createUser({ uid: uid(name), email: emailOf(name) });
  }
  const old = await db.collection('emulatorOutbox').where('to', '==', emailOf('e2e')).get();
  await Promise.all(old.docs.map((d) => d.ref.delete()));

  await db.doc(`orgs/${ORG}`).set({ name: 'Fictional Notify Practice', timezone: 'Australia/Melbourne' });
  for (const name of PEOPLE) {
    await db
      .doc(`orgs/${ORG}/members/${uid(name)}`)
      .set({ role: 'lawyer', status: name === 'gone' ? 'removed' : 'active' });
    await db.doc(`users/${uid(name)}`).set({
      email: emailOf(name),
      displayName: `Fictional ${name}`,
      orgIds: [ORG],
      prefs: {
        theme: 'system',
        density: 'comfortable',
        shortcuts: true,
        notifications: { email: true, push: false, digestHour: 7 },
      },
    });
  }
});

afterAll(async () => {
  await deleteAdminApp(admin);
});

beforeEach(async () => {
  await db.recursiveDelete(db.collection(N));
  await db.recursiveDelete(db.collection(`orgs/${ORG}/digests`));
  for (const name of ['ada', 'ben', 'cy'] as const) {
    await setPrefs(name, { email: true, push: false, digestHour: 7 });
    await db
      .doc(`users/${uid(name)}`)
      .update({ emailDeliverability: FieldValue.delete(), 'prefs.timezone': FieldValue.delete() });
  }
});

describe('notify() routing', () => {
  it('writes in-app, emails by default and pushes when the person turned push on', async () => {
    await setPrefs('ben', { email: true, push: true, digestHour: 7 });
    await db.doc(`users/${uid('ben')}/devices/d-1`).set({
      token: 'fake-fcm-token-ben',
      platform: 'web',
      lastSeenAt: Timestamp.fromDate(MORNING),
    });
    const w = world();
    const result = await notify(
      w.ctx,
      assigned({ recipients: [uid('ada'), uid('ben')], channels: ['inapp', 'email', 'push'], key: 'route' }),
    );
    expect(result.ids).toEqual([`route-${uid('ada')}`, `route-${uid('ben')}`]);
    expect(await data(`${N}/route-${uid('ada')}`)).toMatchObject({ channels: ['inapp', 'email'], readAt: null });
    expect(await data(`${N}/route-${uid('ben')}`)).toMatchObject({ channels: ['inapp', 'email', 'push'] });
    expect(w.tasks.queued.map((q) => [q.queue, q.payload['notificationId'], q.payload['channel']])).toEqual([
      [DELIVER_QUEUE, `route-${uid('ada')}`, 'email'],
      [DELIVER_QUEUE, `route-${uid('ben')}`, 'email'],
      [DELIVER_QUEUE, `route-${uid('ben')}`, 'push'],
    ]);

    expect(await w.drain()).toEqual([{ status: 'sent' }, { status: 'sent' }, { status: 'sent' }]);
    expect(w.mail.sent.map((m) => [m.to, m.template])).toEqual([
      [emailOf('ada'), 'notification'],
      [emailOf('ben'), 'notification'],
    ]);
    expect(w.push.sent.map((p) => p.token)).toEqual(['fake-fcm-token-ben']);
    const ben = await data(`${N}/route-${uid('ben')}`);
    expect((ben['deliveries'] as Record<string, unknown>[]).map((d) => [d['channel'], d['status']])).toEqual([
      ['email', 'sent'],
      ['push', 'sent'],
    ]);
    // Nothing personal or from the text in the logs.
    expect(w.logged.join('\n')).not.toMatch(/Lodge the inventory|example\.test|fake-fcm-token/);
  });

  it('holds email until quiet hours end, in the person’s time zone', async () => {
    const w = world(EVENING);
    await notify(w.ctx, assigned({ key: 'quiet' }));
    expect(((await data(`${N}/quiet`))['deliverAfter'] as Timestamp).toDate()).toEqual(NEXT_MORNING);
    expect(w.tasks.queued[0]?.options.scheduleTime).toEqual(NEXT_MORNING);

    // 11:00 in London: not quiet there.
    await setPrefs('cy', { email: true, push: false, digestHour: 7 }, { timezone: 'Europe/London' });
    await notify(w.ctx, assigned({ recipients: [uid('cy')], key: 'london' }));
    expect((await data(`${N}/london`))['deliverAfter']).toBeUndefined();
    expect(w.tasks.queued[1]?.options.scheduleTime).toBeUndefined();
  });

  it('always emails a critical notification, even with email switched off, and at night', async () => {
    await setPrefs('ada', {
      email: false,
      push: false,
      digestHour: 7,
      kinds: { deadline_escalation: { email: false, inapp: false } },
    });
    const w = world(EVENING);
    await notify(w.ctx, {
      kind: 'deadline_escalation',
      matterId: 'm-1',
      deadlineId: 'd-1',
      recipients: [uid('ada')],
      title: 'A critical deadline is due tomorrow',
      body: 'Open the matter to act on it.',
      link: '/matters/m-1/deadlines',
      key: 'critical',
    });
    expect(await data(`${N}/critical`)).toMatchObject({ channels: ['inapp', 'email'], priority: 'critical' });
    expect(w.tasks.queued[0]?.options.scheduleTime).toBeUndefined();
    expect(await w.drain()).toEqual([{ status: 'sent' }]);
    expect(w.mail.sent[0]).toMatchObject({ to: emailOf('ada'), model: expect.objectContaining({ critical: true }) });

    // A non-critical one to the same person goes in-app only.
    await notify(w.ctx, assigned({ key: 'quiet-pref' }));
    expect(await data(`${N}/quiet-pref`)).toMatchObject({ channels: ['inapp'] });
  });

  it('prunes a device whose token FCM reports gone', async () => {
    await setPrefs('cy', { email: false, push: true, digestHour: 7, quietHours: null });
    await db
      .doc(`users/${uid('cy')}/devices/d-good`)
      .set({ token: 'fake-fcm-good', platform: 'ios', lastSeenAt: Timestamp.fromDate(MORNING) });
    await db
      .doc(`users/${uid('cy')}/devices/d-gone`)
      .set({ token: 'invalid-fcm-old', platform: 'web', lastSeenAt: Timestamp.fromDate(MORNING) });
    const w = world();
    await notify(w.ctx, assigned({ recipients: [uid('cy')], channels: ['inapp', 'push'], key: 'prune' }));
    expect(await w.drain()).toEqual([{ status: 'sent' }]);
    expect((await db.doc(`users/${uid('cy')}/devices/d-gone`).get()).exists).toBe(false);
    expect((await db.doc(`users/${uid('cy')}/devices/d-good`).get()).exists).toBe(true);
    const deliveries = (await data(`${N}/prune`))['deliveries'] as Record<string, unknown>[];
    expect(deliveries.map((d) => [d['deviceId'], d['status'], d['reason'] ?? null])).toEqual([
      ['d-gone', 'failed', 'invalid_token'],
      ['d-good', 'sent', null],
    ]);
  });

  it('collapses more than the burst limit a minute into one summary', async () => {
    const batch = db.batch();
    for (let i = 0; i < NOTIFICATION_BURST_LIMIT; i++) {
      batch.set(db.doc(`${N}/seed-${i}`), {
        kind: 'system',
        recipientUid: uid('ben'),
        createdAt: Timestamp.fromMillis(MORNING.getTime() - 20_000),
      });
    }
    await batch.commit();
    const w = world();
    const first = await notify(w.ctx, assigned({ recipients: [uid('ben')], key: 'burst-1' }));
    await notify(w.ctx, assigned({ recipients: [uid('ben')], key: 'burst-2' }));
    expect(first.collapsed).toEqual(['burst-1']);
    const summaryId = `burst-${uid('ben')}-202610050000`;
    expect(await data(`${N}/burst-2`)).toMatchObject({ channels: ['inapp'], summaryId });
    expect(await data(`${N}/${summaryId}`)).toMatchObject({ kind: 'system', collapsedCount: 2, summaryId: null });
    expect(w.tasks.queued).toEqual([]);
    // Ada isn't in a burst.
    await notify(w.ctx, assigned({ key: 'calm' }));
    expect(await data(`${N}/calm`)).toMatchObject({ summaryId: null, channels: ['inapp', 'email'] });
  });

  it('drops a recipient who left the org before delivery, and never writes to a former member', async () => {
    const w = world();
    const result = await notify(w.ctx, assigned({ recipients: [uid('ada'), uid('gone')], key: 'leaving' }));
    expect(result.skipped).toEqual([{ uid: uid('gone'), reason: 'not_member' }]);
    await db.doc(`orgs/${ORG}/members/${uid('ada')}`).update({ status: 'removed' });
    try {
      expect(await w.drain()).toEqual([{ status: 'dropped', reason: 'not_member' }]);
    } finally {
      await db.doc(`orgs/${ORG}/members/${uid('ada')}`).update({ status: 'active' });
    }
    expect(w.mail.sent).toEqual([]);
    expect(((await data(`${N}/leaving-${uid('ada')}`))['deliveries'] as unknown[])[0]).toMatchObject({
      status: 'dropped',
    });
  });

  it('writes inside a transaction and queues only after it commits', async () => {
    const w = world();
    const result = await db.runTransaction(async (tx) => {
      await tx.get(db.doc(`orgs/${ORG}`));
      return notify(w.ctx, assigned({ key: 'in-tx' }), { tx });
    });
    expect((await db.doc(`${N}/in-tx`).get()).exists).toBe(true);
    expect(w.tasks.queued).toEqual([]);
    await result.dispatch();
    expect(w.tasks.queued).toHaveLength(1);
  });
});

describe('notifications-digest', () => {
  const deadline = (dueDate: string, extra: Record<string, unknown> = {}) => ({
    orgId: ORG,
    matterId: 'm-1',
    assigneeUid: uid('ada'),
    status: 'upcoming',
    title: 'File the inventory',
    dueDate,
    critical: false,
    deletedAt: null,
    ...extra,
  });

  beforeAll(async () => {
    await db.doc(`${M}/m-1`).set({ number: 'NT-2026-0001', title: 'Estate of Fictional Notify', privileged: false });
    await db.doc(`${M}/m-1/deadlines/d-today`).set(deadline('2026-10-06', { critical: true }));
    await db.doc(`${M}/m-1/deadlines/d-late`).set(deadline('2026-10-01'));
    await db.doc(`${M}/m-1/deadlines/d-later`).set(deadline('2026-10-30'));
    await db.doc(`${M}/m-1/tasks/t-late`).set({
      orgId: ORG,
      matterId: 'm-1',
      assigneeUid: uid('ada'),
      status: 'in_progress',
      title: 'Call the executor',
      dueDate: '2026-10-02',
      deletedAt: null,
    });
  });

  it('emails once per local day when the digest hour arrives, and nothing when there is nothing to say', async () => {
    await db.doc(`${N}/mention-1`).set({ kind: 'mention', recipientUid: uid('ada'), readAt: null });
    const w = world(new Date('2026-10-05T19:30:00.000Z')); // 06:30 in Melbourne: not yet
    const deps = { db, clock: w.clock, ports: { mail: w.mail }, log: w.log };
    expect((await runOrgDigests(deps, ORG, 'Australia/Melbourne')).outcomes).toEqual({});

    w.clock.set(DIGEST_TIME);
    const run = await runOrgDigests(deps, ORG, 'Australia/Melbourne');
    // Ada has items; Ben and Cy have nothing to report; the e2e member too.
    expect(run.outcomes).toEqual({ sent: 1, empty: 3 });
    expect(w.mail.sent).toHaveLength(1);
    expect(w.mail.sent[0]).toMatchObject({
      to: emailOf('ada'),
      template: 'digest',
      idempotencyKey: `digest-${uid('ada')}-2026-10-06`,
    });
    expect(w.mail.sent[0]?.model['subject']).toBe('Your day in Materia: 1 due today, 2 overdue, 1 unread mention');
    expect(await data(`orgs/${ORG}/digests/digest-${uid('ada')}-2026-10-06`)).toMatchObject({
      status: 'sent',
      counts: { dueToday: 1, overdue: 2, mentions: 1 },
    });
    expect(await data(`orgs/${ORG}/digests/digest-${uid('ben')}-2026-10-06`)).toMatchObject({ status: 'empty' });

    // Every later run that day (each 15 minutes) sends nothing more.
    w.clock.advance(15 * 60_000);
    expect((await runOrgDigests(deps, ORG, 'Australia/Melbourne')).outcomes).toEqual({});
    w.clock.advance(6 * 60 * 60_000);
    expect((await runOrgDigests(deps, ORG, 'Australia/Melbourne')).outcomes).toEqual({});
    expect(w.mail.sent).toHaveLength(1);
    expect(w.logged.join('\n')).not.toMatch(/File the inventory|example\.test|NT-2026-0001/);
  });
});

describe('Postmark bounce webhook', () => {
  const SECRET = 'fictional-webhook-secret';
  const auth = `Basic ${Buffer.from(`${WEBHOOK_USER}:${SECRET}`).toString('base64')}`;

  it('marks the address undeliverable, tells the person in-app, and stops email to it', async () => {
    const w = world();
    const deps = { db, clock: w.clock, log: w.log, ports: { tasks: w.tasks }, secret: SECRET };
    const refused = await handlePostmarkWebhook(
      {
        method: 'POST',
        authorization: 'Basic bm9wZTpub3Bl',
        body: { RecordType: 'Bounce', Type: 'HardBounce', Email: emailOf('cy') },
      },
      deps,
    );
    expect(refused.status).toBe(401);

    const response = await handlePostmarkWebhook(
      {
        method: 'POST',
        authorization: auth,
        body: { RecordType: 'Bounce', Type: 'HardBounce', Email: emailOf('cy').toUpperCase() },
      },
      deps,
    );
    expect(response).toEqual({ status: 200, body: { ok: true, result: 'hard_bounce', users: 1 } });
    expect((await data(`users/${uid('cy')}`))['emailDeliverability']).toMatchObject({ status: 'undeliverable' });
    const told = await db.collection(N).where('recipientUid', '==', uid('cy')).get();
    expect(told.docs.map((d) => d.data())).toEqual([
      expect.objectContaining({ kind: 'system', channels: ['inapp'], priority: 'high', link: '/settings' }),
    ]);

    await notify(w.ctx, assigned({ recipients: [uid('cy')], key: 'after-bounce' }));
    expect(await w.drain()).toEqual([{ status: 'skipped', reason: 'undeliverable' }]);
    expect(w.mail.sent).toEqual([]);
  });
});

describe('end to end through the emulators', () => {
  it('a task assignment reaches the outbox through Cloud Tasks and notifications-deliver', async () => {
    await setPrefs('e2e', { email: true, push: false, digestHour: 7, quietHours: null });
    await db.doc(`${M}/m-e2e`).set({
      number: 'NT-2026-0002',
      title: 'Estate of Fictional Courier',
      type: 'probate',
      status: 'open',
      privileged: false,
      openTaskCount: 0,
      deletedAt: null,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: 'seed',
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: 'seed',
      schemaVersion: 1,
    });
    await db.doc(`${M}/m-e2e/tasks/t-e2e`).set({
      title: 'Collect the original will',
      status: 'todo',
      priority: 'medium',
      checklist: [],
      order: 1024,
      source: 'manual',
      countedOpen: false,
      orgId: ORG,
      matterId: 'm-e2e',
      assigneeUid: uid('e2e'),
      createdAt: FieldValue.serverTimestamp(),
      createdBy: uid('ada'),
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: uid('ada'),
      schemaVersion: 1,
    });
    const outbox = await poll(
      async () =>
        (await db.collection('emulatorOutbox').where('to', '==', emailOf('e2e')).get()).docs.map((d) => d.data()),
      (found) => found.length > 0,
      60_000,
    );
    expect(outbox).toEqual([
      expect.objectContaining({
        template: 'notification',
        model: expect.objectContaining({
          title: 'Task assigned to you',
          link: expect.stringContaining('/matters/m-e2e/tasks'),
        }),
      }),
    ]);
    const notification = await poll(
      async () => (await db.collection(N).where('recipientUid', '==', uid('e2e')).get()).docs.map((d) => d.data()),
      (found) => Array.isArray(found[0]?.['deliveries']),
    );
    expect(notification[0]?.['deliveries']).toEqual([expect.objectContaining({ channel: 'email', status: 'sent' })]);
  }, 90_000);

  it('serves the dev mail page in the emulator, and the webhook refuses while unconfigured', async () => {
    const base = `http://127.0.0.1:5001/${PROJECT_ID}/australia-southeast1`;
    const page = await fetch(`${base}/dev-mail`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Dev mail');
    const hook = await fetch(`${base}/notifications-postmarkWebhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Basic cG9zdG1hcms6' },
      body: JSON.stringify({ RecordType: 'Bounce', Type: 'HardBounce', Email: emailOf('ada') }),
    });
    // No POSTMARK_WEBHOOK_SECRET in the emulator: every call is refused.
    expect(hook.status).toBe(503);
  });
});
