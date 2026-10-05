import { randomUUID } from 'node:crypto';

import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut, type Auth } from 'firebase/auth';
import {
  connectFirestoreEmulator,
  doc,
  getDoc,
  getFirestore,
  serverTimestamp,
  updateDoc,
  type Firestore as ClientFirestore,
} from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable, type FunctionsError } from 'firebase/functions';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore as getAdminFirestore, type Firestore } from 'firebase-admin/firestore';

import {
  SAFE_CUSTODY_CALLABLES,
  type ReceivePacketResult,
  type RecordMovementResult,
  type Role,
} from '@materia/domain';

/**
 * CORE-17 through the emulators: safeCustody-receive numbers packets from the counter; the rules
 * keep clients from writing packets; safeCustody-recordMovement takes a will out, returns it and
 * releases it only with an authority and a lawyer or above; a destruction needs a second lawyer;
 * and safeCustody-onContactWrite tells the responsible lawyer when the testator dies. Everything is
 * fictional.
 */
const PROJECT_ID = 'demo-materia';
const ORG = 'org-safe-custody';
const PASSWORD = 'fictional-password-c17';
const MATTER = `orgs/${ORG}/matters/m-sc-will`;
const AUTHORITY = { matterId: 'm-sc-will', documentId: 'd-sc-authority' };
const LOCATION = { site: 'Geelong', cabinet: 'Safe A', slot: '2' };

let admin: App;
let db: Firestore;
let client: FirebaseApp;
let auth: Auth;
let firestore: ClientFirestore;

const uidOf = (role: Role) => `sc-${role}`;
const seedMeta = () => ({
  createdAt: FieldValue.serverTimestamp(),
  createdBy: 'seed',
  updatedAt: FieldValue.serverTimestamp(),
  updatedBy: 'seed',
  schemaVersion: 1,
});

async function createMember(role: Role) {
  const adminAuth = getAdminAuth(admin);
  await adminAuth.createUser({ uid: uidOf(role), email: `${uidOf(role)}@example.test`, password: PASSWORD });
  await adminAuth.setCustomUserClaims(uidOf(role), { orgId: ORG, role });
  await db.doc(`orgs/${ORG}/members/${uidOf(role)}`).set({ role, status: 'active', displayName: `Fictional ${role}` });
}

async function signInAs(role: Role) {
  await signOut(auth);
  await signInWithEmailAndPassword(auth, `${uidOf(role)}@example.test`, PASSWORD);
}

function call<T>(name: string, data: Record<string, unknown>) {
  return httpsCallable<Record<string, unknown>, T>(
    getFunctions(client, 'australia-southeast1'),
    name,
  )({ requestId: randomUUID(), ...data }).then((result) => result.data);
}
const receive = (data: Record<string, unknown> = {}) =>
  call<ReceivePacketResult>(SAFE_CUSTODY_CALLABLES.receive, {
    testatorContactId: 'c-sc-wren',
    items: [{ kind: 'will', date: '2019-02-14', description: 'Last will' }],
    location: LOCATION,
    receivedOn: '2019-03-01',
    ...data,
  });
const move = (id: string, data: Record<string, unknown>) =>
  call<RecordMovementResult>(SAFE_CUSTODY_CALLABLES.recordMovement, { id, ...data });

async function failure(promise: Promise<unknown>): Promise<FunctionsError> {
  try {
    await promise;
  } catch (error) {
    return error as FunctionsError;
  }
  throw new Error('expected the call to fail');
}
const detailsOf = (error: FunctionsError) => (error.details ?? {}) as Record<string, unknown>;

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

