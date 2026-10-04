import { randomUUID } from 'node:crypto';

import type { HttpsError } from 'firebase-functions/v2/https';

import type { Role } from '@materia/domain';

import { changeStageDefinition } from './change-stage';
import { nextClientContactIds, removePartyDefinition, upsertPartyDefinition } from './parties';
import { clearRetentionCache } from '../audit/retention';
import { runCallable, type CallableDeps } from '../core/callable';
import { clearFlagCaches, setRemoteFlagLoader } from '../core/flags';
import { createLog } from '../core/log';
import { memoryFirestore } from '../orgs/testing';
import { FakeClock, fakePorts } from '../ports/fakes';

/** Unit tests for the matter screen's callables (CORE-06). All people and practices are fictional. */

const ORG = 'org-a';
const M = `orgs/${ORG}/matters`;
const C = `orgs/${ORG}/contacts`;
const P = `${M}/m1/parties`;
const meta = { createdBy: 'seed', updatedBy: 'seed', schemaVersion: 1 };
const person = (given: string, family: string, extra: Record<string, unknown> = {}) => ({
  ...meta,
  kind: 'person',
  givenNames: given,
  familyName: family,
  ...extra,
});
const party = (contactId: string, role: string, extra: Record<string, unknown> = {}) => ({
  ...meta,
  orgId: ORG,
  matterId: 'm1',
  contactId,
  role,
  addedFrom: 'manual',
  ...extra,
});
const matter = (extra: Record<string, unknown> = {}) => ({
  ...meta,
  number: 'M-2026-0001',
  title: 'Estate of Fictional Quill',
  type: 'probate',
  status: 'open',
  privileged: false,
  clientContactIds: ['c-ada'],
  deceased: { contactId: 'c-bertram', dateOfDeath: '2026-08-01', domicile: 'VIC', lastAddress: 'Geelong VIC' },
  deletedAt: null,
  ...extra,
});

function world(initial: Record<string, Record<string, unknown>> = {}) {
  const store = memoryFirestore({
    [`orgs/${ORG}`]: { name: 'Fictional Bayside Legal', retentionYears: 7, timezone: 'Australia/Melbourne' },
    [`${C}/c-ada`]: person('Ada', 'Quill'),
    [`${C}/c-bertram`]: person('Bertram', 'Quill'),
    [`${C}/c-cleo`]: person('Cleo', 'Marsh'),
    [`${C}/c-dov`]: person('Dov', 'Pellew'),
    [`${C}/c-merged`]: person('Ada', 'Quil', { mergedInto: 'c-ada' }),
    [`${C}/c-deleted`]: person('Gone', 'Contact', { deletedAt: new Date('2026-09-01T00:00:00Z') }),
    [`${M}/m1`]: matter(),
    [`${P}/client-c-ada`]: party('c-ada', 'client'),
    [`${P}/deceased-c-bertram`]: party('c-bertram', 'deceased'),
    ...initial,
  });
  const clock = new FakeClock(new Date('2026-10-04T01:00:00.000Z'));
  const log = createLog({ fn: 'test' }, () => undefined);
  const ctx = <T>(input: T, role: Role = 'lawyer') => ({
    input,
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
  const audits = (action: string) =>
    [...store.docs.entries()]
      .filter(([path, data]) => path.startsWith(`orgs/${ORG}/audit/`) && data['action'] === action)
      .map(([, data]) => data);
  const stage = (stageId: string, role: Role = 'lawyer', matterId = 'm1') =>
    changeStageDefinition.handler(ctx({ requestId: randomUUID(), matterId, stageId }, role) as never);
  const upsert = (input: Record<string, unknown>, role: Role = 'lawyer') =>
    upsertPartyDefinition.handler(ctx({ requestId: randomUUID(), matterId: 'm1', ...input }, role) as never);
  const remove = (partyId: string, role: Role = 'lawyer') =>
    removePartyDefinition.handler(ctx({ requestId: randomUUID(), matterId: 'm1', partyId }, role) as never);
  return { ...store, clock, ctx, deps, doc, audits, stage, upsert, remove };
}

const failureOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string; details?: Record<string, unknown> };
  }
  throw new Error('expected a failure');
};

