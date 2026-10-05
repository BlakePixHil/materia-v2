import { randomUUID } from 'node:crypto';

import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut, type Auth } from 'firebase/auth';
import {
  connectFirestoreEmulator,
  doc,
  getFirestore,
  serverTimestamp,
  setDoc,
  updateDoc,
  type Firestore as ClientFirestore,
} from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable, type FunctionsError } from 'firebase/functions';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore as getAdminFirestore, type Firestore } from 'firebase-admin/firestore';

import { computeTimeEntry, wipContribution, type Role, type SetTimeEntryStatusResult } from '@materia/domain';

/**
 * BILL-01 through the emulators: client-created drafts and the time-onWrite trigger (values
 * recomputed over tampered ones, the rate in force on the entry date, matter.wipCents under
 * concurrent edits) and time-setStatus. Everything is fictional.
 */
const PROJECT_ID = 'demo-materia';
const ORG = 'org-time';
const PASSWORD = 'fictional-password-t9';
const MATTER_ID = 'm-time';
const MATTER = `orgs/${ORG}/matters/${MATTER_ID}`;
const ENTRIES = `${MATTER}/timeEntries`;

let admin: App;
let db: Firestore;
let client: FirebaseApp;
let auth: Auth;
let firestore: ClientFirestore;

const uidOf = (role: Role) => `time-${role}`;

async function createMember(role: Role, rates: { effectiveFrom: string; rateCents: number }[]) {
  const adminAuth = getAdminAuth(admin);
  await adminAuth.createUser({ uid: uidOf(role), email: `${uidOf(role)}@example.test`, password: PASSWORD });
  await adminAuth.setCustomUserClaims(uidOf(role), { orgId: ORG, role });
  await db.doc(`orgs/${ORG}/members/${uidOf(role)}`).set({ role, status: 'active', defaultRateCents: 0, rates });
}

async function signInAs(role: Role) {
  await signOut(auth);
  await signInWithEmailAndPassword(auth, `${uidOf(role)}@example.test`, PASSWORD);
}

const setStatus = (data: Record<string, unknown>) =>
  httpsCallable<Record<string, unknown>, SetTimeEntryStatusResult>(
    getFunctions(client, 'australia-southeast1'),
    'time-setStatus',
  )({ requestId: randomUUID(), ...data }).then((result) => result.data);

async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 45_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    value = await read();
  }
  return value;
}

const data = async (path: string) => (await db.doc(path).get()).data() ?? {};

const ORG_BILLING = { unitMinutes: 6, rounding: 'up' as const, defaultRateCents: 30000 };
const LAWYER_RATES = [
  { effectiveFrom: '2026-07-01', rateCents: 44000 },
  { effectiveFrom: '2026-10-15', rateCents: 48000 },
];

/** Whether a live draft carries the values in force (a final entry keeps its snapshot). */
function recomputed(entry: Record<string, unknown>): boolean {
  if (entry['status'] !== 'draft' || entry['deletedAt']) return true;
  const values = computeTimeEntry({
    minutes: entry['minutes'] as number,
    date: entry['date'] as string,
    org: { billing: ORG_BILLING },
    matter: { fee: { arrangement: 'hourly' } },
    member: entry['uid'] === uidOf('lawyer') ? { rates: LAWYER_RATES } : { rates: [] },
  });
  return entry['units'] === values.units && entry['amountCents'] === values.amountCents;
}

/**
 * Waits until the trigger has caught up (every draft recomputed and every entry's count agreeing
 * with its state) and returns the matter's wipCents with what the entries add up to.
 */
async function settledWip(): Promise<{ wip: unknown; expected: number }> {
  let expected = -1;
  const wip = await poll(
    async () => {
      const entries = (await db.collection(ENTRIES).get()).docs.map((d) => d.data());
      expected = entries.reduce((sum, entry) => sum + wipContribution(entry), 0);
      const settled = entries.every(
        (entry) => recomputed(entry) && entry['wipCountedCents'] === wipContribution(entry),
      );
      return settled ? (await data(MATTER))['wipCents'] : Number.NaN;
    },
    (value) => value === expected,
  );
  return { wip, expected };
}

/** What the client's time repository writes for a new draft. */
const clientEntry = (uid: string, extra: Record<string, unknown> = {}) => ({
  orgId: ORG,
  matterId: MATTER_ID,
  uid,
  date: '2026-10-01',
  minutes: 18,
  units: 3,
  rateCents: 44000,
  amountCents: 13200,
  narrative: 'Perusing and considering the will',
  billable: true,
  status: 'draft',
  source: 'manual',
  wipCountedCents: 0,
  createdAt: serverTimestamp(),
  createdBy: uid,
  updatedAt: serverTimestamp(),
  updatedBy: uid,
  schemaVersion: 1,
  ...extra,
});
const stamped = (uid: string, patch: Record<string, unknown>) => ({
  ...patch,
  updatedAt: serverTimestamp(),
  updatedBy: uid,
});

