import { randomUUID } from 'node:crypto';

import type { Role } from '@materia/domain';

import { applyDefinition } from './apply';
import { cloneDefinition, publishDefinition, saveDefinition } from './manage';
import { clearRetentionCache } from '../audit/retention';
import { runCallable, type CallableDeps } from '../core/callable';
import { clearFlagCaches, setRemoteFlagLoader } from '../core/flags';
import { createLog } from '../core/log';
import { changeStageDefinition } from '../matters/change-stage';
import { createMatterDefinition } from '../matters/create';
import { upgradeTemplateDefinition } from '../matters/upgrade-template';
import { memoryFirestore } from '../orgs/testing';
import { FakeClock, fakePorts } from '../ports/fakes';

/** Unit tests for matter templates (CORE-07). All people, practices and matters are fictional. */

const ORG = 'org-a';
const M = `orgs/${ORG}/matters`;
const C = `orgs/${ORG}/contacts`;
const T = `orgs/${ORG}/templates`;
const meta = { createdBy: 'seed', updatedBy: 'seed', schemaVersion: 1 };
const person = (given: string, family: string) => ({ ...meta, kind: 'person', givenNames: given, familyName: family });
const member = (role: Role, status = 'active') => ({ ...meta, role, status });

const newMatter = (extra: Record<string, unknown> = {}) => ({
  title: 'Estate of Fictional Quill',
  type: 'probate',
  jurisdiction: 'VIC',
  responsibleUid: 'user-lawyer',
  teamUids: [],
  clientContactIds: ['c-ada'],
  deceased: { contactId: 'c-bertram', dateOfDeath: '2026-08-01', domicile: 'VIC', lastAddress: 'Geelong VIC' },
  fee: { arrangement: 'hourly' },
  costsDisclosure: { status: 'required' },
  conflictCheck: { status: 'clear' },
  ...extra,
});

function world({ templates = true, initial = {} as Record<string, Record<string, unknown>> } = {}) {
  const store = memoryFirestore({
    [`orgs/${ORG}`]: {
      name: 'Fictional Bayside Legal',
      retentionYears: 7,
      timezone: 'Australia/Melbourne',
      flags: { 'templates.system': templates },
    },
    [`orgs/${ORG}/members/user-lawyer`]: member('lawyer'),
    [`orgs/${ORG}/members/user-para`]: member('paralegal'),
    [`orgs/${ORG}/members/user-apara`]: member('paralegal', 'suspended'),
    [`orgs/${ORG}/members/user-owner`]: member('owner'),
    [`${C}/c-ada`]: person('Ada', 'Quill'),
    [`${C}/c-bertram`]: person('Bertram', 'Quill'),
    ...initial,
  });
  // 11:00 on 4 October 2026 in Melbourne.
  const clock = new FakeClock(new Date('2026-10-04T01:00:00.000Z'));
  const log = createLog({ fn: 'test' }, () => undefined);
  const ctx = <T>(input: T, role: Role = 'lawyer') => ({
    input: { requestId: randomUUID(), ...input },
    uid: `user-${role}`,
    orgId: ORG,
    role,
    token: {},
    requestId: randomUUID(),
    log,
    clock,
    db: store.db,
    ports: fakePorts(),
    auth: () => {
      throw new Error('no auth in these tests');
    },
  });
  const deps = (): CallableDeps => ({
    db: () => store.db,
    clock,
    ports: () => fakePorts(),
    memberLookup: async () => true,
    idempotency: {
      begin: async () => ({ replay: false }),
      complete: async () => undefined,
      abandon: async () => undefined,
    },
    sink: () => undefined,
  });
  const doc = (path: string) => store.docs.get(path);
  const tasks = (matterId: string) =>
    [...store.docs.entries()]
      .filter(([path]) => path.startsWith(`${M}/${matterId}/tasks/`))
      .map(([path, data]): Record<string, unknown> & { id: string } => ({
        ...data,
        id: path.split('/').at(-1) as string,
      }));
  const audits = (action: string) =>
    [...store.docs.entries()]
      .filter(([path, data]) => path.startsWith(`orgs/${ORG}/audit/`) && data['action'] === action)
      .map(([, data]) => data);
  const create = (matter = newMatter(), role: Role = 'lawyer') =>
    createMatterDefinition.handler(ctx({ matter }, role) as never);
  const stage = (matterId: string, stageId: string, role: Role = 'lawyer', reason?: string) =>
    changeStageDefinition.handler(ctx({ matterId, stageId, ...(reason ? { reason } : {}) }, role) as never);
  const apply = (input: Record<string, unknown>, role: Role = 'lawyer') =>
    applyDefinition.handler(ctx(input, role) as never);
  const clone = (input: Record<string, unknown>, role: Role = 'owner') =>
    cloneDefinition.handler(ctx(input, role) as never);
  const save = (input: Record<string, unknown>, role: Role = 'owner') =>
    saveDefinition.handler(ctx(input, role) as never);
  const publish = (input: Record<string, unknown>, role: Role = 'owner') =>
    publishDefinition.handler(ctx(input, role) as never);
  const upgrade = (input: Record<string, unknown>, role: Role = 'lawyer') =>
    upgradeTemplateDefinition.handler(ctx(input, role) as never);
  const completeTask = (matterId: string, key: string) => {
    const path = `${M}/${matterId}/tasks/tpl-${key}`;
    store.docs.set(path, { ...(store.docs.get(path) ?? {}), status: 'done' });
  };
  const addEvent = (matterId: string, kind: string, date: string) =>
    store.docs.set(`${M}/${matterId}/events/${kind}`, { ...meta, kind, date, meta: {} });
  return {
    ...store,
    clock,
    ctx,
    deps,
    doc,
    tasks,
    audits,
    create,
    stage,
    apply,
    clone,
    save,
    publish,
    upgrade,
    completeTask,
    addEvent,
  };
}

const failureOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string; details?: Record<string, unknown>; issues?: unknown[] };
  }
  throw new Error('expected a failure');
};

/** What a generated task looks like, without the meta. */
const summary = (task: Record<string, unknown>) => ({
  id: task['id'],
  title: task['title'],
  group: task['group'],
  assigneeUid: task['assigneeUid'] ?? null,
  dueDate: task['dueDate'] ?? null,
  duePending: task['duePending'] ?? null,
  priority: task['priority'],
  order: task['order'],
});

beforeEach(() => {
  clearRetentionCache();
  setRemoteFlagLoader(async () => ({}));
});
afterEach(() => clearFlagCaches());

describe('matters-createMatter with templates', () => {
  it('creates a probate matter with a known date of death: its tasks and due dates', async () => {
    const w = world();
    const { matterId } = await w.create();
    expect(w.doc(`${M}/${matterId}`)).toMatchObject({
      templateId: 'system-probate',
      templateVersion: 1,
      stageId: 'instructions',
      stageEnteredOn: '2026-10-04',
      openTaskCount: 6,
    });
    const tasks = w.tasks(matterId).sort((a, b) => Number(a['order']) - Number(b['order']));
    expect(tasks.map(summary)).toMatchSnapshot();
    expect(tasks[0]).toMatchObject({
      orgId: ORG,
      matterId,
      status: 'todo',
      source: 'template',
      templateTaskKey: 'take_instructions',
      createdBy: 'user-lawyer',
      checklist: expect.arrayContaining([{ id: 'c1', text: 'Copy of the will', done: false }]),
    });
    expect(w.audits('matter.created')[0]).toMatchObject({
      data: { templateId: 'system-probate', templateVersion: 1, tasks: 6 },
    });
  });

  it('flags tasks whose anchor is unknown as due date pending', async () => {
    const w = world();
    const { matterId } = await w.create(newMatter({ deceased: undefined }));
    const tasks = w.tasks(matterId);
    expect(tasks.map((t) => t.id).sort()).toEqual([
      'tpl-notify_centrelink',
      'tpl-obtain_death_certificate',
      'tpl-retrieve_original_will',
      'tpl-send_costs_disclosure',
      'tpl-take_instructions',
    ]);
    const centrelink = tasks.find((t) => t.id === 'tpl-notify_centrelink');
    expect(centrelink?.['dueDate']).toBeUndefined();
    expect(centrelink?.['duePending']).toBe('date_of_death');
  });

  it('assigns paralegal tasks to the responsible person when no paralegal is active', async () => {
    const w = world({ initial: { [`orgs/${ORG}/members/user-para`]: member('paralegal', 'removed') } });
    const { matterId } = await w.create(newMatter({ teamUids: [] }));
    expect(w.doc(`${M}/${matterId}/tasks/tpl-obtain_death_certificate`)?.['assigneeUid']).toBe('user-lawyer');
  });

  it('behaves as CORE-06 with the flag off: no template, no tasks', async () => {
    const w = world({ templates: false });
    const { matterId } = await w.create();
    const matter = w.doc(`${M}/${matterId}`);
    expect(matter?.['templateId']).toBeUndefined();
    expect(matter?.['stageId']).toBeUndefined();
    expect(matter?.['openTaskCount']).toBe(0);
    expect(w.tasks(matterId)).toEqual([]);
  });

  it('uses the org’s published template for the type over the system one', async () => {
    const w = world();
    const { templateId } = await w.clone({ sourceTemplateId: 'system-will', name: 'Fictional wills' });
    // A draft alone doesn't count.
    const before = await w.create(newMatter({ type: 'will', deceased: undefined }));
    expect(w.doc(`${M}/${before.matterId}`)?.['templateId']).toBe('system-will');
    await w.publish({ templateId });
    const after = await w.create(newMatter({ type: 'will', deceased: undefined }));
    expect(w.doc(`${M}/${after.matterId}`)).toMatchObject({ templateId, templateVersion: 1, stageId: 'instructions' });
    // A named template must exist and suit the type.
    expect(await failureOf(w.create(newMatter({ templateId })))).toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { fields: { 'matter.templateId': expect.any(Array) } },
    });
    const named = await w.create(newMatter({ type: 'will', deceased: undefined, templateId: 'system-will' }));
    expect(w.doc(`${M}/${named.matterId}`)?.['templateId']).toBe('system-will');
  });
});

