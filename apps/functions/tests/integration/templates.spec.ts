import { randomUUID } from 'node:crypto';

import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut, type Auth } from 'firebase/auth';
import { connectFunctionsEmulator, getFunctions, httpsCallable, type FunctionsError } from 'firebase/functions';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { getFirestore as getAdminFirestore, type Firestore } from 'firebase-admin/firestore';

import {
  contactDerivedFields,
  type ApplyTemplateResult,
  type ChangeMatterStageResult,
  type CloneTemplateResult,
  type CreateMatterResult,
  type PublishTemplateResult,
  type Role,
  type UpgradeMatterTemplateResult,
} from '@materia/domain';

/**
 * CORE-07 through the emulators: matters-createMatter applying the system template, templates-apply,
 * matters-changeStage with template requirements (forward skips, moving back), templates-clone,
 * -save and -publish (versions, existing matters unaffected, the stage-mapping block) and
 * matters-upgradeTemplate, with idempotent retries, and (CORE-07b) pending due dates filled from the
 * key fact or the event. All people, practices and matters are fictional.
 */
const PROJECT_ID = 'demo-materia';
const ORG = 'org-templates';
const PASSWORD = 'fictional-password-c7';
const M = `orgs/${ORG}/matters`;
const T = `orgs/${ORG}/templates`;

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

const uidOf = (role: Role) => `tpl-${role}`;

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
/** A new matter; `undefined` in `extra` leaves the field out. Pending conflict checks suit every role. */
const create = (title: string, extra: Record<string, unknown> = {}) =>
  call<CreateMatterResult>('matters-createMatter', {
    requestId: randomUUID(),
    matter: Object.fromEntries(
      Object.entries({
        title,
        type: 'probate',
        jurisdiction: 'VIC',
        responsibleUid: uidOf('lawyer'),
        teamUids: [],
        clientContactIds: ['c-ada'],
        deceased: { contactId: 'c-bertram', dateOfDeath: '2026-05-01', domicile: 'VIC', lastAddress: 'Geelong VIC' },
        fee: { arrangement: 'hourly' },
        costsDisclosure: { status: 'required' },
        conflictCheck: { status: 'pending' },
        ...extra,
      }).filter(([, value]) => value !== undefined),
    ),
  });
const will = (title: string) => create(title, { type: 'will', deceased: undefined });
const changeStage = (matterId: string, stageId: string, extra: Record<string, unknown> = {}) =>
  call<ChangeMatterStageResult>('matters-changeStage', { requestId: randomUUID(), matterId, stageId, ...extra });

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
const taskIds = async (matterId: string) => (await db.collection(`${M}/${matterId}/tasks`).get()).docs.map((d) => d.id);
const done = (matterId: string, ...keys: string[]) =>
  Promise.all(keys.map((key) => db.doc(`${M}/${matterId}/tasks/tpl-${key}`).update({ status: 'done' })));

beforeAll(async () => {
  admin = initializeAdminApp({ projectId: PROJECT_ID }, 'templates-integration-admin');
  db = getAdminFirestore(admin);
  const adminAuth = getAdminAuth(admin);
  const existing = await adminAuth.listUsers();
  await Promise.all(existing.users.filter((u) => u.uid.startsWith('tpl-')).map((u) => adminAuth.deleteUser(u.uid)));
  await db.recursiveDelete(db.doc(`orgs/${ORG}`));
  await db.doc(`orgs/${ORG}`).set({
    name: 'Fictional Template Practice',
    retentionYears: 7,
    timezone: 'Australia/Melbourne',
    matterNumberFormat: 'TP-{YYYY}-{seq:4}',
    flags: { 'templates.system': true },
  });
  await db.doc(`orgs/${ORG}/contacts/c-ada`).set(person('Ada', 'Quillfeather'));
  await db.doc(`orgs/${ORG}/contacts/c-bertram`).set(person('Bertram', 'Quillfeather'));
  for (const role of ['owner', 'lawyer', 'paralegal', 'readonly'] as const) await createMember(role);

  client = initializeApp({ projectId: PROJECT_ID, apiKey: 'demo-api-key' }, 'templates-integration-client');
  auth = getAuth(client);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFunctionsEmulator(getFunctions(client, 'australia-southeast1'), '127.0.0.1', 5001);
});

afterAll(async () => {
  await signOut(auth);
  await deleteApp(client);
  await deleteAdminApp(admin);
});

