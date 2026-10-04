import { randomUUID } from 'node:crypto';

import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut, type Auth } from 'firebase/auth';
import { connectFunctionsEmulator, getFunctions, httpsCallable, type FunctionsError } from 'firebase/functions';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { getFirestore as getAdminFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';

import {
  contactDerivedFields,
  intakeFormSchema,
  intakeToCreateMatterInput,
  type CreateMatterResult,
  type DateOnly,
  type Role,
  type RunConflictCheckResult,
} from '@materia/domain';

/**
 * CORE-05 through the emulators: matters-createMatter with the intake extension (parties, events,
 * fee, costs disclosure, the conflict check link) in one transaction, with the system templates on.
 * Probate with a client created through contacts-create, family provision with the other side, an
 * unknown date of death, a conflict determination, an idempotent retry and an atomic rollback.
 * All people, practices and matters are fictional.
 */
const PROJECT_ID = 'demo-materia';
const ORG = 'org-intake';
const PASSWORD = 'fictional-password-c5';
const M = `orgs/${ORG}/matters`;
// 11:00 on 4 October 2026 in Melbourne, pinned for this org (emulatorClock).
const NOW = new Date('2026-10-04T01:00:00.000Z');
const TODAY = '2026-10-04' as DateOnly;

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
const person = (given: string, family: string, extra: Record<string, unknown> = {}) => {
  const fields = {
    kind: 'person' as const,
    givenNames: given,
    familyName: family,
    emails: [],
    phones: [],
    addresses: [],
    tags: [],
    isReferrer: false,
    ...extra,
  };
  return { ...meta, ...fields, ...contactDerivedFields(fields as never), deletedAt: null };
};

const uidOf = (role: Role) => `intk-${role}`;

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
const detailsOf = (error: FunctionsError) => (error.details ?? {}) as Record<string, unknown>;
const data = async (path: string) => (await db.doc(path).get()).data() ?? {};
const docsUnder = async (matterId: string, sub: string) =>
  (await db.collection(`${M}/${matterId}/${sub}`).get()).docs.map((doc): Record<string, unknown> & { id: string } => ({
    ...doc.data(),
    id: doc.id,
  }));
const ids = async (matterId: string, sub: string) => (await docsUnder(matterId, sub)).map((doc) => doc.id).sort();

const form = intakeFormSchema({ today: () => TODAY });

/** Runs the conflict check the intake form runs for its subjects (as the signed-in user). */
const runCheck = (subjects: { name: string; role: string; contactId?: string }[]) =>
  call<RunConflictCheckResult>('conflicts-run', { requestId: randomUUID(), subjects });

/**
 * The matter numbers, counter and matters of the org: what a rolled-back create must not change.
 * (Audit entries are left out: the audit triggers of earlier writes land asynchronously.)
 */
async function footprint() {
  const [counter, numbers, matters] = await Promise.all([
    db.doc(`orgs/${ORG}/counters/matter-2026`).get(),
    db.collection(`orgs/${ORG}/matterNumbers`).get(),
    db.collection(M).get(),
  ]);
  return {
    next: counter.get('next') as unknown,
    numbers: numbers.docs.map((doc) => doc.id).sort(),
    matters: matters.docs.map((doc) => doc.id).sort(),
  };
}

beforeAll(async () => {
  admin = initializeAdminApp({ projectId: PROJECT_ID }, 'intake-integration-admin');
  db = getAdminFirestore(admin);
  const adminAuth = getAdminAuth(admin);
  const existing = await adminAuth.listUsers();
  await Promise.all(existing.users.filter((u) => u.uid.startsWith('intk-')).map((u) => adminAuth.deleteUser(u.uid)));
  await db.recursiveDelete(db.doc(`orgs/${ORG}`));
  await db.doc(`orgs/${ORG}`).set({
    name: 'Fictional Intake Practice',
    retentionYears: 7,
    timezone: 'Australia/Melbourne',
    matterNumberFormat: 'IN-{YYYY}-{seq:4}',
    flags: { 'templates.system': true },
  });
  await db.doc(`emulatorClock/${ORG}`).set({ now: Timestamp.fromDate(NOW) });
  await db.doc(`orgs/${ORG}/contacts/c-orla`).set(person('Orla', 'Fenwick', { dateOfBirth: '1938-04-12' }));
  await db.doc(`orgs/${ORG}/contacts/c-piet`).set(person('Piet', 'Fenwick'));
  await db.doc(`orgs/${ORG}/contacts/c-quinn`).set(person('Quinn', 'Marrow'));
  await db.doc(`orgs/${ORG}/contacts/c-rhea`).set(person('Rhea', 'Marrow'));
  await db.doc(`orgs/${ORG}/contacts/c-silas`).set(person('Silas', 'Thorne', { dateOfBirth: '1950-09-30' }));
  for (const role of ['owner', 'lawyer', 'paralegal', 'readonly'] as const) await createMember(role);

  client = initializeApp({ projectId: PROJECT_ID, apiKey: 'demo-api-key' }, 'intake-integration-client');
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

describe('matters-createMatter intake (CORE-05)', () => {
  it('probate with a new client and the deceased: stage, tasks, events, parties and the conflict link', async () => {
    await signInAs('lawyer');
    // The new client goes through the contacts flow first.
    const { contactId: newClient } = await call<{ contactId: string }>('contacts-create', {
      requestId: randomUUID(),
      contact: { kind: 'person', givenNames: 'Tamsin', familyName: 'Fenwick' },
    });
    const check = await runCheck([
      { name: 'Tamsin Fenwick', role: 'client', contactId: newClient },
      { name: 'Orla Fenwick', role: 'deceased', contactId: 'c-orla' },
    ]);
    const input = intakeToCreateMatterInput(
      form.parse({
        type: { type: 'probate' },
        clients: { clientContactIds: [newClient] },
        details: {
          type: 'probate',
          deceasedContactId: 'c-orla',
          deceasedDateOfBirth: '1938-04-12',
          dateOfDeath: '2026-08-01',
          domicile: 'VIC',
          lastAddress: '12 Fictional Parade, Geelong VIC 3220',
          willExists: true,
          willDate: '2018-11-20',
        },
        parties: {
          parties: [
            { contactId: newClient, role: 'executor' },
            { contactId: 'c-piet', role: 'beneficiary', share: 'One half' },
          ],
        },
        fees: { fee: { arrangement: 'fixed', amountCents: 385000 } },
        conflict: { checkId: check.checkId, status: 'clear' },
        review: { title: 'Estate of Orla Fenwick', responsibleUid: uidOf('lawyer'), teamUids: [uidOf('paralegal')] },
      }),
      randomUUID(),
    );
    const { matterId, number, status } = await call<CreateMatterResult>('matters-createMatter', input);
    expect(status).toBe('open');
    expect(number).toMatch(/^IN-2026-\d{4}$/);

    const matter = await data(`${M}/${matterId}`);
    expect(matter).toMatchObject({
      templateId: 'system-probate',
      stageId: 'instructions',
      stageEnteredOn: TODAY,
      deceased: { contactId: 'c-orla', dateOfDeath: '2026-08-01', domicile: 'VIC' },
      facts: { willDate: '2018-11-20' },
      estate: { grantType: 'probate' },
      fee: { arrangement: 'fixed', amountCents: 385000, history: [] },
      costsDisclosure: { status: 'required', estimateCents: 385000 },
      conflictCheck: { status: 'clear', resultId: check.checkId, checkedBy: uidOf('lawyer') },
      clientContactIds: [newClient],
    });
    expect(await ids(matterId, 'parties')).toEqual(
      [`client-${newClient}`, `executor-${newClient}`, 'beneficiary-c-piet', 'deceased-c-orla'].sort(),
    );
    expect(await data(`${M}/${matterId}/parties/beneficiary-c-piet`)).toMatchObject({
      share: 'One half',
      addedFrom: 'manual',
    });
    const events = await docsUnder(matterId, 'events');
    expect(events).toEqual([expect.objectContaining({ kind: 'date_of_death', date: '2026-08-01' })]);
    // Template tasks with due dates: from the stage entry, and from the known date of death.
    expect(await data(`${M}/${matterId}/tasks/tpl-obtain_death_certificate`)).toMatchObject({ dueDate: '2026-10-18' });
    expect(await data(`${M}/${matterId}/tasks/tpl-notify_centrelink`)).toMatchObject({ dueDate: '2026-08-29' });
    expect(await data(`${M}/${matterId}/tasks/tpl-engage_tax_accountant`)).toMatchObject({ dueDate: '2026-10-30' });
    const tasks = await docsUnder(matterId, 'tasks');
    expect(tasks.every((task) => typeof task['dueDate'] === 'string')).toBe(true);
    expect(matter['openTaskCount']).toBe(tasks.length);
  });

  it('family provision: our client as plaintiff, the other side as defendants', async () => {
    await signInAs('lawyer');
    const check = await runCheck([
      { name: 'Quinn Marrow', role: 'plaintiff', contactId: 'c-quinn' },
      { name: 'Rhea Marrow', role: 'defendant', contactId: 'c-rhea' },
    ]);
    const input = intakeToCreateMatterInput(
      form.parse({
        type: { type: 'fp' },
        clients: { clientContactIds: ['c-quinn'] },
        details: {
          type: 'fp',
          deceasedContactId: 'c-silas',
          dateOfDeath: '2026-03-02',
          ourRole: 'plaintiff',
          otherSideContactIds: ['c-rhea'],
        },
        parties: { parties: [] },
        fees: { fee: { arrangement: 'conditional', conditional: { upliftPct: 25, condition: 'A successful claim' } } },
        conflict: { checkId: check.checkId, status: 'clear' },
        review: { title: 'Marrow v Marrow (Estate of Silas Thorne)', responsibleUid: uidOf('lawyer') },
      }),
      randomUUID(),
    );
    const { matterId } = await call<CreateMatterResult>('matters-createMatter', input);
    expect(await ids(matterId, 'parties')).toEqual([
      'client-c-quinn',
      'deceased-c-silas',
      'defendant-c-rhea',
      'plaintiff-c-quinn',
    ]);
    expect(await data(`${M}/${matterId}`)).toMatchObject({
      templateId: 'system-fp',
      dispute: { kind: 'family_provision' },
      deceased: { contactId: 'c-silas', dateOfDeath: '2026-03-02', domicile: '' },
      fee: { arrangement: 'conditional', conditional: { upliftPct: 25 } },
      costsDisclosure: { status: 'required' },
    });
    expect((await docsUnder(matterId, 'events')).map((e) => e['kind'])).toEqual(['date_of_death']);
  });

  it('unknown date of death: no event, one death certificate task, template dues pending', async () => {
    await signInAs('paralegal');
    const check = await runCheck([{ name: 'Orla Fenwick', role: 'deceased', contactId: 'c-orla' }]);
    const intake = (type: 'probate' | 'admin') =>
      intakeToCreateMatterInput(
        form.parse({
          type: { type },
          clients: { clientContactIds: ['c-piet'] },
          details: { type, deceasedContactId: 'c-orla', dateOfDeath: 'unknown', domicile: 'VIC', willExists: true },
          parties: { parties: [] },
          fees: { fee: { arrangement: 'hourly', estimateCents: 600000 } },
          conflict: { checkId: check.checkId, status: 'pending' },
          review: { title: `Estate of Orla Fenwick (${type})`, responsibleUid: uidOf('lawyer') },
        }),
        randomUUID(),
      );
    for (const type of ['probate', 'admin'] as const) {
      const { matterId, status } = await call<CreateMatterResult>('matters-createMatter', intake(type));
      expect(status).toBe('lead');
      const matter = await data(`${M}/${matterId}`);
      expect(matter['deceased']).toEqual({ contactId: 'c-orla', domicile: 'VIC', lastAddress: '' });
      expect(matter['conflictCheck']).toEqual({ status: 'pending', resultId: check.checkId });
      expect(await docsUnder(matterId, 'events')).toEqual([]);
      const tasks = await docsUnder(matterId, 'tasks');
      expect(tasks.filter((task) => task.id === 'tpl-obtain_death_certificate')).toHaveLength(1);
      expect(tasks.filter((task) => /death certificate/i.test(String(task['title'])))).toHaveLength(1);
      expect(await data(`${M}/${matterId}/tasks/tpl-notify_centrelink`)).toMatchObject({ duePending: 'date_of_death' });
      expect((await data(`${M}/${matterId}/tasks/tpl-notify_centrelink`))['dueDate']).toBeUndefined();
      expect(matter['openTaskCount']).toBe(tasks.length);
      // A repeat apply of the template still leaves exactly one.
      await signInAs('lawyer');
      await call('templates-apply', {
        requestId: randomUUID(),
        matterId,
        templateId: matter['templateId'],
        version: matter['templateVersion'],
      });
      expect((await ids(matterId, 'tasks')).filter((id) => id === 'tpl-obtain_death_certificate')).toHaveLength(1);
      await signInAs('paralegal');
    }
  });

  it("a determination of 'conflict' creates a lead; recording it needs conflict.determine", async () => {
    await signInAs('lawyer');
    const check = await runCheck([{ name: 'Rhea Marrow', role: 'client', contactId: 'c-rhea' }]);
    const intake = () =>
      intakeToCreateMatterInput(
        form.parse({
          type: { type: 'will' },
          clients: { clientContactIds: ['c-rhea'] },
          details: { type: 'will', testatorContactId: 'c-rhea' },
          parties: { parties: [{ contactId: 'c-rhea', role: 'executor' }] },
          fees: { fee: { arrangement: 'fixed', amountCents: 55000 } },
          conflict: { checkId: check.checkId, status: 'conflict', reason: 'We act for her opponent in another matter' },
          review: { title: 'Will of Rhea Marrow', responsibleUid: uidOf('lawyer') },
        }),
        randomUUID(),
      );
    const { matterId, status } = await call<CreateMatterResult>('matters-createMatter', intake());
    expect(status).toBe('lead');
    expect(await data(`${M}/${matterId}`)).toMatchObject({
      status: 'lead',
      testator: { contactId: 'c-rhea' },
      costsDisclosure: { status: 'not_required', estimateCents: 55000 },
      conflictCheck: {
        status: 'conflict',
        resultId: check.checkId,
        reason: 'We act for her opponent in another matter',
      },
    });
    // Testator and executor: one contact, two rows.
    expect(await ids(matterId, 'parties')).toEqual(['client-c-rhea', 'executor-c-rhea', 'testator-c-rhea']);
    const blocked = await failure(call('matters-changeStatus', { requestId: randomUUID(), matterId, to: 'open' }));
    expect(detailsOf(blocked)).toMatchObject({ reason: 'conflict_check_not_clear' });

    await signInAs('paralegal');
    const denied = await failure(call('matters-createMatter', intake()));
    expect(detailsOf(denied)).toMatchObject({ code: 'PERMISSION_DENIED', reason: 'conflict_determine_required' });
  });

  it('a retry with the same requestId returns the same matter and creates nothing more', async () => {
    await signInAs('lawyer');
    const check = await runCheck([{ name: 'Piet Fenwick', role: 'client', contactId: 'c-piet' }]);
    const input = intakeToCreateMatterInput(
      form.parse({
        type: { type: 'trust' },
        clients: { clientContactIds: ['c-piet'] },
        details: { type: 'trust', trustName: 'Fenwick Family Trust', trusteeContactIds: ['c-piet', 'c-quinn'] },
        parties: { parties: [] },
        fees: { fee: { arrangement: 'hourly', estimateCents: 250000 } },
        conflict: { checkId: check.checkId, status: 'clear' },
        review: { title: 'Fenwick Family Trust', responsibleUid: uidOf('lawyer') },
      }),
      randomUUID(),
    );
    const first = await call<CreateMatterResult>('matters-createMatter', input);
    const before = await footprint();
    const retried = await Promise.all([
      call<CreateMatterResult>('matters-createMatter', input),
      call<CreateMatterResult>('matters-createMatter', input),
    ]);
    expect(retried).toEqual([first, first]);
    expect(await footprint()).toEqual(before);
    expect((await db.collection(M).where('facts.trustName', '==', 'Fenwick Family Trust').get()).size).toBe(1);
    expect(await ids(first.matterId, 'parties')).toEqual(['client-c-piet', 'trustee-c-piet', 'trustee-c-quinn']);
  });

  it('is all or nothing: an invalid party contact leaves no matter, number or counter step', async () => {
    await signInAs('lawyer');
    const check = await runCheck([{ name: 'Quinn Marrow', role: 'client', contactId: 'c-quinn' }]);
    const input = intakeToCreateMatterInput(
      form.parse({
        type: { type: 'probate' },
        clients: { clientContactIds: ['c-quinn'] },
        details: {
          type: 'probate',
          deceasedContactId: 'c-silas',
          dateOfDeath: '2026-05-05',
          domicile: 'VIC',
          willExists: true,
        },
        parties: {
          parties: [
            { contactId: 'c-quinn', role: 'executor' },
            { contactId: 'c-does-not-exist', role: 'beneficiary' },
          ],
        },
        fees: { fee: { arrangement: 'hourly' } },
        conflict: { checkId: check.checkId, status: 'clear' },
        review: { title: 'Estate of Silas Thorne', responsibleUid: uidOf('lawyer') },
      }),
      randomUUID(),
    );
    const before = await footprint();
    const error = await failure(call('matters-createMatter', input));
    expect(detailsOf(error)).toMatchObject({
      code: 'INVALID_ARGUMENT',
      fields: { 'parties.1.contactId': ['Choose an existing contact'] },
    });
    expect(await footprint()).toEqual(before);

    // A date of death before the deceased's date of birth (on the contact) is refused too.
    const early = { ...input, requestId: randomUUID(), parties: [] };
    (early.matter as { deceased: { dateOfDeath?: string } }).deceased.dateOfDeath = '1950-09-29';
    const tooEarly = await failure(call('matters-createMatter', early));
    expect(detailsOf(tooEarly)).toMatchObject({
      fields: { 'matter.deceased.dateOfDeath': ['The date of death cannot be before the date of birth'] },
    });
    expect(await footprint()).toEqual(before);
  });
});
