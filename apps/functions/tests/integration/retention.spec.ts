import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut, type Auth } from 'firebase/auth';
import {
  connectFirestoreEmulator,
  doc,
  getFirestore,
  serverTimestamp,
  updateDoc,
  type Firestore as ClientFirestore,
} from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable, type FunctionsError } from 'firebase/functions';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { getFirestore as getAdminFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { getStorage as getAdminStorage } from 'firebase-admin/storage';

import type { ClosingChecklistResult, Role } from '@materia/domain';

import { createLog } from '../../src/core/log';
import { archiveOrg } from '../../src/matters/archive';
import { queueOrg } from '../../src/matters/destruction';
import { FakeClock } from '../../src/ports/fakes';

/**
 * CORE-19 through the emulators, with the org's clock pinned (emulatorClock) to move through the
 * years: a probate matter closes through its checklist (an open task bulk-cancelled) and reopens;
 * it closes again, is archived 90 days later (clients can no longer edit it), and once past its
 * retention date is queued, approved by an admin (typed number, fresh sign-in) and destroyed by the
 * `matters-destroy` task: records and Storage objects gone, a tombstone and the audit trail kept,
 * and a certificate issued. Everything is fictional.
 */
const PROJECT_ID = 'demo-materia';
const BUCKET = 'demo-materia.appspot.com';
const ORG = 'org-retention';
const PASSWORD = 'fictional-password-c19';
const MATTER_ID = 'm-retention';
const MATTER = `orgs/${ORG}/matters/${MATTER_ID}`;
const NUMBER = 'RT-2026-0001';
const TASK = `${MATTER}/tasks/t-1`;
const FILE = `${MATTER}/documents/d-1/v1`;

/** The callables' names (as in `MATTER_CALLABLES` in libs/data-access). */
const MATTER_CALLABLES = {
  changeStatus: 'matters-changeStatus',
  closingChecklist: 'matters-closingChecklist',
  close: 'matters-close',
  reopen: 'matters-reopen',
  approveDestruction: 'matters-approveDestruction',
} as const;

let admin: App;
let db: Firestore;
let client: FirebaseApp;
let auth: Auth;
let firestore: ClientFirestore;

const uidOf = (role: Role) => `retention-${role}`;
const log = createLog({ fn: 'integration' }, () => undefined);

type Data = Record<string, unknown>;

const call = <T = Data>(name: string, data: Data) =>
  httpsCallable<Data, T>(getFunctions(client, 'australia-southeast1'), name)(data).then((result) => result.data);
const withRequest = (data: Data) => ({ requestId: crypto.randomUUID(), matterId: MATTER_ID, ...data });
const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as FunctionsError & { details?: Data };
  }
  throw new Error('expected a failure');
};

async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 45_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    value = await read();
  }
  return value;
}

/** Pins "now" for this org in the emulator (functions read it through orgClock). */
const pinClock = (iso: string) => db.doc(`emulatorClock/${ORG}`).set({ now: Timestamp.fromDate(new Date(iso)) });
/** Pins the emulator's clock and returns the same time as the clock injected into a job run here. */
async function at(iso: string): Promise<FakeClock> {
  await pinClock(iso);
  return new FakeClock(new Date(iso));
}
const matter = async () => (await db.doc(MATTER).get()).data() ?? {};
const audited = async (action: string) =>
  (await db.collection(`orgs/${ORG}/audit`).where('action', '==', action).get()).docs.map((d) => d.data());

async function createMember(role: Role) {
  const adminAuth = getAdminAuth(admin);
  await adminAuth.deleteUser(uidOf(role)).catch(() => undefined);
  await adminAuth.createUser({ uid: uidOf(role), email: `${uidOf(role)}@example.test`, password: PASSWORD });
  await adminAuth.setCustomUserClaims(uidOf(role), { orgId: ORG, role });
  await db.doc(`orgs/${ORG}/members/${uidOf(role)}`).set({ role, status: 'active' });
}

