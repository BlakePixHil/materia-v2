import { randomUUID } from 'node:crypto';

import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut, type Auth } from 'firebase/auth';
import { connectFunctionsEmulator, getFunctions, httpsCallable, type FunctionsError } from 'firebase/functions';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { getFirestore as getAdminFirestore, type Firestore } from 'firebase-admin/firestore';

import {
  contactDerivedFields,
  type ChangeMatterStageResult,
  type CreateMatterResult,
  type PartyResult,
  type Role,
} from '@materia/domain';

/**
 * CORE-06 through the emulators: matters-changeStage (requirements, moving back, template stages,
 * permissions), matters-upsertParty and matters-removeParty (clientContactIds and the matter's
 * search kept in step by matters-denormalise, role and share edits, LAST_CLIENT) and the conflict
 * re-check of a party added to an open matter. All people, practices and matters are fictional.
 */
const PROJECT_ID = 'demo-materia';
const ORG = 'org-matter-detail';
const PASSWORD = 'fictional-password-c6';
const M = `orgs/${ORG}/matters`;

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
  return { ...meta, ...fields, ...contactDerivedFields(fields as never), deletedAt: null };
};

const uidOf = (role: Role) => `detail-${role}`;

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
const create = (title: string, extra: Record<string, unknown> = {}) =>
  call<CreateMatterResult>('matters-createMatter', {
    requestId: randomUUID(),
    matter: {
      title,
      type: 'probate',
      jurisdiction: 'VIC',
      responsibleUid: uidOf('lawyer'),
      teamUids: [],
      clientContactIds: ['c-ada'],
      deceased: { contactId: 'c-bertram', dateOfDeath: '2026-05-01', domicile: 'VIC', lastAddress: 'Geelong VIC' },
      fee: { arrangement: 'hourly' },
      costsDisclosure: { status: 'required' },
      conflictCheck: { status: 'clear' },
      ...extra,
    },
  });
const changeStage = (matterId: string, stageId: string) =>
  call<ChangeMatterStageResult>('matters-changeStage', { requestId: randomUUID(), matterId, stageId });
const upsertParty = (matterId: string, input: Record<string, unknown>) =>
  call<PartyResult>('matters-upsertParty', { requestId: randomUUID(), matterId, ...input });
const removeParty = (matterId: string, partyId: string) =>
  call<PartyResult>('matters-removeParty', { requestId: randomUUID(), matterId, partyId });

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
const audits = async (action: string, matterId: string) =>
  (await db.collection(`orgs/${ORG}/audit`).where('action', '==', action).get()).docs
    .map((d) => d.data())
    .filter((entry) => (entry['data'] as { matterId?: string; to?: string } | undefined)?.matterId === matterId);

beforeAll(async () => {
  admin = initializeAdminApp({ projectId: PROJECT_ID }, 'matter-detail-integration-admin');
  db = getAdminFirestore(admin);
  const adminAuth = getAdminAuth(admin);
  const existing = await adminAuth.listUsers();
  await Promise.all(existing.users.filter((u) => u.uid.startsWith('detail-')).map((u) => adminAuth.deleteUser(u.uid)));
  await db.recursiveDelete(db.doc(`orgs/${ORG}`));
  await db.doc(`orgs/${ORG}`).set({
    name: 'Fictional Matter Detail Practice',
    retentionYears: 7,
    timezone: 'Australia/Melbourne',
    matterNumberFormat: 'MD-{YYYY}-{seq:4}',
  });
  await db.doc(`orgs/${ORG}/contacts/c-ada`).set(person('Ada', 'Quill'));
  await db.doc(`orgs/${ORG}/contacts/c-bertram`).set(person('Bertram', 'Quill'));
  await db.doc(`orgs/${ORG}/contacts/c-cleo`).set(person('Cleodora', 'Marchbanks'));
  await db.doc(`orgs/${ORG}/contacts/c-dov`).set(person('Dov', 'Pell'));
  await db.doc(`orgs/${ORG}/contacts/c-esk`).set(person('Eskarina', 'Thornwhistle'));
  for (const role of ['owner', 'lawyer', 'paralegal', 'readonly'] as const) await createMember(role);

  client = initializeApp({ projectId: PROJECT_ID, apiKey: 'demo-api-key' }, 'matter-detail-integration-client');
  auth = getAuth(client);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFunctionsEmulator(getFunctions(client, 'australia-southeast1'), '127.0.0.1', 5001);
});

afterAll(async () => {
  await signOut(auth);
  await deleteApp(client);
  await deleteAdminApp(admin);
});

