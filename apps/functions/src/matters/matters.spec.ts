import { randomUUID } from 'node:crypto';

import { Timestamp } from 'firebase-admin/firestore';
import type { HttpsError } from 'firebase-functions/v2/https';

import { MATTER_TRANSITIONS, MatterStatusSchema, type MatterStatus, type Role } from '@materia/domain';

import { changeStatusDefinition } from './change-status';
import { createMatterDefinition, initialParties, MAX_NUMBER_SKIPS } from './create';
import { denormalise, denormaliseDefinition, isActivity, recordMatterActivity, staleMatterFields } from './denormalise';
import { rebalanceBoardDefinition } from './rebalance-board';
import { renumberDefinition } from './renumber';
import { restoreDefinition } from './restore';
import { matterSearch } from './shared';
import { clearRetentionCache } from '../audit/retention';
import { runCallable, type CallableDeps } from '../core/callable';
import { orgClock } from '../core/emulator-clock';
import { clearFlagCaches, setRemoteFlagLoader } from '../core/flags';
import { createLog } from '../core/log';
import type { TriggerChange, TriggerContext } from '../core/trigger';
import { memoryFirestore } from '../orgs/testing';
import { FakeClock, fakePorts } from '../ports/fakes';

/** Unit tests for the matters functions (CORE-03). All people and practices are fictional. */

const ORG = 'org-a';
const M = `orgs/${ORG}/matters`;
const C = `orgs/${ORG}/contacts`;
const meta = { createdBy: 'seed', updatedBy: 'seed', schemaVersion: 1 };
const person = (given: string, family: string, extra: Record<string, unknown> = {}) => ({
  ...meta,
  kind: 'person',
  givenNames: given,
  familyName: family,
  ...extra,
});
const member = (role: Role, status = 'active') => ({ ...meta, role, status });

/** What the New matter form sends. */
const newMatter = (extra: Record<string, unknown> = {}) => ({
  title: 'Estate of Fictional Quill',
  type: 'probate',
  jurisdiction: 'VIC',
  responsibleUid: 'user-lawyer',
  teamUids: ['user-para'],
  clientContactIds: ['c-ada'],
  deceased: { contactId: 'c-bertram', dateOfDeath: '2026-08-01', domicile: 'VIC', lastAddress: 'Geelong VIC' },
  fee: { arrangement: 'hourly' },
  costsDisclosure: { status: 'required' },
  conflictCheck: { status: 'clear' },
  externalRef: 'LEG/00123',
  ...extra,
});

