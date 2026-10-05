import { randomUUID } from 'node:crypto';

import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut, type Auth } from 'firebase/auth';
import { connectFunctionsEmulator, getFunctions, httpsCallable, type FunctionsError } from 'firebase/functions';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore as getAdminFirestore, type Firestore } from 'firebase-admin/firestore';

import type {
  ConflictHit,
  CreateMatterResult,
  DetermineConflictResult,
  Role,
  RunConflictCheckResult,
} from '@materia/domain';
import {
  buildConflictFixture,
  CONFLICT_CONTACTS as C,
  CONFLICT_MATTERS as M,
  CONFLICT_SCENARIOS,
  type ExpectedConflictHit,
} from '@materia/test-utils';

/**
 * CORE-02 through the emulators: conflicts-run (the seeded 5 adverse and 5 benign scenarios, with
 * conflicts.enforced on and off), conflicts-determine with its audit, the lead → open gate in
 * matters-changeStatus, and the conflicts-onPartyAdded trigger. Everything is fictional.
 */
const PROJECT_ID = 'demo-materia';
const ORG = 'org-conflicts';
/** The same scenarios with conflicts.enforced off (the flag's default). */
const ORG_OFF = 'org-conflicts-off';
const PASSWORD = 'fictional-password-c2';
const MP = `orgs/${ORG}/matters`;
const NOW = new Date('2026-06-01T00:00:00Z');

let admin: App;
let db: Firestore;
let client: FirebaseApp;
let auth: Auth;

const meta = {
  createdAt: FieldValue.serverTimestamp(),
  createdBy: 'seed',
  updatedAt: FieldValue.serverTimestamp(),
  updatedBy: 'seed',
  schemaVersion: 1,
};

type Who = Role | 'off-lawyer';
const uidOf = (who: Who) => `conflicts-${who}`;

async function createMember(who: Who, orgId: string, role: Role) {
  const adminAuth = getAdminAuth(admin);
  await adminAuth.createUser({ uid: uidOf(who), email: `${uidOf(who)}@example.test`, password: PASSWORD });
  await adminAuth.setCustomUserClaims(uidOf(who), { orgId, role });
  await db.doc(`orgs/${orgId}/members/${uidOf(who)}`).set({ role, status: 'active' });
}

async function signInAs(who: Who) {
  await signOut(auth);
  await signInWithEmailAndPassword(auth, `${uidOf(who)}@example.test`, PASSWORD);
}

function call<T>(name: string, data: Record<string, unknown>) {
  return httpsCallable<Record<string, unknown>, T>(
    getFunctions(client, 'australia-southeast1'),
    name,
  )(data).then((result) => result.data);
}
const run = (data: Record<string, unknown>) =>
  call<RunConflictCheckResult>('conflicts-run', { requestId: randomUUID(), ...data });
const determine = (data: Record<string, unknown>) =>
  call<DetermineConflictResult>('conflicts-determine', { requestId: randomUUID(), ...data });
const changeStatus = (matterId: string, to: string) =>
  call('matters-changeStatus', { requestId: randomUUID(), matterId, to });

async function failure(promise: Promise<unknown>): Promise<FunctionsError> {
  try {
    await promise;
  } catch (error) {
    return error as FunctionsError;
  }
  throw new Error('expected the call to fail');
}
const detailsOf = (error: FunctionsError) => (error.details ?? {}) as Record<string, unknown>;

async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    value = await read();
  }
  return value;
}

const data = async (path: string) => (await db.doc(path).get()).data() ?? {};

/** A hit as the scenario expectations describe it. */
const summary = (hits: ConflictHit[]): ExpectedConflictHit[] =>
  hits
    .map((hit) => ({
      contactId: hit.contactId,
      ...(hit.viaMergedContactId ? { viaMergedContactId: hit.viaMergedContactId } : {}),
      matters: hit.matters.map((m) => ({ matterId: m.matterId, role: m.role, status: m.status, adverse: !!m.adverse })),
    }))
    .sort((a, b) => a.contactId.localeCompare(b.contactId));
