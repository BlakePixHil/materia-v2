import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { dateOnly, todayWindow } from '@materia/domain';

import { deadlineChangeGroupRepository, deadlineGroupRepository } from './deadlines';
import { OrgContext } from './org-context';
import type { CollectionDriver, RawDoc, RawPage } from './query';
import { PagedQuery, type EngineContext } from './resources';
import { taskGroupRepository } from './tasks';
import { InMemoryFirestore, provideInMemoryFirestore } from './testing/in-memory-firestore';
import {
  ACTIVE_MEMBERS_QUERY,
  matterCountQuery,
  memberCountRepository,
  myDeadlinesThisWeekQuery,
  myNextTasksQuery,
  myOpenTaskCountQuery,
  myOverdueDeadlinesQuery,
  myTasksThisWeekQuery,
  myTodayChangesQuery,
  orgTimeZoneRepository,
  recentEntriesQuery,
  recentMattersQuery,
  recentMattersRepository,
  recordRecent,
  recordRecentMatter,
  todayMatterRepository,
} from './today';

/** The Today screen's reads and recent matters (CORE-14). Today is Monday 5 October 2026. Fictional data. */

const TODAY = dateOnly('2026-10-05');
const WINDOW = todayWindow(TODAY);
const ME = 'u-jordan';
const meta = {
  createdAt: new Date('2026-10-01T00:00:00Z'),
  createdBy: ME,
  updatedAt: new Date('2026-10-01T00:00:00Z'),
  updatedBy: ME,
  schemaVersion: 1,
};
const M = 'orgs/org-a/matters/m-1';

function deadline(dueDate: string, extra: Record<string, unknown> = {}) {
  return {
    orgId: 'org-a',
    matterId: 'm-1',
    title: `Fictional deadline ${dueDate}`,
    dueDate,
    kind: 'internal',
    critical: false,
    status: 'upcoming',
    assigneeUid: ME,
    reminders: [],
    ...meta,
    ...extra,
  };
}

function task(dueDate: string | undefined, extra: Record<string, unknown> = {}) {
  return {
    orgId: 'org-a',
    matterId: 'm-1',
    title: `Fictional task ${dueDate ?? 'undated'}`,
    status: 'todo',
    priority: 'none',
    assigneeUid: ME,
    ...(dueDate ? { dueDate } : {}),
    order: 1,
    checklist: [],
    source: 'manual',
    ...meta,
    ...extra,
  };
}

function setup() {
  const fs = new InMemoryFirestore();
  TestBed.configureTestingModule({ providers: [provideInMemoryFirestore(fs)] });
  TestBed.inject(OrgContext).setSession({ uid: ME, orgId: 'org-a', role: 'lawyer' });
  const run = <T>(fn: () => T) => TestBed.runInInjectionContext(fn);
  return { fs, run };
}