function world(initial: Record<string, Record<string, unknown>> = {}, at = '2026-10-04T01:00:00.000Z') {
  const store = memoryFirestore({
    [`orgs/${ORG}`]: { name: 'Fictional Bayside Legal', retentionYears: 7, timezone: 'Australia/Melbourne' },
    [`orgs/${ORG}/members/user-lawyer`]: member('lawyer'),
    [`orgs/${ORG}/members/user-para`]: member('paralegal'),
    [`orgs/${ORG}/members/user-gone`]: member('lawyer', 'removed'),
    [`${C}/c-ada`]: person('Ada', 'Quill'),
    [`${C}/c-bertram`]: person('Bertram', 'Quill', { dateOfDeath: '2026-08-01' }),
    [`${C}/c-merged`]: person('Ada', 'Quil', { mergedInto: 'c-ada' }),
    ...initial,
  });
  const clock = new FakeClock(new Date(at));
  const log = createLog({ fn: 'test' }, () => undefined);
  const ctx = <T>(input: T, role: Role = 'lawyer', uid = `user-${role}`) => ({
    input,
    uid,
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
  const doc = (path: string) => store.docs.get(path);
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
  const create = (matter = newMatter(), role: Role = 'lawyer') =>
    createMatterDefinition.handler(ctx({ requestId: randomUUID(), matter }, role) as never);
  const audits = () =>
    [...store.docs.entries()].filter(([path]) => path.startsWith(`orgs/${ORG}/audit/`)).map(([, data]) => data);
  return { ...store, clock, log, ctx, doc, deps, create, audits };
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

describe('matters-createMatter', () => {
  it('numbers matters in sequence from the year’s counter and writes the matter, parties and reservation', async () => {
    const w = world();
    const first = await w.create();
    const second = await w.create(newMatter({ conflictCheck: { status: 'pending' } }));
    expect(first).toEqual({ matterId: expect.any(String), number: 'M-2026-0001', status: 'open' });
    expect(second).toMatchObject({ number: 'M-2026-0002', status: 'lead' });
    expect(w.doc(`orgs/${ORG}/counters/matter-2026`)).toMatchObject({ next: 3, createdBy: 'user-lawyer' });
    expect(w.doc(`orgs/${ORG}/matterNumbers/M-2026-0001`)).toMatchObject({
      number: 'M-2026-0001',
      matterId: first.matterId,
      year: 2026,
    });

    const stored = w.doc(`${M}/${first.matterId}`);
    expect(stored).toMatchObject({
      number: 'M-2026-0001',
      status: 'open',
      externalRef: 'LEG/00123',
      deletedAt: null,
      openTaskCount: 0,
      createdBy: 'user-lawyer',
    });
    expect((stored?.['lastActivityAt'] as Timestamp).toDate()).toEqual(new Date('2026-10-04T01:00:00.000Z'));
    expect(stored?.['search']).toEqual(
      expect.arrayContaining(['m20260001', 'estate', 'ada', 'quill', 'bertram', 'leg', '00123']),
    );
    expect(w.doc(`${M}/${first.matterId}/parties/client-c-ada`)).toMatchObject({
      orgId: ORG,
      matterId: first.matterId,
      contactId: 'c-ada',
      role: 'client',
    });
    expect(w.doc(`${M}/${first.matterId}/parties/deceased-c-bertram`)).toMatchObject({ role: 'deceased' });
    expect(w.audits().find((entry) => entry['action'] === 'matter.created')).toMatchObject({
      entity: { path: `${M}/${first.matterId}` },
      data: { number: 'M-2026-0001', status: 'open', type: 'probate', year: 2026 },
    });
  });

  it('takes the year in the org’s time zone from the (injected) clock', async () => {
    const w = world({}, '2026-12-31T12:59:59.000Z');
    expect((await w.create()).number).toBe('M-2026-0001');
    w.clock.set(new Date('2026-12-31T13:00:00.000Z'));
    expect((await w.create()).number).toBe('M-2027-0001');
    expect(w.doc(`orgs/${ORG}/counters/matter-2026`)).toMatchObject({ next: 2 });
    expect(w.doc(`orgs/${ORG}/counters/matter-2027`)).toMatchObject({ next: 2 });
  });

  it('skips numbers already reserved or held by a matter, so a format change keeps them unique', async () => {
    const w = world({
      [`orgs/${ORG}/counters/matter-2026`]: { ...meta, next: 7 },
      // A migrated matter holds M7 without a reservation.
      [`${M}/legacy`]: { ...meta, number: 'M7', title: 'Migrated matter' },
    });
    await w.db.doc(`orgs/${ORG}`).update({ matterNumberFormat: 'M{seq}' });
    expect((await w.create()).number).toBe('M8');
    // Back to padded numbers, then to a format that would repeat M8: it moves on.
    await w.db.doc(`orgs/${ORG}`).update({ matterNumberFormat: 'M-{YYYY}-{seq:4}' });
    expect((await w.create()).number).toBe('M-2026-0009');
    await w.db.doc(`orgs/${ORG}/counters/matter-2026`).update({ next: 8 });
    await w.db.doc(`orgs/${ORG}`).update({ matterNumberFormat: 'm{seq}' });
    // m8 clashes with M8 (numbers are unique regardless of case), so it moves on to m9.
    expect((await w.create()).number).toBe('m9');
  });

  it('fills {TYPE} from the practice’s type codes (CORE-21a)', async () => {
    const w = world();
    await w.db.doc(`orgs/${ORG}`).update({ matterNumberFormat: '{TYPE}{YY}-{seq:3}' });
    expect((await w.create()).number).toBe('PRB26-001');
    expect((await w.create(newMatter({ type: 'will', deceased: undefined }))).number).toBe('WIL26-002');
    await w.db.doc(`orgs/${ORG}`).update({ matterTypeCodes: { probate: 'EST' } });
    expect((await w.create()).number).toBe('EST26-003');
  });

  it(`gives up after ${MAX_NUMBER_SKIPS} taken numbers`, async () => {
    const taken = Object.fromEntries(
      Array.from({ length: MAX_NUMBER_SKIPS }, (_, i) => [
        `orgs/${ORG}/matterNumbers/X${i + 1}`,
        { ...meta, number: `X${i + 1}`, matterId: `m${i}`, year: 2026 },
      ]),
    );
    const w = world(taken);
    await w.db.doc(`orgs/${ORG}`).update({ matterNumberFormat: 'X{seq}' });
    expect(await failureOf(w.create())).toMatchObject({ code: 'CONFLICT' });
  });

  it('refuses missing, deleted or merged contacts and inactive members, with field paths', async () => {
    const w = world({ [`${C}/c-deleted`]: person('Del', 'Eted', { deletedAt: new Date() }) });
    const error = await failureOf(
      w.create(
        newMatter({
          clientContactIds: ['c-ada', 'c-merged', 'c-nobody'],
          deceased: { contactId: 'c-deleted', dateOfDeath: '2026-08-01', domicile: 'VIC', lastAddress: 'x' },
          testator: { contactId: 'c-nobody' },
          referrerContactId: 'c-nobody',
          responsibleUid: 'user-gone',
          teamUids: ['user-para', 'user-nobody'],
        }),
      ),
    );
    expect(error).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(Object.keys((error.details?.['fields'] ?? {}) as object).sort()).toEqual([
      'matter.clientContactIds.1',
      'matter.clientContactIds.2',
      'matter.deceased.contactId',
      'matter.referrerContactId',
      'matter.responsibleUid',
      'matter.teamUids.1',
      'matter.testator.contactId',
    ]);
  });

  it('lets only privileged.view roles create a privileged matter', async () => {
    const w = world();
    expect(await failureOf(w.create(newMatter({ privileged: true }), 'paralegal'))).toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    await expect(w.create(newMatter({ privileged: true }), 'lawyer')).resolves.toMatchObject({ status: 'open' });
  });

  it('adds one party row per role and contact', () => {
    expect(
      initialParties(
        newMatter({
          clientContactIds: ['c-ada', 'c-ada'],
          testator: { contactId: 'c-ada' },
          deceased: undefined,
        }) as never,
      ),
    ).toEqual([
      { contactId: 'c-ada', role: 'client' },
      { contactId: 'c-ada', role: 'testator' },
    ]);
  });

  it('is for matter.create roles, and the client cannot choose the number or status (wrapper)', async () => {
    const w = world();
    const call = (role: Role, data: Record<string, unknown>) =>
      runCallable(
        createMatterDefinition,
        { data, auth: { uid: `user-${role}`, token: { orgId: ORG, role } } },
        w.deps(),
      );
    const denied = (await failureOf(call('readonly', { requestId: randomUUID(), matter: newMatter() }))) as HttpsError;
    expect(denied.details).toMatchObject({ code: 'PERMISSION_DENIED' });
    const sneaky = (await failureOf(
      call('lawyer', { requestId: randomUUID(), matter: newMatter({ number: 'M-1', status: 'open' }) }),
    )) as HttpsError;
    expect(sneaky.details).toMatchObject({ code: 'INVALID_ARGUMENT' });
    // A paralegal creates leads; recording a determination is for conflict.determine (CORE-02).
    const paralegalClear = (await failureOf(
      call('paralegal', { requestId: randomUUID(), matter: newMatter() }),
    )) as HttpsError;
    expect(paralegalClear.details).toMatchObject({ code: 'PERMISSION_DENIED', reason: 'conflict_determine_required' });
    await expect(
      call('paralegal', { requestId: randomUUID(), matter: newMatter({ conflictCheck: { status: 'pending' } }) }),
    ).resolves.toMatchObject({ number: 'M-2026-0001', status: 'lead' });
  });
});

describe('matters-createMatter conflict intake (CORE-02)', () => {
  it('stamps a determination made at intake and audits it with its reason', async () => {
    const w = world();
    const result = await w.create(
      newMatter({
        conflictCheck: {
          status: 'potential',
          reason: 'Same surname as a beneficiary on an unrelated estate',
          checkedBy: 'someone-else',
        },
      }),
    );
    expect(result.status).toBe('open');
    expect(w.doc(`${M}/${result.matterId}`)?.['conflictCheck']).toMatchObject({
      status: 'potential',
      checkedBy: 'user-lawyer',
      reason: 'Same surname as a beneficiary on an unrelated estate',
    });
    expect(w.audits().find((entry) => entry['action'] === 'matter.conflict_determined')).toMatchObject({
      data: { status: 'potential', atIntake: true, reason: 'Same surname as a beneficiary on an unrelated estate' },
    });
  });

  it('keeps a conflict matter a lead, and needs a reason for potential and conflict', async () => {
    const w = world();
    expect(
      (await w.create(newMatter({ conflictCheck: { status: 'conflict', reason: 'Acting for the other side' } })))
        .status,
    ).toBe('lead');
    expect(await failureOf(w.create(newMatter({ conflictCheck: { status: 'conflict' } })))).toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { fields: { 'matter.conflictCheck.reason': expect.any(Array) } },
    });
  });

  it('keeps only resultId on a pending check, and refuses a check run for another matter', async () => {
    const w = world({
      [`orgs/${ORG}/conflictChecks/k-new`]: { ...meta, subjects: [], hits: [] },
      [`orgs/${ORG}/conflictChecks/k-other`]: { ...meta, subjects: [], hits: [], excludeMatterId: 'm-other' },
    });
    const { matterId } = await w.create(
      newMatter({ conflictCheck: { status: 'pending', resultId: 'k-new', checkedBy: 'user-lawyer' } }),
    );
    expect(w.doc(`${M}/${matterId}`)?.['conflictCheck']).toEqual({ status: 'pending', resultId: 'k-new' });
    for (const resultId of ['k-other', 'k-missing']) {
      expect(await failureOf(w.create(newMatter({ conflictCheck: { status: 'pending', resultId } })))).toMatchObject({
        code: 'INVALID_ARGUMENT',
        details: { fields: { 'matter.conflictCheck.resultId': expect.any(Array) } },
      });
    }
  });
});

describe('matters-changeStatus', () => {
  const STATUSES = MatterStatusSchema.options;
  const seeded = (status: MatterStatus, extra: Record<string, unknown> = {}) =>
    world({
      [`${M}/m1`]: {
        ...meta,
        number: 'M-2026-0001',
        title: 'Estate of Fictional Quill',
        status,
        conflictCheck: { status: 'clear' },
        privileged: false,
        deletedAt: null,
        ...extra,
      },
    });
  const change = (w: ReturnType<typeof world>, to: MatterStatus, reason?: string, role: Role = 'lawyer') =>
    changeStatusDefinition.handler(
      w.ctx({ requestId: randomUUID(), matterId: 'm1', to, ...(reason ? { reason } : {}) }, role) as never,
    );

  const pairs = STATUSES.flatMap((from) => STATUSES.map((to) => [from, to] as const));
  // Closing runs the checklist through matters-close (CORE-19, retention.spec.ts).
  const allowed = pairs.filter(([from, to]) => MATTER_TRANSITIONS[from].includes(to) && to !== 'closed');
  const refused = pairs.filter(([from, to]) => !MATTER_TRANSITIONS[from].includes(to));

  it.each(allowed)('%s → %s is allowed', async (from, to) => {
    const w = seeded(from);
    await expect(change(w, to, 'Client asked to resume')).resolves.toEqual({ matterId: 'm1', status: to });
    expect(w.doc(`${M}/m1`)).toMatchObject({ status: to, updatedBy: 'user-lawyer' });
  });

  it.each(refused)('%s → %s is MATTER_INVALID_TRANSITION', async (from, to) => {
    const w = seeded(from);
    const error = await failureOf(change(w, to, 'Because'));
    expect(error).toMatchObject({ code: 'MATTER_INVALID_TRANSITION', details: { from, to } });
    expect(w.doc(`${M}/m1`)?.['status']).toBe(from);
  });

  it('opens a lead only once the conflict check is clear or potential (CORE-02)', async () => {
    const w = seeded('lead', { conflictCheck: { status: 'conflict', reason: 'Acting for the other side' } });
    expect(await failureOf(change(w, 'open'))).toMatchObject({
      code: 'FAILED_PRECONDITION',
      details: { reason: 'conflict_check_not_clear', conflictStatus: 'conflict' },
    });
    const pending = seeded('lead', { conflictCheck: { status: 'pending' } });
    expect(await failureOf(change(pending, 'open'))).toMatchObject({
      details: { reason: 'conflict_check_not_clear', conflictStatus: 'pending' },
    });
    const potential = seeded('lead', { conflictCheck: { status: 'potential', reason: 'Waived after review' } });
    await expect(change(potential, 'open')).resolves.toEqual({ matterId: 'm1', status: 'open' });
    const noCheck = seeded('lead', { conflictCheck: undefined });
    expect(await failureOf(change(noCheck, 'open'))).toMatchObject({
      details: { reason: 'conflict_check_not_clear', conflictStatus: 'pending' },
    });
  });

  it('sends closing to matters-close; reopening needs a reason and clears the closing fields', async () => {
    const w = seeded('closed', {
      closedAt: new Date('2026-09-01T00:00:00Z'),
      closeReason: 'Estate finalised',
      destroyAfter: '2033-09-01',
      closing: { closingLetterSent: true, finalDistributionRecorded: true, tasksCancelled: 0, holds: [] },
    });
    for (const from of ['open', 'on_hold'] as const) {
      expect(await failureOf(change(seeded(from), 'closed', 'Estate finalised'))).toMatchObject({
        code: 'FAILED_PRECONDITION',
        details: { reason: 'closing_checklist_required' },
      });
    }
    expect(await failureOf(change(w, 'open'))).toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { fields: { reason: expect.any(Array) } },
    });
    expect(await failureOf(change(w, 'open', '   '))).toMatchObject({ code: 'INVALID_ARGUMENT' });
    await change(w, 'open', 'Further assets found');
    for (const field of ['closedAt', 'closeReason', 'destroyAfter', 'closing', 'archivedAt']) {
      expect(w.doc(`${M}/m1`)).not.toHaveProperty(field);
    }
    expect(
      w
        .audits()
        .filter((entry) => entry['action'] === 'matter.status_changed')
        .at(-1),
    ).toMatchObject({
      data: { from: 'closed', to: 'open', reason: 'Further assets found' },
    });
    // Archiving stamps archivedAt; an archived matter reopens the same way.
    const closed = seeded('closed', { closedAt: new Date('2026-06-01T00:00:00Z') });
    await change(closed, 'archived');
    expect(closed.doc(`${M}/m1`)?.['archivedAt']).toBeInstanceOf(Timestamp);
    await change(closed, 'open', 'Further assets found');
    expect(closed.doc(`${M}/m1`)).toMatchObject({ status: 'open' });
    expect(closed.doc(`${M}/m1`)).not.toHaveProperty('archivedAt');
  });

  it('treats deleted, missing, unreadable and malformed matters as not found or invalid', async () => {
    expect(await failureOf(change(seeded('open', { deletedAt: new Date() }), 'closed'))).toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await failureOf(change(world(), 'closed'))).toMatchObject({ code: 'NOT_FOUND' });
    const privileged = seeded('open', { privileged: true });
    expect(await failureOf(change(privileged, 'closed', undefined, 'paralegal'))).toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await failureOf(change(seeded('active' as MatterStatus), 'closed'))).toMatchObject({
      code: 'FAILED_PRECONDITION',
      details: { reason: 'invalid_status' },
    });
  });

  it('is for matter.status roles: a paralegal cannot change status (wrapper)', async () => {
    const w = seeded('open');
    const call = (role: Role) =>
      runCallable(
        changeStatusDefinition,
        {
          data: { requestId: randomUUID(), matterId: 'm1', to: 'on_hold' },
          auth: { uid: `user-${role}`, token: { orgId: ORG, role } },
        },
        w.deps(),
      );
    expect(((await failureOf(call('paralegal'))) as HttpsError).details).toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(call('lawyer')).resolves.toEqual({ matterId: 'm1', status: 'on_hold' });
  });
});

