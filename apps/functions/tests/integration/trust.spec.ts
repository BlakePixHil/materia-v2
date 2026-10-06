import { randomUUID } from 'node:crypto';

import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut, type Auth } from 'firebase/auth';
import {
  connectFirestoreEmulator,
  doc,
  getDoc,
  getFirestore,
  setDoc,
  type Firestore as ClientFirestore,
} from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable, type FunctionsError } from 'firebase/functions';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore as getAdminFirestore, type Firestore } from 'firebase-admin/firestore';

import { TRUST_CALLABLES, type Role, type TrustSaveResult } from '@materia/domain';

/**
 * BILL-11 through the emulators: trust-recordSnapshot writes the matter's snapshot and its audit
 * entries; only billing roles read it, and no client writes it. Everything is fictional.
 */
const PROJECT_ID = 'demo-materia';
const ORG = 'org-trust';
const PASSWORD = 'fictional-password-t11';
const MATTER_ID = 'm-trust';
const SNAPSHOT = `orgs/${ORG}/trustSnapshots/${MATTER_ID}`;

let admin: App;
let db: Firestore;
let client: FirebaseApp;
let auth: Auth;
let firestore: ClientFirestore;

const uidOf = (role: Role) => `trust-${role}`;

async function createMember(role: Role) {
  const adminAuth = getAdminAuth(admin);
  await adminAuth.createUser({ uid: uidOf(role), email: `${uidOf(role)}@example.test`, password: PASSWORD });
  await adminAuth.setCustomUserClaims(uidOf(role), { orgId: ORG, role });
  await db.doc(`orgs/${ORG}/members/${uidOf(role)}`).set({ role, status: 'active', defaultRateCents: 0, rates: [] });
}

async function signInAs(role: Role) {
  await signOut(auth);
  await signInWithEmailAndPassword(auth, `${uidOf(role)}@example.test`, PASSWORD);
}

const callable = (name: string) => (data: Record<string, unknown>) =>
  httpsCallable<Record<string, unknown>, TrustSaveResult>(
    getFunctions(client, 'australia-southeast1'),
    name,
  )({
    requestId: randomUUID(),
    ...data,
  }).then((result) => result.data);
const recordSnapshot = callable(TRUST_CALLABLES.recordSnapshot);
const updateSettings = callable(TRUST_CALLABLES.updateSettings);

async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    value = await read();
  }
  return value;
}

const audits = async () =>
  (await db.collection(`orgs/${ORG}/audit`).get()).docs
    .map((d) => d.data())
    .filter((entry) => (entry['entity'] as { collection?: string }).collection === 'trustSnapshots');

beforeAll(async () => {
  admin = initializeAdminApp({ projectId: PROJECT_ID }, 'trust-integration-admin');
  db = getAdminFirestore(admin);
  const adminAuth = getAdminAuth(admin);
  const existing = await adminAuth.listUsers();
  await Promise.all(existing.users.filter((u) => u.uid.startsWith('trust-')).map((u) => adminAuth.deleteUser(u.uid)));
  await db.recursiveDelete(db.doc(`orgs/${ORG}`));
  await db.doc(`orgs/${ORG}`).set({
    name: 'Fictional Trust Practice',
    timezone: 'Australia/Melbourne',
    flags: { 'billing.trustDisplay': true },
  });
  await createMember('owner');
  await createMember('lawyer');
  await createMember('paralegal');
  await db.doc(`orgs/${ORG}/matters/${MATTER_ID}`).set({
    number: 'TR-2026-0001',
    title: 'Estate of Fictional Wren',
    type: 'probate',
    status: 'open',
    privileged: false,
    deletedAt: null,
    createdAt: FieldValue.serverTimestamp(),
    createdBy: 'seed',
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: 'seed',
    schemaVersion: 1,
  });

  client = initializeApp({ projectId: PROJECT_ID, apiKey: 'demo-api-key' }, 'trust-integration-client');
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

describe('trust snapshots', () => {
  it('records a snapshot only once the practice turns trust balances on', async () => {
    await signInAs('lawyer');
    const error = (await recordSnapshot({ matterId: MATTER_ID, amountCents: 500_000, asAt: '2026-10-01' }).catch(
      (e: unknown) => e,
    )) as FunctionsError;
    expect(error.details).toMatchObject({ code: 'FAILED_PRECONDITION' });

    await signInAs('owner');
    await expect(
      updateSettings({ settings: { showOnMatters: true, system: 'smokeball', staleAfterDays: 30 } }),
    ).resolves.toEqual({ saved: true });
  });

  it('writes the snapshot and audits each change, which is its history', async () => {
    await signInAs('lawyer');
    await expect(
      recordSnapshot({ matterId: MATTER_ID, amountCents: 8_421_000, asAt: '2026-10-01', note: 'Ledger report' }),
    ).resolves.toEqual({ saved: true });
    await recordSnapshot({ matterId: MATTER_ID, amountCents: 7_900_000, asAt: '2026-10-02' });
    expect((await db.doc(SNAPSHOT).get()).data()).toMatchObject({
      matterId: MATTER_ID,
      amountCents: 7_900_000,
      asAt: '2026-10-02',
      source: 'manual',
      sourceSystemName: 'Smokeball',
      recordedBy: uidOf('lawyer'),
    });
    // Two semantic entries from the callable, and the audit trigger's create and update for the writes.
    const written = (list: Record<string, unknown>[]) =>
      list.filter((e) => ['create', 'update'].includes(String(e['action'])));
    const entries = await poll(audits, (list) => written(list).length >= 2, 20_000);
    const semantic = entries.filter((e) => e['action'] === 'trust.snapshot_recorded');
    expect(semantic.map((e) => e['summary']).sort()).toEqual([
      'Trust balance snapshot recorded',
      'Trust balance snapshot updated',
    ]);
    expect(semantic.find((e) => e['summary'] === 'Trust balance snapshot updated')?.['data']).toMatchObject({
      amountCents: 7_900_000,
      previousAmountCents: 8_421_000,
    });
    expect(written(entries).map((e) => e['action'])).toEqual(expect.arrayContaining(['create', 'update']));
    expect(written(entries).every((e) => e['source'] === 'callable')).toBe(true);
  });

  it('is read by billing roles only, and written by no client', async () => {
    await signInAs('lawyer');
    expect((await getDoc(doc(firestore, SNAPSHOT))).get('amountCents')).toBe(7_900_000);
    await expect(
      setDoc(doc(firestore, SNAPSHOT), { matterId: MATTER_ID, amountCents: 1, asAt: '2026-10-02' }),
    ).rejects.toMatchObject({ code: 'permission-denied' });

    await signInAs('paralegal');
    await expect(getDoc(doc(firestore, SNAPSHOT))).rejects.toMatchObject({ code: 'permission-denied' });
    const error = (await recordSnapshot({ matterId: MATTER_ID, amountCents: 1, asAt: '2026-10-02' }).catch(
      (e: unknown) => e,
    )) as FunctionsError;
    expect(error.code).toBe('functions/permission-denied');
  });
});
