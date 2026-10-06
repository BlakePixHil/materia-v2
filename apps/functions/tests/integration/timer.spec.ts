import { randomUUID } from 'node:crypto';

import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut, type Auth } from 'firebase/auth';
import {
  connectFirestoreEmulator,
  doc,
  getFirestore,
  runTransaction,
  serverTimestamp,
  type Firestore as ClientFirestore,
} from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable, type FunctionsError } from 'firebase/functions';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore as getAdminFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';

import type { StopTimerResult } from '@materia/domain';

import { createLog } from '../../src/core/log';
import { FakeClock, FakeTaskQueue } from '../../src/ports/fakes';
import { checkForgottenTimers } from '../../src/time/forgotten';

/**
 * BILL-02 through the emulators: the forgotten-timer job over the real `timer` collection group
 * (by `running`) and transactions, with an injected clock (10 hours, then midnight in Melbourne)
 * and a fake task queue; two clients starting a timer at the same instant end with one; and
 * `time-stopTimer` saving a draft entry that `time-onWrite` then prices. Everything is fictional.
 */
const PROJECT_ID = 'demo-materia';
const ORG = 'org-timer';
const PASSWORD = 'fictional-password-t2';
const MATTER_ID = 'm-timer';
const MATTER = `orgs/${ORG}/matters/${MATTER_ID}`;
const N = `orgs/${ORG}/notifications`;
const uidOf = (name: string) => `timer-${name}`;
const timerOf = (name: string) => `users/${uidOf(name)}/timer/current`;
const HOUR = 3_600_000;
// 09:00 Melbourne (AEDT) on Tuesday 6 October 2026.
const NINE = new Date('2026-10-05T22:00:00Z');

let admin: App;
let db: Firestore;
let client: FirebaseApp;
let auth: Auth;
let firestore: ClientFirestore;
const log = createLog({ fn: 'timer-integration' }, () => undefined);

async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 45_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    value = await read();
  }
  return value;
}

const seedTimer = (name: string, startedAt: Date, extra: Record<string, unknown> = {}) =>
  db.doc(timerOf(name)).set({
    orgId: ORG,
    matterId: MATTER_ID,
    matterNumber: 'TR-2026-0001',
    startedAt: Timestamp.fromDate(startedAt),
    accumulatedMs: 0,
    running: true,
    narrativeDraft: '',
    lastHeartbeatAt: Timestamp.fromDate(startedAt),
    createdAt: Timestamp.fromDate(startedAt),
    createdBy: uidOf(name),
    updatedAt: Timestamp.fromDate(startedAt),
    updatedBy: uidOf(name),
    schemaVersion: 1,
    ...extra,
  });

const notices = async (name: string) =>
  (await db.collection(N).where('recipientUid', '==', uidOf(name)).get()).docs.map((d) => d.data());

beforeAll(async () => {
  admin = initializeAdminApp({ projectId: PROJECT_ID }, 'timer-integration-admin');
  db = getAdminFirestore(admin);
  const adminAuth = getAdminAuth(admin);
  await db.recursiveDelete(db.doc(`orgs/${ORG}`));
  await db.doc(`orgs/${ORG}`).set({
    name: 'Fictional Timer Practice',
    timezone: 'Australia/Melbourne',
    billing: { unitMinutes: 6, rounding: 'up', defaultRateCents: 30000, gstRegistered: true },
  });
  for (const name of ['lawyer', 'night', 'paused']) {
    await adminAuth.deleteUser(uidOf(name)).catch(() => undefined);
    await adminAuth.createUser({ uid: uidOf(name), email: `${uidOf(name)}@example.test`, password: PASSWORD });
    await adminAuth.setCustomUserClaims(uidOf(name), { orgId: ORG, role: 'lawyer' });
    await db.doc(`orgs/${ORG}/members/${uidOf(name)}`).set({
      role: 'lawyer',
      status: 'active',
      rates: [{ effectiveFrom: '2026-07-01', rateCents: 44000 }],
    });
    await db.recursiveDelete(db.doc(`users/${uidOf(name)}`));
  }
  await db.doc(MATTER).set({
    number: 'TR-2026-0001',
    title: 'Estate of Fictional Wren',
    type: 'probate',
    status: 'open',
    privileged: false,
    fee: { arrangement: 'hourly', history: [] },
    wipCents: 0,
    deletedAt: null,
    createdAt: FieldValue.serverTimestamp(),
    createdBy: 'seed',
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: 'seed',
    schemaVersion: 1,
  });

  client = initializeApp({ projectId: PROJECT_ID, apiKey: 'demo-api-key' }, 'timer-integration-client');
  auth = getAuth(client);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFunctionsEmulator(getFunctions(client, 'australia-southeast1'), '127.0.0.1', 5001);
  firestore = getFirestore(client);
  connectFirestoreEmulator(firestore, '127.0.0.1', 8080);
});

