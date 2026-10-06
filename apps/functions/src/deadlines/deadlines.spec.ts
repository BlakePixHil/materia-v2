import { randomUUID } from 'node:crypto';

import type { HttpsError } from 'firebase-functions/v2/https';

import { toRuleSetDoc, VIC_RULESET_V1, type RuleSet } from '@materia/deadlines';
import { type Role } from '@materia/domain';

import { completeDefinition } from './complete';
import { deleteEventDefinition, recomputeDefinition, upsertEventDefinition } from './events';
import { flagMissedAllOrgs, flagMissedDeadlines } from './missed';
import { onDeadlineWrite, onWriteDefinition, syncNextDeadline } from './on-write';
import { overrideDefinition } from './override';
import { privilegeChanged, syncMatterPrivilege } from './privilege';
import { recomputeMatter } from './recompute';
import { resolveChangeDefinition } from './resolve-change';
import { engineEvents, matterFacts, templateRuleIds } from './shared';
import { proposeRulesetUpgradeDefinition } from './upgrade';
import { runCallable, type CallableDefinition, type CallableDeps } from '../core/callable';
import { clearFlagCaches, setRemoteFlagLoader } from '../core/flags';
import { createLog } from '../core/log';
import type { TriggerChange, TriggerContext } from '../core/trigger';
import { denormaliseDefinition } from '../matters/denormalise';
import { memoryFirestore } from '../orgs/testing';
import { FakeClock, fakePorts } from '../ports/fakes';

/** Unit tests for the deadlines functions (CORE-10). Every org, person and matter is fictional. */

const ORG = 'org-a';
const M = `orgs/${ORG}/matters`;
const MATTER = `${M}/m1`;
const D = `${MATTER}/deadlines`;
const meta = { createdBy: 'user-lawyer', updatedBy: 'user-lawyer', schemaVersion: 1 };
const member = (role: Role) => ({ ...meta, role, status: 'active' });
const matterDoc = (extra: Record<string, unknown> = {}) => ({
  ...meta,
  number: 'BL-2026-0042',
  title: 'Estate of Fictional Person',
  type: 'probate',
  jurisdiction: 'VIC',
  status: 'active',
  stageId: 'intake',
  responsibleUid: 'user-lawyer',
  teamUids: [],
  clientContactIds: ['c-1'],
  deceased: { contactId: 'c-2' },
  openTaskCount: 0,
  recomputeVersion: 0,
  deletedAt: null,
  ...extra,
});

type Data = Record<string, unknown>;

function world({ statutory = true, matters = { m1: matterDoc() } as Record<string, Data> } = {}) {
  const store = memoryFirestore({
    [`orgs/${ORG}`]: {
      name: 'Fictional Bayside Legal',
      timezone: 'Australia/Melbourne',
      flags: { 'deadlines.ruleset.vic.v1': statutory },
    },
    [`orgs/${ORG}/members/user-lawyer`]: member('lawyer'),
    [`orgs/${ORG}/members/user-paralegal`]: member('paralegal'),
    [`orgs/${ORG}/members/user-admin`]: member('admin'),
    ...Object.fromEntries(Object.entries(matters).map(([id, data]) => [`${M}/${id}`, data])),
  });
  // 11:00 on 5 October 2026 in Melbourne.
  const clock = new FakeClock(new Date('2026-10-05T00:00:00.000Z'));
  const ports = fakePorts();
  const deps = (): CallableDeps => ({
    db: () => store.db,
    clock,
    ports: () => ports,
    memberLookup: async () => true,
    idempotency: {
      begin: async () => ({ replay: false }),
      complete: async () => undefined,
      abandon: async () => undefined,
    },
    sink: () => undefined,
  });
  const call = <T>(def: CallableDefinition<never, T>, data: Data, role: Role = 'lawyer') =>
    runCallable(
      def as unknown as CallableDefinition<never, T>,
      { data: { requestId: randomUUID(), ...data }, auth: { uid: `user-${role}`, token: { orgId: ORG, role } } },
      deps(),
    );
  const under = (path: string) =>
    [...store.docs.entries()]
      .filter(([p]) => p.startsWith(`${path}/`) && p.split('/').length === path.split('/').length + 1)
      .map(([p, data]): Data & { id: string } => ({ ...data, id: p.split('/').at(-1) as string }));
  const doc = (path: string) => store.docs.get(path) as Data | undefined;
  const log = createLog({ fn: 'test' }, () => undefined);
  return { ...store, clock, call, under, doc, log, ports };
}