describe('matters-createMatter and templates-apply', () => {
  it('applies the system template on create, and a repeat apply adds nothing', async () => {
    await signInAs('lawyer');
    const { matterId } = await create('Estate of Fictional Applewhite');
    expect(await data(`${M}/${matterId}`)).toMatchObject({
      templateId: 'system-probate',
      templateVersion: 1,
      stageId: 'instructions',
      openTaskCount: 6,
    });
    const tasks = await taskIds(matterId);
    expect(tasks.sort()).toEqual([
      'tpl-engage_tax_accountant',
      'tpl-notify_centrelink',
      'tpl-obtain_death_certificate',
      'tpl-retrieve_original_will',
      'tpl-send_costs_disclosure',
      'tpl-take_instructions',
    ]);
    // Date of death 1 May 2026: Centrelink 28 days on, the accountant 90 days on.
    expect(await data(`${M}/${matterId}/tasks/tpl-notify_centrelink`)).toMatchObject({
      dueDate: '2026-05-29',
      assigneeUid: uidOf('paralegal'),
      source: 'template',
      templateTaskKey: 'notify_centrelink',
    });
    expect((await data(`${M}/${matterId}/tasks/tpl-engage_tax_accountant`))['dueDate']).toBe('2026-07-30');

    const requestId = randomUUID();
    const input = { requestId, matterId, templateId: 'system-probate', version: 1 };
    const applied = await call<ApplyTemplateResult>('templates-apply', input);
    expect(applied).toMatchObject({ templateId: 'system-probate', version: 1, createdTaskIds: [] });
    // A retry with the same request id replays the result.
    expect(await call<ApplyTemplateResult>('templates-apply', input)).toEqual(applied);
    expect(await taskIds(matterId)).toHaveLength(6);
    expect((await data(`${M}/${matterId}`))['openTaskCount']).toBe(6);
  });

  it('marks a task due date pending while its anchor is unknown, and refuses readonly', async () => {
    await signInAs('paralegal');
    const { matterId } = await create('Estate of Fictional Nodate', { deceased: undefined });
    const centrelink = await data(`${M}/${matterId}/tasks/tpl-notify_centrelink`);
    expect(centrelink['dueDate']).toBeUndefined();
    expect(centrelink['duePending']).toBe('date_of_death');
    await signInAs('readonly');
    const refused = await failure(
      call('templates-apply', { requestId: randomUUID(), matterId, templateId: 'system-probate', version: 1 }),
    );
    expect(detailsOf(refused)['code']).toBe('PERMISSION_DENIED');
  });
});

describe('matters-changeStage with templates', () => {
  it('refuses a forward skip until every stage passed is satisfied, then allows it', async () => {
    await signInAs('paralegal');
    const { matterId } = await create('Estate of Fictional Skipwith');
    const refused = await failure(changeStage(matterId, 'advertisement'));
    expect(refused.code).toBe('functions/failed-precondition');
    expect(detailsOf(refused)).toMatchObject({
      code: 'MATTER_STAGE_REQUIREMENTS',
      requirements: [],
      events: [],
      tasks: ['obtain_death_certificate', 'retrieve_original_will', 'publish_advertisement'],
    });
    await done(matterId, 'obtain_death_certificate', 'retrieve_original_will');
    // "Publish the advertisement" belongs to the skipped stage, so it was never created.
    await db.doc(`${M}/${matterId}/tasks/tpl-publish_advertisement`).set({ status: 'done' });
    const moved = await changeStage(matterId, 'advertisement');
    expect(moved).toMatchObject({ stageId: 'advertisement' });
    expect(moved.createdTaskIds?.sort()).toEqual(['tpl-file_application', 'tpl-prepare_affidavit']);
    expect(await taskIds(matterId)).not.toContain('tpl-prepare_inventory');
  });

  it('moves back only for lawyers and above, with a reason, keeping later tasks; retries are idempotent', async () => {
    await signInAs('paralegal');
    const { matterId } = await create('Estate of Fictional Backtrack');
    await done(matterId, 'obtain_death_certificate', 'retrieve_original_will');
    const requestId = randomUUID();
    const first = await call<ChangeMatterStageResult>('matters-changeStage', {
      requestId,
      matterId,
      stageId: 'documents',
    });
    const retry = await call<ChangeMatterStageResult>('matters-changeStage', {
      requestId,
      matterId,
      stageId: 'documents',
    });
    expect(retry).toEqual(first);
    expect((await taskIds(matterId)).filter((id) => id === 'tpl-prepare_inventory')).toHaveLength(1);

    const back = { reason: 'Original will not yet located' };
    expect(detailsOf(await failure(changeStage(matterId, 'instructions', back)))).toMatchObject({
      code: 'PERMISSION_DENIED',
      reason: 'stage_back_requires_lawyer',
    });
    await signInAs('lawyer');
    expect(detailsOf(await failure(changeStage(matterId, 'instructions')))).toMatchObject({
      code: 'INVALID_ARGUMENT',
      fields: { reason: expect.any(Array) },
    });
    expect((await changeStage(matterId, 'instructions', back)).stageId).toBe('instructions');
    expect(await taskIds(matterId)).toContain('tpl-prepare_inventory');
    const entries = (await db.collection(`orgs/${ORG}/audit`).where('action', '==', 'matter.stage_changed').get()).docs
      .map((d) => d.data())
      .filter((entry) => (entry['entity'] as { id?: string } | undefined)?.id === matterId);
    expect(entries.map((entry) => entry['data'])).toEqual(
      expect.arrayContaining([expect.objectContaining({ from: 'documents', to: 'instructions', direction: 'back' })]),
    );
  });
});