describe('matters-changeStage', () => {
  it('moves forward when the key facts are recorded, refuses missing ones, and moves back', async () => {
    await signInAs('paralegal');
    const { matterId } = await create('Estate of Fictional Stagewright', {
      conflictCheck: { status: 'pending' },
    });
    // The matter has the date of death, so the grant application stage is open to it.
    expect(await changeStage(matterId, 'grant_application')).toEqual({ matterId, stageId: 'grant_application' });
    expect(await data(`${M}/${matterId}`)).toMatchObject({
      stageId: 'grant_application',
      updatedBy: uidOf('paralegal'),
    });

    // Grant issued needs the grant date.
    const refused = await failure(changeStage(matterId, 'grant_issued'));
    expect(refused.code).toBe('functions/failed-precondition');
    expect(detailsOf(refused)).toMatchObject({ code: 'MATTER_STAGE_REQUIREMENTS', requirements: ['grantDate'] });
    expect((await data(`${M}/${matterId}`))['stageId']).toBe('grant_application');

    await db.doc(`${M}/${matterId}`).update({ estate: { grantDate: '2026-05-20', grantNo: 'S PRB 2026 0101' } });
    expect((await changeStage(matterId, 'collection')).stageId).toBe('collection');
    // Moving back has no requirements.
    expect((await changeStage(matterId, 'intake')).stageId).toBe('intake');

    const entries = (await db.collection(`orgs/${ORG}/audit`).where('action', '==', 'matter.stage_changed').get()).docs
      .map((d) => d.data())
      .filter((entry) => (entry['entity'] as { id?: string } | undefined)?.id === matterId)
      .map((entry) => entry['data']);
    expect(entries).toEqual(
      expect.arrayContaining([
        { from: null, to: 'grant_application' },
        { from: 'grant_application', to: 'collection' },
        { from: 'collection', to: 'intake' },
      ]),
    );
    expect(detailsOf(await failure(changeStage(matterId, 'drafting')))).toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('uses the matter template’s stages', async () => {
    await db.doc(`orgs/${ORG}/templates/tpl-probate`).set({
      ...meta,
      name: 'Fictional small estate',
      matterType: 'probate',
      version: 1,
      stages: [
        { id: 'intake', title: 'Intake' },
        { id: 'valuation', title: 'Valuation' },
        { id: 'finalisation', title: 'Finalisation' },
      ],
      tasks: [],
      deadlineRuleIds: [],
      published: true,
      source: 'org',
    });
    await signInAs('lawyer');
    const { matterId } = await create('Estate of Fictional Templated');
    await db.doc(`${M}/${matterId}`).update({ templateId: 'tpl-probate' });
    expect((await changeStage(matterId, 'valuation')).stageId).toBe('valuation');
    // A default stage the template leaves out is unknown here.
    expect(detailsOf(await failure(changeStage(matterId, 'grant_application')))).toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('is for matter.edit roles: readonly is refused', async () => {
    await signInAs('lawyer');
    const { matterId } = await create('Estate of Fictional Onlooker');
    await signInAs('readonly');
    expect(detailsOf(await failure(changeStage(matterId, 'grant_application')))['code']).toBe('PERMISSION_DENIED');
    expect((await data(`${M}/${matterId}`))['stageId']).toBeUndefined();
  });
});

describe('matters-upsertParty and matters-removeParty', () => {
  it('adds a client and keeps clientContactIds and the search tokens in step', async () => {
    await signInAs('paralegal');
    const { matterId } = await create('Estate of Ivo', { conflictCheck: { status: 'pending' } });
    expect((await data(`${M}/${matterId}`))['search']).not.toContain('pell');
    const added = await upsertParty(matterId, { contactId: 'c-dov', role: 'client' });
    expect(added).toEqual({ matterId, partyId: 'client-c-dov', clientContactIds: ['c-ada', 'c-dov'] });
    expect(await data(`${M}/${matterId}/parties/client-c-dov`)).toMatchObject({
      orgId: ORG,
      matterId,
      contactId: 'c-dov',
      role: 'client',
      addedFrom: 'manual',
      createdBy: uidOf('paralegal'),
    });
    const matter = await poll(
      () => data(`${M}/${matterId}`),
      (m) => ((m['search'] as string[] | undefined) ?? []).includes('pell'),
    );
    expect(matter['clientContactIds']).toEqual(['c-ada', 'c-dov']);
    expect(matter['search']).toEqual(expect.arrayContaining(['dov', 'pell', 'ada', 'quill']));
    expect((await audits('matter.party_added', matterId))[0]).toMatchObject({
      data: { matterId, partyId: 'client-c-dov', contactId: 'c-dov', role: 'client' },
      actor: { uid: uidOf('paralegal') },
    });

    // Removing the client drops their name from the search again.
    expect((await removeParty(matterId, 'client-c-dov')).clientContactIds).toEqual(['c-ada']);
    const after = await poll(
      () => data(`${M}/${matterId}`),
      (m) => !((m['search'] as string[] | undefined) ?? []).includes('pell'),
    );
    expect(after['clientContactIds']).toEqual(['c-ada']);
    expect(after['search']).not.toContain('dov');
    expect(await data(`${M}/${matterId}/parties/client-c-dov`)).toMatchObject({ deletedBy: uidOf('paralegal') });
    expect(await audits('matter.party_removed', matterId)).toHaveLength(1);
  });

  it('edits share and notes, moves a row when its role changes, and revives a removed row', async () => {
    await signInAs('lawyer');
    const { matterId } = await create('Estate of Fictional Reshuffle');
    await upsertParty(matterId, { contactId: 'c-cleo', role: 'beneficiary', share: 'One quarter' });
    await upsertParty(matterId, {
      partyId: 'beneficiary-c-cleo',
      contactId: 'c-cleo',
      role: 'beneficiary',
      share: 'One half',
      notes: 'Residuary beneficiary',
    });
    expect(await data(`${M}/${matterId}/parties/beneficiary-c-cleo`)).toMatchObject({
      share: 'One half',
      notes: 'Residuary beneficiary',
    });
    expect(await audits('matter.party_updated', matterId)).toHaveLength(1);

    const moved = await upsertParty(matterId, {
      partyId: 'beneficiary-c-cleo',
      contactId: 'c-cleo',
      role: 'executor',
      notes: 'Residuary beneficiary',
    });
    expect(moved.partyId).toBe('executor-c-cleo');
    expect((await data(`${M}/${matterId}/parties/beneficiary-c-cleo`))['deletedAt']).toBeTruthy();
    expect(await data(`${M}/${matterId}/parties/executor-c-cleo`)).toMatchObject({
      role: 'executor',
      contactId: 'c-cleo',
      notes: 'Residuary beneficiary',
    });

    // Adding her back as a beneficiary revives the old row.
    expect((await upsertParty(matterId, { contactId: 'c-cleo', role: 'beneficiary' })).partyId).toBe(
      'beneficiary-c-cleo',
    );
    expect(await data(`${M}/${matterId}/parties/beneficiary-c-cleo`)).toMatchObject({
      deletedAt: null,
      deletedBy: null,
    });
  });

  it('refuses to remove or re-role the last client (LAST_CLIENT), and a merged contact', async () => {
    await signInAs('lawyer');
    const { matterId } = await create('Estate of Fictional Lastly');
    const removing = await failure(removeParty(matterId, 'client-c-ada'));
    expect(removing.code).toBe('functions/failed-precondition');
    expect(detailsOf(removing)).toMatchObject({ code: 'LAST_CLIENT' });
    expect(
      detailsOf(
        await failure(upsertParty(matterId, { partyId: 'client-c-ada', contactId: 'c-ada', role: 'executor' })),
      ),
    ).toMatchObject({ code: 'LAST_CLIENT' });
    expect((await data(`${M}/${matterId}/parties/client-c-ada`))['deletedAt']).toBeUndefined();
    expect((await data(`${M}/${matterId}`))['clientContactIds']).toEqual(['c-ada']);

    await db.doc(`orgs/${ORG}/contacts/c-merged`).set({ ...person('Ada', 'Quil'), mergedInto: 'c-ada' });
    expect(detailsOf(await failure(upsertParty(matterId, { contactId: 'c-merged', role: 'witness' })))).toMatchObject({
      code: 'INVALID_ARGUMENT',
      fields: { contactId: expect.any(Array) },
    });
  });

  it('is for matter.edit roles: readonly is refused', async () => {
    await signInAs('lawyer');
    const { matterId } = await create('Estate of Fictional Bystander');
    await signInAs('readonly');
    expect(detailsOf(await failure(upsertParty(matterId, { contactId: 'c-cleo', role: 'witness' })))['code']).toBe(
      'PERMISSION_DENIED',
    );
    expect(detailsOf(await failure(removeParty(matterId, 'deceased-c-bertram')))['code']).toBe('PERMISSION_DENIED');
  });

  it('re-checks conflicts when a party is added to an open matter: alert and notification', async () => {
    await signInAs('lawyer');
    // Eskarina is the client on one matter, then added as executor on another, open, matter.
    await create('Estate of Fictional Thornwhistle', { clientContactIds: ['c-esk'] });
    const { matterId, status } = await create('Estate of Fictional Crossover', { responsibleUid: uidOf('owner') });
    expect(status).toBe('open');
    await signInAs('paralegal');
    await upsertParty(matterId, { contactId: 'c-esk', role: 'executor' });

    const matter = await poll(
      () => data(`${M}/${matterId}`),
      (m) => !!m['conflictAlert'],
    );
    const alert = matter['conflictAlert'] as { checkId: string; contactId: string; partyId: string };
    expect(alert).toMatchObject({ contactId: 'c-esk', partyId: 'executor-c-esk' });
    expect(await data(`orgs/${ORG}/conflictChecks/${alert.checkId}`)).toMatchObject({
      excludeMatterId: matterId,
      ranBy: uidOf('paralegal'),
    });
    const notifications = await poll(
      async () =>
        (await db.collection(`orgs/${ORG}/notifications`).where('matterId', '==', matterId).get()).docs.map((d) =>
          d.data(),
        ),
      (list) => list.length > 0,
    );
    expect(notifications).toEqual([
      expect.objectContaining({
        kind: 'conflict_alert',
        recipientUid: uidOf('owner'),
        checkId: alert.checkId,
        contactId: 'c-esk',
        priority: 'high',
      }),
    ]);
  });
});