type World = ReturnType<typeof world>;

const upcoming = (w: World) =>
  w
    .under(D)
    .filter((d) => d['status'] === 'upcoming')
    .map((d) => d.id)
    .sort();

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return { code: (error as HttpsError).code, details: (error as HttpsError).details as Data };
  }
  throw new Error('expected a failure');
};

const upsert = (w: World, data: Data, role: Role = 'lawyer') =>
  w.call(upsertEventDefinition as never, { matterId: 'm1', ...data }, role) as Promise<{
    eventId: string;
    recompute: {
      created: string[];
      proposed: string[];
      updated: string[];
      statutoryDisabled: boolean;
      createdTaskIds: string[];
      recomputeVersion: number;
      calendarMissing: string[];
    };
    filledTaskIds: string[];
  }>;

beforeEach(() => {
  setRemoteFlagLoader(async () => ({}));
  clearFlagCaches();
});

describe('shared helpers', () => {
  it('falls back to key facts for anchors and reads facts and template rules', () => {
    const matter = { deceased: { dateOfDeath: '2026-03-01' }, estate: { hasMainResidence: true } };
    const events = engineEvents(matter, [
      { id: 'e1', data: { kind: 'grant_issued', date: '2026-06-01', meta: { x: 1 } } },
      { id: 'e2', data: { kind: 'caveat_lodged', date: '2026-06-02', deletedAt: new Date() } },
      { id: 'e3', data: { kind: 'not_a_kind', date: '2026-06-03' } },
    ]);
    expect(events).toEqual([
      { id: 'e1', kind: 'grant_issued', date: '2026-06-01', meta: { x: 1 } },
      { kind: 'date_of_death', date: '2026-03-01' },
    ]);
    expect(matterFacts(matter, events)).toEqual({
      estate: { hasMainResidence: true },
      grant: { filed: true },
      org: {},
    });
    expect(matterFacts({}, [])).toEqual({ estate: {}, grant: {}, org: {} });
    expect(templateRuleIds(undefined)).toBeUndefined();
    expect(templateRuleIds({ deadlineRuleIds: [] })).toBeUndefined();
    expect(templateRuleIds({ deadlineRuleIds: ['a'] })).toEqual(['a']);
  });
});

