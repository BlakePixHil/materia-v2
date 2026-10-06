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
import { FieldValue, getFirestore as getAdminFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';

import { toRuleSetDoc, VIC_RULESET_V1, type RuleSet } from '@materia/deadlines';
import { DEADLINE_CALLABLES, type Role } from '@materia/domain';

import { createLog } from '../../src/core/log';
import { currentRuleSets, ruleSetUpgradePath, upgradeOrgRuleSets } from '../../src/deadlines/upgrade';
import { FakeClock, FakeTaskQueue } from '../../src/ports/fakes';

/**
 * CORE-10 through the emulators: events recorded through deadlines-upsertEvent recompute the
 * matter's deadlines (new, changed and removed), proposals and their decisions (a critical one
 * needs the matter number typed), overrides and the conflict flag, completion and its audit,
 * concurrent recomputes, matter.nextDeadline from the deadlines-onWrite trigger, a blocked deadline
 * when calendar data is missing, and the rule-set upgrade backfill, by hand and by the hourly job.
 * Everything is fictional.
 */
const PROJECT_ID = 'demo-materia';
const ORG = 'org-deadlines';
const PASSWORD = 'fictional-password-d10';
const MATTER_ID = 'm-deadlines';
const MATTER = `orgs/${ORG}/matters/${MATTER_ID}`;
const DEADLINES = `${MATTER}/deadlines`;
const NUMBER = 'DL-2026-0001';
// 11:00 on 5 October 2026 in Melbourne, pinned for this org (emulatorClock).
const NOW = new Date('2026-10-05T00:00:00.000Z');

let admin: App;
let db: Firestore;
let client: FirebaseApp;
let auth: Auth;
let firestore: ClientFirestore;

const uidOf = (role: Role) => `deadlines-${role}`;

async function createMember(role: Role) {
  const adminAuth = getAdminAuth(admin);
  await adminAuth.createUser({ uid: uidOf(role), email: `${uidOf(role)}@example.test`, password: PASSWORD });
  await adminAuth.setCustomUserClaims(uidOf(role), { orgId: ORG, role });
  await db.doc(`orgs/${ORG}/members/${uidOf(role)}`).set({ role, status: 'active' });
}

async function signInAs(role: Role) {
  await signOut(auth);
  await signInWithEmailAndPassword(auth, `${uidOf(role)}@example.test`, PASSWORD);
}

type Data = Record<string, unknown>;

const call = <T = Data>(name: string, data: Data) =>
  httpsCallable<Data, T>(getFunctions(client, 'australia-southeast1'), name)(data).then((result) => result.data);
const withRequest = (data: Data) => ({ requestId: crypto.randomUUID(), matterId: MATTER_ID, ...data });
const upsertEvent = (data: Data) =>
  call<{ eventId: string; recompute: { created: string[]; proposed: string[]; calendarMissing: string[] } }>(
    DEADLINE_CALLABLES.upsertEvent,
    withRequest(data),
  );
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

const data = async (path: string) => (await db.doc(path).get()).data() ?? {};
const nextDeadline = async () => (await data(MATTER))['nextDeadline'] as Data | undefined;
const auditActions = async () =>
  (await db.collection(`orgs/${ORG}/audit`).where('source', '==', 'callable').get()).docs.map((d) => d.get('action'));

async function resetMatter(extra: Data = {}) {
  await db.recursiveDelete(db.doc(MATTER));
  await db.doc(MATTER).set({
    number: NUMBER,
    title: 'Estate of Fictional Alder',
    type: 'probate',
    jurisdiction: 'VIC',
    status: 'open',
    stageId: 'intake',
    responsibleUid: uidOf('lawyer'),
    teamUids: [],
    clientContactIds: ['c-fictional'],
    deceased: { contactId: 'c-deceased' },
    privileged: false,
    openTaskCount: 0,
    recomputeVersion: 0,
    deletedAt: null,
    createdAt: FieldValue.serverTimestamp(),
    createdBy: 'seed',
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: 'seed',
    schemaVersion: 1,
    ...extra,
  });
}

beforeAll(async () => {
  admin = initializeAdminApp({ projectId: PROJECT_ID }, 'deadlines-integration-admin');
  db = getAdminFirestore(admin);
  const adminAuth = getAdminAuth(admin);
  const existing = await adminAuth.listUsers();
  await Promise.all(
    existing.users.filter((u) => u.uid.startsWith('deadlines-')).map((u) => adminAuth.deleteUser(u.uid)),
  );
  await db.recursiveDelete(db.doc(`orgs/${ORG}`));
  await db.doc(`orgs/${ORG}`).set({
    name: 'Fictional Deadlines Practice',
    timezone: 'Australia/Melbourne',
    flags: { 'deadlines.ruleset.vic.v1': true },
  });
  await db.doc(`emulatorClock/${ORG}`).set({ now: Timestamp.fromDate(NOW) });
  for (const role of ['admin', 'lawyer', 'paralegal'] as const) await createMember(role);

  client = initializeApp({ projectId: PROJECT_ID, apiKey: 'demo-api-key' }, 'deadlines-integration-client');
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

describe('recompute', () => {
  beforeAll(() => resetMatter());

  it('creates deadlines from a new event and denormalises the next one', async () => {
    await signInAs('paralegal');
    const result = await upsertEvent({ kind: 'date_of_death', date: '2026-08-01' });
    expect(result.recompute.created).toEqual(
      expect.arrayContaining(['rule-org.executor_year', 'rule-vic.probate.prompt_filing', 'rule-au.tax.final_return']),
    );
    expect(await data(`${DEADLINES}/rule-org.executor_year`)).toMatchObject({
      status: 'upcoming',
      // 1 August 2027 is a Sunday: rolled to Monday.
      dueDate: '2027-08-02',
      computed: { ruleId: 'org.executor_year', ruleSetId: 'vic', ruleSetVersion: 1 },
    });
    expect(((await data(MATTER))['deceased'] as Data)['dateOfDeath']).toBe('2026-08-01');
    const next = await poll(nextDeadline, (value) => !!value);
    const soonest = (await db.collection(DEADLINES).where('status', '==', 'upcoming').orderBy('dueDate').limit(1).get())
      .docs[0];
    expect(next).toMatchObject({ id: soonest?.id, dueDate: soonest?.get('dueDate') });
    // Nothing new: recomputing writes nothing.
    const version = (await data(MATTER))['recomputeVersion'];
    const again = await call<{ created: string[]; recomputeVersion: number }>(DEADLINE_CALLABLES.recompute, {
      matterId: MATTER_ID,
    });
    expect(again).toMatchObject({ created: [], recomputeVersion: version });
  });

  it('proposes a changed date instead of moving it, and decides it', async () => {
    await signInAs('paralegal');
    const events = await db.collection(`${MATTER}/events`).where('kind', '==', 'date_of_death').get();
    const eventId = events.docs[0]?.id as string;
    const edit = await upsertEvent({ eventId, kind: 'date_of_death', date: '2026-07-01' });
    const changeId = edit.recompute.proposed.find((id) => id.startsWith('rule-org.executor_year')) as string;
    expect(changeId).toBeDefined();
    expect((await data(`${DEADLINES}/rule-org.executor_year`))['dueDate']).toBe('2027-08-02');
    expect(await data(`${MATTER}/deadlineChanges/${changeId}`)).toMatchObject({
      kind: 'moved',
      status: 'pending',
      fromDueDate: '2027-08-02',
      toDueDate: '2027-07-01',
    });
    expect(await data(`orgs/${ORG}/notifications/dlchange-${MATTER_ID}-${changeId}`)).toMatchObject({
      kind: 'deadline_changed',
      recipientUid: uidOf('lawyer'),
    });

    // A paralegal can't decide; the responsible lawyer accepts.
    const denied = await failure(call(DEADLINE_CALLABLES.resolveChange, withRequest({ changeId, accept: true })));
    expect(denied.code).toBe('functions/permission-denied');
    await signInAs('lawyer');
    expect(await call(DEADLINE_CALLABLES.resolveChange, withRequest({ changeId, accept: true }))).toMatchObject({
      status: 'accepted',
    });
    expect((await data(`${DEADLINES}/rule-org.executor_year`))['dueDate']).toBe('2027-07-01');
    expect(await auditActions()).toContain('deadline.change_accepted');
  });

  it('a critical change needs the matter number typed; deleting the anchor proposes a removal', async () => {
    await signInAs('lawyer');
    // The caveat rule's deadline exists, blocked until a caveat is lodged; lodging one dates it.
    expect(await data(`${DEADLINES}/rule-vic.caveat.expiry`)).toMatchObject({
      status: 'blocked',
      blockedCode: 'anchor_missing',
    });
    const lodged = await upsertEvent({ kind: 'caveat_lodged', date: '2026-09-01' });
    expect(await data(`${DEADLINES}/rule-vic.caveat.expiry`)).toMatchObject({ status: 'upcoming', critical: true });
    const moved = await upsertEvent({ eventId: lodged.eventId, kind: 'caveat_lodged', date: '2026-09-08' });
    const changeId = moved.recompute.proposed[0] as string;
    const missing = await failure(call(DEADLINE_CALLABLES.resolveChange, withRequest({ changeId, accept: true })));
    expect(missing.code).toBe('functions/invalid-argument');
    expect((missing.details?.['fields'] as Data)['confirmation']).toBeDefined();
    expect(
      await call(DEADLINE_CALLABLES.resolveChange, withRequest({ changeId, accept: true, confirmation: NUMBER })),
    ).toMatchObject({ status: 'accepted' });

    const removed = await call<{ recompute: { proposed: string[] } }>(
      DEADLINE_CALLABLES.deleteEvent,
      withRequest({ eventId: lodged.eventId }),
    );
    const removal = removed.recompute.proposed[0] as string;
    expect(await data(`${MATTER}/deadlineChanges/${removal}`)).toMatchObject({ kind: 'removed', critical: true });
    await call(DEADLINE_CALLABLES.resolveChange, withRequest({ changeId: removal, accept: false }));
    expect(await data(`${DEADLINES}/rule-vic.caveat.expiry`)).toMatchObject({
      status: 'upcoming',
      declined: { kind: 'removed' },
    });
  });

  it('overrides with a reason, flags an earlier computed date, and audits', async () => {
    await signInAs('lawyer');
    await call(
      DEADLINE_CALLABLES.override,
      withRequest({ deadlineId: 'rule-org.executor_year', dueDate: '2027-07-30', reason: 'Agreed with the executor' }),
    );
    expect(await data(`${DEADLINES}/rule-org.executor_year`)).toMatchObject({
      dueDate: '2027-07-30',
      override: { dueDate: '2027-07-30', reason: 'Agreed with the executor' },
    });
    const events = await db.collection(`${MATTER}/events`).where('kind', '==', 'date_of_death').get();
    await upsertEvent({ eventId: events.docs[0]?.id, kind: 'date_of_death', date: '2026-06-01' });
    expect(await data(`${DEADLINES}/rule-org.executor_year`)).toMatchObject({
      dueDate: '2027-07-30',
      overrideConflict: true,
    });
    expect(await auditActions()).toEqual(expect.arrayContaining(['deadline.overridden', 'matter.event_recorded']));
  });

  it('marks deadlines done (and waived with a reason), moving nextDeadline on', async () => {
    await signInAs('paralegal');
    const before = await poll(nextDeadline, (value) => !!value);
    await call(DEADLINE_CALLABLES.complete, withRequest({ deadlineId: before?.['id'], outcome: 'done' }));
    const after = await poll(nextDeadline, (value) => value?.['id'] !== before?.['id']);
    expect(after?.['id']).not.toBe(before?.['id']);
    const waived = await failure(
      call(DEADLINE_CALLABLES.complete, withRequest({ deadlineId: after?.['id'], outcome: 'waived', reason: 'x' })),
    );
    expect(waived.code).toBe('functions/permission-denied');
    await signInAs('lawyer');
    await call(
      DEADLINE_CALLABLES.complete,
      withRequest({ deadlineId: after?.['id'], outcome: 'waived', reason: 'Not needed for this estate' }),
    );
    expect(await auditActions()).toEqual(expect.arrayContaining(['deadline.done', 'deadline.waived']));
  });

  it('a manual deadline created by a client becomes the next deadline', async () => {
    await signInAs('paralegal');
    const uid = uidOf('paralegal');
    await setDoc(doc(firestore, `${DEADLINES}/manual-1`), {
      orgId: ORG,
      matterId: MATTER_ID,
      title: 'Fictional settlement date',
      // Earlier than every computed date (all after the date of death), overdue included.
      dueDate: '2026-01-05',
      kind: 'contractual',
      critical: false,
      status: 'upcoming',
      assigneeUid: uid,
      reminders: [],
      createdAt: serverTimestamp(),
      createdBy: uid,
      updatedAt: serverTimestamp(),
      updatedBy: uid,
      schemaVersion: 1,
    });
    expect(await poll(nextDeadline, (value) => value?.['id'] === 'manual-1')).toMatchObject({
      id: 'manual-1',
      dueDate: '2026-01-05',
    });
    // Status changes go through deadlines-complete.
    await expect(
      updateDoc(doc(firestore, `${DEADLINES}/manual-1`), {
        status: 'done',
        updatedAt: serverTimestamp(),
        updatedBy: uid,
      }),
    ).rejects.toBeTruthy();
  });
});

describe('concurrency and calendars', () => {
  beforeAll(() => resetMatter());

  it('serialises concurrent recomputes on the matter: every event lands, one version each', async () => {
    await signInAs('lawyer');
    const dates = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05'];
    await Promise.all(dates.map((date) => upsertEvent({ kind: 'notice_published', date })));
    const matter = await data(MATTER);
    expect(matter['recomputeVersion']).toBe(dates.length);
    expect((await db.collection(`${MATTER}/events`).get()).size).toBe(dates.length);
    // The rule anchors on the earliest notice; one deadline, one linked task.
    expect(await data(`${DEADLINES}/rule-vic.probate.advert_min`)).toMatchObject({ status: 'upcoming' });
    const tasks = await db.collection(`${MATTER}/tasks`).where('deadlineId', '==', 'rule-vic.probate.advert_min').get();
    expect(tasks.size).toBe(1);
    expect(
      await poll(
        async () => (await data(MATTER))['openTaskCount'],
        (count) => count === 1,
      ),
    ).toBe(1);
  });

  it('blocks a deadline whose calendar year is missing', async () => {
    await signInAs('lawyer');
    const result = await upsertEvent({ kind: 'caveat_lodged', date: '2028-11-01' });
    expect(result.recompute.calendarMissing).toEqual(['rule-vic.caveat.expiry']);
    expect(await data(`${DEADLINES}/rule-vic.caveat.expiry`)).toMatchObject({
      status: 'blocked',
      blockedCode: 'calendar_missing',
    });
  });
});

describe('deadlines-proposeRulesetUpgrade', () => {
  const V2 = 'ruleSets/vic/versions/2';

  beforeAll(() => resetMatter({ deceased: { contactId: 'c-deceased', dateOfDeath: '2026-08-01' } }));
  afterAll(() => db.doc(V2).delete());

  it('turns a published version’s date changes into proposals, admins only', async () => {
    await signInAs('lawyer');
    await call(DEADLINE_CALLABLES.recompute, { matterId: MATTER_ID });
    expect((await data(`${DEADLINES}/rule-org.executor_year`))['dueDate']).toBe('2027-08-02');

    // Version 2 moves the executor's year to 11 months.
    const v2 = {
      ...VIC_RULESET_V1,
      version: 2,
      rules: VIC_RULESET_V1.rules.map((rule) =>
        rule.id === 'org.executor_year' && 'offset' in rule ? { ...rule, offset: { months: 11 } } : rule,
      ),
    } as RuleSet;
    await db.doc(V2).set({
      ...toRuleSetDoc(v2),
      createdAt: FieldValue.serverTimestamp(),
      createdBy: 'system',
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: 'system',
      schemaVersion: 1,
    });

    const denied = await failure(call(DEADLINE_CALLABLES.proposeRulesetUpgrade, { requestId: crypto.randomUUID() }));
    expect(denied.code).toBe('functions/permission-denied');
    await signInAs('admin');
    const result = await call<Data>(DEADLINE_CALLABLES.proposeRulesetUpgrade, { requestId: crypto.randomUUID() });
    expect(result).toMatchObject({ processed: 1, upgraded: 1, failed: [] });
    expect(result['proposed']).toBeGreaterThanOrEqual(1);
    const change = (
      await db
        .collection(`${MATTER}/deadlineChanges`)
        .where('deadlineId', '==', 'rule-org.executor_year')
        .where('status', '==', 'pending')
        .get()
    ).docs[0]?.data();
    expect(change).toMatchObject({ cause: 'ruleset_upgrade', fromDueDate: '2027-08-02', toDueDate: '2027-07-01' });
    // The date in force doesn't move until a lawyer accepts.
    expect((await data(`${DEADLINES}/rule-org.executor_year`))['dueDate']).toBe('2027-08-02');
    // Run again: nothing new.
    expect(
      await call<Data>(DEADLINE_CALLABLES.proposeRulesetUpgrade, { requestId: crypto.randomUUID() }),
    ).toMatchObject({ processed: 1, proposed: 0 });
  });

  it('the hourly job finds deadlines on version 1, upgrades the org to version 2 once, and records it', async () => {
    const log = createLog({ fn: 'deadlines-integration' }, () => undefined);
    const ruleSets = (await currentRuleSets(db, log)).filter((set) => set.ruleSetId === 'vic');
    expect(ruleSets.map((set) => set.version)).toEqual([2]);
    const deps = { clock: new FakeClock(NOW), log, ports: { tasks: new FakeTaskQueue() }, timeLeft: () => true };
    // The proposal from the run by hand is still pending, so nothing new is proposed.
    expect(await upgradeOrgRuleSets(db, ORG, ruleSets, deps)).toEqual([
      { ruleSetId: 'vic', version: 2, status: 'done', processed: 1, proposed: 0 },
    ]);
    expect(await data(ruleSetUpgradePath(ORG, 'vic', 2))).toMatchObject({ status: 'done', processed: 1, failed: [] });
    expect(await upgradeOrgRuleSets(db, ORG, ruleSets, deps)).toEqual([
      { ruleSetId: 'vic', version: 2, status: 'skipped', processed: 0, proposed: 0 },
    ]);
  });
});
