import { TestBed } from '@angular/core/testing';

import { DEFAULT_MATTER_VIEWS, type DateOnly, type MatterViewSort } from '@materia/domain';

import {
  hasMatterFilters,
  isIndexedMatterQuery,
  MATTER_LIST_INDEXES,
  matterMatchesFilters,
  matterQueryPlan,
  mattersRepository,
  SAVED_MATTER_VIEWS_QUERY,
  savedViewsRepository,
  type MatterListItem,
} from './matters';
import { OrgContext } from './org-context';
import { InMemoryFirestore, provideInMemoryFirestore } from './testing/in-memory-firestore';

const RECENT: MatterViewSort = { field: 'lastActivity', dir: 'desc' };
const ME = { viewerUid: 'u-jordan', privilegedVisible: true };

function setup(seed: (fs: InMemoryFirestore) => void = () => undefined, role: 'lawyer' | 'readonly' = 'lawyer') {
  const fs = new InMemoryFirestore();
  seed(fs);
  TestBed.configureTestingModule({ providers: [provideInMemoryFirestore(fs)] });
  const context = TestBed.inject(OrgContext);
  context.setSession({ uid: 'u-jordan', orgId: 'org-a', role });
  return { fs, context };
}

const row = (overrides: Partial<MatterListItem> = {}): MatterListItem => ({
  number: 'M-2026-0007',
  title: 'Estate of Fictional Quill',
  type: 'probate',
  status: 'open',
  jurisdiction: 'VIC',
  responsibleUid: 'u-jordan',
  teamUids: [],
  clientContactIds: ['c-1'],
  privileged: false,
  priority: 'none',
  labels: [],
  search: ['es', 'est', 'qu', 'qui', 'quill', 'av', 'ave', 'avery'],
  openTaskCount: 0,
  wipCents: 0 as MatterListItem['wipCents'],
  ...overrides,
});