describe('referral thank-you task (CORE-18)', () => {
  const TASK = `${M}/m1/tasks/referrer-thank-you`;
  const settings = (thankYouTask: boolean) => ({
    [`orgs/${ORG}`]: {
      name: 'Fictional Bayside Legal',
      retentionYears: 7,
      timezone: 'Australia/Melbourne',
      settings: { referrals: { thankYouTask } },
    },
    [`${C}/c-ref`]: { ...meta, kind: 'organisation', orgName: 'Lighthouse Fictional Advisers', isReferrer: true },
  });
  const lead = (extra: Record<string, unknown> = {}) => ({
    [`${M}/m1`]: {
      ...meta,
      number: 'M-2026-0001',
      title: 'Will of Fictional Quill',
      status: 'lead',
      responsibleUid: 'user-lawyer',
      conflictCheck: { status: 'clear' },
      referrerContactId: 'c-ref',
      openTaskCount: 2,
      privileged: false,
      deletedAt: null,
      ...extra,
    },
  });
  const open = (w: ReturnType<typeof world>, to: MatterStatus = 'open') =>
    changeStatusDefinition.handler(w.ctx({ requestId: randomUUID(), matterId: 'm1', to }) as never);
  const tasksOf = (w: ReturnType<typeof world>, matterId: string) =>
    [...w.docs.entries()].filter(([path]) => path.startsWith(`${M}/${matterId}/tasks/`));

  it('creates "Thank …" for the responsible lawyer when a referred lead opens, once', async () => {
    const w = world({ ...settings(true), ...lead() });
    await open(w);
    expect(w.doc(TASK)).toMatchObject({
      title: 'Thank Lighthouse Fictional Advisers for the referral',
      status: 'todo',
      assigneeUid: 'user-lawyer',
      dueDate: '2026-10-11',
      group: 'Referral',
      countedOpen: true,
      orgId: ORG,
      matterId: 'm1',
    });
    expect(w.doc(`${M}/m1`)?.['openTaskCount']).toBe(3);
    expect(w.audits().find((a) => a['action'] === 'matter.status_changed')?.['data']).toMatchObject({
      referrerThankYouTask: true,
    });
    // On hold and open again: the task exists, so nothing more.
    await open(w, 'on_hold');
    await open(w, 'open');
    expect(tasksOf(w, 'm1')).toHaveLength(1);
    expect(w.doc(`${M}/m1`)?.['openTaskCount']).toBe(3);
  });

  it('does nothing when the setting is off, the matter has no referrer, or only a source', async () => {
    for (const w of [
      world({ ...settings(false), ...lead() }),
      world({ ...settings(true), ...lead({ referrerContactId: undefined }) }),
      world({ ...settings(true), ...lead({ referrerContactId: undefined, referralSource: 'website' }) }),
      world(lead()),
    ]) {
      await open(w);
      expect(w.doc(TASK)).toBeUndefined();
      expect(w.doc(`${M}/m1`)?.['openTaskCount']).toBe(2);
    }
  });

  it('adds it to a referred matter created open, counted with its other tasks', async () => {
    const w = world(settings(true));
    const result = await w.create(newMatter({ referrerContactId: 'c-ref' }));
    const tasks = tasksOf(w, result.matterId);
    expect(tasks.map(([, task]) => task['title'])).toEqual(['Thank Lighthouse Fictional Advisers for the referral']);
    expect(w.doc(`${M}/${result.matterId}`)).toMatchObject({ referrerContactId: 'c-ref', openTaskCount: 1 });
    // A lead (conflict check pending) waits until it opens.
    const pending = await w.create(newMatter({ referrerContactId: 'c-ref', conflictCheck: { status: 'pending' } }));
    expect(tasksOf(w, pending.matterId)).toHaveLength(0);
  });

  it('stores a referral source instead of a referrer, and refuses an unknown referrer', async () => {
    const w = world(settings(true));
    const result = await w.create(newMatter({ referralSource: 'walk_in' }));
    expect(w.doc(`${M}/${result.matterId}`)).toMatchObject({ referralSource: 'walk_in' });
    expect(tasksOf(w, result.matterId)).toHaveLength(0);
    expect(await failureOf(w.create(newMatter({ referrerContactId: 'c-nobody' })))).toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { fields: { 'matter.referrerContactId': ['Choose an existing contact'] } },
    });
    expect(
      await failureOf(w.create(newMatter({ referrerContactId: 'c-ref', referralSource: 'website' }))),
    ).toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { fields: { 'matter.referralSource': ['Choose a referrer or a source, not both'] } },
    });
  });
});