describe('today queries', () => {
  it('reads my overdue deadlines and this week’s, nobody else’s', async () => {
    const { fs, run } = setup();
    fs.set(`${M}/deadlines/late`, deadline('2026-10-01'));
    fs.set(`${M}/deadlines/today`, deadline('2026-10-05'));
    fs.set(`${M}/deadlines/sun`, deadline('2026-10-11'));
    fs.set(`${M}/deadlines/next`, deadline('2026-10-12'));
    fs.set(`${M}/deadlines/theirs`, deadline('2026-10-01', { assigneeUid: 'u-priya' }));
    fs.set(`${M}/deadlines/done`, deadline('2026-10-06', { status: 'done' }));
    fs.set(`orgs/org-b/matters/m-9/deadlines/other-org`, deadline('2026-10-01', { orgId: 'org-b' }));
    const repo = run(() => deadlineGroupRepository());
    expect((await repo.query(myOverdueDeadlinesQuery(ME, TODAY))).map((r) => r.id)).toEqual(['late']);
    expect((await repo.query(myDeadlinesThisWeekQuery(ME, WINDOW))).map((r) => r.id)).toEqual(['today', 'sun']);
    expect(await repo.count(myDeadlinesThisWeekQuery(ME, WINDOW))).toBe(2);
    expect(myOverdueDeadlinesQuery(ME, TODAY).pageSize).toBe(50);
  });

  it('reads my open tasks this week, and my next dated tasks soonest first', async () => {
    const { fs, run } = setup();
    fs.set(`${M}/tasks/late`, task('2026-10-02'));
    fs.set(`${M}/tasks/wed`, task('2026-10-07', { status: 'in_progress' }));
    fs.set(`${M}/tasks/done`, task('2026-10-07', { status: 'done' }));
    fs.set(`${M}/tasks/next-week`, task('2026-10-14'));
    fs.set(`${M}/tasks/undated`, task(undefined));
    fs.set(`orgs/org-a/members/${ME}/tasks/mine`, task('2026-10-05', { matterId: null }));
    const repo = run(() => taskGroupRepository());
    expect((await repo.query(myTasksThisWeekQuery(ME, WINDOW))).map((r) => r.id)).toEqual(['mine', 'wed']);
    expect((await repo.query(myNextTasksQuery(ME, 3))).map((r) => r.id)).toEqual(['late', 'mine', 'wed']);
    expect(await repo.count(myOpenTaskCountQuery(ME))).toBe(5);
  });

  it('reads the proposals waiting on me', async () => {
    const { fs, run } = setup();
    const change = (status: string, assigneeUid = ME) => ({
      orgId: 'org-a',
      matterId: 'm-1',
      deadlineId: 'rule-x',
      ruleId: 'x',
      title: 'Fictional filing',
      critical: false,
      kind: 'moved',
      cause: 'event',
      status,
      fromDueDate: '2026-10-09',
      toDueDate: '2026-10-16',
      earlier: false,
      intoPast: false,
      assigneeUid,
      recomputeVersion: 2,
      ...meta,
    });
    fs.set(`${M}/deadlineChanges/c-1`, change('pending'));
    fs.set(`${M}/deadlineChanges/c-2`, change('accepted'));
    fs.set(`${M}/deadlineChanges/c-3`, change('pending', 'u-priya'));
    const rows = await run(() => deadlineChangeGroupRepository()).query(myTodayChangesQuery(ME));
    expect(rows.map((r) => r.id)).toEqual(['c-1']);
  });

  it('counts live matters, mine, and active members; reads a matter and the org’s time zone', async () => {
    const { fs, run } = setup();
    const matter = (status: string, extra: Record<string, unknown> = {}) => ({
      number: 'M-2026-0001',
      title: 'Estate of Fictional Person',
      type: 'probate',
      status,
      responsibleUid: ME,
      privileged: false,
      deletedAt: null,
      ...meta,
      ...extra,
    });
    fs.set(M, matter('open'));
    fs.set('orgs/org-a/matters/m-2', matter('open', { privileged: true }));
    fs.set('orgs/org-a/matters/m-3', matter('closed'));
    fs.set('orgs/org-a/matters/m-4', matter('open', { responsibleUid: 'u-priya' }));
    fs.set('orgs/org-a/matters/m-5', matter('open', { deletedAt: new Date() }));
    const matters = run(() => todayMatterRepository());
    expect(await matters.count(matterCountQuery({ privilegedVisible: true, responsibleUid: ME, status: 'open' }))).toBe(
      2,
    );
    expect(
      await matters.count(matterCountQuery({ privilegedVisible: false, responsibleUid: ME, status: 'open' })),
    ).toBe(1);
    expect(await matters.count(matterCountQuery({ privilegedVisible: true }))).toBe(4);
    expect(await matters.get('m-1')).toMatchObject({ number: 'M-2026-0001', type: 'probate', status: 'open' });

    fs.set(`orgs/org-a/members/${ME}`, { status: 'active', ...meta });
    fs.set('orgs/org-a/members/u-gone', { status: 'removed', ...meta });
    expect(await run(() => memberCountRepository()).count(ACTIVE_MEMBERS_QUERY)).toBe(1);

    fs.set('orgs/org-a', { name: 'Fictional Legal', timezone: 'Australia/Perth', ...meta });
    expect((await run(() => orgTimeZoneRepository()).get('org-a'))?.timezone).toBe('Australia/Perth');
    fs.set('orgs/org-b', { name: 'Fictional Two', ...meta });
    expect((await run(() => orgTimeZoneRepository()).get('org-b'))?.timezone).toBe('Australia/Melbourne');
  });

  it('refuses a matter the rules refuse', async () => {
    const { fs, run } = setup();
    fs.denyRead(M);
    await expect(run(() => todayMatterRepository()).get('m-1')).rejects.toMatchObject({ code: 'ACCESS_REVOKED' });
  });
});