const sorted = (hits: readonly ExpectedConflictHit[]) =>
  [...hits].sort((a, b) => a.contactId.localeCompare(b.contactId));

async function seedOrg(orgId: string, enforced: boolean) {
  await db.recursiveDelete(db.doc(`orgs/${orgId}`));
  await db.doc(`orgs/${orgId}`).set({
    name: 'Fictional Conflicts Practice',
    retentionYears: 7,
    timezone: 'Australia/Melbourne',
    matterNumberFormat: 'CF-{YYYY}-{seq:4}',
    // The per-org override flags-setOrgOverride writes (FND-23).
    ...(enforced ? { flags: { 'conflicts.enforced': true } } : {}),
  });
  const fixture = buildConflictFixture({
    orgId,
    uid: uidOf('lawyer'),
    now: NOW,
    format: 'CF-{YYYY}-{seq:4}',
    year: 2026,
    firstSeq: 1,
  });
  const batch = db.batch();
  for (const doc of fixture.docs) batch.set(db.doc(doc.path), doc.data);
  await batch.commit();
}

beforeAll(async () => {
  admin = initializeAdminApp({ projectId: PROJECT_ID }, 'conflicts-integration-admin');
  db = getAdminFirestore(admin);
  const adminAuth = getAdminAuth(admin);
  const existing = await adminAuth.listUsers();
  await Promise.all(
    existing.users.filter((u) => u.uid.startsWith('conflicts-')).map((u) => adminAuth.deleteUser(u.uid)),
  );
  await seedOrg(ORG, true);
  await seedOrg(ORG_OFF, false);
  for (const role of ['owner', 'lawyer', 'paralegal', 'readonly'] as const) await createMember(role, ORG, role);
  await createMember('off-lawyer', ORG_OFF, 'lawyer');

  client = initializeApp({ projectId: PROJECT_ID, apiKey: 'demo-api-key' }, 'conflicts-integration-client');
  auth = getAuth(client);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFunctionsEmulator(getFunctions(client, 'australia-southeast1'), '127.0.0.1', 5001);
});

afterAll(async () => {
  await signOut(auth);
  await deleteApp(client);
  await deleteAdminApp(admin);
});

describe('seeded scenarios (5 adverse, 5 benign)', () => {
  it('has five of each', () => {
    expect(CONFLICT_SCENARIOS.filter((s) => s.kind === 'adverse')).toHaveLength(5);
    expect(CONFLICT_SCENARIOS.filter((s) => s.kind === 'benign')).toHaveLength(5);
  });

  it.each(CONFLICT_SCENARIOS.map((s) => [s.kind, s.name, s] as const))(
    '%s: %s produces the expected hit set (conflicts.enforced on)',
    async (kind, _name, scenario) => {
      await signInAs('paralegal');
      const result = await run({ subjects: scenario.subjects });
      expect(result.adverseRolesChecked).toBe(true);
      expect(summary(result.hits)).toEqual(sorted(scenario.expected));
      const adverse = result.hits.some((hit) => hit.matters.some((m) => !!m.adverse));
      expect(adverse).toBe(kind === 'adverse');
    },
  );

  it('reports the same hits with roles only while conflicts.enforced is off', async () => {
    await signInAs('off-lawyer');
    for (const scenario of CONFLICT_SCENARIOS) {
      const result = await run({ subjects: scenario.subjects });
      expect(result.adverseRolesChecked, scenario.name).toBe(false);
      const unmarked = sorted(scenario.expected).map((hit) => ({
        ...hit,
        matters: hit.matters.map((m) => ({ ...m, adverse: false })),
      }));
      expect(summary(result.hits), scenario.name).toEqual(unmarked);
    }
  });
});

