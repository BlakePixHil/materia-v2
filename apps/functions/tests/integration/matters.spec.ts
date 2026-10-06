import { randomUUID } from 'node:crypto';

import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut, type Auth } from 'firebase/auth';
import { connectFunctionsEmulator, getFunctions, httpsCallable, type FunctionsError } from 'firebase/functions';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { getFirestore as getAdminFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';

import {
  contactDerivedFields,
  MATTER_TRANSITIONS,
  MatterStatusSchema,
  type CreateMatterResult,
  type MatterStatus,
  type Role,
} from '@materia/domain';

/**
 * CORE-03 through the emulators: matters-createMatter (numbering under contention, the Melbourne
 * year boundary with a pinned clock, idempotency, format changes), matters-changeStatus (every
 * transition), matters-restore and the matters-denormalise trigger, with real claims. All people,
 * practices and matters are fictional.
 */
const PROJECT_ID = 'demo-materia';
const ORG = 'org-matters';
const PASSWORD = 'fictional-password-c3';
const M = `orgs/${ORG}/matters`;
const DAY = 86_400_000;

let admin: App;
let db: Firestore;
let client: FirebaseApp;
let auth: Auth;

const meta = {
  createdAt: new Date('2026-06-01T00:00:00Z'),
  createdBy: 'seed',
  updatedAt: new Date('2026-06-01T00:00:00Z'),
  updatedBy: 'seed',
  schemaVersion: 1,
};
const person = (given: string, family: string) => {
  const fields = {
    kind: 'person' as const,
    givenNames: given,
    familyName: family,
    emails: [],
    phones: [],
    addresses: [],
    tags: [],
    isReferrer: false,
  };
  return { ...meta, ...fields, ...contactDerivedFields(fields as never) };
};

/** What the New matter form sends. */
const newMatter = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  type: 'probate',
  jurisdiction: 'VIC',
  responsibleUid: 'matters-lawyer',
  teamUids: [],
  clientContactIds: ['c-ada'],
  deceased: { contactId: 'c-bertram', dateOfDeath: '2026-05-01', domicile: 'VIC', lastAddress: 'Geelong VIC' },
  fee: { arrangement: 'hourly' },
  costsDisclosure: { status: 'required' },
  conflictCheck: { status: 'clear' },
  ...extra,
});

/** A matter written straight to Firestore (as the seed or the migration would). */
const rawMatter = (status: MatterStatus, extra: Record<string, unknown> = {}) => ({
  ...meta,
  number: `RAW-${randomUUID().slice(0, 8)}`,
  title: 'Estate of Fictional Rawlings',
  type: 'admin',
  status,
  jurisdiction: 'VIC',
  responsibleUid: 'matters-lawyer',
  clientContactIds: ['c-ada'],
  conflictCheck: { status: 'clear' },
  privileged: false,
  ...extra,
});

async function createMember(who: Role) {
  const adminAuth = getAdminAuth(admin);
  await adminAuth.createUser({ uid: `matters-${who}`, email: `matters-${who}@example.test`, password: PASSWORD });
  await adminAuth.setCustomUserClaims(`matters-${who}`, { orgId: ORG, role: who });
  await db.doc(`orgs/${ORG}/members/matters-${who}`).set({ role: who, status: 'active' });
}

async function signInAs(who: Role) {
  await signOut(auth);
  await signInWithEmailAndPassword(auth, `matters-${who}@example.test`, PASSWORD);
}

// Parallel creates contend on one counter; on a busy CI runner they can outlast the SDK's 70 s
// default, so allow up to the test's own 120 s.
function call<T>(name: string, data: Record<string, unknown>) {
  return httpsCallable<Record<string, unknown>, T>(getFunctions(client, 'australia-southeast1'), name, {
    timeout: 110_000,
  })(data).then((result) => result.data);
}
const create = (title: string, extra: Record<string, unknown> = {}, requestId = randomUUID()) =>
  call<CreateMatterResult>('matters-createMatter', { requestId, matter: newMatter(title, extra) });
const changeStatus = (matterId: string, to: MatterStatus, reason?: string) =>
  call('matters-changeStatus', { requestId: randomUUID(), matterId, to, ...(reason ? { reason } : {}) });