async function signInAs(role: Role) {
  await signOut(auth);
  await signInWithEmailAndPassword(auth, `${uidOf(role)}@example.test`, PASSWORD);
}

/** Closes the matter with every checklist item answered. */
const closeMatter = (extra: Data = {}) =>
  call<Data>(
    MATTER_CALLABLES.close,
    withRequest({
      reason: 'Estate fully administered',
      checklist: { originals: 'returned', closingLetterSent: true, finalDistributionRecorded: true },
      ...extra,
    }),
  );

beforeAll(async () => {
  admin = initializeAdminApp({ projectId: PROJECT_ID, storageBucket: BUCKET }, 'retention-integration-admin');
  db = getAdminFirestore(admin);
  await db.recursiveDelete(db.doc(`orgs/${ORG}`));
  await db.doc(`orgs/${ORG}`).set({
    name: 'Fictional Retention Practice',
    timezone: 'Australia/Melbourne',
    retentionYears: 7,
    flags: { 'matters.destruction': true },
  });
  await createMember('lawyer');
  await createMember('admin');
  // 11:00 on Monday 5 October 2026 in Melbourne.
  await pinClock('2026-10-05T00:00:00Z');
  await db.doc(MATTER).set({
    orgId: ORG,
    number: NUMBER,
    title: 'Estate of Fictional Retention',
    type: 'probate',
    status: 'open',
    responsibleUid: uidOf('lawyer'),
    teamUids: [],
    labels: [],
    privileged: false,
    deletedAt: null,
  });
  await db.doc(TASK).set({
    orgId: ORG,
    matterId: MATTER_ID,
    title: 'Send the fictional final account',
    status: 'todo',
    assigneeUid: uidOf('lawyer'),
    deletedAt: null,
  });

  client = initializeApp({ projectId: PROJECT_ID, apiKey: 'demo-api-key' }, 'retention-integration-client');
  auth = getAuth(client);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFunctionsEmulator(getFunctions(client, 'australia-southeast1'), '127.0.0.1', 5001);
  firestore = getFirestore(client);
  connectFirestoreEmulator(firestore, '127.0.0.1', 8080);
});

afterAll(async () => {
  await db.doc(`emulatorClock/${ORG}`).delete();
  await signOut(auth);
  await deleteApp(client);
  await deleteAdminApp(admin);
});