beforeAll(async () => {
  admin = initializeAdminApp({ projectId: PROJECT_ID }, 'time-integration-admin');
  db = getAdminFirestore(admin);
  const adminAuth = getAdminAuth(admin);
  const existing = await adminAuth.listUsers();
  await Promise.all(existing.users.filter((u) => u.uid.startsWith('time-')).map((u) => adminAuth.deleteUser(u.uid)));
  await db.recursiveDelete(db.doc(`orgs/${ORG}`));
  await db.doc(`orgs/${ORG}`).set({
    name: 'Fictional Time Practice',
    timezone: 'Australia/Melbourne',
    billing: { ...ORG_BILLING, gstRegistered: true },
  });
  // The lawyer's rate rises mid-month; the paralegal has no rate (the org default applies).
  await createMember('lawyer', LAWYER_RATES);
  await createMember('paralegal', []);
  await createMember('readonly', []);
  await db.doc(MATTER).set({
    number: 'TM-2026-0001',
    title: 'Estate of Fictional Lark',
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

  client = initializeApp({ projectId: PROJECT_ID, apiKey: 'demo-api-key' }, 'time-integration-client');
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

describe('time-onWrite', () => {
  it('overrides tampered client amounts with the rate in force on the entry date', async () => {
    await signInAs('lawyer');
    const uid = uidOf('lawyer');
    // Values a tampering client might send: a tiny rate and a huge amount.
    await setDoc(
      doc(firestore, `${ENTRIES}/tampered`),
      clientEntry(uid, { units: 1, rateCents: 1, amountCents: 99_999_999 }),
    );
    const fixed = await poll(
      () => data(`${ENTRIES}/tampered`),
      (entry) => entry['amountCents'] === 13200,
    );
    expect(fixed).toMatchObject({ units: 3, rateCents: 44000, amountCents: 13200, wipCountedCents: 13200 });

    // After the mid-month rate change, the entry's own date decides.
    await setDoc(doc(firestore, `${ENTRIES}/later`), clientEntry(uid, { date: '2026-10-20' }));
    const later = await poll(
      () => data(`${ENTRIES}/later`),
      (entry) => entry['rateCents'] === 48000,
    );
    expect(later).toMatchObject({ rateCents: 48000, amountCents: 14400 });

    // An edit that tampers again is corrected again.
    await updateDoc(doc(firestore, `${ENTRIES}/tampered`), stamped(uid, { minutes: 30, amountCents: 5 }));
    const edited = await poll(
      () => data(`${ENTRIES}/tampered`),
      (entry) => entry['amountCents'] === 22000,
    );
    expect(edited).toMatchObject({ units: 5, amountCents: 22000 });
    expect(await settledWip()).toEqual({ wip: 22000 + 14400, expected: 22000 + 14400 });
  });

  it('uses the org default rate for a member without one', async () => {
    await signInAs('paralegal');
    await setDoc(doc(firestore, `${ENTRIES}/para`), clientEntry(uidOf('paralegal'), { minutes: 60 }));
    const entry = await poll(
      () => data(`${ENTRIES}/para`),
      (value) => value['rateCents'] === 30000,
    );
    expect(entry).toMatchObject({ units: 10, rateCents: 30000, amountCents: 30000 });
  });

  it('keeps matter.wipCents exact under concurrent edits', async () => {
    // 25 entries created at once, then every one edited several times concurrently (durations,
    // billable flips, deletes and restores) with the writes racing each other.
    const ids = Array.from({ length: 25 }, (_, i) => `race-${i}`);
    await Promise.all(
      ids.map((id, i) =>
        db.doc(`${ENTRIES}/${id}`).set({
          ...clientEntry(uidOf('lawyer'), { minutes: 6 * (i + 1), units: 0, amountCents: 0 }),
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }),
      ),
    );
    await Promise.all(
      ids.flatMap((id, i) => [
        db.doc(`${ENTRIES}/${id}`).update({ minutes: 12 + i }),
        db.doc(`${ENTRIES}/${id}`).update({ billable: i % 3 !== 0 }),
        i % 5 === 0
          ? db.doc(`${ENTRIES}/${id}`).update({ deletedAt: FieldValue.serverTimestamp(), deletedBy: 'seed' })
          : db.doc(`${ENTRIES}/${id}`).update({ narrative: `Fictional attendance ${i}` }),
      ]),
    );
    const { wip, expected } = await settledWip();
    const race = (await db.collection(ENTRIES).get()).docs.filter((d) => d.id.startsWith('race-'));
    // Every surviving billable race entry was recomputed from its last duration (none were 0).
    expect(race.filter((d) => wipContribution(d.data()) > 0)).toHaveLength(13);
    expect(wip).toBe(expected);
  });

  it('refuses client writes to final entries, and approval goes through time-setStatus', async () => {
    await signInAs('paralegal');
    await expect(setStatus({ matterId: MATTER_ID, entryIds: ['para'], status: 'final' })).rejects.toMatchObject({
      code: 'functions/permission-denied',
    } satisfies Partial<FunctionsError>);

    await signInAs('lawyer');
    expect(await setStatus({ matterId: MATTER_ID, entryIds: ['para', 'missing'], status: 'final' })).toEqual({
      updated: ['para'],
      skipped: ['missing'],
    });
    expect(await data(`${ENTRIES}/para`)).toMatchObject({ status: 'final', amountCents: 30000 });
    await expect(
      updateDoc(doc(firestore, `${ENTRIES}/para`), stamped(uidOf('lawyer'), { narrative: 'Changed after approval' })),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    // Final entries are still work in progress until billed.
    const { wip, expected } = await settledWip();
    expect(wip).toBe(expected);
  });
});