describe('matters-changeStage with templates', () => {
  it('refuses a forward move until the stage’s facts, events and tasks are there, then creates its tasks', async () => {
    const w = world();
    const { matterId } = await w.create(newMatter({ deceased: undefined }));
    const refused = await failureOf(w.stage(matterId, 'documents'));
    expect(refused).toMatchObject({
      code: 'MATTER_STAGE_REQUIREMENTS',
      details: {
        matterId,
        stageId: 'documents',
        requirements: ['dateOfDeath'],
        events: [],
        tasks: ['obtain_death_certificate', 'retrieve_original_will'],
      },
    });
    w.docs.set(`${M}/${matterId}`, {
      ...w.doc(`${M}/${matterId}`),
      deceased: { contactId: 'c-bertram', dateOfDeath: '2026-08-01', domicile: 'VIC', lastAddress: 'Geelong VIC' },
    });
    w.completeTask(matterId, 'obtain_death_certificate');
    w.completeTask(matterId, 'retrieve_original_will');
    w.clock.set(new Date('2026-10-10T01:00:00.000Z'));
    const moved = await w.stage(matterId, 'documents');
    expect(moved).toEqual({
      matterId,
      stageId: 'documents',
      createdTaskIds: ['tpl-prepare_inventory', 'tpl-publish_advertisement'],
    });
    expect(w.doc(`${M}/${matterId}`)).toMatchObject({ stageId: 'documents', stageEnteredOn: '2026-10-10' });
    expect(w.doc(`${M}/${matterId}/tasks/tpl-prepare_inventory`)).toMatchObject({
      dueDate: '2026-10-31',
      assigneeUid: 'user-para',
      group: 'Will & death certificate obtained',
    });
    expect(w.doc(`${M}/${matterId}`)?.['openTaskCount']).toBe(7);
  });

  it('allows a forward skip when every stage passed is satisfied, and refuses it otherwise', async () => {
    const w = world();
    const { matterId } = await w.create();
    for (const key of ['obtain_death_certificate', 'retrieve_original_will']) w.completeTask(matterId, key);
    // Skipping to the application needs the advertisement published and its task done.
    const refused = await failureOf(w.stage(matterId, 'application_filed'));
    expect(refused.details).toMatchObject({
      requirements: [],
      events: ['notice_published'],
      tasks: ['publish_advertisement', 'file_application'],
    });
    w.docs.set(`${M}/${matterId}/tasks/tpl-publish_advertisement`, { status: 'done' });
    w.docs.set(`${M}/${matterId}/tasks/tpl-file_application`, { status: 'done' });
    w.addEvent(matterId, 'notice_published', '2026-09-20');
    await expect(w.stage(matterId, 'application_filed')).resolves.toMatchObject({
      stageId: 'application_filed',
      createdTaskIds: ['tpl-respond_to_requisitions'],
    });
    // Skipped stages don't get their tasks.
    expect(w.doc(`${M}/${matterId}/tasks/tpl-prepare_affidavit`)).toBeUndefined();
  });

  it('moves back only for lawyers and above, with a reason, keeping later tasks', async () => {
    const w = world();
    const { matterId } = await w.create();
    for (const key of ['obtain_death_certificate', 'retrieve_original_will']) w.completeTask(matterId, key);
    await w.stage(matterId, 'documents', 'paralegal');
    expect(await failureOf(w.stage(matterId, 'instructions', 'paralegal', 'Wrong stage'))).toMatchObject({
      code: 'PERMISSION_DENIED',
      details: { reason: 'stage_back_requires_lawyer' },
    });
    expect(await failureOf(w.stage(matterId, 'instructions', 'lawyer'))).toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { fields: { reason: expect.any(Array) } },
    });
    await expect(w.stage(matterId, 'instructions', 'lawyer', 'Original will not yet located')).resolves.toMatchObject({
      stageId: 'instructions',
      createdTaskIds: [],
    });
    expect(w.doc(`${M}/${matterId}/tasks/tpl-prepare_inventory`)).toBeDefined();
    expect(w.audits('matter.stage_changed').at(-1)).toMatchObject({
      data: { from: 'documents', to: 'instructions', direction: 'back' },
    });
  });

  it('reads the matter’s own template version, so a later publish doesn’t change its stages', async () => {
    const w = world();
    const { templateId } = await w.clone({ sourceTemplateId: 'system-will' });
    await w.publish({ templateId });
    const { matterId } = await w.create(newMatter({ type: 'will', deceased: undefined }));
    const draft = w.doc(`${T}/${templateId}`) as { stages: { id: string }[] };
    await w.save({ templateId, stages: draft.stages.map((s) => (s.id === 'draft' ? { ...s, name: 'Drafting' } : s)) });
    await w.publish({ templateId });
    expect(w.doc(`${M}/${matterId}`)?.['templateVersion']).toBe(1);
    expect(w.doc(`${T}/${templateId}/versions/1`)).toMatchObject({ version: 1 });
    expect(w.doc(`${T}/${templateId}/versions/2`)).toMatchObject({ version: 2 });
    w.completeTask(matterId, 'take_instructions');
    await expect(w.stage(matterId, 'draft')).resolves.toMatchObject({ createdTaskIds: ['tpl-prepare_draft'] });
  });
});

