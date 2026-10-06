import { TestBed } from '@angular/core/testing';

import { DEADLINE_CALLABLES, groupDeadlines, type Role } from '@materia/domain';

import { CallableClient } from './callable-client';
import {
  deadlineCallables,
  deadlineChangeGroupRepository,
  deadlineGroupRepository,
  MATTER_DEADLINES_QUERY,
  MATTER_EVENTS_QUERY,
  matterDeadlineChangeRepository,
  matterDeadlineRepository,
  matterEventRepository,
  myPendingChangesQuery,
  myUpcomingDeadlinesQuery,
  PENDING_CHANGES_QUERY,
  REVIEW_QUEUE_QUERY,
  UPCOMING_DEADLINES_QUERY,
} from './deadlines';
import { OrgContext } from './org-context';
import { InMemoryFirestore, provideInMemoryFirestore } from './testing/in-memory-firestore';

/** Deadlines reads, manual deadline writes and the deadlines callables (CORE-10). Fictional data only. */

const meta = {
  createdAt: new Date('2026-10-01T00:00:00Z'),
  createdBy: 'u-jordan',
  updatedAt: new Date('2026-10-01T00:00:00Z'),
  updatedBy: 'u-jordan',
  schemaVersion: 1,
};
const M = 'orgs/org-a/matters/m-1';

function deadline(title: string, extra: Record<string, unknown> = {}) {
  return {
    orgId: 'org-a',
    matterId: 'm-1',
    title,
    dueDate: '2026-10-09',
    kind: 'internal',
    critical: false,
    status: 'upcoming',
    assigneeUid: 'u-jordan',
    reminders: [],
    pastOnCreation: false,
    ...meta,
    ...extra,
  };
}

function setup(role: Role = 'lawyer') {
  const fs = new InMemoryFirestore();
  TestBed.configureTestingModule({ providers: [provideInMemoryFirestore(fs)] });
  TestBed.inject(OrgContext).setSession({ uid: 'u-jordan', orgId: 'org-a', role });
  const run = <T>(fn: () => T) => TestBed.runInInjectionContext(fn);
  return { fs, run };
}

describe('matterDeadlineRepository', () => {
  it('reads every deadline of a matter, blocked ones without a date included', async () => {
    const { fs, run } = setup();
    fs.set(`${M}/deadlines/d-1`, deadline('Fictional settlement'));
    fs.set(
      `${M}/deadlines/rule-x`,
      deadline('Fictional caveat expiry', {
        dueDate: undefined,
        status: 'blocked',
        blockedReason: 'No caveat has been lodged',
        blockedCode: 'anchor_missing',
        kind: 'court',
        computed: { ruleId: 'x', ruleSetId: 'vic', ruleSetVersion: 1, inputs: {}, trace: [] },
      }),
    );
    fs.set(`${M}/deadlines/gone`, deadline('Gone', { deletedAt: new Date('2026-10-02T00:00:00Z') }));
    const rows = await run(() => matterDeadlineRepository(() => 'm-1')).query(MATTER_DEADLINES_QUERY);
    expect(rows.map((r) => [r.id, r.status, r.dueDate]).sort()).toEqual([
      ['d-1', 'upcoming', '2026-10-09'],
      ['rule-x', 'blocked', undefined],
    ]);
    expect(groupDeadlines(rows, '2026-10-07' as never)[1]?.deadlines.map((r) => r.id)).toEqual(['d-1']);
  });

  it('creates a manual deadline with the org, matter and status the rules require', async () => {
    const { fs, run } = setup();
    const deadlines = run(() => matterDeadlineRepository(() => 'm-1'));
    const id = await deadlines.create({
      title: 'Fictional contract settlement',
      dueDate: '2026-11-20' as never,
      kind: 'contractual',
      assigneeUid: 'u-jordan',
      privileged: false,
    });
    expect(fs.get(`${M}/deadlines/${id}`)).toMatchObject({
      orgId: 'org-a',
      matterId: 'm-1',
      status: 'upcoming',
      critical: false,
      reminders: [],
      privileged: false,
      createdBy: 'u-jordan',
    });
    // The matter's flag is required (CORE-10b).
    await expect(
      deadlines.create({ title: 'x', dueDate: '2026-11-20', kind: 'internal', assigneeUid: 'u-jordan' }),
    ).rejects.toBeTruthy();
    await expect(
      deadlines.create({ title: 'x', dueDate: '2026-11-20', kind: 'statutory', assigneeUid: 'u-jordan' }),
    ).rejects.toBeTruthy();
    await expect(
      run(() => matterDeadlineRepository(() => null)).create({
        title: 'x',
        dueDate: '2026-11-20',
        kind: 'internal',
        assigneeUid: 'u-jordan',
      }),
    ).rejects.toThrow();
  });

  it('updates whitelisted fields only', async () => {
    const { fs, run } = setup();
    fs.set(`${M}/deadlines/d-1`, deadline('Fictional settlement'));
    const deadlines = run(() => matterDeadlineRepository(() => 'm-1'));
    await deadlines.update('d-1', { dueDate: '2026-10-16', critical: true });
    expect(fs.get(`${M}/deadlines/d-1`)).toMatchObject({ dueDate: '2026-10-16', critical: true });
    await expect(deadlines.update('d-1', { status: 'done' })).rejects.toBeTruthy();
    await expect(deadlines.update('d-1', { kind: 'statutory' })).rejects.toBeTruthy();
  });
});

