import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { getFirestore as getAdminFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';

import { createLog } from '../../src/core/log';
import { FakeClock, FakeTaskQueue } from '../../src/ports/fakes';
import { dispatchOrg } from '../../src/reminders/dispatch';

/**
 * CORE-11 against the emulators. A critical deadline is written as a client would; the deployed
 * `deadlines-onWrite` trigger schedules its first reminder (at the org's pinned emulator clock);
 * then `reminders-dispatch` runs with an injected clock through 31 days of the emulator's
 * Firestore (real collection-group queries and transactions) with a fake task queue. The heartbeat
 * runs over every org, so it is covered by the unit tests instead. Everyone and everything is fictional.
 */
const PROJECT_ID = 'demo-materia';
const ORG = 'org-remind';
const MATTER = `orgs/${ORG}/matters/m-1`;
const DEADLINE = `${MATTER}/deadlines/d-1`;
const N = `orgs/${ORG}/notifications`;
const PEOPLE = ['lawyer', 'partner', 'admin', 'paralegal'] as const;
const uid = (name: string) => `remind-${name}`;
/** 08:00 Melbourne daylight time on a date. */
const at8 = (date: string) => new Date(`${date}T08:00:00+11:00`);

let admin: App;
let db: Firestore;

async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 45_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    value = await read();
  }
  return value;
}

beforeAll(async () => {
  admin = initializeAdminApp({ projectId: PROJECT_ID }, 'reminders-integration-admin');
  db = getAdminFirestore(admin);
  await db.recursiveDelete(db.doc(`orgs/${ORG}`));
  const adminAuth = getAdminAuth(admin);
  for (const name of PEOPLE) {
    await adminAuth.deleteUser(uid(name)).catch(() => undefined);
    await adminAuth.createUser({ uid: uid(name), email: `${uid(name)}@example.test` });
  }
  await db.doc(`orgs/${ORG}`).set({ name: 'Fictional Reminders Practice', timezone: 'Australia/Melbourne' });
  const roles = { lawyer: 'lawyer', partner: 'lawyer', admin: 'admin', paralegal: 'paralegal' };
  for (const name of PEOPLE) {
    await db.doc(`orgs/${ORG}/members/${uid(name)}`).set({
      role: roles[name],
      status: 'active',
      ...(name === 'lawyer' ? { supervisorUid: uid('partner') } : {}),
    });
  }
  await db.doc(MATTER).set({
    number: 'RM-2026-0001',
    title: 'Estate of Fictional Reminder',
    status: 'active',
    responsibleUid: uid('lawyer'),
    privileged: false,
    deletedAt: null,
  });
});

afterAll(async () => {
  await db.doc(`emulatorClock/${ORG}`).delete();
  await deleteAdminApp(admin);
});

describe('reminders-dispatch through the emulators', () => {
  it('schedules on write, then sends exactly five reminders and one escalation over 31 days', async () => {
    // The trigger reads the org's pinned clock: 11:00 on Monday 26 October 2026 in Melbourne.
    await db.doc(`emulatorClock/${ORG}`).set({ now: Timestamp.fromDate(new Date('2026-10-26T00:00:00Z')) });
    await db.doc(DEADLINE).set({
      orgId: ORG,
      matterId: 'm-1',
      title: 'File the fictional affidavit',
      dueDate: '2026-11-26',
      kind: 'court',
      critical: true,
      status: 'upcoming',
      assigneeUid: uid('paralegal'),
      reminders: [],
      pastOnCreation: false,
      deletedAt: null,
    });
    const scheduled = await poll(
      async () => (await db.doc(DEADLINE).get()).get('nextReminderAt') as Timestamp | undefined,
      (value) => !!value,
    );
    expect(scheduled?.toDate().toISOString()).toBe(at8('2026-10-27').toISOString());
    // From here the dispatcher's injected clock decides.
    await db.doc(`emulatorClock/${ORG}`).delete();

    const clock = new FakeClock();
    const tasks = new FakeTaskQueue();
    const log = createLog({ fn: 'integration' }, () => undefined);
    // Around 08:00 Melbourne (21:00 UTC the day before) each day, and once mid-afternoon.
    for (let day = Date.parse('2026-10-26T00:00:00Z'); day <= Date.parse('2026-11-27T00:00:00Z'); day += 86_400_000) {
      for (const hour of [4, 20, 21, 22]) {
        clock.set(new Date(day + hour * 3_600_000));
        await dispatchOrg(db, ORG, clock, log, { tasks });
      }
    }

    const sent = (await db.collection(N).where('kind', '==', 'deadline_reminder').get()).docs;
    const forParalegal = sent
      .filter((doc) => doc.get('recipientUid') === uid('paralegal'))
      .map((doc) => [doc.id, (doc.get('createdAt') as Timestamp).toDate().toISOString()])
      .sort();
    expect(forParalegal).toEqual(
      (
        [
          [1, '2026-11-25'],
          [14, '2026-11-12'],
          [3, '2026-11-23'],
          [30, '2026-10-27'],
          [7, '2026-11-19'],
        ] as const
      ).map(([offset, date]) => [`dlrem-m-1-d-1-${offset}-${uid('paralegal')}`, at8(date).toISOString()]),
    );
    // The responsible lawyer gets each one too.
    expect(sent).toHaveLength(10);

    const escalations = (await db.collection(N).where('kind', '==', 'deadline_escalation').get()).docs;
    expect(escalations.map((doc) => doc.get('recipientUid')).sort()).toEqual([uid('admin'), uid('partner')]);
    expect((await db.doc(DEADLINE).get()).get('escalatedTo')).toEqual([uid('admin'), uid('partner')]);
    // A critical deadline's reminders always go by email too.
    expect(sent.every((doc) => (doc.get('channels') as string[]).includes('email'))).toBe(true);
  });
});
