import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut, type Auth } from 'firebase/auth';
import {
  connectFirestoreEmulator,
  deleteDoc,
  doc,
  getDoc,
  getFirestore,
  serverTimestamp,
  setDoc,
  updateDoc,
  type Firestore as ClientFirestore,
} from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable, type FunctionsError } from 'firebase/functions';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { getFirestore as getAdminFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';

import { PUSH_BODY, PUSH_DEVICE_STALE_DAYS } from '@materia/domain';

import { createLog } from '../../src/core/log';
import { deliverNotification } from '../../src/notifications/deliver';
import { notify } from '../../src/notifications/notify';
import { TEST_PUSH } from '../../src/notifications/test-push';
import { FakeClock, FakeMail, FakePush, FakeTaskQueue } from '../../src/ports/fakes';

/**
 * MOB-04's device registry against the emulators: a signed-in person registers, refreshes and
 * removes their own device through the rules (and can't touch anyone else's), Settings' test push
 * goes through the deployed `notifications-testPush` to the emulator's push outbox, and delivery
 * prunes devices unseen for 60 days and never puts the notification's text on a lock screen.
 * Everyone and everything is fictional.
 */
const PROJECT_ID = 'demo-materia';
const ORG = 'org-push';
const PASSWORD = 'fictional-password-1';
const N = `orgs/${ORG}/notifications`;
const NOW = new Date('2026-10-05T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

let admin: App;
let db: Firestore;
let client: FirebaseApp;
let auth: Auth;
let firestore: ClientFirestore;

const uid = (name: 'ada' | 'ben') => `push-${name}`;
const emailOf = (name: 'ada' | 'ben') => `${uid(name)}@example.test`;
const devicePath = (name: 'ada' | 'ben', deviceId: string) => `users/${uid(name)}/devices/${deviceId}`;

const testPush = (deviceId: string) =>
  httpsCallable<{ deviceId: string }, { sent: true }>(
    getFunctions(client, 'australia-southeast1'),
    'notifications-testPush',
  )({ deviceId });

async function signInAs(name: 'ada' | 'ben') {
  await signOut(auth);
  await signInWithEmailAndPassword(auth, emailOf(name), PASSWORD);
}

/** What PushDevices writes the first time this browser turns push on. */
const registration = (name: 'ada' | 'ben', token: string) => ({
  token,
  platform: 'web',
  label: 'Chrome on macOS',
  lastSeenAt: serverTimestamp(),
  createdAt: serverTimestamp(),
  createdBy: uid(name),
  updatedAt: serverTimestamp(),
  updatedBy: uid(name),
  schemaVersion: 1,
});

async function failure(promise: Promise<unknown>): Promise<{ code?: string; details?: unknown }> {
  try {
    await promise;
  } catch (error) {
    return error as FunctionsError;
  }
  throw new Error('expected the call to fail');
}

async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    value = await read();
  }
  return value;
}

const outboxFor = async (token: string) =>
  (await db.collection('emulatorPushOutbox').where('token', '==', token).get()).docs.map((d) => d.data());

beforeAll(async () => {
  admin = initializeAdminApp({ projectId: PROJECT_ID }, 'push-devices-integration-admin');
  db = getAdminFirestore(admin);
  const adminAuth = getAdminAuth(admin);
  await db.recursiveDelete(db.doc(`orgs/${ORG}`));
  for (const name of ['ada', 'ben'] as const) {
    await db.recursiveDelete(db.doc(`users/${uid(name)}`));
    await adminAuth.deleteUser(uid(name)).catch(() => undefined);
    await adminAuth.createUser({ uid: uid(name), email: emailOf(name), password: PASSWORD });
    await adminAuth.setCustomUserClaims(uid(name), { orgId: ORG, role: 'lawyer' });
  }
  const old = await db
    .collection('emulatorPushOutbox')
    .where('token', '>=', 'push-it-')
    .where('token', '<', 'push-it.')
    .get();
  await Promise.all(old.docs.map((d) => d.ref.delete()));

  await db.doc(`orgs/${ORG}`).set({ name: 'Fictional Push Practice', timezone: 'Australia/Melbourne' });
  for (const name of ['ada', 'ben'] as const) {
    await db.doc(`orgs/${ORG}/members/${uid(name)}`).set({ role: 'lawyer', status: 'active' });
    await db.doc(`users/${uid(name)}`).set({
      email: emailOf(name),
      displayName: `Fictional ${name}`,
      orgIds: [ORG],
      prefs: {
        theme: 'system',
        density: 'comfortable',
        shortcuts: true,
        notifications: { email: false, push: true, digestHour: 7, quietHours: null },
      },
    });
  }

  client = initializeApp({ projectId: PROJECT_ID, apiKey: 'demo-api-key' }, 'push-devices-integration-client');
  auth = getAuth(client);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  firestore = getFirestore(client);
  connectFirestoreEmulator(firestore, '127.0.0.1', 8080);
  connectFunctionsEmulator(getFunctions(client, 'australia-southeast1'), '127.0.0.1', 5001);
});