describe('across matters', () => {
  it('lists upcoming, mine and the review queue in the active org', async () => {
    const { fs, run } = setup();
    fs.set(`${M}/deadlines/d-1`, deadline('Mine'));
    fs.set(`${M}/deadlines/d-2`, deadline('Theirs', { assigneeUid: 'u-daniel', dueDate: '2026-10-08' }));
    fs.set(`${M}/deadlines/d-3`, deadline('Past', { pastOnCreation: true, dueDate: '2026-09-01' }));
    fs.set(`${M}/deadlines/d-4`, deadline('Done', { status: 'done' }));
    fs.set('orgs/org-b/matters/m-9/deadlines/d-9', deadline('Other org', { orgId: 'org-b' }));
    const group = run(() => deadlineGroupRepository());
    expect((await group.query(UPCOMING_DEADLINES_QUERY)).map((r) => r.title)).toEqual(['Past', 'Theirs', 'Mine']);
    expect((await group.query(myUpcomingDeadlinesQuery('u-jordan'))).map((r) => r.title)).toEqual(['Past', 'Mine']);
    expect((await group.query(REVIEW_QUEUE_QUERY)).map((r) => r.title)).toEqual(['Past']);
  });

  it('reads proposals for a matter and those waiting on me', async () => {
    const { fs, run } = setup();
    const proposal = {
      orgId: 'org-a',
      matterId: 'm-1',
      deadlineId: 'rule-x',
      ruleId: 'x',
      title: 'Fictional deadline',
      critical: true,
      kind: 'moved',
      cause: 'event',
      status: 'pending',
      fromDueDate: '2026-11-02',
      toDueDate: '2026-10-26',
      earlier: true,
      intoPast: false,
      assigneeUid: 'u-jordan',
      recomputeVersion: 2,
      ...meta,
    };
    fs.set(`${M}/deadlineChanges/rule-x-v2`, proposal);
    fs.set(`${M}/deadlineChanges/rule-y-v2`, { ...proposal, deadlineId: 'rule-y', status: 'accepted' });
    const pending = await run(() => matterDeadlineChangeRepository(() => 'm-1')).query(PENDING_CHANGES_QUERY);
    expect(pending.map((r) => r.id)).toEqual(['rule-x-v2']);
    const mine = await run(() => deadlineChangeGroupRepository()).query(myPendingChangesQuery('u-jordan'));
    expect(mine.map((r) => [r.id, r.toDueDate])).toEqual([['rule-x-v2', '2026-10-26']]);
  });

  // CORE-10b: without privileged.view, only deadlines and proposals on matters that aren't privileged.
  it.each([
    ['readonly', ['Open matter'], ['c-1']],
    ['paralegal', ['Open matter'], ['c-1']],
    // Every one, including one written before the copy (until the backfill gives it one).
    ['lawyer', ['Before the copy', 'Open matter', 'Privileged matter'], ['c-1', 'c-2']],
  ] as const)('across matters as %s, reads %j and proposals %j', async (role, titles, changeIds) => {
    const { fs, run } = setup(role);
    fs.set(`${M}/deadlines/d-1`, deadline('Open matter', { privileged: false }));
    fs.set(`${M}/deadlines/d-2`, deadline('Privileged matter', { privileged: true }));
    fs.set(`${M}/deadlines/d-3`, deadline('Before the copy'));
    const change = {
      orgId: 'org-a',
      matterId: 'm-1',
      deadlineId: 'd-1',
      ruleId: 'x',
      title: 'Fictional deadline',
      critical: false,
      kind: 'moved',
      cause: 'event',
      status: 'pending',
      fromDueDate: '2026-11-02',
      toDueDate: '2026-10-26',
      earlier: true,
      intoPast: false,
      assigneeUid: 'u-jordan',
      recomputeVersion: 2,
      ...meta,
    };
    fs.set(`${M}/deadlineChanges/c-1`, { ...change, privileged: false });
    fs.set(`${M}/deadlineChanges/c-2`, { ...change, privileged: true });
    const group = run(() => deadlineGroupRepository());
    const watched = run(() => group.watchQuery(UPCOMING_DEADLINES_QUERY));
    TestBed.tick();
    expect((await group.query(UPCOMING_DEADLINES_QUERY)).map((r) => r.title).sort()).toEqual(titles);
    expect(
      watched
        .value()
        .map((r) => r.title)
        .sort(),
    ).toEqual(titles);
    expect(await group.count(UPCOMING_DEADLINES_QUERY)).toBe(titles.length);
    const changes = run(() => deadlineChangeGroupRepository());
    expect((await changes.query(myPendingChangesQuery('u-jordan'))).map((r) => r.id).sort()).toEqual(changeIds);
  });

  it('reads a matter’s events by date', async () => {
    const { fs, run } = setup();
    fs.set(`${M}/events/e-2`, { kind: 'notice_published', date: '2026-09-01', meta: {}, ...meta });
    fs.set(`${M}/events/e-1`, { kind: 'date_of_death', date: '2026-07-14', meta: {}, ...meta });
    const rows = await run(() => matterEventRepository(() => 'm-1')).query(MATTER_EVENTS_QUERY);
    expect(rows.map((r) => r.kind)).toEqual(['date_of_death', 'notice_published']);
  });
});