describe('recent matters', () => {
  it('records an open as the whole entry, once per org and matter, and lists the latest', async () => {
    const { fs, run } = setup();
    const recents = run(() => recentMattersRepository());
    const now = new Date('2026-10-05T01:00:00Z');
    expect(await recordRecentMatter(recents, 'org-a', 'm-1', now)).toBe('org-a_m-1');
    await recordRecentMatter(recents, 'org-a', 'm-1', now);
    await recordRecentMatter(recents, 'org-a', 'm-2', now);
    const stored = fs.get(`users/${ME}/recent/org-a_m-1`);
    expect(stored).toMatchObject({ orgId: 'org-a', matterId: 'm-1', createdBy: ME, updatedBy: ME, schemaVersion: 1 });
    expect((stored?.['expireAt'] as Date).toISOString()).toBe('2027-01-03T01:00:00.000Z');
    expect(fs.writes.filter((w) => w.path === `users/${ME}/recent/org-a_m-1`)).toHaveLength(2);

    fs.set(`users/${ME}/recent/org-b_m-9`, { ...fs.get(`users/${ME}/recent/org-a_m-2`), orgId: 'org-b' });
    const openedAt = (matterId: string, at: string) =>
      fs.set(`users/${ME}/recent/org-a_${matterId}`, {
        ...fs.get(`users/${ME}/recent/org-a_${matterId}`),
        updatedAt: new Date(at),
      });
    openedAt('m-1', '2026-10-05T00:00:00Z');
    openedAt('m-2', '2026-10-06T00:00:00Z');
    const rows = await recents.query(recentMattersQuery('org-a'));
    expect(rows.map((r) => r.matterId)).toEqual(['m-2', 'm-1']);
    expect(recentMattersQuery('org-a').pageSize).toBe(8);
  });

  it('records contacts, tasks and documents too; Today lists matters, the palette everything (CORE-15)', async () => {
    const { fs, run } = setup();
    const recents = run(() => recentMattersRepository());
    const now = new Date('2026-10-05T01:00:00Z');
    await recordRecentMatter(recents, 'org-a', 'm-1', now);
    expect(await recordRecent(recents, 'org-a', { kind: 'contact', entityId: 'c-1' }, now)).toBe('org-a_contact_c-1');
    expect(await recordRecent(recents, 'org-a', { kind: 'task', matterId: 'm-1', entityId: 't-1' }, now)).toBe(
      'org-a_task_m-1_t-1',
    );
    expect(await recordRecent(recents, 'org-a', { kind: 'document', matterId: 'm-1', entityId: 'd-1' }, now)).toBe(
      'org-a_document_m-1_d-1',
    );
    expect(fs.get(`users/${ME}/recent/org-a_contact_c-1`)).toMatchObject({ kind: 'contact', entityId: 'c-1' });
    expect(fs.get(`users/${ME}/recent/org-a_contact_c-1`)).not.toHaveProperty('matterId');
    expect(fs.get(`users/${ME}/recent/org-a_m-1`)).not.toHaveProperty('entityId');
    expect((await recents.query(recentMattersQuery('org-a'))).map((r) => r.id)).toEqual(['org-a_m-1']);
    expect(await recents.query(recentEntriesQuery('org-a'))).toHaveLength(4);
    expect(recentEntriesQuery('org-a').pageSize).toBe(10);
  });

  it('refuses an entry the schema refuses', async () => {
    const { run } = setup();
    const recents = run(() => recentMattersRepository());
    await expect(recents.create({ orgId: 'org-a', matterId: 'a/b', expireAt: new Date() })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });
});

describe('cache-first one-shot reads', () => {
  function raw(id: string, fromCache: boolean): RawPage {
    const doc: RawDoc = { id, cursor: id, snapshot: { id, data: () => ({ title: id }) } as never };
    return { docs: [doc], fromCache };
  }

  function engine(driver: Partial<CollectionDriver>): EngineContext<{ title: string }> {
    return {
      driver: driver as CollectionDriver,
      convert: (doc) => ({ id: doc.id, title: doc.id }),
      online: signal(true),
      track: () => () => undefined,
      label: 'test',
    };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('shows the cached rows until the server answers', async () => {
    let answer: (page: RawPage) => void = () => undefined;
    const fetch = vi.fn(() => new Promise<RawPage>((resolve) => (answer = resolve)));
    const fetchCached = vi.fn(async () => raw('cached', true));
    const query = new PagedQuery(engine({ fetch, fetchCached }), { pageSize: 5 }, false, true);
    query.start();
    await settle();
    expect(query.value().map((r) => r.id)).toEqual(['cached']);
    expect(query.fromCache()).toBe(true);
    expect(query.status()).toBe('ready');
    answer(raw('server', false));
    await settle();
    expect(query.value().map((r) => r.id)).toEqual(['server']);
    expect(query.fromCache()).toBe(false);
  });

  it('ignores the cache once the server has answered, and an empty or failing cache', async () => {
    let cached: (page: RawPage) => void = () => undefined;
    const late = new PagedQuery(
      engine({
        fetch: async () => raw('server', false),
        fetchCached: () => new Promise<RawPage>((resolve) => (cached = resolve)),
      }),
      {},
      false,
      true,
    );
    late.start();
    await settle();
    cached(raw('stale', true));
    await settle();
    expect(late.value().map((r) => r.id)).toEqual(['server']);

    const empty = new PagedQuery(
      engine({
        fetch: () => new Promise<RawPage>(() => undefined),
        fetchCached: async () => ({ docs: [], fromCache: true }),
      }),
      {},
      false,
      true,
    );
    empty.start();
    await settle();
    expect(empty.status()).toBe('loading');

    const failing = new PagedQuery(
      engine({
        fetch: async () => raw('server', false),
        fetchCached: async () => Promise.reject(new Error('no cache')),
      }),
      {},
      false,
      true,
    );
    failing.start();
    await settle();
    expect(failing.value().map((r) => r.id)).toEqual(['server']);
  });

  it('waits for the server without cacheFirst, and reports a failed read', async () => {
    const fetchCached = vi.fn(async () => raw('cached', true));
    const plain = new PagedQuery(engine({ fetch: async () => raw('server', false), fetchCached }), {}, false);
    plain.start();
    await settle();
    expect(fetchCached).not.toHaveBeenCalled();
    expect(plain.value().map((r) => r.id)).toEqual(['server']);

    const broken = new PagedQuery(
      engine({ fetch: async () => Promise.reject({ code: 'unavailable' }), fetchCached }),
      {},
      false,
      true,
    );
    broken.start();
    await settle();
    expect(broken.error()?.code).toBe('UNAVAILABLE');
  });
});