describe('deadlines-upsertEvent and recompute', () => {
  it('records a date of death, mirrors the key fact and creates the computed deadlines', async () => {
    const w = world();
    const result = await upsert(w, { kind: 'date_of_death', date: '2026-08-01' });
    // Rules whose anchor is still unknown are created blocked, with the rule's reason.
    expect(upcoming(w)).toEqual(
      ['rule-au.tax.final_return', 'rule-org.executor_year', 'rule-vic.probate.prompt_filing'].sort(),
    );
    // The main residence rule applies only when the estate has one.
    expect(w.doc(`${D}/rule-au.cgt.main_residence`)).toBeUndefined();
    expect(result.recompute.created).toContain('rule-vic.caveat.expiry');
    expect(w.doc(`${D}/rule-vic.caveat.expiry`)).toMatchObject({
      status: 'blocked',
      blockedCode: 'anchor_missing',
      blockedReason: 'No caveat has been lodged',
    });
    expect(result.recompute.statutoryDisabled).toBe(false);
    expect(result.recompute.recomputeVersion).toBe(1);
    const matter = w.doc(MATTER) as Data;
    expect(matter['recomputeVersion']).toBe(1);
    expect((matter['deceased'] as Data)['dateOfDeath']).toBe('2026-08-01');
    const deadline = w.doc(`${D}/rule-org.executor_year`) as Data;
    // 1 August 2027 is a Sunday, so the date rolls to Monday.
    expect(deadline).toMatchObject({
      status: 'upcoming',
      dueDate: '2027-08-02',
      orgId: ORG,
      matterId: 'm1',
      assigneeUid: 'user-lawyer',
    });
    expect(deadline['computed']).toMatchObject({ ruleId: 'org.executor_year', ruleSetId: 'vic', ruleSetVersion: 1 });
    expect(w.under(`${MATTER}/events`)).toHaveLength(1);
  });

  it('refuses a future date of death on the date field', async () => {
    const w = world();
    const error = await failure(upsert(w, { kind: 'date_of_death', date: '2026-10-06' }));
    expect(error.code).toBe('invalid-argument');
    expect(error.details['fields']).toHaveProperty('date');
  });

  it('skips statutory rules while the rule set flag is off', async () => {
    const w = world({ statutory: false });
    const result = await upsert(w, { kind: 'date_of_death', date: '2026-08-01' });
    expect(result.recompute.statutoryDisabled).toBe(true);
    expect(upcoming(w)).toEqual(['rule-org.executor_year', 'rule-vic.probate.prompt_filing']);
    expect(result.recompute.created.some((id) => id.startsWith('rule-au.'))).toBe(false);
  });

  it('is idempotent: recomputing with nothing new writes nothing', async () => {
    const w = world();
    await upsert(w, { kind: 'date_of_death', date: '2026-08-01' });
    const again = (await w.call(recomputeDefinition as never, { matterId: 'm1' })) as {
      ran: boolean;
      recomputeVersion: number;
      created: string[];
    };
    expect(again).toMatchObject({ ran: true, recomputeVersion: 1, created: [] });
    expect((w.doc(MATTER) as Data)['recomputeVersion']).toBe(1);
  });

  it('proposes a change instead of moving a deadline, and notifies the responsible lawyer', async () => {
    const w = world();
    const first = await upsert(w, { kind: 'date_of_death', date: '2026-08-01' });
    const edit = await upsert(w, { kind: 'date_of_death', date: '2026-07-01', eventId: first.eventId });
    expect(edit.recompute.proposed).toContain('rule-org.executor_year-v2');
    expect((w.doc(`${D}/rule-org.executor_year`) as Data)['dueDate']).toBe('2027-08-02');
    const change = w.doc(`${MATTER}/deadlineChanges/rule-org.executor_year-v2`) as Data;
    expect(change).toMatchObject({
      kind: 'moved',
      status: 'pending',
      fromDueDate: '2027-08-02',
      toDueDate: '2027-07-01',
      earlier: true,
      cause: 'event',
      assigneeUid: 'user-lawyer',
    });
    expect(w.doc(`orgs/${ORG}/notifications/dlchange-m1-rule-org.executor_year-v2`)).toMatchObject({
      kind: 'deadline_changed',
      recipientUid: 'user-lawyer',
      matterId: 'm1',
    });
    // The same edit again proposes nothing new.
    const repeat = await upsert(w, { kind: 'date_of_death', date: '2026-07-01', eventId: first.eventId });
    expect(repeat.recompute.proposed).toEqual([]);
  });

  it('a missing event is NOT_FOUND', async () => {
    const w = world();
    const error = await failure(upsert(w, { kind: 'date_of_death', date: '2026-08-01', eventId: 'nope' }));
    expect(error.code).toBe('not-found');
  });

  it('deleting an anchor event proposes removals', async () => {
    const w = world();
    const first = await upsert(w, { kind: 'caveat_lodged', date: '2026-09-01' });
    const deleted = (await w.call(deleteEventDefinition as never, { matterId: 'm1', eventId: first.eventId })) as {
      recompute: { proposed: string[] };
    };
    expect(deleted.recompute.proposed).toEqual(['rule-vic.caveat.expiry-v2']);
    expect(w.doc(`${MATTER}/deadlineChanges/rule-vic.caveat.expiry-v2`)).toMatchObject({
      kind: 'removed',
      critical: true,
    });
    expect((w.doc(`${MATTER}/events/${first.eventId}`) as Data)['deletedAt']).toBeDefined();
  });

  it('creates rule tasks once the matter reaches their stage, and counts them', async () => {
    const w = world();
    const grant = await upsert(w, { kind: 'grant_issued', date: '2026-09-01' });
    // vic.fp.limitation's task has no matching stage here, so it is created now; plan-distribution
    // waits for the distribution stage.
    expect(grant.recompute.createdTaskIds).toEqual(['dlt-advise-fp-window']);
    const task = w.doc(`${MATTER}/tasks/dlt-advise-fp-window`) as Data;
    expect(task).toMatchObject({
      source: 'rule',
      deadlineId: 'rule-vic.fp.limitation',
      priority: 'high',
      countedOpen: true,
    });
    expect((w.doc(`${D}/rule-vic.fp.limitation`) as Data)['taskId']).toBe('dlt-advise-fp-window');
    expect((w.doc(MATTER) as Data)['openTaskCount']).toBe(1);

    await w.db.doc(MATTER).update({ stageId: 'distribution' });
    const outcome = await recomputeMatter(w.db, {
      orgId: ORG,
      matterId: 'm1',
      uid: 'user-lawyer',
      role: 'lawyer',
      cause: 'stage',
      clock: w.clock,
      log: w.log,
      ports: w.ports,
    });
    expect(outcome.createdTaskIds).toEqual(['dlt-plan-distribution']);
    expect((w.doc(MATTER) as Data)['openTaskCount']).toBe(2);
  });

  it('blocks a deadline whose calendar year is not loaded', async () => {
    const w = world();
    const result = await upsert(w, { kind: 'caveat_lodged', date: '2028-11-01' });
    expect(result.recompute.calendarMissing).toEqual(['rule-vic.caveat.expiry']);
    expect(w.doc(`${D}/rule-vic.caveat.expiry`)).toMatchObject({ status: 'blocked', blockedCode: 'calendar_missing' });
    expect((w.doc(`${D}/rule-vic.caveat.expiry`) as Data)['dueDate']).toBeUndefined();
  });

  it('flags deadlines already past when created', async () => {
    const w = world();
    await upsert(w, { kind: 'date_of_death', date: '2025-02-10' });
    expect((w.doc(`${D}/rule-vic.probate.prompt_filing`) as Data)['pastOnCreation']).toBe(true);
  });

  it('does nothing for a matter outside a rule set jurisdiction', async () => {
    const w = world({ matters: { m1: matterDoc({ jurisdiction: 'NSW' }) } });
    const result = await upsert(w, { kind: 'date_of_death', date: '2026-08-01' });
    expect(result.recompute.created).toEqual([]);
    expect(w.under(D)).toEqual([]);
  });
});