describe('deadlineCallables', () => {
  it('calls each deadlines-* callable, idempotent ones with a request id', async () => {
    const calls: { name: string; data: unknown }[] = [];
    const client = new CallableClient(
      {
        call: async <T>(name: string, data: unknown) => {
          calls.push({ name, data });
          return {} as T;
        },
        refreshClaims: async () => undefined,
      },
      { newId: () => '00000000-0000-4000-8000-000000000001' },
    );
    const api = deadlineCallables(client);
    await api.upsertEvent({ matterId: 'm-1', kind: 'date_of_death', date: '2026-07-14' as never });
    await api.deleteEvent({ matterId: 'm-1', eventId: 'e-1' });
    await api.recompute({ matterId: 'm-1' });
    await api.resolveChange({ matterId: 'm-1', changeId: 'c-1', accept: true, confirmation: 'HV-2026-0001' });
    await api.override({ matterId: 'm-1', deadlineId: 'd-1', dueDate: null });
    await api.complete({ matterId: 'm-1', deadlineId: 'd-1', outcome: 'done' });
    await api.acknowledge({ matterId: 'm-1', deadlineId: 'd-1' });
    await api.proposeRulesetUpgrade({});
    expect(calls.map((c) => c.name)).toEqual([
      DEADLINE_CALLABLES.upsertEvent,
      DEADLINE_CALLABLES.deleteEvent,
      DEADLINE_CALLABLES.recompute,
      DEADLINE_CALLABLES.resolveChange,
      DEADLINE_CALLABLES.override,
      DEADLINE_CALLABLES.complete,
      DEADLINE_CALLABLES.acknowledge,
      DEADLINE_CALLABLES.proposeRulesetUpgrade,
    ]);
    expect(calls[2]?.data).toEqual({ matterId: 'm-1' });
    expect(calls[0]?.data).toMatchObject({ requestId: '00000000-0000-4000-8000-000000000001' });
  });
});