afterAll(async () => {
  await signOut(auth);
  await deleteApp(client);
  await deleteAdminApp(admin);
});

describe('the device registry', () => {
  it('lets a person register, refresh and remove their own device, and nobody else’s', async () => {
    await signInAs('ada');
    const mine = doc(firestore, devicePath('ada', 'dev-ada-1'));
    await setDoc(mine, registration('ada', 'push-it-ada-1'));
    expect((await getDoc(mine)).data()).toMatchObject({ token: 'push-it-ada-1', label: 'Chrome on macOS' });

    // The daily refresh: FCM handed the browser a new token.
    await updateDoc(mine, {
      token: 'push-it-ada-2',
      lastSeenAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      updatedBy: uid('ada'),
    });
    expect((await db.doc(devicePath('ada', 'dev-ada-1')).get()).get('token')).toBe('push-it-ada-2');

    // A label Settings can't show is refused.
    await expect(
      setDoc(doc(firestore, devicePath('ada', 'dev-ada-2')), { ...registration('ada', 'x'), label: '' }),
    ).rejects.toMatchObject({ code: 'permission-denied' });

    // Someone else's devices are out of reach, both ways.
    await expect(
      setDoc(doc(firestore, devicePath('ben', 'dev-sneaky')), registration('ada', 'push-it-sneaky')),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    await signInAs('ben');
    await expect(getDoc(mine)).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(deleteDoc(mine)).rejects.toMatchObject({ code: 'permission-denied' });

    // Sign-out removes this browser's device.
    await signInAs('ada');
    await deleteDoc(mine);
    expect((await db.doc(devicePath('ada', 'dev-ada-1')).get()).exists).toBe(false);
  });
});

describe('notifications-testPush', () => {
  it('sends a test to the caller’s own device and nothing else', async () => {
    await signInAs('ada');
    await setDoc(doc(firestore, devicePath('ada', 'dev-ada-test')), registration('ada', 'push-it-ada-test'));
    await expect(testPush('dev-ada-test')).resolves.toMatchObject({ data: { sent: true } });
    const sent = await poll(
      () => outboxFor('push-it-ada-test'),
      (found) => found.length > 0,
    );
    expect(sent).toEqual([
      expect.objectContaining({ ...TEST_PUSH, orgId: ORG, tag: 'test-dev-ada-test', token: 'push-it-ada-test' }),
    ]);

    // Ben can't test Ada's device: to him it doesn't exist.
    await signInAs('ben');
    expect(await failure(testPush('dev-ada-test'))).toMatchObject({
      code: 'functions/not-found',
      details: expect.objectContaining({ reason: 'no_device' }),
    });
  });

  it('removes a device whose token is gone and says so', async () => {
    await signInAs('ben');
    await setDoc(doc(firestore, devicePath('ben', 'dev-ben-old')), registration('ben', 'invalid-push-it-ben'));
    expect(await failure(testPush('dev-ben-old'))).toMatchObject({
      code: 'functions/failed-precondition',
      details: expect.objectContaining({ reason: 'invalid_token' }),
    });
    expect((await db.doc(devicePath('ben', 'dev-ben-old')).get()).exists).toBe(false);
  });
});

describe('push delivery', () => {
  it('pushes to every recent device with no client details, and prunes devices unseen for 60 days', async () => {
    await db.recursiveDelete(db.collection(`users/${uid('ben')}/devices`));
    const seen = (daysAgo: number) => Timestamp.fromMillis(NOW.getTime() - daysAgo * DAY);
    const device = (token: string, daysAgo: number) => ({
      token,
      platform: 'web',
      label: 'Chrome on macOS',
      lastSeenAt: seen(daysAgo),
    });
    await db.doc(devicePath('ben', 'd-laptop')).set(device('push-it-laptop', 1));
    await db.doc(devicePath('ben', 'd-phone')).set(device('push-it-phone', PUSH_DEVICE_STALE_DAYS - 1));
    await db.doc(devicePath('ben', 'd-drawer')).set(device('push-it-drawer', PUSH_DEVICE_STALE_DAYS + 1));

    const clock = new FakeClock(NOW);
    const tasks = new FakeTaskQueue();
    const push = new FakePush();
    const logged: string[] = [];
    const log = createLog({ fn: 'push-integration' }, (_severity, message, entry) => {
      logged.push(JSON.stringify({ message, entry }));
    });
    await notify(
      { db, orgId: ORG, clock, log, ports: { tasks } },
      {
        kind: 'deadline_reminder',
        matterId: 'm-push',
        deadlineId: 'd-push',
        recipients: [uid('ben')],
        channels: ['inapp', 'push'],
        title: 'Deadline in 3 days: PX-2026-0001',
        body: 'File the caveat for the Estate of Fictional Whitfield',
        link: '/matters/m-push/deadlines',
        key: 'push-route',
      },
    );
    const outcomes = [];
    for (const { payload } of tasks.queued.splice(0)) {
      outcomes.push(
        await deliverNotification(payload as never, {
          db,
          ports: { mail: new FakeMail(), push, clock },
          log,
          attempt: 0,
        }),
      );
    }
    expect(outcomes).toEqual([{ status: 'sent' }]);

    expect(push.sent.map((p) => p.token).sort()).toEqual(['push-it-laptop', 'push-it-phone']);
    for (const { message } of push.sent) {
      expect(message).toEqual({
        title: 'Deadline in 3 days: PX-2026-0001',
        body: PUSH_BODY,
        link: '/matters/m-push/deadlines',
        orgId: ORG,
        tag: 'push-route',
      });
      expect(JSON.stringify(message)).not.toMatch(/Whitfield|caveat/);
    }
    // In the app, the full text stays.
    expect((await db.doc(`${N}/push-route`).get()).get('body')).toContain('Whitfield');

    expect((await db.doc(devicePath('ben', 'd-drawer')).get()).exists).toBe(false);
    expect((await db.doc(devicePath('ben', 'd-phone')).get()).exists).toBe(true);
    expect(logged.join('\n')).not.toMatch(/Whitfield|push-it-|example\.test/);
  });

  it('records a person whose only devices went quiet as skipped', async () => {
    await db.recursiveDelete(db.collection(`users/${uid('ada')}/devices`));
    await db.doc(devicePath('ada', 'd-old')).set({
      token: 'push-it-old',
      platform: 'android',
      label: 'Chrome on Android',
      lastSeenAt: Timestamp.fromMillis(NOW.getTime() - (PUSH_DEVICE_STALE_DAYS + 5) * DAY),
    });
    const clock = new FakeClock(NOW);
    const tasks = new FakeTaskQueue();
    const push = new FakePush();
    const log = createLog({ fn: 'push-integration' }, () => undefined);
    await notify(
      { db, orgId: ORG, clock, log, ports: { tasks } },
      {
        kind: 'deadline_reminder',
        matterId: 'm-push',
        deadlineId: 'd-push',
        recipients: [uid('ada')],
        channels: ['inapp', 'push'],
        title: 'Deadline tomorrow: PX-2026-0001',
        body: 'Serve the notice',
        link: '/matters/m-push/deadlines',
        key: 'push-quiet',
      },
    );
    for (const { payload } of tasks.queued.splice(0)) {
      await deliverNotification(payload as never, {
        db,
        ports: { mail: new FakeMail(), push, clock },
        log,
        attempt: 0,
      });
    }
    expect(push.sent).toEqual([]);
    expect((await db.doc(devicePath('ada', 'd-old')).get()).exists).toBe(false);
    const deliveries = (await db.doc(`${N}/push-quiet`).get()).get('deliveries') as Record<string, unknown>[];
    expect(deliveries).toEqual([
      expect.objectContaining({ channel: 'push', status: 'skipped', reason: 'inactive_devices' }),
    ]);
  });
});