describe('privileged copies (CORE-10b)', () => {
  const COPIES = [D, `${MATTER}/deadlineChanges`, `${MATTER}/events`];
  const flags = (w: World) => COPIES.map((path) => [...new Set(w.under(path).map((row) => row['privileged']))]);
  /** A date of death, then a later edit of it: events, deadlines and a proposal. */
  const history = async (w: World) => {
    const first = await upsert(w, { kind: 'date_of_death', date: '2026-08-01' });
    await upsert(w, { kind: 'date_of_death', date: '2026-07-01', eventId: first.eventId });
    return first.eventId;
  };

  it('every event, deadline and proposal a recompute writes copies the matter’s flag', async () => {
    const privileged = world({ matters: { m1: matterDoc({ privileged: true }) } });
    await history(privileged);
    expect(flags(privileged)).toEqual([[true], [true], [true]]);

    const open = world();
    const eventId = await history(open);
    await open.call(deleteEventDefinition as never, { matterId: 'm1', eventId });
    expect(flags(open)).toEqual([[false], [false], [false]]);
  });

  it('a flag that changes is copied to the records that differ, once', async () => {
    const w = world();
    await history(w);
    const count = COPIES.reduce((sum, path) => sum + w.under(path).length, 0);
    await w.db.doc(MATTER).update({ privileged: true });
    expect(await syncMatterPrivilege(w.db as never, ORG, 'm1')).toBe(count);
    expect(flags(w)).toEqual([[true], [true], [true]]);
    expect(await syncMatterPrivilege(w.db as never, ORG, 'm1')).toBe(0);
    // A destroyed matter's tombstone (CORE-19), or a missing matter, is left alone.
    await w.db.doc(MATTER).update({ privileged: false, destroyedAt: new Date() });
    expect(await syncMatterPrivilege(w.db as never, ORG, 'm1')).toBe(0);
    expect(await syncMatterPrivilege(w.db as never, ORG, 'nope')).toBe(0);
  });

  it('matters-denormalise copies it when the matter’s flag changed, and only then', async () => {
    const w = world();
    await history(w);
    const run = (before: Data | undefined, after: Data) =>
      denormaliseDefinition.handler(
        {
          before: before ? { ref: { path: MATTER }, data: () => before } : undefined,
          after: { ref: { path: MATTER }, data: () => after },
        } as unknown as TriggerChange,
        {
          eventId: 'e1',
          time: new Date('2026-10-05T01:00:00Z'),
          params: { orgId: ORG, matterId: 'm1' },
          log: w.log,
          clock: w.clock,
          db: w.db,
          ports: w.ports,
        } as unknown as TriggerContext,
      );
    const before = { ...(w.doc(MATTER) as Data) };
    await w.db.doc(MATTER).update({ title: 'Estate of Fictional Person (renamed)' });
    await run(before, w.doc(MATTER) as Data);
    expect(flags(w)).toEqual([[false], [false], [false]]);
    await w.db.doc(MATTER).update({ privileged: true });
    await run(before, w.doc(MATTER) as Data);
    expect(flags(w)).toEqual([[true], [true], [true]]);

    expect(privilegeChanged({ privileged: false }, { privileged: true })).toBe(true);
    expect(privilegeChanged({}, { privileged: false })).toBe(false);
    expect(privilegeChanged(undefined, { privileged: true })).toBe(false);
    expect(privilegeChanged({ privileged: true }, undefined)).toBe(false);
  });
});