describe('matterQueryPlan', () => {
  it('pages every default view on the server, "My open matters" by status, responsible and activity', () => {
    const [mine, allOpen, leads, onHold, closed] = DEFAULT_MATTER_VIEWS.map((view) =>
      matterQueryPlan(view.filters, view.sort, ME),
    );
    expect(mine).toEqual({
      mode: 'paged',
      spec: {
        where: [
          ['status', '==', 'open'],
          ['responsibleUid', '==', 'u-jordan'],
        ],
        orderBy: [['lastActivityAt', 'desc']],
        pageSize: 50,
      },
      clientFilters: [],
      clientSort: false,
    });
    for (const plan of [allOpen, leads, onHold]) expect(plan?.mode).toBe('paged');
    // Recently closed filters closedAt here (a range on another field than the order).
    expect(closed).toMatchObject({
      mode: 'capped',
      spec: { where: [['status', '==', 'closed']], orderBy: [['lastActivityAt', 'desc']], pageSize: 500 },
      clientFilters: ['closedWithinDays'],
    });
    expect(closed?.notice).toContain('500');
  });

  it('serves each indexed combination in one query', () => {
    const paged = (filters: Parameters<typeof matterQueryPlan>[0], sort = RECENT) =>
      matterQueryPlan(filters, sort, ME).mode;
    expect(paged({})).toBe('paged');
    expect(paged({}, { field: 'title', dir: 'asc' })).toBe('paged');
    expect(paged({ status: ['open', 'lead'] })).toBe('paged');
    expect(paged({ status: ['open'], type: ['will'] })).toBe('paged');
    expect(paged({ responsible: 'u-priya' })).toBe('paged');
    expect(paged({ status: ['open'] }, { field: 'number', dir: 'asc' })).toBe('paged');
    expect(paged({ status: ['open'] }, { field: 'title', dir: 'desc' })).toBe('paged');
    expect(paged({ label: 'urgent-review' })).toBe('paged');
    expect(paged({ jurisdiction: 'VIC', status: ['open'] })).toBe('paged');
    expect(matterQueryPlan({ label: 'x' }, RECENT, ME).spec.where).toEqual([['labels', 'array-contains', 'x']]);
    expect(matterQueryPlan({ status: ['open'], type: ['will', 'poa'] }, RECENT, ME).spec.where).toEqual([
      ['status', '==', 'open'],
      ['type', 'in', ['will', 'poa']],
    ]);
    // Type alone has no index: all matters, most recent first, filtered here.
    expect(matterQueryPlan({ type: ['will'] }, RECENT, ME)).toMatchObject({ mode: 'capped', clientFilters: ['type'] });
  });

  it('falls back to the largest indexed subset, 500 rows and a notice for other combinations', () => {
    const plan = matterQueryPlan({ status: ['open'], type: ['will'], label: 'x', jurisdiction: 'VIC' }, RECENT, ME);
    expect(plan.mode).toBe('capped');
    expect(plan.spec.pageSize).toBe(500);
    expect(plan.spec.orderBy).toEqual([['lastActivityAt', 'desc']]);
    expect(plan.spec.where).toHaveLength(2);
    expect(plan.clientFilters).toHaveLength(2);
    expect(plan.notice).toBeTruthy();

    // An unindexed sort direction, a client-only sort, and overdue are all here too.
    expect(matterQueryPlan({ label: 'x' }, { field: 'number', dir: 'asc' }, ME)).toMatchObject({
      mode: 'capped',
      spec: { where: [['labels', 'array-contains', 'x']] },
      clientSort: true,
    });
    expect(matterQueryPlan({ status: ['open'] }, { field: 'wip', dir: 'desc' }, ME)).toMatchObject({
      mode: 'capped',
      spec: { where: [['status', '==', 'open']] },
      clientFilters: [],
      clientSort: true,
    });
    expect(matterQueryPlan({ hasOverdue: true, responsible: 'me' }, RECENT, ME)).toMatchObject({
      mode: 'capped',
      spec: { where: [['responsibleUid', '==', 'u-jordan']] },
      clientFilters: ['hasOverdue'],
    });
    // A second list filter can't be an `in` as well.
    expect(matterQueryPlan({ status: ['open', 'lead'], type: ['will', 'poa'] }, RECENT, ME)).toMatchObject({
      mode: 'capped',
      spec: { where: [['status', 'in', ['open', 'lead']]] },
      clientFilters: ['type'],
    });
  });

  it('searches by the first word token without an order, and the rest here', () => {
    expect(matterQueryPlan({ query: "Quill's estate", status: ['open'] }, RECENT, ME)).toEqual({
      mode: 'capped',
      spec: { where: [['search', 'array-contains', 'quills']], pageSize: 500 },
      clientFilters: ['status', 'query'],
      clientSort: true,
      notice: expect.stringContaining('500'),
    });
  });

  it('adds privileged == false for roles that cannot see privileged matters', () => {
    const plan = matterQueryPlan({ status: ['open'] }, RECENT, { viewerUid: 'u', privilegedVisible: false });
    expect(plan.spec.where).toEqual([
      ['privileged', '==', false],
      ['status', '==', 'open'],
    ]);
  });

  it('knows its index list', () => {
    expect(MATTER_LIST_INDEXES).toHaveLength(8);
    expect(isIndexedMatterQuery([], 'number', 'asc')).toBe(true);
    expect(isIndexedMatterQuery(['responsibleUid', 'status'], 'lastActivityAt', 'desc')).toBe(true);
    expect(isIndexedMatterQuery(['type'], 'lastActivityAt', 'desc')).toBe(false);
  });
});