describe('conflicts-run', () => {
  it('stores the run and returns it; a repeat requestId replays it', async () => {
    await signInAs('paralegal');
    const requestId = randomUUID();
    const subjects = [{ name: 'Dorothea Quint', role: 'witness', dob: '1961-02-03' }];
    const first = await call<RunConflictCheckResult>('conflicts-run', { requestId, subjects });
    expect(await call<RunConflictCheckResult>('conflicts-run', { requestId, subjects })).toEqual(first);
    const stored = await data(`orgs/${ORG}/conflictChecks/${first.checkId}`);
    expect(stored).toMatchObject({
      ranBy: uidOf('paralegal'),
      adverseRolesChecked: true,
      subjects: [{ kind: 'person', name: 'Dorothea Quint', role: 'witness', dob: '1961-02-03' }],
      hits: first.hits,
    });
    const byPara = await db
      .collection(`orgs/${ORG}/conflictChecks`)
      .where('ranBy', '==', uidOf('paralegal'))
      .where('subjects', '==', stored['subjects'])
      .get();
    expect(byPara.size).toBe(1);
  });

  it('includes archived and deleted matters, follows a picked merged contact, and leaves out excludeMatterId', async () => {
    await db.doc(`${MP}/m-old-deleted`).set({
      ...meta,
      number: 'CF-2019-0001',
      title: 'Quint v Somebody (fictional)',
      type: 'contest',
      status: 'archived',
      privileged: false,
      deletedAt: new Date('2026-01-01T00:00:00Z'),
    });
    await db
      .doc(`${MP}/m-old-deleted/parties/p-1`)
      .set({ ...meta, orgId: ORG, matterId: 'm-old-deleted', contactId: C.dorothea, role: 'plaintiff' });
    await signInAs('lawyer');
    const all = await run({ subjects: [{ name: 'Dorothea Quint', role: 'client' }] });
    expect(all.hits[0]?.matters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ matterId: 'm-old-deleted', status: 'archived', deleted: true }),
        expect.objectContaining({ matterId: M.contest, status: 'open', role: 'defendant' }),
      ]),
    );
    const excluded = await run({ subjects: [{ name: 'Dorothea Quint', role: 'client' }], excludeMatterId: M.contest });
    expect(excluded.hits[0]?.matters.map((m) => m.matterId)).toEqual(['m-old-deleted']);

    const picked = await run({ subjects: [{ name: 'Fenella Brightwater', role: 'client', contactId: C.fenellaOld }] });
    expect(picked.hits).toHaveLength(1);
    expect(picked.hits[0]).toMatchObject({ contactId: C.fenella, self: true, viaMergedContactId: C.fenellaOld });
  });

  it('skips soft-deleted contacts', async () => {
    await db.doc(`orgs/${ORG}/contacts/c-deleted`).set({
      ...meta,
      kind: 'person',
      givenNames: 'Peregrine',
      familyName: 'Oakhollow',
      emails: [],
      phones: [],
      deletedAt: new Date('2026-01-01T00:00:00Z'),
    });
    await signInAs('paralegal');
    expect((await run({ subjects: [{ name: 'Peregrine Oakhollow', role: 'client' }] })).hits).toEqual([]);
  });

  it('is for conflict.run roles: readonly is refused', async () => {
    await signInAs('readonly');
    const error = await failure(run({ subjects: [{ name: 'Ada Quill', role: 'client' }] }));
    expect(detailsOf(error)['code']).toBe('PERMISSION_DENIED');
  });
});