describe('deadlines-resolveChange', () => {
  async function proposed(w: World, kind = 'date_of_death', from = '2026-08-01', to = '2026-07-01') {
    const first = await upsert(w, { kind, date: from });
    const edit = await upsert(w, { kind, date: to, eventId: first.eventId });
    return edit.recompute.proposed;
  }

  it('accepting a move sets the new date and provenance', async () => {
    const w = world();
    await proposed(w);
    const result = await w.call(resolveChangeDefinition as never, {
      matterId: 'm1',
      changeId: 'rule-org.executor_year-v2',
      accept: true,
    });
    expect(result).toEqual({
      changeId: 'rule-org.executor_year-v2',
      deadlineId: 'rule-org.executor_year',
      status: 'accepted',
    });
    expect(w.doc(`${D}/rule-org.executor_year`)).toMatchObject({ dueDate: '2027-07-01' });
    expect(w.doc(`${MATTER}/deadlineChanges/rule-org.executor_year-v2`)).toMatchObject({
      status: 'accepted',
      resolvedBy: 'user-lawyer',
    });
    const error = await failure(
      w.call(resolveChangeDefinition as never, { matterId: 'm1', changeId: 'rule-org.executor_year-v2', accept: true }),
    );
    expect(error.details['reason']).toBe('change_not_pending');
  });

  it('rejecting keeps the date and is remembered', async () => {
    const w = world();
    await proposed(w);
    await w.call(resolveChangeDefinition as never, {
      matterId: 'm1',
      changeId: 'rule-org.executor_year-v2',
      accept: false,
    });
    expect(w.doc(`${D}/rule-org.executor_year`)).toMatchObject({
      dueDate: '2027-08-02',
      declined: { kind: 'moved', dueDate: '2027-07-01' },
    });
    const again = await recomputeMatter(w.db, {
      orgId: ORG,
      matterId: 'm1',
      uid: 'system',
      role: 'owner',
      cause: 'recompute',
      clock: w.clock,
      log: w.log,
      ports: w.ports,
    });
    expect(again.proposed).toEqual([]);
  });

  it('a critical change needs the matter number typed', async () => {
    const w = world();
    const changes = await proposed(w, 'caveat_lodged', '2026-09-01', '2026-09-10');
    expect(changes).toEqual(['rule-vic.caveat.expiry-v2']);
    const missing = await failure(
      w.call(resolveChangeDefinition as never, { matterId: 'm1', changeId: changes[0], accept: true }),
    );
    expect(missing.code).toBe('invalid-argument');
    expect(missing.details['fields']).toHaveProperty('confirmation');
    const ok = await w.call(resolveChangeDefinition as never, {
      matterId: 'm1',
      changeId: changes[0],
      accept: true,
      confirmation: ' bl-2026-0042 ',
    });
    expect(ok).toMatchObject({ status: 'accepted' });
  });

  it('accepting a removal supersedes the deadline; paralegals cannot decide', async () => {
    const w = world();
    const first = await upsert(w, { kind: 'caveat_lodged', date: '2026-09-01' });
    await w.call(deleteEventDefinition as never, { matterId: 'm1', eventId: first.eventId });
    const denied = await failure(
      w.call(
        resolveChangeDefinition as never,
        { matterId: 'm1', changeId: 'rule-vic.caveat.expiry-v2', accept: true },
        'paralegal',
      ),
    );
    expect(denied.code).toBe('permission-denied');
    await w.call(resolveChangeDefinition as never, {
      matterId: 'm1',
      changeId: 'rule-vic.caveat.expiry-v2',
      accept: true,
      confirmation: 'BL-2026-0042',
    });
    expect((w.doc(`${D}/rule-vic.caveat.expiry`) as Data)['status']).toBe('superseded');
  });

  it('a stale proposal is superseded, and a missing one NOT_FOUND', async () => {
    const w = world();
    await proposed(w);
    await w.db.doc(`${D}/rule-org.executor_year`).update({ dueDate: '2027-09-09' });
    const result = await w.call(resolveChangeDefinition as never, {
      matterId: 'm1',
      changeId: 'rule-org.executor_year-v2',
      accept: true,
    });
    expect(result).toMatchObject({ status: 'superseded' });
    const error = await failure(
      w.call(resolveChangeDefinition as never, { matterId: 'm1', changeId: 'nope', accept: true }),
    );
    expect(error.code).toBe('not-found');
  });
});

