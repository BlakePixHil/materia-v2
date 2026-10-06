import { randomUUID } from 'node:crypto';

import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut, type Auth } from 'firebase/auth';
import { connectFunctionsEmulator, getFunctions, httpsCallable, type FunctionsError } from 'firebase/functions';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore as getAdminFirestore, type Firestore } from 'firebase-admin/firestore';

import {
  ESTATE_CALLABLES,
  ESTATE_INVENTORY_TITLE,
  type ExportInventoryResult,
  type InventorySchedule,
  type Role,
} from '@materia/domain';

/**
 * CORE-16 through the emulators: estate-onWrite and estate-onLiabilityWrite keep the matter's
 * register totals and its gross and net estate values as assets and liabilities are written,
 * edited and soft deleted (assets passing outside the estate stay out of gross), flag a recorded
 * distribution for review when an asset's value changes, and estate-exportInventory queues a
 * `pdf.render` job of the inventory schedule saved as a privileged matter document when the matter
 * is privileged. Everything is fictional.
 */
const PROJECT_ID = 'demo-materia';
const ORG = 'org-estate';
const PASSWORD = 'fictional-password-e16';
const MATTER_ID = 'm-estate';
const MATTER = `orgs/${ORG}/matters/${MATTER_ID}`;

let admin: App;
let db: Firestore;
let client: FirebaseApp;
let auth: Auth;

const uidOf = (role: Role) => `estate-${role}`;

async function createMember(role: Role) {
  const adminAuth = getAdminAuth(admin);
  await adminAuth.createUser({ uid: uidOf(role), email: `${uidOf(role)}@example.test`, password: PASSWORD });
  await adminAuth.setCustomUserClaims(uidOf(role), { orgId: ORG, role });
  await db.doc(`orgs/${ORG}/members/${uidOf(role)}`).set({ role, status: 'active', displayName: `${role} Fictional` });
}

async function signInAs(role: Role) {
  await signOut(auth);
  await signInWithEmailAndPassword(auth, `${uidOf(role)}@example.test`, PASSWORD);
}

function call<T>(name: string, data: Record<string, unknown>) {
  return httpsCallable<Record<string, unknown>, T>(
    getFunctions(client, 'australia-southeast1'),
    name,
  )(data).then((result) => result.data);
}