beforeAll(async () => {
  admin = initializeAdminApp({ projectId: PROJECT_ID }, 'safe-custody-integration-admin');
  db = getAdminFirestore(admin);
  const adminAuth = getAdminAuth(admin);
  const existing = await adminAuth.listUsers();
  await Promise.all(existing.users.filter((u) => u.uid.startsWith('sc-')).map((u) => adminAuth.deleteUser(u.uid)));
  await db.recursiveDelete(db.doc(`orgs/${ORG}`));
  await db.doc(`orgs/${ORG}`).set({ name: 'Fictional Custody Practice', timezone: 'Australia/Melbourne' });
  for (const role of ['owner', 'lawyer', 'paralegal'] as const) await createMember(role);
  await db.doc(`orgs/${ORG}/contacts/c-sc-wren`).set({
    kind: 'person',
    givenNames: 'Ada',
    familyName: 'Wren',
    emails: [],
    phones: [],
    addresses: [],
    tags: [],
    ...seedMeta(),
  });
  await db.doc(MATTER).set({
    number: 'SC-M-0001',
    title: 'Will of Fictional Wren',
    type: 'will',
    status: 'open',
    privileged: false,
    deletedAt: null,
    ...seedMeta(),
  });
  await db.doc(`${MATTER}/documents/d-sc-authority`).set({
    name: 'Signed authority.pdf',
    privileged: false,
    scan: { status: 'clean' },
    version: 1,
    deletedAt: null,
    ...seedMeta(),
  });

  client = initializeApp({ projectId: PROJECT_ID, apiKey: 'demo-api-key' }, 'safe-custody-integration-client');
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

describe('the safe custody register', () => {
  it('receives a will, moves it out, returns it and releases it only with an authority', async () => {
    await signInAs('paralegal');
    const first = await receive();
    const second = await receive();
    expect(first.packetNo).toBe('SC-000001');
    expect(second.packetNo).toBe('SC-000002');
    const packetPath = `orgs/${ORG}/safeCustody/${first.id}`;

    // Members read packets; nobody writes them directly, so movements always go through the callable.
    expect((await getDoc(doc(firestore, packetPath))).get('status')).toBe('held');
    await expect(
      updateDoc(doc(firestore, packetPath), {
        status: 'released',
        updatedAt: serverTimestamp(),
        updatedBy: uidOf('paralegal'),
      }),
    ).rejects.toMatchObject({ code: 'permission-denied' });

    expect(await move(first.id, { kind: 'out', reason: 'Signing review', to: 'Fictional lawyer' })).toEqual({
      status: 'out',
      pendingConfirmation: false,
    });
    await move(first.id, { kind: 'returned', reason: 'Back in the safe' });

    // A paralegal can't release; a lawyer can't without an authority.
    const release = { kind: 'released', reason: 'Executor’s request', to: 'Fictional Executor', authority: AUTHORITY };
    expect((await failure(move(first.id, release))).code).toBe('functions/permission-denied');
    await signInAs('lawyer');
    const unauthorised: Record<string, unknown> = { ...release };
    delete unauthorised['authority'];
    const missing = await failure(move(first.id, unauthorised));
    expect(missing.code).toBe('functions/invalid-argument');
    expect(detailsOf(missing)['fields']).toMatchObject({ authority: ['Choose the authority document'] });

    expect(await move(first.id, release)).toEqual({ status: 'released', pendingConfirmation: false });
    const packet = await data(packetPath);
    expect(packet['status']).toBe('released');
    expect((packet['movements'] as { kind: string }[]).map((m) => m.kind)).toEqual([
      'in',
      'out',
      'returned',
      'released',
    ]);
    expect((packet['movements'] as Record<string, unknown>[])[3]).toMatchObject({
      by: uidOf('lawyer'),
      authority: AUTHORITY,
      to: 'Fictional Executor',
    });
    const closed = await failure(move(first.id, { kind: 'out', reason: 'x', to: 'y' }));
    expect(detailsOf(closed)).toMatchObject({ reason: 'packet_closed' });
  });

  it('destroys an original only when a second lawyer confirms', async () => {
    await signInAs('lawyer');
    const { id } = await receive();
    expect(
      await move(id, { kind: 'destroyed', reason: 'Testator’s written instruction', authority: AUTHORITY }),
    ).toEqual({
      status: 'held',
      pendingConfirmation: true,
    });
    const own = await failure(call(SAFE_CUSTODY_CALLABLES.confirmDestruction, { id, approve: true }));
    expect(detailsOf(own)).toMatchObject({ reason: 'same_person' });

    await signInAs('owner');
    expect(await call(SAFE_CUSTODY_CALLABLES.confirmDestruction, { id, approve: true })).toEqual({
      status: 'destroyed',
      pendingConfirmation: false,
    });
    const packet = await data(`orgs/${ORG}/safeCustody/${id}`);
    expect(packet).toMatchObject({ status: 'destroyed', pendingDestruction: null });
    expect((packet['movements'] as Record<string, unknown>[]).at(-1)).toMatchObject({
      kind: 'destroyed',
      by: uidOf('lawyer'),
      approvedBy: uidOf('owner'),
    });
  });

  it('tells the responsible lawyer when a testator with a held packet dies', async () => {
    await signInAs('paralegal');
    const { id, packetNo } = await receive({ responsibleUid: uidOf('lawyer') });
    await db.doc(`orgs/${ORG}/contacts/c-sc-wren`).update({ dateOfDeath: '2026-10-01', updatedBy: 'seed' });
    const notification = await poll(
      () => data(`orgs/${ORG}/notifications/sc-death-${id}`),
      (value) => !!value['kind'],
    );
    expect(notification).toMatchObject({
      kind: 'safe_custody',
      packetId: id,
      recipientUid: uidOf('lawyer'),
      title: `Original will held: ${packetNo}`,
      link: `/safe-custody/${id}`,
    });
  });
});