describe('deadlines-override', () => {
  it('overrides with a reason, flags an earlier computed date, and clears', async () => {
    const w = world();
    const first = await upsert(w, { kind: 'date_of_death', date: '2026-08-01' });
    const set = await w.call(overrideDefinition as never, {
      matterId: 'm1',
      deadlineId: 'rule-org.executor_year',
      dueDate: '2027-09-01',
      reason: 'Agreed with the fictional executor',
    });
    expect(set).toEqual({ deadlineId: 'rule-org.executor_year', dueDate: '2027-09-01', overrideConflict: false });
    expect(w.doc(`${D}/rule-org.executor_year`)).toMatchObject({
      dueDate: '2027-09-01',
      override: { dueDate: '2027-09-01', reason: 'Agreed with the fictional executor', by: 'user-lawyer' },
    });
    // The anchor moves earlier: the computed date goes earlier than the override.
    await upsert(w, { kind: 'date_of_death', date: '2026-06-01', eventId: first.eventId });
    expect(w.doc(`${D}/rule-org.executor_year`)).toMatchObject({ dueDate: '2027-09-01', overrideConflict: true });
    expect(
      w.under(`orgs/${ORG}/notifications`).some((n) => n.id.startsWith('dlconflict-m1-rule-org.executor_year')),
    ).toBe(true);

    const cleared = await w.call(overrideDefinition as never, {
      matterId: 'm1',
      deadlineId: 'rule-org.executor_year',
      dueDate: null,
    });
    expect(cleared).toMatchObject({ dueDate: '2027-06-01' });
    const after = w.doc(`${D}/rule-org.executor_year`) as Data;
    expect(after['override']).toBeUndefined();
    expect(after['overrideConflict']).toBeUndefined();
    // Clearing again changes nothing.
    expect(
      await w.call(overrideDefinition as never, {
        matterId: 'm1',
        deadlineId: 'rule-org.executor_year',
        dueDate: null,
      }),
    ).toMatchObject({
      dueDate: '2027-06-01',
    });
  });

  it('refuses paralegals, manual deadlines, closed and missing ones, and a missing reason', async () => {
    const w = world();
    await upsert(w, { kind: 'date_of_death', date: '2026-08-01' });
    await w.db.doc(`${D}/manual-1`).set({
      ...meta,
      title: 'Fictional contract date',
      dueDate: '2026-12-01',
      kind: 'contractual',
      critical: false,
      status: 'upcoming',
      orgId: ORG,
      matterId: 'm1',
    });
    const input = {
      matterId: 'm1',
      deadlineId: 'rule-org.executor_year',
      dueDate: '2027-09-01',
      reason: 'Fictional reason',
    };
    expect((await failure(w.call(overrideDefinition as never, input, 'paralegal'))).code).toBe('permission-denied');
    expect((await failure(w.call(overrideDefinition as never, { ...input, reason: undefined }))).code).toBe(
      'invalid-argument',
    );
    expect(
      (await failure(w.call(overrideDefinition as never, { ...input, deadlineId: 'manual-1' }))).details['reason'],
    ).toBe('manual_deadline');
    expect((await failure(w.call(overrideDefinition as never, { ...input, deadlineId: 'nope' }))).code).toBe(
      'not-found',
    );
    await w.call(completeDefinition as never, {
      matterId: 'm1',
      deadlineId: 'rule-org.executor_year',
      outcome: 'done',
    });
    expect((await failure(w.call(overrideDefinition as never, input))).details['reason']).toBe('deadline_not_open');
  });
});