describe('matters-restore', () => {
  const DAY = 86_400_000;
  const seeded = (deletedDaysAgo: number | null) => {
    const w = world({
      [`${M}/m1`]: {
        ...meta,
        number: 'M-2026-0001',
        title: 'Estate of Fictional Quill',
        status: 'open',
        deletedAt:
          deletedDaysAgo === null ? null : new Date(Date.parse('2026-10-04T01:00:00.000Z') - deletedDaysAgo * DAY),
        deletedBy: deletedDaysAgo === null ? null : 'user-lawyer',
      },
    });
    return w;
  };
  const restore = (w: ReturnType<typeof world>) =>
    restoreDefinition.handler(w.ctx({ requestId: randomUUID(), matterId: 'm1' }, 'admin') as never);

  it('restores within 30 days, and audits it', async () => {
    const w = seeded(29);
    await expect(restore(w)).resolves.toEqual({ matterId: 'm1', restored: true });
    expect(w.doc(`${M}/m1`)).toMatchObject({ deletedAt: null, deletedBy: null, updatedBy: 'user-admin' });
    expect(w.audits().find((entry) => entry['action'] === 'matter.restored')).toBeDefined();
  });

  it('refuses after 30 days', async () => {
    expect(await failureOf(restore(seeded(31)))).toMatchObject({
      code: 'FAILED_PRECONDITION',
      details: { reason: 'restore_window_passed', windowDays: 30 },
    });
  });

  it('leaves a live matter alone and refuses a missing one', async () => {
    await expect(restore(seeded(null))).resolves.toEqual({ matterId: 'm1', restored: false });
    expect(await failureOf(restore(world()))).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('is for owners and admins (wrapper)', async () => {
    const w = seeded(1);
    const call = (role: Role) =>
      runCallable(
        restoreDefinition,
        {
          data: { requestId: randomUUID(), matterId: 'm1' },
          auth: { uid: `user-${role}`, token: { orgId: ORG, role } },
        },
        w.deps(),
      );
    expect(((await failureOf(call('lawyer'))) as HttpsError).details).toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(call('owner')).resolves.toEqual({ matterId: 'm1', restored: true });
  });
});

describe('matters-renumber (CORE-21a)', () => {
  const seeded = () =>
    world({
      [`${M}/m1`]: {
        ...meta,
        number: 'M-2026-0001',
        title: 'Estate of Fictional Quill',
        clientContactIds: ['c-ada'],
        status: 'open',
        deletedAt: null,
      },
      [`orgs/${ORG}/matterNumbers/M-2026-0001`]: { ...meta, number: 'M-2026-0001', matterId: 'm1', year: 2026 },
      [`${M}/m2`]: { ...meta, number: 'M-2026-0002', title: 'Other', status: 'open', deletedAt: null },
      [`orgs/${ORG}/matterNumbers/M-2026-0002`]: { ...meta, number: 'M-2026-0002', matterId: 'm2', year: 2026 },
      // A migrated matter holds LEG-9 without a reservation.
      [`${M}/legacy`]: { ...meta, number: 'LEG-9', title: 'Migrated', status: 'open', deletedAt: null },
    });
  const renumber = (w: ReturnType<typeof world>, number: string, matterId = 'm1', role: Role = 'lawyer') =>
    renumberDefinition.handler(w.ctx({ requestId: randomUUID(), matterId, number }, role) as never);

  it('moves the reservation, updates number and search, and audits it', async () => {
    const w = seeded();
    await expect(renumber(w, '3E-104233')).resolves.toEqual({ matterId: 'm1', number: '3E-104233', changed: true });
    expect(w.doc(`${M}/m1`)).toMatchObject({ number: '3E-104233', updatedBy: 'user-lawyer' });
    expect(w.doc(`${M}/m1`)?.['search']).toEqual(expect.arrayContaining(['3e104233', 'ada', 'quill']));
    expect(w.doc(`orgs/${ORG}/matterNumbers/3E-104233`)).toMatchObject({ matterId: 'm1', year: 2026 });
    expect(w.doc(`orgs/${ORG}/matterNumbers/M-2026-0001`)).toBeUndefined();
    expect(w.audits().find((entry) => entry['action'] === 'matter.renumbered')).toMatchObject({
      data: { from: 'M-2026-0001', to: '3E-104233' },
    });
  });

  it('refuses a number another matter has, in any case, with or without a reservation', async () => {
    const w = seeded();
    for (const taken of ['M-2026-0002', 'm-2026-0002', 'LEG-9']) {
      expect(await failureOf(renumber(w, taken))).toMatchObject({ code: 'ALREADY_EXISTS', details: { number: taken } });
    }
    expect(w.doc(`${M}/m1`)).toMatchObject({ number: 'M-2026-0001' });
    expect(w.doc(`orgs/${ORG}/matterNumbers/M-2026-0001`)).toMatchObject({ matterId: 'm1' });
  });

  it('keeps the reservation for a case-only change and does nothing for the same number', async () => {
    const w = seeded();
    await expect(renumber(w, 'M-2026-0001')).resolves.toMatchObject({ changed: false });
    await expect(renumber(w, 'm-2026-0001')).resolves.toMatchObject({ changed: true });
    expect(w.doc(`orgs/${ORG}/matterNumbers/M-2026-0001`)).toMatchObject({ number: 'm-2026-0001', matterId: 'm1' });
  });

  it('frees the old number for the next new matter', async () => {
    const w = seeded();
    await renumber(w, 'X-1');
    await w.db.doc(`orgs/${ORG}/counters/matter-2026`).set({ ...meta, next: 1 });
    expect((await w.create()).number).toBe('M-2026-0001');
  });

  it('refuses a missing or deleted matter, and is for lawyers and above (wrapper)', async () => {
    const w = seeded();
    expect(await failureOf(renumber(w, 'X-1', 'nope'))).toMatchObject({ code: 'NOT_FOUND' });
    const call = (role: Role) =>
      runCallable(
        renumberDefinition,
        {
          data: { requestId: randomUUID(), matterId: 'm1', number: 'X-2' },
          auth: { uid: `user-${role}`, token: { orgId: ORG, role } },
        },
        w.deps(),
      );
    expect(((await failureOf(call('paralegal'))) as HttpsError).details).toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(call('admin')).resolves.toMatchObject({ number: 'X-2' });
  });
});

describe('matters-denormalise', () => {
  const PATH = `${M}/m1`;
  const trigger = (w: ReturnType<typeof world>, before: Record<string, unknown> | undefined, time: string) => {
    const current = w.doc(PATH);
    const change = {
      before: before ? { ref: { path: PATH }, data: () => before } : undefined,
      after: current ? { ref: { path: PATH }, data: () => current } : undefined,
    } as unknown as TriggerChange;
    const ctx = {
      eventId: 'e1',
      time: new Date(time),
      params: { orgId: ORG, matterId: 'm1' },
      log: w.log,
      clock: w.clock,
      db: w.db,
      ports: fakePorts(),
    } as unknown as TriggerContext;
    return denormalise(change, ctx);
  };
  const raw = {
    ...meta,
    number: 'HV-2026-0042',
    title: 'Estate of Fictional Quill',
    clientContactIds: ['c-ada'],
    deceased: { contactId: 'c-bertram' },
    createdAt: new Date('2026-10-01T00:00:00Z'),
  };

  it('fills search, lastActivityAt and deletedAt on a matter written without them, then stops', async () => {
    const w = world({ [PATH]: raw });
    expect(await trigger(w, undefined, '2026-10-04T02:00:00Z')).toBe('updated');
    const stored = w.doc(PATH);
    expect(stored?.['search']).toEqual(expect.arrayContaining(['hv20260042', 'ada', 'quill', 'bertram']));
    expect(stored?.['deletedAt']).toBeNull();
    expect((stored?.['lastActivityAt'] as Timestamp).toDate()).toEqual(new Date('2026-10-01T00:00:00Z'));
    expect(stored?.['updatedBy']).toBe('seed');
    // Its own write changes only derived fields: the next event is a no-op.
    expect(await trigger(w, { ...raw }, '2026-10-04T02:00:01Z')).toBe('unchanged');
  });

  it('moves lastActivityAt forward on a meaningful edit, not on derived-field writes', async () => {
    const w = world({ [PATH]: raw });
    await trigger(w, undefined, '2026-10-04T02:00:00Z');
    const before = { ...w.doc(PATH) };
    await w.db.doc(PATH).update({ title: 'Estate of Fictional Quillon', updatedBy: 'user-lawyer' });
    expect(await trigger(w, before, '2026-10-04T03:00:00Z')).toBe('updated');
    expect((w.doc(PATH)?.['lastActivityAt'] as Timestamp).toDate()).toEqual(new Date('2026-10-04T03:00:00Z'));
    expect(w.doc(PATH)?.['search']).toContain('quillon');

    const again = { ...w.doc(PATH) };
    await w.db.doc(PATH).update({ openTaskCount: 3, boardOrder: 2 });
    expect(await trigger(w, again, '2026-10-04T04:00:00Z')).toBe('unchanged');
    // An out-of-order (older) event never moves it back.
    await w.db.doc(PATH).update({ priority: 'high' });
    expect(await trigger(w, again, '2026-10-04T02:30:00Z')).toBe('unchanged');
  });

  it('ignores deletes and knows its document', async () => {
    const w = world();
    expect(await trigger(w, raw, '2026-10-04T02:00:00Z')).toBe('deleted');
    expect(denormaliseDefinition).toMatchObject({
      name: 'matters-denormalise',
      document: 'orgs/{orgId}/matters/{matterId}',
      on: 'written',
    });
  });

  it('tells activity from bookkeeping', () => {
    expect(isActivity({ title: 'a' }, { title: 'b' })).toBe(true);
    expect(isActivity({ status: 'open' }, { status: 'closed', updatedAt: 1 })).toBe(true);
    expect(isActivity({ search: [] }, { search: ['x'], lastActivityAt: 1, deletedAt: null })).toBe(false);
    expect(isActivity({ updatedAt: 1 }, { updatedAt: 2, updatedBy: 'x' })).toBe(false);
  });

  it('reports exactly the stale fields', () => {
    const names = new Map([['c-ada', 'Ada Quill']]);
    const current = {
      number: 'M-1',
      title: 'T',
      clientContactIds: ['c-ada'],
      lastActivityAt: new Date('2026-10-01T00:00:00Z'),
      deletedAt: null,
    };
    expect(staleMatterFields({ ...current, search: matterSearch(current, names) }, names)).toEqual({});
    expect(staleMatterFields({ ...current, search: [] }, names)).toEqual({ search: matterSearch(current, names) });
  });

  it('recordMatterActivity moves lastActivityAt forward only', async () => {
    const w = world({ [PATH]: { ...raw, lastActivityAt: new Date('2026-10-02T00:00:00Z') } });
    expect(await recordMatterActivity(w.db, ORG, 'm1', new Date('2026-10-01T00:00:00Z'))).toBe(false);
    expect(await recordMatterActivity(w.db, ORG, 'm1', new Date('2026-10-03T00:00:00Z'))).toBe(true);
    expect((w.doc(PATH)?.['lastActivityAt'] as Timestamp).toDate()).toEqual(new Date('2026-10-03T00:00:00Z'));
    expect(await recordMatterActivity(w.db, ORG, 'missing', new Date())).toBe(false);
  });
});

describe('orgClock (emulator-only clock pin)', () => {
  it('reads emulatorClock/{orgId} in the emulator only', async () => {
    const pinned = new Date('2026-12-31T13:00:00Z');
    const w = world({ [`emulatorClock/${ORG}`]: { now: pinned } });
    expect((await orgClock(w.db, ORG, w.clock, false)).now()).toEqual(w.clock.now());
    expect((await orgClock(w.db, ORG, w.clock, true)).now()).toEqual(pinned);
    expect((await orgClock(w.db, 'org-other', w.clock, true)).now()).toEqual(w.clock.now());
  });
});

describe('matters-rebalanceBoard (CORE-04)', () => {
  const live = (title: string, extra: Record<string, unknown> = {}) => ({
    ...meta,
    number: title,
    title,
    status: 'open',
    deletedAt: null,
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    ...extra,
  });
  const seeded = () =>
    world({
      [`${M}/m1`]: live('One', { boardOrder: 5 }),
      [`${M}/m2`]: live('Two', { boardOrder: 5.0000001 }),
      [`${M}/m3`]: live('Three'),
      [`${M}/gone`]: live('Gone', { deletedAt: new Date('2026-10-02T00:00:00.000Z') }),
      [`${M}/secret`]: live('Secret', { privileged: true }),
    });
  const rebalance = (w: ReturnType<typeof world>, matterIds: string[], role: Role = 'lawyer') =>
    rebalanceBoardDefinition.handler(w.ctx({ requestId: randomUUID(), matterIds }, role) as never);

  it('spaces the column out in the order given, writing only boardOrder', async () => {
    const w = seeded();
    await expect(rebalance(w, ['m3', 'm2', 'm1'])).resolves.toEqual({ updated: 3, skipped: [] });
    expect(w.doc(`${M}/m3`)?.['boardOrder']).toBe(1024);
    expect(w.doc(`${M}/m2`)?.['boardOrder']).toBe(2048);
    expect(w.doc(`${M}/m1`)).toMatchObject({ boardOrder: 3072, updatedBy: 'seed' });
    expect(w.doc(`${M}/m1`)?.['updatedAt']).toEqual(Timestamp.fromDate(new Date('2026-10-01T00:00:00.000Z')));
  });

  it('skips missing, deleted and (for paralegals) privileged matters without revealing them', async () => {
    const w = seeded();
    await expect(rebalance(w, ['m1', 'gone', 'nope', 'secret', 'm2'], 'paralegal')).resolves.toEqual({
      updated: 2,
      skipped: ['gone', 'nope', 'secret'],
    });
    expect(w.doc(`${M}/m2`)?.['boardOrder']).toBe(5 * 1024);
    expect(w.doc(`${M}/secret`)?.['boardOrder']).toBeUndefined();
    await expect(rebalance(w, ['secret'], 'lawyer')).resolves.toEqual({ updated: 1, skipped: [] });
    await expect(rebalance(w, ['nope'])).resolves.toEqual({ updated: 0, skipped: ['nope'] });
  });

  it('is for roles that edit matters (wrapper)', async () => {
    const w = seeded();
    const call = (role: Role) =>
      runCallable(
        rebalanceBoardDefinition,
        {
          data: { requestId: randomUUID(), matterIds: ['m1'] },
          auth: { uid: `user-${role}`, token: { orgId: ORG, role } },
        },
        w.deps(),
      );
    expect(((await failureOf(call('readonly'))) as HttpsError).details).toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(call('paralegal')).resolves.toEqual({ updated: 1, skipped: [] });
  });
});