describe('determinations and opening a matter', () => {
  const newLead = (title: string) =>
    call<CreateMatterResult>('matters-createMatter', {
      requestId: randomUUID(),
      matter: {
        title,
        type: 'probate',
        jurisdiction: 'VIC',
        responsibleUid: uidOf('lawyer'),
        teamUids: [],
        clientContactIds: [C.juniper],
        fee: { arrangement: 'hourly' },
        costsDisclosure: { status: 'required' },
        conflictCheck: { status: 'pending' },
      },
    });
  const auditFor = async (matterId: string) =>
    (
      await db
        .collection(`orgs/${ORG}/audit`)
        .where('action', '==', 'matter.conflict_determined')
        .where('entity.path', '==', `${MP}/${matterId}`)
        .get()
    ).docs.map((d) => d.data());

  it('a matter can’t be opened without a determination; clear opens it, and it is audited', async () => {
    await signInAs('paralegal');
    const { matterId, status } = await newLead('Estate of Fictional Ashdown');
    expect(status).toBe('lead');
    const check = await run({ subjects: [{ name: 'Peregrine Oakhollow', role: 'client' }], excludeMatterId: matterId });
    // A paralegal runs the check but can't determine it.
    expect(detailsOf(await failure(determine({ checkId: check.checkId, matterId, status: 'clear' })))['code']).toBe(
      'PERMISSION_DENIED',
    );

    await signInAs('lawyer');
    const blocked = await failure(changeStatus(matterId, 'open'));
    expect(blocked.code).toBe('functions/failed-precondition');
    expect(detailsOf(blocked)).toMatchObject({ reason: 'conflict_check_not_clear', conflictStatus: 'pending' });

    expect(await determine({ checkId: check.checkId, matterId, status: 'clear' })).toEqual({
      matterId,
      status: 'clear',
    });
    expect((await data(`${MP}/${matterId}`))['conflictCheck']).toMatchObject({
      status: 'clear',
      checkedBy: uidOf('lawyer'),
      resultId: check.checkId,
    });
    expect(await auditFor(matterId)).toEqual([
      expect.objectContaining({
        actor: { uid: uidOf('lawyer') },
        data: expect.objectContaining({ status: 'clear', previousStatus: 'pending', checkId: check.checkId }),
      }),
    ]);
    expect(await changeStatus(matterId, 'open')).toEqual({ matterId, status: 'open' });
  });

  it('potential needs a reason and a lawyer, is audited with the reason, and opens', async () => {
    await signInAs('lawyer');
    const { matterId } = await newLead('Estate of Fictional Stroud');
    const check = await run({ subjects: [{ name: 'Barnaby Stroud', role: 'executor' }], excludeMatterId: matterId });
    expect(check.hits[0]?.matters[0]?.adverse).toBeTruthy();
    const noReason = await failure(determine({ checkId: check.checkId, matterId, status: 'potential' }));
    expect(noReason.code).toBe('functions/invalid-argument');

    const reason = 'Different Barnaby Stroud: date of birth and address differ (fictional)';
    await determine({ checkId: check.checkId, matterId, status: 'potential', reason });
    expect((await data(`${MP}/${matterId}`))['conflictCheck']).toMatchObject({ status: 'potential', reason });
    expect(await auditFor(matterId)).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ status: 'potential', reason, adverse: true }) }),
    ]);
    expect(await changeStatus(matterId, 'open')).toEqual({ matterId, status: 'open' });
  });

  it('conflict blocks opening', async () => {
    await signInAs('owner');
    const { matterId } = await newLead('Estate of Fictional Quint');
    const check = await run({ subjects: [{ name: 'Dorothea Quint', role: 'client' }], excludeMatterId: matterId });
    const reason = 'We act for the plaintiff against Dorothea Quint (fictional)';
    await determine({ checkId: check.checkId, matterId, status: 'conflict', reason });
    const blocked = await failure(changeStatus(matterId, 'open'));
    expect(detailsOf(blocked)).toMatchObject({ reason: 'conflict_check_not_clear', conflictStatus: 'conflict' });
    expect((await data(`${MP}/${matterId}`))['status']).toBe('lead');
    expect(await auditFor(matterId)).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ status: 'conflict', reason }) }),
    ]);
  });

  it('a check run for another matter is refused', async () => {
    await signInAs('lawyer');
    const { matterId } = await newLead('Estate of Fictional Pell');
    const other = await run({ subjects: [{ name: 'Cosima Pell', role: 'client' }], excludeMatterId: M.probate });
    const error = await failure(determine({ checkId: other.checkId, matterId, status: 'clear' }));
    expect(detailsOf(error)).toMatchObject({ code: 'FAILED_PRECONDITION', reason: 'check_for_another_matter' });
  });
});

