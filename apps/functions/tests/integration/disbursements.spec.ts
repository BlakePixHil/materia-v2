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

import {
  disbursementAmounts,
  disbursementWipContribution,
  type GstTreatment,
  type Role,
  type SetDisbursementStatusResult,
} from '@materia/domain';

/**
 * BILL-04 through the emulators: client-created disbursements and the disbursements-onWrite
 * trigger (GST recomputed over a tampered preview, GST-inclusive entry, matter.disbursementWipCents
 * under concurrent edits, time WIP untouched) and disbursements-setStatus. Everything is fictional.
 */
const PROJECT_ID = 'demo-materia';
const ORG = 'org-disb';
const PASSWORD = 'fictional-password-d4';
const MATTER_ID = 'm-disb';
const MATTER = `orgs/${ORG}/matters/${MATTER_ID}`;
const ITEMS = `${MATTER}/disbursements`;

let admin: App;
let db: Firestore;
let client: FirebaseApp;
let auth: Auth;
let firestore: ClientFirestore;

const uidOf = (role: Role) => `disb-${role}`;

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

const setStatus = (data: Record<string, unknown>) =>
  httpsCallable<Record<string, unknown>, SetDisbursementStatusResult>(
    getFunctions(client, 'australia-southeast1'),
    'disbursements-setStatus',
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

/** Whether an unbilled one carries the amounts its entry and treatment give. */
function recomputed(item: Record<string, unknown>): boolean {
  if (item['status'] !== 'unbilled' || item['deletedAt']) return true;
  const amounts = disbursementAmounts({
    amountExGstCents: item['amountExGstCents'] as number,
    amountIncGstCents: item['amountIncGstCents'] as number | null | undefined,
    gstTreatment: item['gstTreatment'] as GstTreatment,
  });
  return item['amountExGstCents'] === amounts.amountExGstCents && item['gstCents'] === amounts.gstCents;
}

/** Waits for the trigger to catch up, then the matter's total with what the disbursements add up to. */
async function settledWip(): Promise<{ wip: unknown; expected: number }> {
  let expected = -1;
  const wip = await poll(
    async () => {
      const items = (await db.collection(ITEMS).get()).docs.map((d) => d.data());
      expected = items.reduce((sum, item) => sum + disbursementWipContribution(item), 0);
      const settled = items.every(
        (item) => recomputed(item) && item['wipCountedCents'] === disbursementWipContribution(item),
      );
      return settled ? ((await data(MATTER))['disbursementWipCents'] ?? 0) : Number.NaN;
    },
    (value) => value === expected,
  );
  return { wip, expected };
}

/** What the client's disbursement repository writes for a new one. */
const clientItem = (uid: string, extra: Record<string, unknown> = {}) => ({
  orgId: ORG,
  matterId: MATTER_ID,
  date: '2026-10-01',
  description: 'Title search',
  payee: 'Fictional Titles Office',
  category: 'search',
  amountExGstCents: 2_000,
  gstCents: 200,
  amountIncGstCents: null,
  gstTreatment: 'taxable',
  receiptDocumentId: null,
  status: 'unbilled',
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
  admin = initializeAdminApp({ projectId: PROJECT_ID }, 'disbursements-integration-admin');
  db = getAdminFirestore(admin);
  const adminAuth = getAdminAuth(admin);
  const existing = await adminAuth.listUsers();
  await Promise.all(existing.users.filter((u) => u.uid.startsWith('disb-')).map((u) => adminAuth.deleteUser(u.uid)));
  await db.recursiveDelete(db.doc(`orgs/${ORG}`));
  await db.doc(`orgs/${ORG}`).set({
    name: 'Fictional Disbursement Practice',
    timezone: 'Australia/Melbourne',
    billing: { unitMinutes: 6, rounding: 'up', defaultRateCents: 30000, gstRegistered: true },
    flags: { 'billing.disbursements': true },
  });
  await createMember('lawyer');
  await createMember('paralegal');
  await db.doc(MATTER).set({
    number: 'DM-2026-0001',
    title: 'Estate of Fictional Wren',
    type: 'probate',
    status: 'open',
    privileged: false,
    fee: { arrangement: 'hourly', history: [] },
    wipCents: 13_200,
    deletedAt: null,
    createdAt: FieldValue.serverTimestamp(),
    createdBy: 'seed',
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: 'seed',
    schemaVersion: 1,
  });

  client = initializeApp({ projectId: PROJECT_ID, apiKey: 'demo-api-key' }, 'disbursements-integration-client');
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

describe('disbursements-onWrite', () => {
  it('recomputes GST over a tampered preview, and derives ex GST from an inclusive amount', async () => {
    await signInAs('paralegal');
    const uid = uidOf('paralegal');
    await setDoc(doc(firestore, `${ITEMS}/tampered`), clientItem(uid, { gstCents: 0 }));
    expect(
      await poll(
        () => data(`${ITEMS}/tampered`),
        (item) => item['gstCents'] === 200,
      ),
    ).toMatchObject({ amountExGstCents: 2_000, gstCents: 200, wipCountedCents: 2_000 });

    // Paid $11.05 including GST: $10.05 ex GST, and the 1-cent remainder in the GST.
    await setDoc(
      doc(firestore, `${ITEMS}/inclusive`),
      clientItem(uid, { amountIncGstCents: 1_105, amountExGstCents: 1_000, gstCents: 105 }),
    );
    expect(
      await poll(
        () => data(`${ITEMS}/inclusive`),
        (item) => item['amountExGstCents'] === 1_005,
      ),
    ).toMatchObject({ amountExGstCents: 1_005, gstCents: 100 });

    // A GST-free court fee.
    await setDoc(
      doc(firestore, `${ITEMS}/court`),
      clientItem(uid, { description: 'Filing fee', category: 'court_fee', gstTreatment: 'gst_free', gstCents: 0 }),
    );
    expect(await settledWip()).toEqual({ wip: 2_000 + 1_005 + 2_000, expected: 5_005 });
    expect((await data(MATTER))['wipCents']).toBe(13_200);
  });

  it('keeps matter.disbursementWipCents exact under concurrent edits', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `race-${i}`);
    await Promise.all(
      ids.map((id, i) =>
        db.doc(`${ITEMS}/${id}`).set({
          ...clientItem(uidOf('lawyer'), { amountExGstCents: 100 * (i + 1) }),
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }),
      ),
    );
    await Promise.all(
      ids.flatMap((id, i) => [
        db.doc(`${ITEMS}/${id}`).update({ amountExGstCents: 150 + i }),
        db.doc(`${ITEMS}/${id}`).update({ gstTreatment: i % 2 ? 'taxable' : 'gst_free' }),
        i % 4 === 0
          ? db.doc(`${ITEMS}/${id}`).update({ deletedAt: FieldValue.serverTimestamp(), deletedBy: 'seed' })
          : db.doc(`${ITEMS}/${id}`).update({ status: i % 3 ? 'unbilled' : 'written_off' }),
      ]),
    );
    const { wip, expected } = await settledWip();
    expect(wip).toBe(expected);
  });

  it('writes off through disbursements-setStatus, and billed ones are frozen for clients', async () => {
    await signInAs('paralegal');
    await expect(
      setStatus({ matterId: MATTER_ID, disbursementIds: ['tampered'], status: 'written_off' }),
    ).rejects.toMatchObject({ code: 'functions/permission-denied' } satisfies Partial<FunctionsError>);

    await signInAs('lawyer');
    expect(
      await setStatus({ matterId: MATTER_ID, disbursementIds: ['tampered', 'missing'], status: 'written_off' }),
    ).toEqual({ updated: ['tampered'], skipped: ['missing'] });
    let settled = await settledWip();
    expect(settled.wip).toBe(settled.expected);

    await db.doc(`${ITEMS}/court`).update({ status: 'billed', invoiceId: 'inv-fictional-1' });
    await expect(
      updateDoc(doc(firestore, `${ITEMS}/court`), stamped(uidOf('lawyer'), { description: 'Changed after billing' })),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    settled = await settledWip();
    expect(settled.wip).toBe(settled.expected);
  });
});