async function failure(promise: Promise<unknown>): Promise<FunctionsError> {
  try {
    await promise;
  } catch (error) {
    return error as FunctionsError;
  }
  throw new Error('expected the call to fail');
}
const detailsOf = (error: FunctionsError) => (error.details ?? {}) as Record<string, unknown>;

/**
 * Polls for a trigger's result. Its event waits in the Firestore emulator's queue behind every event
 * this file's earlier tests left (changeStatus seeds a matter for each pair of statuses, and each
 * matter write fires the denormalise, audit and metrics triggers in turn), so allow the 45 s the
 * other files allow.
 */
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
/** Pins "now" for the org's callables (emulator only; see core/emulator-clock.ts). */
const pinClock = (iso: string) => db.doc(`emulatorClock/${ORG}`).set({ now: Timestamp.fromDate(new Date(iso)) });

beforeAll(async () => {
  admin = initializeAdminApp({ projectId: PROJECT_ID }, 'matters-integration-admin');
  db = getAdminFirestore(admin);
  const adminAuth = getAdminAuth(admin);
  const existing = await adminAuth.listUsers();
  await Promise.all(existing.users.filter((u) => u.uid.startsWith('matters-')).map((u) => adminAuth.deleteUser(u.uid)));
  await db.recursiveDelete(db.doc(`orgs/${ORG}`));
  await db.doc(`orgs/${ORG}`).set({
    name: 'Fictional Matters Practice',
    retentionYears: 7,
    timezone: 'Australia/Melbourne',
    matterNumberFormat: 'M-{YYYY}-{seq:4}',
  });
  await db.doc(`orgs/${ORG}/contacts/c-ada`).set(person('Ada', 'Quill'));
  await db.doc(`orgs/${ORG}/contacts/c-bertram`).set(person('Bertram', 'Quill'));
  for (const role of ['owner', 'lawyer', 'paralegal', 'readonly'] as const) await createMember(role);
  await pinClock('2026-06-01T00:00:00Z');

  client = initializeApp({ projectId: PROJECT_ID, apiKey: 'demo-api-key' }, 'matters-integration-client');
  auth = getAuth(client);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFunctionsEmulator(getFunctions(client, 'australia-southeast1'), '127.0.0.1', 5001);
});

afterAll(async () => {
  await db.doc(`emulatorClock/${ORG}`).delete();
  await signOut(auth);
  await deleteApp(client);
  await deleteAdminApp(admin);
});

/**
 * Creates racing for the same counter. Ten still contend on every number. At twenty the emulator's
 * lock manager timed out transactions often enough (each retry backing off, while the Functions
 * emulator started a worker per request) that the slowest calls took over 70 s.
 */
const PARALLEL = 10;
const sequential = (seq: number) => `M-2026-${String(seq).padStart(4, '0')}`;