describe('templates-apply', () => {
  it('gives a matter a template and creates its tasks once, however often it is called', async () => {
    const w = world({ templates: false });
    const { matterId } = await w.create();
    w.docs.set(`orgs/${ORG}`, { ...w.doc(`orgs/${ORG}`), flags: { 'templates.system': true } });
    clearFlagCaches();
    const first = await w.apply({ matterId, templateId: 'system-probate', version: 1 });
    expect(first).toMatchObject({ templateId: 'system-probate', version: 1, stageId: 'instructions' });
    expect(first.createdTaskIds).toHaveLength(6);
    const again = await w.apply({ matterId, templateId: 'system-probate', version: 1 });
    expect(again.createdTaskIds).toEqual([]);
    expect(w.tasks(matterId)).toHaveLength(6);
    expect(w.doc(`${M}/${matterId}`)?.['openTaskCount']).toBe(6);
    expect(w.audits('matter.template_applied')).toHaveLength(2);
  });

  it('refuses another type’s template, an unknown version, a closed matter and the flag off', async () => {
    const w = world();
    const { matterId } = await w.create();
    expect(await failureOf(w.apply({ matterId, templateId: 'system-will', version: 1 }))).toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(await failureOf(w.apply({ matterId, templateId: 'system-probate', version: 2 }))).toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await failureOf(w.apply({ matterId, templateId: 'nope', version: 1 }))).toMatchObject({
      code: 'NOT_FOUND',
    });
    w.docs.set(`${M}/${matterId}`, { ...w.doc(`${M}/${matterId}`), status: 'closed' });
    expect(await failureOf(w.apply({ matterId, templateId: 'system-probate', version: 1 }))).toMatchObject({
      code: 'FAILED_PRECONDITION',
      details: { reason: 'matter_closed' },
    });
    const off = world({ templates: false });
    clearFlagCaches();
    expect(await failureOf(off.apply({ matterId, templateId: 'system-probate', version: 1 }))).toMatchObject({
      code: 'FEATURE_DISABLED',
    });
  });
});