beforeEach(() => {
  clearRetentionCache();
  setRemoteFlagLoader(async () => ({}));
});
afterEach(() => clearFlagCaches());

describe('matters-changeStage', () => {
  it('moves forward when the requirements are met, writes the meta and audits from and to', async () => {
    const w = world();
    // Grant application needs the date of death, which the matter has.
    await expect(w.stage('grant_application')).resolves.toEqual({ matterId: 'm1', stageId: 'grant_application' });
    expect(w.doc(`${M}/m1`)).toMatchObject({ stageId: 'grant_application', updatedBy: 'user-lawyer' });
    expect(w.audits('matter.stage_changed')).toEqual([
      expect.objectContaining({ data: { from: null, to: 'grant_application' } }),
    ]);
  });

  it('refuses a forward move with unmet requirements, listing key fact ids only', async () => {
    const w = world();
    const error = await failureOf(w.stage('collection'));
    expect(error).toMatchObject({
      code: 'MATTER_STAGE_REQUIREMENTS',
      details: { matterId: 'm1', stageId: 'collection', requirements: ['grantDate'] },
    });
    expect(w.doc(`${M}/m1`)?.['stageId']).toBeUndefined();
    expect(w.audits('matter.stage_changed')).toHaveLength(0);
  });

  it('moves forward once the fact is recorded, and back without requirements', async () => {
    const w = world({
      [`${M}/m1`]: matter({ stageId: 'grant_application', estate: { grantDate: '2026-09-20' } }),
    });
    await w.stage('distribution');
    expect(w.doc(`${M}/m1`)?.['stageId']).toBe('distribution');
    const back = world({ [`${M}/m1`]: matter({ stageId: 'distribution', deceased: undefined }) });
    await expect(back.stage('intake')).resolves.toEqual({ matterId: 'm1', stageId: 'intake' });
    expect(back.audits('matter.stage_changed')[0]).toMatchObject({ data: { from: 'distribution', to: 'intake' } });
  });

  it('is a no-op for the current stage', async () => {
    const w = world({ [`${M}/m1`]: matter({ stageId: 'intake' }) });
    await expect(w.stage('intake')).resolves.toEqual({ matterId: 'm1', stageId: 'intake' });
    expect(w.audits('matter.stage_changed')).toHaveLength(0);
  });

  it('refuses an unknown stage with a field error', async () => {
    const error = await failureOf(world().stage('drafting'));
    expect(error).toMatchObject({ code: 'INVALID_ARGUMENT', details: { fields: { stageId: expect.any(Array) } } });
  });

  it('uses the template’s stages when the matter has one, with the defaults’ requirements', async () => {
    const w = world({
      [`${M}/m1`]: matter({ templateId: 'tpl-1', deceased: undefined }),
      [`orgs/${ORG}/templates/tpl-1`]: {
        ...meta,
        name: 'Fictional probate',
        matterType: 'probate',
        stages: [
          { id: 'intake', title: 'Intake' },
          { id: 'valuation', title: 'Valuation' },
          { id: 'grant_application', title: 'Apply for the grant' },
        ],
      },
    });
    await expect(w.stage('valuation')).resolves.toMatchObject({ stageId: 'valuation' });
    // `grant_application` keeps the default's requirement (date of death).
    expect(await failureOf(w.stage('grant_application'))).toMatchObject({
      code: 'MATTER_STAGE_REQUIREMENTS',
      details: { requirements: ['dateOfDeath'] },
    });
    // A default stage the template doesn't have is unknown.
    expect(await failureOf(w.stage('collection'))).toMatchObject({ code: 'INVALID_ARGUMENT' });
    // A missing template falls back to the defaults.
    const missing = world({ [`${M}/m1`]: matter({ templateId: 'tpl-gone' }) });
    await expect(missing.stage('grant_application')).resolves.toMatchObject({ stageId: 'grant_application' });
  });

  it('refuses closed and archived matters, and hides deleted, missing and privileged ones', async () => {
    for (const status of ['closed', 'archived']) {
      expect(await failureOf(world({ [`${M}/m1`]: matter({ status }) }).stage('intake'))).toMatchObject({
        code: 'FAILED_PRECONDITION',
        details: { reason: 'matter_closed', status },
      });
    }
    await expect(world({ [`${M}/m1`]: matter({ status: 'on_hold' }) }).stage('intake')).resolves.toBeTruthy();
    expect(await failureOf(world({ [`${M}/m1`]: matter({ deletedAt: new Date() }) }).stage('intake'))).toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await failureOf(world().stage('intake', 'lawyer', 'm-missing'))).toMatchObject({ code: 'NOT_FOUND' });
    const privileged = world({ [`${M}/m1`]: matter({ privileged: true }) });
    expect(await failureOf(privileged.stage('intake', 'paralegal'))).toMatchObject({ code: 'NOT_FOUND' });
    await expect(privileged.stage('intake', 'lawyer')).resolves.toBeTruthy();
    expect(await failureOf(world({ [`${M}/m1`]: matter({ type: 'nonsense' }) }).stage('intake'))).toMatchObject({
      code: 'FAILED_PRECONDITION',
      details: { reason: 'invalid_type' },
    });
  });

  it('is for matter.edit roles: readonly is refused (wrapper)', async () => {
    const w = world();
    const call = (role: Role) =>
      runCallable(
        changeStageDefinition,
        {
          data: { requestId: randomUUID(), matterId: 'm1', stageId: 'grant_application' },
          auth: { uid: `user-${role}`, token: { orgId: ORG, role } },
        },
        w.deps(),
      );
    expect(((await failureOf(call('readonly'))) as HttpsError).details).toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(call('paralegal')).resolves.toEqual({ matterId: 'm1', stageId: 'grant_application' });
  });
});