describe('conflicts-onPartyAdded', () => {
  const addParty = (matterId: string, partyId: string, contactId: string, role: string) =>
    db
      .doc(`${MP}/${matterId}/parties/${partyId}`)
      .set({ ...meta, createdBy: uidOf('paralegal'), orgId: ORG, matterId, contactId, role });
  const notificationsFor = async (matterId: string) =>
    (
      await db
        .collection(`orgs/${ORG}/notifications`)
        .where('matterId', '==', matterId)
        .where('kind', '==', 'conflict_alert')
        .get()
    ).docs.map((d) => d.data());

  it('alerts an open matter and notifies its responsible lawyer when a new party is on other matters', async () => {
    // Barnaby, the plaintiff on the Stroud claim, added as executor of the open Halloway estate.
    await addParty(M.probate, 'p-new-barnaby', C.barnaby, 'executor');
    const matter = await poll(
      () => data(`${MP}/${M.probate}`),
      (m) => !!m['conflictAlert'],
    );
    const alert = matter['conflictAlert'] as { checkId: string; contactId: string; adverse: boolean; partyId: string };
    expect(alert).toMatchObject({ contactId: C.barnaby, partyId: 'p-new-barnaby', adverse: true });
    expect(await data(`orgs/${ORG}/conflictChecks/${alert.checkId}`)).toMatchObject({
      excludeMatterId: M.probate,
      ranBy: uidOf('paralegal'),
      adverseRolesChecked: true,
    });
    const notifications = await poll(
      () => notificationsFor(M.probate),
      (list) => list.length > 0,
    );
    expect(notifications).toEqual([
      expect.objectContaining({
        recipientUid: uidOf('lawyer'),
        checkId: alert.checkId,
        contactId: C.barnaby,
        priority: 'high',
        link: `/matters/${M.probate}`,
        channels: ['inapp'],
        readAt: null,
      }),
    ]);
    // Nothing is blocked retroactively.
    expect(matter['status']).toBe('open');

    // Determining on that check clears the alert.
    await signInAs('lawyer');
    await determine({
      checkId: alert.checkId,
      matterId: M.probate,
      status: 'potential',
      reason: 'Executor appointment reviewed; no conflict in acting (fictional)',
    });
    expect((await data(`${MP}/${M.probate}`))['conflictAlert']).toBeUndefined();
  });

  it('leaves leads alone (they get the full check before opening)', async () => {
    await db.doc(`${MP}/m-lead`).set({
      ...meta,
      number: 'CF-2026-0900',
      title: 'Fictional lead',
      type: 'probate',
      status: 'lead',
      responsibleUid: uidOf('lawyer'),
      privileged: false,
      conflictCheck: { status: 'pending' },
      deletedAt: null,
    });
    await addParty('m-lead', 'p-lead-barnaby', C.barnaby, 'executor');
    // An open matter's party added afterwards is processed: once it is, the lead's would have been too.
    await addParty(M.will, 'p-will-dorothea', C.dorothea, 'witness');
    await poll(
      () => data(`${MP}/${M.will}`),
      (m) => !!m['conflictAlert'],
    );
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const leadChecks = await db.collection(`orgs/${ORG}/conflictChecks`).where('excludeMatterId', '==', 'm-lead').get();
    expect(leadChecks.size).toBe(0);
    expect((await data(`${MP}/m-lead`))['conflictAlert']).toBeUndefined();
  });
});