describe('deadlines-complete and the missed check', () => {
  it('marks done (and linked tasks on request), waived with a reason, and missed only after the check', async () => {
    const w = world();
    await upsert(w, { kind: 'grant_issued', date: '2026-09-01' });
    const done = await w.call(completeDefinition as never, {
      matterId: 'm1',
      deadlineId: 'rule-vic.fp.limitation',
      outcome: 'done',
      completeLinkedTasks: true,
    });
    expect(done).toEqual({
      deadlineId: 'rule-vic.fp.limitation',
      status: 'done',
      openLinkedTaskIds: [],
      completedTaskIds: ['dlt-advise-fp-window'],
    });
    expect(w.doc(`${D}/rule-vic.fp.limitation`)).toMatchObject({
      status: 'done',
      resolution: { on: '2026-10-05', by: 'user-lawyer' },
    });
    expect((w.doc(`${MATTER}/tasks/dlt-advise-fp-window`) as Data)['status']).toBe('done');

    expect(
      (
        await failure(
          w.call(
            completeDefinition as never,
            { matterId: 'm1', deadlineId: 'rule-vic.distribution.s99a', outcome: 'waived', reason: 'x' },
            'paralegal',
          ),
        )
      ).code,
    ).toBe('permission-denied');
    expect(
      await w.call(completeDefinition as never, {
        matterId: 'm1',
        deadlineId: 'rule-vic.distribution.s99a',
        outcome: 'waived',
        reason: 'Fictional reason',
      }),
    ).toMatchObject({ status: 'waived' });
    expect(
      (
        await failure(
          w.call(completeDefinition as never, {
            matterId: 'm1',
            deadlineId: 'rule-vic.distribution.s99a',
            outcome: 'done',
          }),
        )
      ).details['reason'],
    ).toBe('deadline_not_open');
    expect(
      (await failure(w.call(completeDefinition as never, { matterId: 'm1', deadlineId: 'nope', outcome: 'done' })))
        .code,
    ).toBe('not-found');
    expect(
      (
        await failure(
          w.call(completeDefinition as never, {
            matterId: 'm1',
            deadlineId: 'rule-vic.fp.limitation',
            outcome: 'done',
            completedOn: '2026-10-06',
          }),
        )
      ).code,
    ).toBe('invalid-argument');
  });

  it('asks about a past-due deadline once, then allows missed', async () => {
    const w = world();
    await upsert(w, { kind: 'date_of_death', date: '2026-08-01' });
    // prompt_filing is due in the future; make one past due.
    await w.db.doc(`${D}/rule-vic.probate.prompt_filing`).update({ dueDate: '2026-10-01' });
    const notYet = await failure(
      w.call(completeDefinition as never, {
        matterId: 'm1',
        deadlineId: 'rule-vic.probate.prompt_filing',
        outcome: 'missed',
      }),
    );
    expect(notYet.details['reason']).toBe('not_past_due');

    const outcome = await flagMissedDeadlines(w.db, ORG, w.clock, w.log, w.ports);
    expect(outcome.flagged).toEqual(['m1/rule-vic.probate.prompt_filing']);
    expect(w.doc(`${D}/rule-vic.probate.prompt_filing`)).toMatchObject({ missedCheck: { since: '2026-10-01' } });
    expect(w.doc(`orgs/${ORG}/notifications/dlmissed-m1-rule-vic.probate.prompt_filing-2026-10-01`)).toMatchObject({
      kind: 'deadline_missed',
      recipientUid: 'user-lawyer',
    });
    expect(await flagMissedAllOrgs(w.db, w.clock, w.log, w.ports)).toBe(0);

    const missed = await w.call(completeDefinition as never, {
      matterId: 'm1',
      deadlineId: 'rule-vic.probate.prompt_filing',
      outcome: 'missed',
    });
    expect(missed).toMatchObject({ status: 'missed' });
    expect((w.doc(`${D}/rule-vic.probate.prompt_filing`) as Data)['missedCheck']).toBeUndefined();
  });
});

describe('nextDeadline', () => {
  it('keeps the matter’s next deadline current and removes it when none is left', async () => {
    const w = world();
    expect(await syncNextDeadline(w.db, ORG, 'nope')).toBeNull();
    await upsert(w, { kind: 'caveat_lodged', date: '2026-09-01' });
    const ctx = {
      db: w.db,
      params: { orgId: ORG, matterId: 'm1', deadlineId: 'rule-vic.caveat.expiry' },
      log: w.log,
      ports: w.ports,
    } as unknown as TriggerContext;
    await onDeadlineWrite(ctx);
    expect((w.doc(MATTER) as Data)['nextDeadline']).toMatchObject({ id: 'rule-vic.caveat.expiry', critical: true });
    expect(await syncNextDeadline(w.db, ORG, 'm1')).toMatchObject({ written: false });
    await w.call(completeDefinition as never, {
      matterId: 'm1',
      deadlineId: 'rule-vic.caveat.expiry',
      outcome: 'done',
    });
    await onWriteDefinition.handler({ before: undefined, after: undefined }, ctx);
    expect((w.doc(MATTER) as Data)['nextDeadline']).toBeUndefined();
  });
});