describe('matterMatchesFilters', () => {
  const context = { viewerUid: 'u-jordan', today: '2026-10-04' as DateOnly, now: new Date('2026-10-04T00:00:00Z') };

  it('applies every filter to a loaded row', () => {
    const due = (dueDate: string) => ({ id: 'd', dueDate: dueDate as DateOnly, title: 'Notice', critical: false });
    expect(matterMatchesFilters(row(), { status: ['open'], responsible: 'me', type: ['probate'] }, context)).toBe(true);
    expect(matterMatchesFilters(row(), { responsible: 'u-priya' }, context)).toBe(false);
    expect(matterMatchesFilters(row(), { status: ['lead'] }, context)).toBe(false);
    expect(matterMatchesFilters(row(), { type: ['will'] }, context)).toBe(false);
    expect(matterMatchesFilters(row({ labels: ['x'] }), { label: 'x' }, context)).toBe(true);
    expect(matterMatchesFilters(row(), { label: 'x' }, context)).toBe(false);
    expect(matterMatchesFilters(row(), { jurisdiction: 'NSW' }, context)).toBe(false);
    expect(matterMatchesFilters(row({ nextDeadline: due('2026-10-03') }), { hasOverdue: true }, context)).toBe(true);
    expect(matterMatchesFilters(row({ nextDeadline: due('2026-10-04') }), { hasOverdue: true }, context)).toBe(false);
    expect(matterMatchesFilters(row(), { hasOverdue: true }, context)).toBe(false);
    const closedAt = new Date('2026-09-01T00:00:00Z');
    expect(matterMatchesFilters(row({ closedAt }), { closedWithinDays: 90 }, context)).toBe(true);
    expect(matterMatchesFilters(row({ closedAt }), { closedWithinDays: 7 }, context)).toBe(false);
    expect(matterMatchesFilters(row(), { query: 'avery quill' }, context)).toBe(true);
    expect(matterMatchesFilters(row(), { query: '0007' }, context)).toBe(true);
    expect(matterMatchesFilters(row(), { query: 'avery zed' }, context)).toBe(false);
    expect(matterMatchesFilters(row({ deletedAt: new Date() }), {}, context)).toBe(false);
  });

  it('says whether anything is filtered', () => {
    expect(hasMatterFilters({})).toBe(false);
    expect(hasMatterFilters({ status: [], query: '  ' })).toBe(false);
    expect(hasMatterFilters({ hasOverdue: true })).toBe(true);
  });
});

describe('mattersRepository', () => {
  it('runs a planned query, hides soft-deleted matters and drops other fields', () => {
    const { fs } = setup((f) => {
      const stored = (id: string, data: Partial<MatterListItem> & Record<string, unknown>) =>
        f.set(`orgs/org-a/matters/${id}`, {
          ...row(),
          lastActivityAt: new Date(`2026-10-0${id.slice(-1)}T00:00:00Z`),
          fee: { arrangement: 'hourly', history: [] },
          ...data,
        });
      stored('m1', {});
      stored('m2', { status: 'lead' });
      stored('m3', { deletedAt: new Date() });
      stored('m4', { title: 'Most recent' });
    });
    const plan = matterQueryPlan({ status: ['open'] }, RECENT, ME);
    const list = TestBed.runInInjectionContext(() => mattersRepository().watchQuery(plan.spec));
    TestBed.tick();
    expect(list.value().map((m) => m.id)).toEqual(['m4', 'm1']);
    expect(list.value()[0]).not.toHaveProperty('fee');
    expect(fs.listenerCount).toBe(1);
  });

  it('writes whitelisted fields only', async () => {
    const { fs } = setup((f) => f.set('orgs/org-a/matters/m1', { ...row() }));
    const matters = TestBed.runInInjectionContext(() => mattersRepository());
    await matters.update('m1', { responsibleUid: 'u-priya', labels: ['x'] });
    expect(fs.get('orgs/org-a/matters/m1')).toMatchObject({ responsibleUid: 'u-priya', labels: ['x'] });
    await expect(matters.update('m1', { status: 'closed' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

describe('savedViewsRepository', () => {
  it('creates, renames, lists by org and deletes the person’s own views', async () => {
    const { fs } = setup((f) =>
      f.set('users/u-jordan/views/v-other-org', {
        orgId: 'org-b',
        list: 'matters',
        name: 'Elsewhere',
        filters: {},
        sort: RECENT,
        groupBy: 'none',
        createdAt: new Date(),
        createdBy: 'u-jordan',
        updatedAt: new Date(),
        updatedBy: 'u-jordan',
        schemaVersion: 1,
      }),
    );
    const views = TestBed.runInInjectionContext(() => savedViewsRepository());
    const id = await views.create({
      orgId: 'org-a',
      list: 'matters',
      name: 'Overdue probate',
      filters: { type: ['probate'], hasOverdue: true },
      sort: RECENT,
      groupBy: 'status',
    });
    expect(fs.writes[0]).toMatchObject({ op: 'create', path: `users/u-jordan/views/${id}` });
    await views.update(id, { name: 'Probate, overdue' });
    const list = TestBed.runInInjectionContext(() => views.watchQuery(SAVED_MATTER_VIEWS_QUERY('org-a')));
    TestBed.tick();
    expect(list.value().map((v) => v.name)).toEqual(['Probate, overdue']);
    await views.hardDelete(id);
    expect(list.value()).toEqual([]);
    await expect(views.create({ orgId: 'org-a', list: 'matters', name: '' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });
});