describe('templates-clone, templates-save and templates-publish', () => {
  it('clones a system template into an unpublished draft and publishes immutable versions', async () => {
    const w = world();
    const { templateId } = await w.clone({ sourceTemplateId: 'system-probate', name: 'Fictional probate' });
    expect(w.doc(`${T}/${templateId}`)).toMatchObject({
      name: 'Fictional probate',
      matterType: 'probate',
      version: 0,
      source: 'org',
      published: false,
      basedOn: { templateId: 'system-probate', version: 1 },
    });
    expect(await w.publish({ templateId })).toEqual({ templateId, version: 1 });
    expect(await w.publish({ templateId })).toEqual({ templateId, version: 2 });
    expect(w.doc(`${T}/${templateId}`)).toMatchObject({ version: 2, published: true, publishedBy: 'user-owner' });
    expect(w.doc(`${T}/${templateId}/versions/2`)).toMatchObject({ templateId, version: 2, published: true });
    // Cloning an org template takes its latest version.
    const copy = await w.clone({ sourceTemplateId: templateId });
    expect(w.doc(`${T}/${copy.templateId}`)?.['basedOn']).toEqual({ templateId, version: 2 });
    expect(await failureOf(w.clone({ sourceTemplateId: copy.templateId }))).toMatchObject({ code: 'NOT_FOUND' });
    expect(w.audits('template.published')).toHaveLength(2);
  });

  it('validates the whole draft on save, and never edits system templates', async () => {
    const w = world();
    const { templateId } = await w.clone({ sourceTemplateId: 'system-will' });
    const draft = w.doc(`${T}/${templateId}`) as { tasks: { stageId: string }[] };
    const broken = await failureOf(
      w.save({ templateId, tasks: draft.tasks.map((task, i) => (i === 0 ? { ...task, stageId: 'nowhere' } : task)) }),
    );
    expect(broken.issues).toContainEqual(expect.objectContaining({ path: ['tasks', 0, 'stageId'] }));
    expect(w.doc(`${T}/${templateId}`)?.['tasks']).toEqual(draft.tasks);
    await w.save({ templateId, name: 'Fictional will kit', deadlineRuleIds: [] });
    expect(w.doc(`${T}/${templateId}`)?.['name']).toBe('Fictional will kit');
    expect(await failureOf(w.save({ templateId: 'system-will', name: 'Mine' }))).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('is for owners and admins only', async () => {
    const w = world();
    const call = (role: Role) =>
      runCallable(
        cloneDefinition,
        {
          data: { requestId: randomUUID(), sourceTemplateId: 'system-will' },
          auth: { uid: `user-${role}`, token: { orgId: ORG, role } },
        },
        w.deps(),
      );
    expect(await failureOf(call('lawyer'))).toMatchObject({ details: { code: 'PERMISSION_DENIED' } });
    await expect(call('owner')).resolves.toMatchObject({ templateId: expect.any(String) });
  });

  it('blocks publishing a version that drops a stage matters are in until it is mapped', async () => {
    const w = world();
    const { templateId } = await w.clone({ sourceTemplateId: 'system-will' });
    await w.publish({ templateId });
    const { matterId } = await w.create(newMatter({ type: 'will', deceased: undefined }));
    w.completeTask(matterId, 'take_instructions');
    await w.stage(matterId, 'draft');

    const draft = w.doc(`${T}/${templateId}`) as { stages: { id: string; entryRequires?: unknown }[] };
    const tasks = (w.doc(`${T}/${templateId}`) as { tasks: { key: string; stageId: string }[] }).tasks;
    // Drop "Draft": its task moves to Instructions, and Client review now needs Instructions' task.
    await w.save({
      templateId,
      stages: draft.stages
        .filter((s) => s.id !== 'draft')
        .map((s) => (s.id === 'client_review' ? { ...s, entryRequires: { tasksDone: ['take_instructions'] } } : s)),
      tasks: tasks.map((t) => (t.stageId === 'draft' ? { ...t, stageId: 'instructions' } : t)),
    });
    expect(await failureOf(w.publish({ templateId }))).toMatchObject({
      code: 'TEMPLATE_STAGE_MAPPING_REQUIRED',
      details: { templateId, stages: ['draft'] },
    });
    expect(await failureOf(w.publish({ templateId, stageMapping: { draft: 'nowhere' } }))).toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { fields: { 'stageMapping.draft': expect.any(Array) } },
    });
    expect(await w.publish({ templateId, stageMapping: { draft: 'client_review' } })).toEqual({
      templateId,
      version: 2,
    });
    expect(w.doc(`${T}/${templateId}/versions/2`)?.['stageMapping']).toEqual({ draft: 'client_review' });
    // The matter keeps version 1 and its stage.
    expect(w.doc(`${M}/${matterId}`)).toMatchObject({ templateVersion: 1, stageId: 'draft' });

    // Upgrading follows the mapping and adds only the missing tasks of the new stage.
    const before = w.tasks(matterId).map((t) => t.id);
    const upgraded = await w.upgrade({ matterId, version: 2 });
    expect(upgraded).toMatchObject({ version: 2, stageId: 'client_review' });
    expect(upgraded.createdTaskIds.sort()).toEqual(['tpl-record_client_approval', 'tpl-send_draft']);
    expect(
      w
        .tasks(matterId)
        .map((t) => t.id)
        .filter((id) => !before.includes(id))
        .sort(),
    ).toEqual(['tpl-record_client_approval', 'tpl-send_draft']);
    expect(w.doc(`${M}/${matterId}`)).toMatchObject({ templateVersion: 2, stageId: 'client_review' });
    // Again: nothing more to add; an earlier version is refused.
    expect((await w.upgrade({ matterId, version: 2 })).createdTaskIds).toEqual([]);
    expect(await failureOf(w.upgrade({ matterId, version: 1 }))).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await failureOf(w.upgrade({ matterId, version: 3 }))).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses an upgrade for a matter without a template, or whose stage has no mapping', async () => {
    const w = world({ templates: false });
    const { matterId } = await w.create();
    w.docs.set(`orgs/${ORG}`, { ...w.doc(`orgs/${ORG}`), flags: { 'templates.system': true } });
    clearFlagCaches();
    expect(await failureOf(w.upgrade({ matterId, version: 1 }))).toMatchObject({
      code: 'FAILED_PRECONDITION',
      details: { reason: 'no_template' },
    });
    w.docs.set(`${M}/${matterId}`, { ...w.doc(`${M}/${matterId}`), templateId: 'system-probate', stageId: 'gone' });
    expect(await failureOf(w.upgrade({ matterId, version: 1 }))).toMatchObject({
      code: 'FAILED_PRECONDITION',
      details: { reason: 'stage_unmapped' },
    });
  });
});