async function failure(promise: Promise<unknown>): Promise<FunctionsError> {
  try {
    await promise;
  } catch (error) {
    return error as FunctionsError;
  }
  throw new Error('expected the call to fail');
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

const data = async (path: string) => (await db.doc(path).get()).data() ?? {};
const meta = () => ({
  createdAt: FieldValue.serverTimestamp(),
  createdBy: uidOf('lawyer'),
  updatedAt: FieldValue.serverTimestamp(),
  updatedBy: uidOf('lawyer'),
  schemaVersion: 1,
});
const asset = (fields: Record<string, unknown>) => ({
  class: 'bank',
  description: 'Everyday account',
  valueAtDeathCents: 1_000_000,
  jointlyHeld: false,
  passesOutsideEstate: false,
  status: 'valued',
  documentIds: [],
  ...fields,
  ...meta(),
});

const matterDoc = (privileged: boolean) => ({
  number: 'ES-2026-0001',
  title: 'Estate of Fictional Ashby',
  type: 'probate',
  status: 'open',
  jurisdiction: 'VIC',
  responsibleUid: uidOf('lawyer'),
  teamUids: [],
  clientContactIds: ['c-estate'],
  privileged,
  openTaskCount: 0,
  deletedAt: null,
  conflictCheck: { status: 'clear' },
  estate: { grantType: 'probate' },
  createdAt: FieldValue.serverTimestamp(),
  createdBy: 'seed',
  updatedAt: FieldValue.serverTimestamp(),
  updatedBy: 'seed',
  schemaVersion: 1,
});

/** The matter's register totals and estate values, as estate-onWrite keeps them. */
async function totals() {
  const matter = await data(MATTER);
  const register = (matter['estateRegister'] ?? {}) as Record<string, unknown>;
  const estate = (matter['estate'] ?? {}) as Record<string, unknown>;
  return {
    gross: register['grossCents'],
    liabilities: register['liabilitiesCents'],
    net: register['netCents'],
    outside: register['outsideCents'],
    grossValue: estate['grossValueCents'],
    netValue: estate['netValueCents'],
  };
}

beforeAll(async () => {
  admin = initializeAdminApp({ projectId: PROJECT_ID }, 'estate-integration-admin');
  db = getAdminFirestore(admin);
  const adminAuth = getAdminAuth(admin);
  const existing = await adminAuth.listUsers();
  await Promise.all(existing.users.filter((u) => u.uid.startsWith('estate-')).map((u) => adminAuth.deleteUser(u.uid)));
  await db.recursiveDelete(db.doc(`orgs/${ORG}`));
  await db.doc(`orgs/${ORG}`).set({
    name: 'Fictional Estates Practice',
    timezone: 'Australia/Melbourne',
    // The per-org override flags-setOrgOverride writes (FND-23).
    flags: { 'estate.register': true },
  });
  for (const role of ['lawyer', 'paralegal'] as const) await createMember(role);
  await db.doc(MATTER).set(matterDoc(false));

  client = initializeApp({ projectId: PROJECT_ID, apiKey: 'demo-api-key' }, 'estate-integration-client');
  auth = getAuth(client);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFunctionsEmulator(getFunctions(client, 'australia-southeast1'), '127.0.0.1', 5001);
});

afterAll(async () => {
  await signOut(auth);
  await deleteApp(client);
  await deleteAdminApp(admin);
});

describe('estate register', () => {
  it('keeps the matter’s totals in step with its assets and liabilities, and flags distributions', async () => {
    await db.doc(`${MATTER}/assets/a-bank`).set(asset({}));
    await db.doc(`${MATTER}/assets/a-house`).set(
      asset({
        class: 'real_property',
        description: 'Fictional house',
        valueAtDeathCents: 60_000_000,
        jointlyHeld: true,
        jointHolding: 'tenants_in_common',
        shareBps: 5000,
      }),
    );
    await db.doc(`${MATTER}/assets/a-super`).set(
      asset({
        class: 'superannuation',
        description: 'Fictional Super',
        valueAtDeathCents: 9_000_000,
        passesOutsideEstate: true,
      }),
    );
    await db.doc(`${MATTER}/liabilities/l-funeral`).set({
      class: 'funeral',
      creditor: 'Fictional Funerals',
      amountCents: 850_000,
      status: 'paid',
      ...meta(),
    });
    const expected = {
      gross: 31_000_000,
      liabilities: 850_000,
      net: 30_150_000,
      outside: 9_000_000,
      grossValue: 31_000_000,
      netValue: 30_150_000,
    };
    expect(await poll(totals, (t) => t.gross === expected.gross && t.net === expected.net)).toEqual(expected);

    // A residuary gift recorded now is flagged when an asset's value changes later.
    await db.doc(`${MATTER}/distributions/d-residue`).set({
      beneficiaryPartyId: 'beneficiary-c-heir',
      kind: 'residuary',
      share: 'Whole',
      status: 'planned',
      ...meta(),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await db
      .doc(`${MATTER}/assets/a-bank`)
      .update({ valueAtDeathCents: 1_250_000, updatedAt: FieldValue.serverTimestamp() });
    const flagged = await poll(
      () => data(`${MATTER}/distributions/d-residue`),
      (d) => d['needsValueReview'] === true,
    );
    expect(flagged).toMatchObject({ needsValueReview: true, updatedBy: 'system' });
    expect(await poll(totals, (t) => t.gross === 31_250_000)).toMatchObject({ gross: 31_250_000, net: 30_400_000 });

    // A soft-deleted liability leaves the totals; the estate value follows.
    await db
      .doc(`${MATTER}/liabilities/l-funeral`)
      .update({ deletedAt: FieldValue.serverTimestamp(), deletedBy: uidOf('lawyer') });
    expect(await poll(totals, (t) => t.liabilities === 0)).toMatchObject({
      liabilities: 0,
      net: 31_250_000,
      netValue: 31_250_000,
    });
  });

  it('queues the inventory PDF as a pdf.render job saved to the matter’s documents', async () => {
    await signInAs('lawyer');
    const { jobId } = await call<ExportInventoryResult>(ESTATE_CALLABLES.exportInventory, {
      requestId: randomUUID(),
      matterId: MATTER_ID,
    });
    const job = await data(`orgs/${ORG}/jobs/${jobId}`);
    const input = job['input'] as { templateId: string; data: InventorySchedule };
    expect(job).toMatchObject({
      type: 'pdf.render',
      createdBy: uidOf('lawyer'),
      target: {
        kind: 'matter',
        matterId: MATTER_ID,
        category: 'financial',
        privileged: false,
        name: `${ESTATE_INVENTORY_TITLE} - ES-2026-0001.pdf`,
      },
    });
    expect(input.templateId).toBe('estate-inventory');
    expect(input.data.title).toBe(ESTATE_INVENTORY_TITLE);
    expect(input.data.assetGroups.map((group) => [group.label, group.total])).toEqual([
      ['Real property', '$300,000.00'],
      ['Bank accounts', '$12,500.00'],
    ]);
    expect(input.data.outsideGroups.map((group) => group.label)).toEqual(['Superannuation']);
    expect(input.data.footer).toContain('not a court form');
  });

  it('keeps a privileged matter’s inventory privileged, and refuses paralegals', async () => {
    await db.doc(MATTER).update({ privileged: true });
    await signInAs('lawyer');
    const { jobId } = await call<ExportInventoryResult>(ESTATE_CALLABLES.exportInventory, {
      requestId: randomUUID(),
      matterId: MATTER_ID,
    });
    expect((await data(`orgs/${ORG}/jobs/${jobId}`))['target']).toMatchObject({ privileged: true });
    await signInAs('paralegal');
    const refused = await failure(
      call(ESTATE_CALLABLES.exportInventory, { requestId: randomUUID(), matterId: MATTER_ID }),
    );
    expect(['functions/not-found', 'functions/permission-denied']).toContain(refused.code);
    await db.doc(MATTER).update({ privileged: false });
  });
});