describe('matters-upsertParty', () => {
  it('adds a contact in a role at partyDocId, audits it, and adds a new client to clientContactIds', async () => {
    const w = world();
    await expect(w.upsert({ contactId: 'c-cleo', role: 'beneficiary', share: '50%' })).resolves.toEqual({
      matterId: 'm1',
      partyId: 'beneficiary-c-cleo',
      clientContactIds: ['c-ada'],
    });
    expect(w.doc(`${P}/beneficiary-c-cleo`)).toMatchObject({
      orgId: ORG,
      matterId: 'm1',
      contactId: 'c-cleo',
      role: 'beneficiary',
      share: '50%',
      addedFrom: 'manual',
      createdBy: 'user-lawyer',
      updatedBy: 'user-lawyer',
    });
    expect(w.audits('matter.party_added')).toEqual([
      expect.objectContaining({
        data: { matterId: 'm1', partyId: 'beneficiary-c-cleo', contactId: 'c-cleo', role: 'beneficiary' },
      }),
    ]);

    await expect(w.upsert({ contactId: 'c-dov', role: 'client' }, 'paralegal')).resolves.toMatchObject({
      partyId: 'client-c-dov',
      clientContactIds: ['c-ada', 'c-dov'],
    });
    expect(w.doc(`${M}/m1`)).toMatchObject({ clientContactIds: ['c-ada', 'c-dov'], updatedBy: 'user-paralegal' });
    // A party change is activity on the matter.
    expect(w.doc(`${M}/m1`)?.['lastActivityAt']).toBeDefined();
  });

  it('updates share and notes of a live row when the contact already has the role (omitted clears)', async () => {
    const w = world({ [`${P}/beneficiary-c-cleo`]: party('c-cleo', 'beneficiary', { share: '10%', notes: 'Old' }) });
    await w.upsert({ contactId: 'c-cleo', role: 'beneficiary', share: '25%' });
    expect(w.doc(`${P}/beneficiary-c-cleo`)).toMatchObject({ share: '25%' });
    expect(w.doc(`${P}/beneficiary-c-cleo`)).not.toHaveProperty('notes');
    expect(w.audits('matter.party_updated')).toHaveLength(1);
    expect(w.audits('matter.party_added')).toHaveLength(0);
  });

  it('revives a soft-deleted row with the same id', async () => {
    const w = world({
      [`${P}/beneficiary-c-cleo`]: party('c-cleo', 'beneficiary', {
        deletedAt: new Date('2026-09-01T00:00:00Z'),
        deletedBy: 'user-lawyer',
        createdAt: new Date('2026-08-01T00:00:00Z'),
      }),
    });
    await expect(w.upsert({ contactId: 'c-cleo', role: 'beneficiary' })).resolves.toMatchObject({
      partyId: 'beneficiary-c-cleo',
    });
    const row = w.doc(`${P}/beneficiary-c-cleo`);
    expect(row).toMatchObject({ deletedAt: null, deletedBy: null, updatedBy: 'user-lawyer', createdBy: 'seed' });
    expect(w.audits('matter.party_added')).toHaveLength(1);
  });

  it('refuses missing, deleted and merged contacts with a field error', async () => {
    for (const contactId of ['c-missing', 'c-deleted', 'c-merged']) {
      const w = world();
      expect(await failureOf(w.upsert({ contactId, role: 'witness' }))).toMatchObject({
        code: 'INVALID_ARGUMENT',
        details: { fields: { contactId: expect.any(Array) } },
      });
      expect(w.doc(`${P}/witness-${contactId}`)).toBeUndefined();
    }
  });

  it('edits a row by partyId, and moves it to the new id when the role changes', async () => {
    const w = world({ [`${P}/beneficiary-c-cleo`]: party('c-cleo', 'beneficiary', { share: '10%' }) });
    await w.upsert({
      partyId: 'beneficiary-c-cleo',
      contactId: 'c-cleo',
      role: 'beneficiary',
      notes: 'Lives overseas',
    });
    expect(w.doc(`${P}/beneficiary-c-cleo`)).toMatchObject({ notes: 'Lives overseas' });
    expect(w.doc(`${P}/beneficiary-c-cleo`)).not.toHaveProperty('share');

    await expect(w.upsert({ partyId: 'beneficiary-c-cleo', contactId: 'c-cleo', role: 'client' })).resolves.toEqual({
      matterId: 'm1',
      partyId: 'client-c-cleo',
      clientContactIds: ['c-ada', 'c-cleo'],
    });
    expect(w.doc(`${P}/beneficiary-c-cleo`)).toMatchObject({ deletedBy: 'user-lawyer' });
    expect(w.doc(`${P}/beneficiary-c-cleo`)?.['deletedAt']).toBeTruthy();
    expect(w.doc(`${P}/client-c-cleo`)).toMatchObject({ role: 'client', contactId: 'c-cleo' });
    expect(w.doc(`${P}/client-c-cleo`)).not.toHaveProperty('notes');
    expect(w.audits('matter.party_updated').at(-1)).toMatchObject({
      data: { partyId: 'client-c-cleo', previousPartyId: 'beneficiary-c-cleo', previousRole: 'beneficiary' },
    });

    // Moving the only other client away from `client` is fine; moving the last one is not.
    await w.upsert({ partyId: 'client-c-ada', contactId: 'c-ada', role: 'executor' });
    expect(w.doc(`${M}/m1`)?.['clientContactIds']).toEqual(['c-cleo']);
    expect(
      await failureOf(w.upsert({ partyId: 'client-c-cleo', contactId: 'c-cleo', role: 'beneficiary' })),
    ).toMatchObject({ code: 'LAST_CLIENT' });
    expect(w.doc(`${P}/client-c-cleo`)?.['deletedAt']).toBeUndefined();
  });

  it('refuses a move onto a role the contact already has, and a missing or deleted partyId', async () => {
    const w = world({
      [`${P}/beneficiary-c-cleo`]: party('c-cleo', 'beneficiary'),
      [`${P}/executor-c-cleo`]: party('c-cleo', 'executor'),
      [`${P}/witness-c-dov`]: party('c-dov', 'witness', { deletedAt: new Date() }),
    });
    expect(
      await failureOf(w.upsert({ partyId: 'beneficiary-c-cleo', contactId: 'c-cleo', role: 'executor' })),
    ).toMatchObject({ code: 'INVALID_ARGUMENT', details: { fields: { role: expect.any(Array) } } });
    expect(await failureOf(w.upsert({ partyId: 'p-none', contactId: 'c-cleo', role: 'executor' }))).toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await failureOf(w.upsert({ partyId: 'witness-c-dov', contactId: 'c-dov', role: 'witness' }))).toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('hides privileged matters from roles without privileged.view and refuses deleted matters', async () => {
    const privileged = world({ [`${M}/m1`]: matter({ privileged: true }) });
    expect(await failureOf(privileged.upsert({ contactId: 'c-cleo', role: 'witness' }, 'paralegal'))).toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(privileged.upsert({ contactId: 'c-cleo', role: 'witness' }, 'lawyer')).resolves.toBeTruthy();
    const deleted = world({ [`${M}/m1`]: matter({ deletedAt: new Date() }) });
    expect(await failureOf(deleted.upsert({ contactId: 'c-cleo', role: 'witness' }))).toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('is for matter.edit roles: readonly is refused (wrapper)', async () => {
    const w = world();
    const call = (role: Role) =>
      runCallable(
        upsertPartyDefinition,
        {
          data: { requestId: randomUUID(), matterId: 'm1', contactId: 'c-cleo', role: 'witness' },
          auth: { uid: `user-${role}`, token: { orgId: ORG, role } },
        },
        w.deps(),
      );
    expect(((await failureOf(call('readonly'))) as HttpsError).details).toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(call('paralegal')).resolves.toMatchObject({ partyId: 'witness-c-cleo' });
  });
});

describe('matters-removeParty', () => {
  it('soft-deletes the row, recomputes clients and audits it', async () => {
    const w = world({
      [`${M}/m1`]: matter({ clientContactIds: ['c-ada', 'c-dov'] }),
      [`${P}/client-c-dov`]: party('c-dov', 'client'),
    });
    await expect(w.remove('client-c-dov')).resolves.toEqual({
      matterId: 'm1',
      partyId: 'client-c-dov',
      clientContactIds: ['c-ada'],
    });
    expect(w.doc(`${P}/client-c-dov`)).toMatchObject({ deletedBy: 'user-lawyer' });
    expect(w.doc(`${M}/m1`)?.['clientContactIds']).toEqual(['c-ada']);
    expect(w.audits('matter.party_removed')).toEqual([
      expect.objectContaining({
        data: { matterId: 'm1', partyId: 'client-c-dov', contactId: 'c-dov', role: 'client' },
      }),
    ]);
    // Removing a non-client leaves clientContactIds alone.
    await w.remove('deceased-c-bertram');
    expect(w.doc(`${M}/m1`)?.['clientContactIds']).toEqual(['c-ada']);
  });

  it('refuses to remove the last client, and a missing or already removed row', async () => {
    const w = world();
    const error = await failureOf(w.remove('client-c-ada'));
    expect(error).toMatchObject({ code: 'LAST_CLIENT', details: { matterId: 'm1', partyId: 'client-c-ada' } });
    expect(w.doc(`${P}/client-c-ada`)?.['deletedAt']).toBeUndefined();
    expect(await failureOf(w.remove('p-none'))).toMatchObject({ code: 'NOT_FOUND' });
    await w.remove('deceased-c-bertram');
    expect(await failureOf(w.remove('deceased-c-bertram'))).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('nextClientContactIds', () => {
  const row = (contactId: string, role: 'client' | 'executor', live = true) => ({ contactId, role, live });

  it('follows the live client rows, keeping the matter’s order and appending new clients', () => {
    const rows = new Map([
      ['a', row('c-b', 'client')],
      ['b', row('c-a', 'client')],
      ['c', row('c-c', 'client')],
      ['d', row('c-x', 'executor')],
    ]);
    expect(nextClientContactIds(['c-a', 'c-b'], rows)).toEqual(['c-a', 'c-b', 'c-c']);
    rows.set('b', row('c-a', 'client', false));
    expect(nextClientContactIds(['c-a', 'c-b'], rows)).toEqual(['c-b', 'c-c']);
  });

  it('keeps a client the matter lists with no client row at all (matters written before CORE-06)', () => {
    const rows = new Map([['x', row('c-x', 'executor')]]);
    expect(nextClientContactIds(['c-legacy'], rows)).toEqual(['c-legacy']);
    rows.set('y', row('c-legacy', 'client', false));
    expect(nextClientContactIds(['c-legacy'], rows)).toEqual([]);
  });
});