describe('org templates: clone, save, publish and upgrade', () => {
  let templateId: string;

  it('clones and publishes versions; matters keep the version they were created with', async () => {
    await signInAs('lawyer');
    expect(
      detailsOf(await failure(call('templates-clone', { requestId: randomUUID(), sourceTemplateId: 'system-will' }))),
    ).toMatchObject({ code: 'PERMISSION_DENIED' });

    await signInAs('owner');
    templateId = (
      await call<CloneTemplateResult>('templates-clone', {
        requestId: randomUUID(),
        sourceTemplateId: 'system-will',
        name: 'Fictional will kit',
      })
    ).templateId;
    expect(await data(`${T}/${templateId}`)).toMatchObject({ version: 0, published: false, source: 'org' });
    expect(await call<PublishTemplateResult>('templates-publish', { requestId: randomUUID(), templateId })).toEqual({
      templateId,
      version: 1,
    });

    const { matterId } = await will('Will of Fictional Versionby');
    expect(await data(`${M}/${matterId}`)).toMatchObject({ templateId, templateVersion: 1, stageId: 'instructions' });

    const draft = (await data(`${T}/${templateId}`)) as { stages: { id: string; name: string }[] };
    await call('templates-save', {
      requestId: randomUUID(),
      templateId,
      stages: draft.stages.map((stage) => (stage.id === 'draft' ? { ...stage, name: 'Drafting' } : stage)),
    });
    expect(
      (await call<PublishTemplateResult>('templates-publish', { requestId: randomUUID(), templateId })).version,
    ).toBe(2);
    expect((await data(`${T}/${templateId}/versions/1`))['stages']).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'draft', name: 'Draft' })]),
    );
    expect((await data(`${M}/${matterId}`))['templateVersion']).toBe(1);
    // A new will matter takes the latest version.
    const later = await will('Will of Fictional Laterly');
    expect((await data(`${M}/${later.matterId}`))['templateVersion']).toBe(2);
  });

  it('blocks a publish that drops an occupied stage until it is mapped; upgrades add only missing tasks', async () => {
    await signInAs('lawyer');
    const { matterId } = await will('Will of Fictional Stagewell');
    await done(matterId, 'take_instructions');
    await changeStage(matterId, 'draft');
    const before = await taskIds(matterId);

    await signInAs('owner');
    const draft = (await data(`${T}/${templateId}`)) as {
      stages: { id: string; entryRequires?: unknown }[];
      tasks: { stageId: string }[];
    };
    await call('templates-save', {
      requestId: randomUUID(),
      templateId,
      stages: draft.stages
        .filter((stage) => stage.id !== 'draft')
        .map((stage) =>
          stage.id === 'client_review' ? { ...stage, entryRequires: { tasksDone: ['take_instructions'] } } : stage,
        ),
      tasks: draft.tasks.map((task) => (task.stageId === 'draft' ? { ...task, stageId: 'instructions' } : task)),
    });
    const blocked = await failure(call('templates-publish', { requestId: randomUUID(), templateId }));
    expect(blocked.code).toBe('functions/failed-precondition');
    expect(detailsOf(blocked)).toMatchObject({ code: 'TEMPLATE_STAGE_MAPPING_REQUIRED', stages: ['draft'] });
    const published = await call<PublishTemplateResult>('templates-publish', {
      requestId: randomUUID(),
      templateId,
      stageMapping: { draft: 'client_review' },
    });
    expect(published.version).toBe(3);
    expect(await data(`${M}/${matterId}`)).toMatchObject({ templateVersion: 2, stageId: 'draft' });

    await signInAs('paralegal');
    const requestId = randomUUID();
    const upgraded = await call<UpgradeMatterTemplateResult>('matters-upgradeTemplate', {
      requestId,
      matterId,
      version: 3,
    });
    expect(upgraded).toMatchObject({ version: 3, stageId: 'client_review' });
    expect([...upgraded.createdTaskIds].sort()).toEqual(['tpl-record_client_approval', 'tpl-send_draft']);
    const after = await taskIds(matterId);
    expect(after.filter((id) => !before.includes(id)).sort()).toEqual(['tpl-record_client_approval', 'tpl-send_draft']);
    // Nothing was deleted, and a retry replays.
    expect(after).toEqual(expect.arrayContaining(before));
    expect(
      await call<UpgradeMatterTemplateResult>('matters-upgradeTemplate', { requestId, matterId, version: 3 }),
    ).toEqual(upgraded);
    expect(
      (
        await call<UpgradeMatterTemplateResult>('matters-upgradeTemplate', {
          requestId: randomUUID(),
          matterId,
          version: 3,
        })
      ).createdTaskIds,
    ).toEqual([]);
  });
});