describe('closing and retention through the emulators', () => {
  it('closes through the checklist (cancelling the open task), then reopens with a reason', async () => {
    await signInAs('lawyer');
    const checklist = await call<ClosingChecklistResult>(MATTER_CALLABLES.closingChecklist, { matterId: MATTER_ID });
    expect(checklist.counts).toEqual({ upcomingDeadlines: 0, openTasks: 1 });
    expect(checklist.blocking).toEqual(['tasks', 'originals', 'closing_letter', 'final_distribution']);
    expect(checklist.destroyAfter).toBe('2033-10-05');

    const refused = await failure(closeMatter());
    expect(refused.code).toBe('functions/failed-precondition');
    expect(refused.details).toMatchObject({ reason: 'closing_checklist', blocking: ['tasks'] });
    // A plain status change can't close it.
    const plain = await failure(call(MATTER_CALLABLES.changeStatus, withRequest({ to: 'closed', reason: 'x' })));
    expect(plain.details).toMatchObject({ reason: 'closing_checklist_required' });

    const closed = await closeMatter({ cancelOpenTasks: { reason: 'Superseded by the final account' } });
    expect(closed).toMatchObject({ status: 'closed', destroyAfter: '2033-10-05', tasksCancelled: 1 });
    expect(await matter()).toMatchObject({ status: 'closed', destroyAfter: '2033-10-05' });
    expect((await db.doc(TASK).get()).get('status')).toBe('cancelled');
    expect(await audited('matter.closed')).toHaveLength(1);

    await call(MATTER_CALLABLES.reopen, withRequest({ reason: 'Further fictional assets found' }));
    const reopened = await matter();
    expect(reopened['status']).toBe('open');
    expect(reopened).not.toHaveProperty('destroyAfter');
    expect(reopened).not.toHaveProperty('closedAt');
    expect(await audited('matter.reopened')).toHaveLength(1);
  });

  it('archives 90 days after closing, after which clients can no longer edit it', async () => {
    await signInAs('lawyer');
    await closeMatter();
    // 89 days later: not yet.
    expect(await archiveOrg(db, ORG, await at('2027-01-02T00:00:00Z'), log)).toEqual([]);
    expect(await archiveOrg(db, ORG, await at('2027-01-03T00:00:00Z'), log)).toEqual([MATTER_ID]);
    expect(await matter()).toMatchObject({ status: 'archived' });

    const edit = await failure(
      updateDoc(doc(firestore, MATTER), {
        title: 'Renamed while archived',
        updatedAt: serverTimestamp(),
        updatedBy: uidOf('lawyer'),
      }),
    );
    expect(edit.code).toBe('permission-denied');
  });

  it('queues the matter past its retention date; an admin approves; the task destroys it and issues a certificate', async () => {
    const bucket = getAdminStorage(admin).bucket(BUCKET);
    await bucket.file(FILE).save(Buffer.from('fictional will'), { contentType: 'application/pdf' });
    await db.doc(`${MATTER}/documents/d-1`).set({ orgId: ORG, matterId: MATTER_ID, name: 'Will.pdf', deletedAt: null });

    // Not due until after 5 October 2033.
    expect(await queueOrg(db, ORG, await at('2033-10-05T00:00:00Z'), log)).toEqual([]);
    expect(await queueOrg(db, ORG, await at('2033-11-01T00:00:00Z'), log)).toEqual([MATTER_ID]);
    const QUEUED = `orgs/${ORG}/destructionQueue/${MATTER_ID}`;
    expect((await db.doc(QUEUED).get()).data()).toMatchObject({ status: 'pending', number: NUMBER });

    // Lawyers can't approve; admins type the number.
    await signInAs('lawyer');
    const lawyer = await failure(call(MATTER_CALLABLES.approveDestruction, withRequest({ confirmation: NUMBER })));
    expect(lawyer.code).toBe('functions/permission-denied');
    await signInAs('admin');
    const typo = await failure(
      call(MATTER_CALLABLES.approveDestruction, withRequest({ confirmation: 'RT-2026-0002' })),
    );
    expect(typo.code).toBe('functions/invalid-argument');
    await call(MATTER_CALLABLES.approveDestruction, withRequest({ confirmation: NUMBER.toLowerCase() }));

    const done = await poll(
      async () => (await db.doc(QUEUED).get()).data() ?? {},
      (entry) => entry['status'] === 'destroyed',
      60_000,
    );
    expect(done).toMatchObject({ status: 'destroyed', stage: 'certificate', certificateId: `dc-${MATTER_ID}` });
    expect(done).not.toHaveProperty('title');

    // The tombstone: number, type and dates, no title; records and files gone.
    const tombstone = await matter();
    expect(tombstone).toMatchObject({ number: NUMBER, type: 'probate', certificateId: `dc-${MATTER_ID}` });
    expect(tombstone).not.toHaveProperty('title');
    expect(tombstone['destroyedAt']).toBeTruthy();
    expect(tombstone['deletedAt']).toBeTruthy();
    expect((await db.collection(`${MATTER}/tasks`).get()).size).toBe(0);
    expect((await db.collection(`${MATTER}/documents`).get()).size).toBe(0);
    expect((await bucket.file(FILE).exists())[0]).toBe(false);

    // The certificate and the audit trail stay.
    const certificate = (await db.doc(`orgs/${ORG}/destructionCertificates/dc-${MATTER_ID}`).get()).data();
    expect(certificate).toMatchObject({ number: NUMBER, approvedBy: uidOf('admin') });
    const [pdf] = await bucket.file(String(certificate?.['storagePath'])).download();
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(await audited('matter.closed')).toHaveLength(2);
    expect(await audited('matter.destroyed')).toHaveLength(1);
  }, 90_000);
});