afterAll(async () => {
  await signOut(auth);
  await deleteApp(client);
  await deleteAdminApp(admin);
});

describe('time-flagForgottenTimers', () => {
  it('finds timers over 10 hours and across midnight with a fake clock, flags them once and notifies', async () => {
    // Started at 09:00; one at 23:30 that evening; one paused.
    await seedTimer('lawyer', NINE);
    await seedTimer('night', new Date('2026-10-06T12:30:00Z'));
    await seedTimer('paused', new Date(NINE.getTime() - 20 * HOUR), { running: false, accumulatedMs: HOUR });
    const clock = new FakeClock(new Date(NINE.getTime() + 9 * HOUR));
    const tasks = new FakeTaskQueue();

    // 18:00: nothing yet.
    expect((await checkForgottenTimers(db, clock, log, { tasks })).flagged).toEqual([]);

    // 19:05: the 09:00 timer has run over 10 hours.
    clock.set(new Date(NINE.getTime() + 10 * HOUR + 5 * 60_000));
    const long = await checkForgottenTimers(db, clock, log, { tasks });
    expect(long.flagged).toEqual([uidOf('lawyer')]);
    expect((await db.doc(timerOf('lawyer')).get()).get('forgotten')).toMatchObject({ reason: 'long' });
    expect(await notices('lawyer')).toEqual([
      expect.objectContaining({
        kind: 'system',
        title: 'Your timer is still running',
        link: `/matters/${MATTER_ID}/time`,
        channels: ['inapp'],
      }),
    ]);

    // 00:10 Wednesday: the 23:30 timer ran across midnight; the 09:00 one isn't told twice.
    clock.set(new Date('2026-10-06T13:10:00Z'));
    const midnight = await checkForgottenTimers(db, clock, log, { tasks });
    expect(midnight.flagged).toEqual([uidOf('night')]);
    expect((await db.doc(timerOf('night')).get()).get('forgotten')).toMatchObject({ reason: 'midnight' });
    expect(await notices('lawyer')).toHaveLength(1);
    expect(String((await notices('night'))[0]?.['body'])).toContain('since yesterday');
    expect(await notices('paused')).toEqual([]);
    expect((await db.doc(timerOf('paused')).get()).get('forgotten')).toBeUndefined();
  });
});

describe('starting and stopping', () => {
  const stopTimer = (data: Record<string, unknown>) =>
    httpsCallable<Record<string, unknown>, StopTimerResult>(
      getFunctions(client, 'australia-southeast1'),
      'time-stopTimer',
    )({ requestId: randomUUID(), ...data }).then((result) => result.data);

  /** What the web app writes to start a timer: in a transaction that refuses a second one. */
  const start = (matterNumber: string) =>
    runTransaction(firestore, async (tx) => {
      const ref = doc(firestore, timerOf('lawyer'));
      if ((await tx.get(ref)).exists()) return 'conflict';
      const uid = uidOf('lawyer');
      tx.set(ref, {
        orgId: ORG,
        matterId: MATTER_ID,
        matterNumber,
        startedAt: serverTimestamp(),
        accumulatedMs: 0,
        running: true,
        narrativeDraft: '',
        lastHeartbeatAt: serverTimestamp(),
        createdAt: serverTimestamp(),
        createdBy: uid,
        updatedAt: serverTimestamp(),
        updatedBy: uid,
        schemaVersion: 1,
      });
      return 'started';
    });

  it('two starts at the same instant end with one timer; stopping saves a priced draft and deletes it', async () => {
    await db.recursiveDelete(db.doc(`users/${uidOf('lawyer')}`));
    await signOut(auth);
    await signInWithEmailAndPassword(auth, `${uidOf('lawyer')}@example.test`, PASSWORD);
    const outcomes = await Promise.all([start('TR-2026-0001'), start('TR-2026-0001')]);
    expect(outcomes.sort()).toEqual(['conflict', 'started']);

    // 24 minutes of earlier segments, paused: 4 units at the lawyer's rate.
    await db.doc(timerOf('lawyer')).update({ running: false, accumulatedMs: 24 * 60_000 });
    const result = await stopTimer({ narrative: 'Perusing and considering the will', billable: true });
    expect(result).toMatchObject({ matterId: MATTER_ID, minutes: 24 });
    expect((await db.doc(timerOf('lawyer')).get()).exists).toBe(false);
    const entry = await poll(
      async () => (await db.doc(`${MATTER}/timeEntries/${result.entryIds[0]}`).get()).data(),
      (data) => data?.['wipCountedCents'] === 17600,
    );
    expect(entry).toMatchObject({
      uid: uidOf('lawyer'),
      minutes: 24,
      units: 4,
      amountCents: 17600,
      status: 'draft',
      source: 'timer',
      narrative: 'Perusing and considering the will',
    });

    // Nothing left to stop.
    const error = await stopTimer({ narrative: '' }).catch((e: FunctionsError) => e);
    expect((error as FunctionsError).code).toBe('functions/not-found');
  });
});