describe('pending template due dates (CORE-07b)', () => {
  const task = (matterId: string, key: string) => `${M}/${matterId}/tasks/tpl-${key}`;
  const undated = { contactId: 'c-bertram', domicile: 'VIC', lastAddress: 'Geelong VIC' };

  it('fills them when the date of death is set on the matter, leaving hand-dated and cancelled tasks alone', async () => {
    await signInAs('lawyer');
    const { matterId } = await create('Estate of Fictional Latedate', { deceased: undated });
    const pending = await data(task(matterId, 'notify_centrelink'));
    expect(pending['duePending']).toBe('date_of_death');
    // Copies of the pending task: one dated by hand, one cancelled.
    await db.doc(task(matterId, 'hand_dated')).set({ ...pending, dueDate: '2026-12-01', updatedBy: uidOf('lawyer') });
    await db.doc(task(matterId, 'cancelled')).set({ ...pending, status: 'cancelled' });
    // tasks-onWrite may still be syncing the copies' counts, so compare only what a fill would change.
    const dates = async () =>
      Promise.all(
        ['hand_dated', 'cancelled'].map(async (key) => {
          const { dueDate, duePending, updatedBy } = await data(task(matterId, key));
          return { dueDate, duePending, updatedBy };
        }),
      );
    const untouched = await dates();

    // As a client edit of the key fact would: matters-denormalise reacts.
    await db.doc(`${M}/${matterId}`).update({ 'deceased.dateOfDeath': '2026-07-01', updatedBy: uidOf('lawyer') });
    await expect
      .poll(async () => (await data(task(matterId, 'notify_centrelink')))['dueDate'], { timeout: 40_000 })
      .toBe('2026-07-29');
    const filled = await data(task(matterId, 'notify_centrelink'));
    expect(filled['duePending']).toBeUndefined();
    expect(filled['updatedBy']).toBe('system');
    expect(await dates()).toEqual(untouched);
    expect(untouched).toEqual([
      { dueDate: '2026-12-01', duePending: 'date_of_death', updatedBy: uidOf('lawyer') },
      { dueDate: undefined, duePending: 'date_of_death', updatedBy: expect.any(String) },
    ]);
  }, 60_000);

  it('fills them when the event is recorded through deadlines-upsertEvent', async () => {
    await signInAs('lawyer');
    const { matterId } = await create('Estate of Fictional Eventdate', { deceased: undated });
    const result = await call<{ filledTaskIds: string[] }>('deadlines-upsertEvent', {
      requestId: randomUUID(),
      matterId,
      kind: 'date_of_death',
      date: '2026-08-01',
    });
    expect(result.filledTaskIds).toEqual(['tpl-notify_centrelink']);
    const filled = await data(task(matterId, 'notify_centrelink'));
    expect(filled).toMatchObject({ dueDate: '2026-08-29', updatedBy: uidOf('lawyer') });
    expect(filled['duePending']).toBeUndefined();
    expect((await data(`${M}/${matterId}`))['deceased']).toMatchObject({ dateOfDeath: '2026-08-01' });
  });
});