describe('matters-createMatter', () => {
  it(`gives ${PARALLEL} parallel creates ${PARALLEL} distinct, sequential numbers`, async () => {
    await signInAs('lawyer');
    const results = await Promise.all(
      Array.from({ length: PARALLEL }, (_, i) => create(`Estate of Fictional Parallel ${i + 1}`)),
    );
    const numbers = results.map((r) => r.number).sort();
    expect(numbers).toEqual(Array.from({ length: PARALLEL }, (_, i) => sequential(i + 1)));
    expect(new Set(results.map((r) => r.matterId)).size).toBe(PARALLEL);
    expect(await data(`orgs/${ORG}/counters/matter-2026`)).toMatchObject({ next: PARALLEL + 1 });

    const first = results.find((r) => r.number === 'M-2026-0001') as CreateMatterResult;
    const stored = await data(`${M}/${first.matterId}`);
    expect(stored).toMatchObject({ status: 'open', deletedAt: null, createdBy: 'matters-lawyer' });
    expect(stored['search']).toEqual(expect.arrayContaining(['m20260001', 'ada', 'quill', 'bertram']));
    expect((await data(`${M}/${first.matterId}/parties/client-c-ada`))['role']).toBe('client');
    expect((await data(`orgs/${ORG}/matterNumbers/M-2026-0001`))['matterId']).toBe(first.matterId);
    const audit = await db.collection(`orgs/${ORG}/audit`).where('action', '==', 'matter.created').get();
    expect(audit.size).toBe(PARALLEL);
  }, 120_000);

  it('rolls the number year at midnight in Melbourne (pinned clock)', async () => {
    await signInAs('lawyer');
    await pinClock('2026-12-31T12:59:59Z');
    expect((await create('Estate of Fictional New Year Eve')).number).toBe(sequential(PARALLEL + 1));
    await pinClock('2026-12-31T13:00:00Z');
    expect((await create('Estate of Fictional New Year Day')).number).toBe('M-2027-0001');
    expect(await data(`orgs/${ORG}/counters/matter-2027`)).toMatchObject({ next: 2 });
    await pinClock('2026-06-01T00:00:00Z');
  });

  it('replays the same requestId with the same matter', async () => {
    await signInAs('paralegal');
    const requestId = randomUUID();
    // A paralegal creates leads: recording a determination is for conflict.determine (CORE-02).
    const pending = { conflictCheck: { status: 'pending' } };
    const first = await create('Estate of Fictional Repeat', pending, requestId);
    expect(await create('Estate of Fictional Repeat', pending, requestId)).toEqual(first);
    const same = await db.collection(M).where('title', '==', 'Estate of Fictional Repeat').get();
    expect(same.size).toBe(1);
  });

  it('keeps numbers unique when the format changes mid-year', async () => {
    await signInAs('lawyer');
    const counter = db.doc(`orgs/${ORG}/counters/matter-2026`);
    const next = (await counter.get()).get('next') as number;
    // A three-digit format, and a migrated matter already holding the next number in it.
    await db.doc(`orgs/${ORG}`).update({ matterNumberFormat: 'M-{YYYY}-{seq:3}' });
    const held = `M-2026-${String(next).padStart(3, '0')}`;
    await db.doc(`${M}/migrated-1`).set(rawMatter('open', { number: held, externalRef: 'LEGACY-77' }));
    const migrated = await create('Estate of Fictional Migrant', { externalRef: 'LEGACY-77' });
    expect(migrated.number).toBe(`M-2026-${String(next + 1).padStart(3, '0')}`);
    expect(await data(`${M}/${migrated.matterId}`)).toMatchObject({ externalRef: 'LEGACY-77' });

    // Back to four digits with the counter wound back: every number already reserved is skipped.
    await db.doc(`orgs/${ORG}`).update({ matterNumberFormat: 'M-{YYYY}-{seq:4}' });
    await counter.update({ next: 1 });
    const after = await create('Estate of Fictional Rewind');
    expect(after.number).toBe(`M-2026-${String(next).padStart(4, '0')}`);

    const all = await db.collection(M).select('number').get();
    const numbers = all.docs.map((d) => String(d.get('number')).toUpperCase());
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('is for matter.create roles: readonly is refused, a paralegal creates', async () => {
    await signInAs('readonly');
    expect(detailsOf(await failure(create('Estate of Fictional Nobody')))['code']).toBe('PERMISSION_DENIED');
    await signInAs('paralegal');
    expect((await create('Estate of Fictional Lead', { conflictCheck: { status: 'pending' } })).status).toBe('lead');
    // A determination at intake needs conflict.determine (CORE-02).
    expect(detailsOf(await failure(create('Estate of Fictional Cleared')))).toMatchObject({
      code: 'PERMISSION_DENIED',
      reason: 'conflict_determine_required',
    });
  });
});

describe('matters-changeStatus', () => {
  const STATUSES = MatterStatusSchema.options;
  const pairs = STATUSES.flatMap((from) => STATUSES.map((to) => [from, to] as const));

  beforeAll(async () => {
    const batch = db.batch();
    for (const [from, to] of pairs) batch.set(db.doc(`${M}/t-${from}-${to}`), rawMatter(from));
    await batch.commit();
  });

  it('allows every transition in MATTER_TRANSITIONS and refuses every other', async () => {
    await signInAs('lawyer');
    for (const [from, to] of pairs) {
      const matterId = `t-${from}-${to}`;
      if (MATTER_TRANSITIONS[from].includes(to) && to === 'closed') {
        // Closing goes through matters-close and its checklist (CORE-19).
        const error = await failure(changeStatus(matterId, to, 'Fictional reason'));
        expect(detailsOf(error), `${from} → ${to}`).toMatchObject({ reason: 'closing_checklist_required' });
      } else if (MATTER_TRANSITIONS[from].includes(to)) {
        expect(await changeStatus(matterId, to, 'Fictional reason'), `${from} → ${to}`).toEqual({
          matterId,
          status: to,
        });
        expect((await data(`${M}/${matterId}`))['status']).toBe(to);
      } else {
        const error = await failure(changeStatus(matterId, to, 'Fictional reason'));
        expect(detailsOf(error), `${from} → ${to}`).toMatchObject({ code: 'MATTER_INVALID_TRANSITION', from, to });
        expect(error.code).toBe('functions/failed-precondition');
      }
    }
  }, 120_000);

  it('opens a lead only with a determination that allows it', async () => {
    await db.doc(`${M}/lead-unchecked`).set(rawMatter('lead', { conflictCheck: { status: 'pending' } }));
    await signInAs('lawyer');
    const error = await failure(changeStatus('lead-unchecked', 'open'));
    expect(error.code).toBe('functions/failed-precondition');
    expect(detailsOf(error)).toMatchObject({ code: 'FAILED_PRECONDITION', reason: 'conflict_check_not_clear' });
  });

  it('reopening needs a reason, and clears the closing fields', async () => {
    // Closed through matters-close (CORE-19); written directly here.
    await db
      .doc(`${M}/to-reopen`)
      .set(rawMatter('closed', { closedAt: new Date(), closeReason: 'Estate finalised', destroyAfter: '2033-10-05' }));
    await signInAs('lawyer');
    const error = await failure(changeStatus('to-reopen', 'open'));
    expect(error.code).toBe('functions/invalid-argument');
    await changeStatus('to-reopen', 'open', 'Further assets found');
    const reopened = await data(`${M}/to-reopen`);
    expect(reopened['status']).toBe('open');
    expect(reopened['closedAt']).toBeUndefined();
    expect(reopened['destroyAfter']).toBeUndefined();
    const audit = await db.collection(`orgs/${ORG}/audit`).where('action', '==', 'matter.status_changed').get();
    expect(audit.docs.map((d) => d.data()['entity']['path'])).toContain(`${M}/to-reopen`);
  });

  it('a paralegal cannot change status', async () => {
    await db.doc(`${M}/para-status`).set(rawMatter('open'));
    await signInAs('paralegal');
    expect(detailsOf(await failure(changeStatus('para-status', 'on_hold')))['code']).toBe('PERMISSION_DENIED');
  });
});

describe('matters-denormalise', () => {
  it('fills search, lastActivityAt and deletedAt, and follows meaningful edits', async () => {
    const path = `${M}/denorm-1`;
    await db.doc(path).set(rawMatter('open', { number: 'HV-2026-0042', externalRef: 'OLD-9' }));
    const filled = await poll(
      () => data(path),
      (doc) => Array.isArray(doc['search']) && doc['lastActivityAt'] !== undefined,
    );
    expect(filled['search']).toEqual(expect.arrayContaining(['hv20260042', 'estate', 'ada', 'quill', 'old9']));
    expect(filled['deletedAt']).toBeNull();
    const first = (filled['lastActivityAt'] as Timestamp).toMillis();

    // A client-style edit is activity: lastActivityAt moves on and search follows the title. (The
    // event for the trigger's own first write may land after the edit and pick up the new title
    // first, so wait for both.)
    await db.doc(path).update({ title: 'Estate of Fictional Rawlinson', updatedBy: 'matters-lawyer' });
    const edited = await poll(
      () => data(path),
      (doc) =>
        (doc['search'] as string[]).includes('rawlinson') && (doc['lastActivityAt'] as Timestamp).toMillis() > first,
    );
    expect(edited['search']).toContain('rawlinson');
    expect((edited['lastActivityAt'] as Timestamp).toMillis()).toBeGreaterThan(first);
    expect(edited['updatedBy']).toBe('matters-lawyer');
  }, 120_000);
});

describe('matters-restore', () => {
  beforeAll(async () => {
    const now = Date.now();
    await db
      .doc(`${M}/deleted-recent`)
      .set(rawMatter('open', { deletedAt: new Date(now - 10 * DAY), deletedBy: 'matters-lawyer' }));
    await db
      .doc(`${M}/deleted-old`)
      .set(rawMatter('open', { deletedAt: new Date(now - 31 * DAY), deletedBy: 'matters-lawyer' }));
  });

  it('is for owners and admins', async () => {
    await signInAs('lawyer');
    const error = await failure(call('matters-restore', { requestId: randomUUID(), matterId: 'deleted-recent' }));
    expect(detailsOf(error)['code']).toBe('PERMISSION_DENIED');
  });

  it('restores within 30 days and refuses after', async () => {
    await signInAs('owner');
    expect(await call('matters-restore', { requestId: randomUUID(), matterId: 'deleted-recent' })).toEqual({
      matterId: 'deleted-recent',
      restored: true,
    });
    expect(await data(`${M}/deleted-recent`)).toMatchObject({ deletedAt: null, updatedBy: 'matters-owner' });
    const error = await failure(call('matters-restore', { requestId: randomUUID(), matterId: 'deleted-old' }));
    expect(detailsOf(error)).toMatchObject({ code: 'FAILED_PRECONDITION', reason: 'restore_window_passed' });
    expect((await data(`${M}/deleted-old`))['deletedAt']).not.toBeNull();
  });
});

describe('referrals (CORE-18)', () => {
  const settings = (thankYouTask: boolean) =>
    db.doc(`orgs/${ORG}`).update({ settings: { referrals: { thankYouTask } } });

  beforeAll(async () => {
    await db.doc(`orgs/${ORG}/contacts/c-referrer`).set({
      ...person('Lena', 'Fictional-Planner'),
      isReferrer: true,
      referrerMeta: { company: 'Fictional Wealth Partners', industry: 'financial_planner' },
    });
    await settings(true);
  });
  afterAll(() => db.doc(`orgs/${ORG}`).update({ settings: {} }));

  it('stores the referrer and gives a referred matter created open one thank-you task', async () => {
    await signInAs('lawyer');
    const { matterId, status } = await create('Estate of Fictional Referred', { referrerContactId: 'c-referrer' });
    expect(status).toBe('open');
    const task = await data(`${M}/${matterId}/tasks/referrer-thank-you`);
    expect(task).toMatchObject({
      title: 'Thank Lena Fictional-Planner for the referral',
      assigneeUid: 'matters-lawyer',
      status: 'todo',
      countedOpen: true,
    });
    // tasks-onWrite leaves the count alone: the create counted it with any template tasks.
    const tasks = await db.collection(`${M}/${matterId}/tasks`).get();
    const matter = await data(`${M}/${matterId}`);
    expect(matter).toMatchObject({ referrerContactId: 'c-referrer', openTaskCount: tasks.size });
  });

  it('adds it when a referred lead opens, and not for a source or with the setting off', async () => {
    await db.doc(`${M}/ref-lead`).set(rawMatter('lead', { referrerContactId: 'c-referrer', openTaskCount: 0 }));
    await db.doc(`${M}/src-lead`).set(rawMatter('lead', { referralSource: 'website', openTaskCount: 0 }));
    await signInAs('lawyer');
    await changeStatus('ref-lead', 'open');
    await changeStatus('src-lead', 'open');
    expect((await data(`${M}/ref-lead/tasks/referrer-thank-you`))['title']).toBe(
      'Thank Lena Fictional-Planner for the referral',
    );
    expect((await data(`${M}/ref-lead`))['openTaskCount']).toBe(1);
    expect((await db.doc(`${M}/src-lead/tasks/referrer-thank-you`).get()).exists).toBe(false);

    await settings(false);
    await db.doc(`${M}/off-lead`).set(rawMatter('lead', { referrerContactId: 'c-referrer' }));
    await changeStatus('off-lead', 'open');
    expect((await db.doc(`${M}/off-lead/tasks/referrer-thank-you`).get()).exists).toBe(false);
    await settings(true);
  });
});
