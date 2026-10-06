import { randomUUID } from 'node:crypto';

import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut, type Auth } from 'firebase/auth';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore as getAdminFirestore, type Firestore } from 'firebase-admin/firestore';

import type { Role, UpdateFeeResult } from '@materia/domain';

/**
 * BILL-05 through the emulators: the fees-budgetOn* triggers keep matter.budget from time entries
 * and disbursements, budget alerts go to the responsible lawyer and their supervisor once per
 * threshold per fee revision, and fees-update re-arms them. Everything is fictional.
 */
const PROJECT_ID = 'demo-materia';
const ORG = 'org-fees';
const PASSWORD = 'fictional-password-f5';
const MATTER_ID = 'm-fees';
const MATTER = `orgs/${ORG}/matters/${MATTER_ID}`;

let admin: App;
let db: Firestore;
let client: FirebaseApp;
let auth: Auth;

const uidOf = (role: Role) => `fees-${role}`;
const stamp = { createdBy: 'seed', updatedBy: 'seed', schemaVersion: 1 };

async function createMember(role: Role, extra: Record<string, unknown> = {}) {
  const adminAuth = getAdminAuth(admin);
  await adminAuth.createUser({ uid: uidOf(role), email: `${uidOf(role)}@example.test`, password: PASSWORD });
  await adminAuth.setCustomUserClaims(uidOf(role), { orgId: ORG, role });
  await db.doc(`orgs/${ORG}/members/${uidOf(role)}`).set({
    role,
    status: 'active',
    displayName: `Fictional ${role}`,
    defaultRateCents: 0,
    rates: [],
    ...extra,
  });
}

async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 45_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    value = await read();
  }
  return value;
}

type Budget = { recordedCents?: number; pct?: number; revision?: number; alerted?: number[] };
const budget = async () => ((await db.doc(MATTER).get()).get('budget') ?? {}) as Budget;
const budgetAt = (recordedCents: number) =>
  poll(budget, (b) => b.recordedCents === recordedCents && Array.isArray(b.alerted));
const alerts = async () =>
  (await db.collection(`orgs/${ORG}/notifications`).where('matterId', '==', MATTER_ID).get()).docs
    .map((d) => d.data())
    .filter((n) => n['kind'] === 'budget_alert');

let entry = 0;
/** A final entry keeps its amount (time-onWrite only reprices drafts). */
const addTime = (amountCents: number) =>
  db.doc(`${MATTER}/timeEntries/te-${++entry}`).set({
    ...stamp,
    orgId: ORG,
    matterId: MATTER_ID,
    uid: uidOf('lawyer'),
    date: '2026-10-01',
    minutes: 60,
    units: 10,
    rateCents: amountCents,
    amountCents,
    narrative: 'Fictional attendance',
    billable: true,
    status: 'final',
    source: 'manual',
    wipCountedCents: 0,
    deletedAt: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

beforeAll(async () => {
  admin = initializeAdminApp({ projectId: PROJECT_ID }, 'fees-integration-admin');
  db = getAdminFirestore(admin);
  const adminAuth = getAdminAuth(admin);
  const existing = await adminAuth.listUsers();
  await Promise.all(existing.users.filter((u) => u.uid.startsWith('fees-')).map((u) => adminAuth.deleteUser(u.uid)));
  await db.recursiveDelete(db.doc(`orgs/${ORG}`));
  await db.doc(`orgs/${ORG}`).set({
    name: 'Fictional Fees Practice',
    timezone: 'Australia/Melbourne',
    billing: { unitMinutes: 6, rounding: 'up', defaultRateCents: 30000, gstRegistered: true },
    flags: { 'billing.feeBudgets': true },
  });
  await createMember('owner');
  await createMember('lawyer', { supervisorUid: uidOf('owner') });
  await db.doc(MATTER).set({
    ...stamp,
    number: 'FM-2026-0001',
    title: 'Estate of Fictional Wren',
    type: 'probate',
    status: 'open',
    privileged: false,
    responsibleUid: uidOf('lawyer'),
    fee: { arrangement: 'fixed', amountCents: 100000, history: [] },
    wipCents: 0,
    deletedAt: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  client = initializeApp({ projectId: PROJECT_ID, apiKey: 'demo-api-key' }, 'fees-integration-client');
  auth = getAuth(client);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFunctionsEmulator(getFunctions(client, 'australia-southeast1'), '127.0.0.1', 5001);
});

afterAll(async () => {
  await signOut(auth);
  await deleteApp(client);
  await deleteAdminApp(admin);
});

describe('budget alerts', () => {
  it('fire once per threshold per fee revision, to the responsible lawyer and their supervisor', async () => {
    await addTime(85000);
    expect(await budgetAt(85000)).toMatchObject({ pct: 85, revision: 0, alerted: [80] });
    const first = await poll(alerts, (sent) => sent.length >= 2);
    expect(first.map((n) => n['recipientUid']).sort()).toEqual([uidOf('lawyer'), uidOf('owner')]);
    expect(first[0]).toMatchObject({ title: 'Budget 80% used: FM-2026-0001', link: `/matters/${MATTER_ID}/overview` });

    // More time below 100% fires nothing new, and a disbursement counts ex GST.
    await addTime(10000);
    await db.doc(`${MATTER}/disbursements/d1`).set({
      ...stamp,
      date: '2026-10-02',
      description: 'Probate filing fee',
      amountExGstCents: 2000,
      gstCents: 0,
      gstTreatment: 'gst_free',
      payee: 'Supreme Court of Victoria',
      status: 'final',
      deletedAt: null,
    });
    expect(await budgetAt(97000)).toMatchObject({ pct: 97, alerted: [80] });
    expect(await alerts()).toHaveLength(2);

    // Two writes at once cross 100%: still one alert each.
    await Promise.all([addTime(5000), addTime(5000)]);
    expect(await budgetAt(107000)).toMatchObject({ pct: 107, alerted: [80, 100] });
    expect(await poll(alerts, (sent) => sent.length >= 4)).toHaveLength(4);

    // Revising the fee re-arms the alerts: 107,000 of 150,000 is 71%, then more time passes 80%.
    await signInWithEmailAndPassword(auth, `${uidOf('lawyer')}@example.test`, PASSWORD);
    const update = httpsCallable<Record<string, unknown>, UpdateFeeResult>(
      getFunctions(client, 'australia-southeast1'),
      'fees-update',
    );
    const result = await update({
      requestId: randomUUID(),
      matterId: MATTER_ID,
      fee: { arrangement: 'fixed', amountCents: 150000 },
      reason: 'Caveat lodged against the grant',
    });
    expect(result.data).toEqual({ matterId: MATTER_ID, revision: 1, changed: true });
    expect(await budget()).toMatchObject({ pct: 71, revision: 1, alerted: [] });
    const fee = (await db.doc(MATTER).get()).get('fee');
    expect(fee).toMatchObject({ amountCents: 150000, revision: 1 });
    expect(fee.history).toEqual([
      expect.objectContaining({
        by: uidOf('lawyer'),
        from: { arrangement: 'fixed', amountCents: 100000 },
        to: { arrangement: 'fixed', amountCents: 150000 },
        reason: 'Caveat lodged against the grant',
      }),
    ]);

    await addTime(15000);
    expect(await budgetAt(122000)).toMatchObject({ pct: 81, revision: 1, alerted: [80] });
    expect(await poll(alerts, (sent) => sent.length >= 6)).toHaveLength(6);
    // Five trigger rounds and a callable, each waiting on the Functions emulator (cold starts in CI).
  }, 120_000);
});