describe('deadlines-proposeRulesetUpgrade', () => {
  it('recomputes live open matters page by page, admins only', async () => {
    const w = world({
      matters: {
        m1: matterDoc({ deceased: { dateOfDeath: '2026-08-01' } }),
        m2: matterDoc({ deceased: { dateOfDeath: '2026-07-01' } }),
        m3: matterDoc({ status: 'closed', deceased: { dateOfDeath: '2026-07-01' } }),
        m4: matterDoc({ deletedAt: new Date(), deceased: { dateOfDeath: '2026-07-01' } }),
      },
    });
    expect((await failure(w.call(proposeRulesetUpgradeDefinition as never, {}, 'lawyer'))).code).toBe(
      'permission-denied',
    );
    const page1 = (await w.call(proposeRulesetUpgradeDefinition as never, { limit: 2 }, 'admin')) as Data;
    expect(page1).toMatchObject({ processed: 2, upgraded: 2, proposed: 0, failed: [], nextCursor: 'm2' });
    expect(page1['created']).toBeGreaterThan(0);
    const page2 = (await w.call(proposeRulesetUpgradeDefinition as never, { limit: 2, cursor: 'm2' }, 'admin')) as Data;
    // m3 is closed and m4 deleted: skipped, but the page was full, so there may be more.
    expect(page2).toMatchObject({ processed: 0, upgraded: 0, nextCursor: 'm4' });
    const page3 = (await w.call(proposeRulesetUpgradeDefinition as never, { limit: 2, cursor: 'm4' }, 'admin')) as Data;
    expect(page3).toMatchObject({ processed: 0 });
    expect(page3['nextCursor']).toBeUndefined();
    // Again: nothing new.
    expect(await w.call(proposeRulesetUpgradeDefinition as never, {}, 'admin')).toMatchObject({
      processed: 2,
      upgraded: 0,
    });
  });

  it('turns a stored version’s date changes into proposals; an invalid stored version is skipped', async () => {
    const w = world({ matters: { m1: matterDoc({ deceased: { contactId: 'c-2', dateOfDeath: '2026-08-01' } }) } });
    await recomputeMatter(w.db, {
      orgId: ORG,
      matterId: 'm1',
      uid: 'system',
      role: 'owner',
      cause: 'recompute',
      clock: w.clock,
      log: w.log,
      ports: w.ports,
    });
    expect((w.doc(`${D}/rule-org.executor_year`) as Data)['dueDate']).toBe('2027-08-02');
    const v2 = {
      ...VIC_RULESET_V1,
      version: 2,
      rules: VIC_RULESET_V1.rules.map((rule) =>
        rule.id === 'org.executor_year' ? { ...rule, offset: { months: 11 } } : rule,
      ),
    } as RuleSet;
    await w.db.doc('ruleSets/vic/versions/2').set({ ...toRuleSetDoc(v2), ...meta });
    await w.db.doc('ruleSets/vic/versions/3').set({ published: true, version: 3, rules: 'not rules' });
    const result = (await w.call(proposeRulesetUpgradeDefinition as never, {}, 'admin')) as Data;
    expect(result).toMatchObject({ processed: 1, upgraded: 1, proposed: 1, failed: [] });
    expect(w.doc(`${MATTER}/deadlineChanges/rule-org.executor_year-v2`)).toMatchObject({
      cause: 'ruleset_upgrade',
      fromDueDate: '2027-08-02',
      toDueDate: '2027-07-01',
      computed: { ruleSetVersion: 2 },
    });
    expect(w.doc(`${D}/rule-org.executor_year`)).toMatchObject({
      dueDate: '2027-08-02',
      computed: { ruleSetVersion: 1 },
    });
    // Unchanged dates take the new provenance in place. Version 2's statutory rules have no
    // practitioner-review flag yet, so they are skipped and keep version 1's.
    expect((w.doc(`${D}/rule-vic.probate.prompt_filing`) as Data)['computed']).toMatchObject({ ruleSetVersion: 2 });
    expect((w.doc(`${D}/rule-au.tax.final_return`) as Data)['computed']).toMatchObject({ ruleSetVersion: 1 });
  });
});
