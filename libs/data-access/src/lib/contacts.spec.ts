import { TestBed } from '@angular/core/testing';

import {
  contactListQuery,
  contactMatchesFilters,
  contactPartiesQuery,
  contactPartiesRepository,
  contactsRepository,
  matterSummariesRepository,
  referredMattersQuery,
  referredMattersRepository,
  type ContactListItem,
} from './contacts';
import { OrgContext } from './org-context';
import { InMemoryFirestore, provideInMemoryFirestore } from './testing/in-memory-firestore';

function setup(seed: (fs: InMemoryFirestore) => void = () => undefined) {
  const fs = new InMemoryFirestore();
  seed(fs);
  TestBed.configureTestingModule({ providers: [provideInMemoryFirestore(fs)] });
  const context = TestBed.inject(OrgContext);
  context.setSession({ uid: 'u-lawyer', orgId: 'org-a', role: 'lawyer' });
  return { fs, context };
}

const person = (overrides: Partial<ContactListItem> = {}): ContactListItem => ({
  kind: 'person',
  givenNames: 'Avery',
  familyName: 'Quill',
  emails: [],
  phones: [],
  addresses: [],
  tags: [],
  isReferrer: false,
  ...overrides,
});

describe('contactListQuery', () => {
  it('orders by sortName and carries one Firestore filter: search, then kind, referrer, tag', () => {
    expect(contactListQuery()).toEqual({ orderBy: [['sortName', 'asc']], pageSize: 50 });
    expect(contactListQuery({ query: "  O'Brien ", kind: 'person', tag: 'vip' }).where).toEqual([
      ['search', 'array-contains', 'obrien'],
    ]);
    expect(contactListQuery({ query: 'a', kind: 'organisation' }).where).toEqual([['kind', '==', 'organisation']]);
    expect(contactListQuery({ referrersOnly: true, tag: 'vip' }).where).toEqual([['isReferrer', '==', true]]);
    expect(contactListQuery({ tag: 'vip' }, 10)).toEqual({
      where: [['tags', 'array-contains', 'vip']],
      orderBy: [['sortName', 'asc']],
      pageSize: 10,
    });
  });
});

describe('contactMatchesFilters', () => {
  it('applies the filters the query could not carry, and every search word', () => {
    const avery = person({
      tags: ['vip'],
      isReferrer: true,
      emails: [{ type: 'work', address: 'avery@example.test' }],
    });
    expect(
      contactMatchesFilters(avery, { query: 'avery quill', kind: 'person', tag: 'vip', referrersOnly: true }),
    ).toBe(true);
    expect(contactMatchesFilters(avery, { query: 'avery zed' })).toBe(false);
    expect(contactMatchesFilters(avery, { kind: 'organisation' })).toBe(false);
    expect(contactMatchesFilters(avery, { tag: 'other' })).toBe(false);
    expect(contactMatchesFilters(person(), { referrersOnly: true })).toBe(false);
    expect(contactMatchesFilters(avery, { query: 'a' })).toBe(true);
  });

  it('filters referrers by industry (CORE-18)', () => {
    const planner = person({ isReferrer: true, referrerMeta: { industry: 'financial_planner' } });
    expect(contactListQuery({ industry: 'financial_planner' }).where).toEqual([['isReferrer', '==', true]]);
    expect(contactMatchesFilters(planner, { industry: 'financial_planner' })).toBe(true);
    expect(contactMatchesFilters(planner, { industry: 'accountant' })).toBe(false);
    expect(
      contactMatchesFilters(person({ referrerMeta: { industry: 'accountant' } }), { industry: 'accountant' }),
    ).toBe(false);
  });

  it('hides tombstones and soft-deleted contacts', () => {
    expect(contactMatchesFilters(person({ mergedInto: 'c-2' }))).toBe(false);
    expect(contactMatchesFilters(person({ deletedAt: new Date() }))).toBe(false);
  });
});

describe('contactsRepository', () => {
  it('lists by sortName, drops server-only fields, and searches by token', () => {
    setup((fs) => {
      fs.set('orgs/org-a/contacts/c1', {
        ...person({ givenNames: 'Zara', familyName: 'Moss', sortName: 'zara moss' }),
        search: ['za', 'zar', 'mo', 'mos', 'moss'],
        dedupeKey: 'person:moss zara|',
      });
      fs.set('orgs/org-a/contacts/c2', {
        ...person({ sortName: 'avery quill' }),
        search: ['av', 'ave'],
        dedupeKey: 'x',
      });
      fs.set('orgs/org-b/contacts/c3', { ...person({ sortName: 'aaron other' }), search: [], dedupeKey: 'x' });
    });
    const all = TestBed.runInInjectionContext(() => contactsRepository().watchQuery(contactListQuery()));
    const found = TestBed.runInInjectionContext(() =>
      contactsRepository().watchQuery(contactListQuery({ query: 'Mos' })),
    );
    TestBed.tick();
    expect(all.value().map((c) => c.id)).toEqual(['c2', 'c1']);
    expect(all.value()[0]).not.toHaveProperty('search');
    expect(found.value().map((c) => c.id)).toEqual(['c1']);
  });

  it('updates whitelisted fields and removes cleared ones, never server-owned fields', async () => {
    const { fs } = setup((f) =>
      f.set('orgs/org-a/contacts/c1', { ...person({ sortName: 'avery quill' }), dateOfDeath: '2026-09-01' }),
    );
    const contacts = TestBed.runInInjectionContext(() => contactsRepository());
    await contacts.update('c1', { familyName: 'Quillon' }, { remove: ['dateOfDeath'] });
    expect(fs.writes.at(-1)).toMatchObject({ op: 'update', data: { familyName: 'Quillon' }, removed: ['dateOfDeath'] });
    expect(fs.get('orgs/org-a/contacts/c1')).not.toHaveProperty('dateOfDeath');
    await expect(contacts.update('c1', { sortName: 'x' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(contacts.update('c1', {}, { remove: ['search'] })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(contacts.update('c1', { mergedInto: 'c2' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

describe('contactPartiesRepository (collection group)', () => {
  const partyAt = (
    fs: InMemoryFirestore,
    org: string,
    matter: string,
    id: string,
    contactId: string,
    role = 'executor',
  ) => fs.set(`orgs/${org}/matters/${matter}/parties/${id}`, { contactId, role, orgId: org, matterId: matter });

  it('reads parties across every matter of the active org only, live', () => {
    const { fs } = setup((f) => {
      partyAt(f, 'org-a', 'm1', 'p1', 'c1', 'executor');
      partyAt(f, 'org-a', 'm2', 'p2', 'c1', 'beneficiary');
      partyAt(f, 'org-a', 'm2', 'p3', 'c2');
      partyAt(f, 'org-b', 'm9', 'p9', 'c1');
    });
    const parties = TestBed.runInInjectionContext(() =>
      contactPartiesRepository().watchQuery(contactPartiesQuery('c1')),
    );
    TestBed.tick();
    expect(parties.value().map((p) => [p.matterId, p.role])).toEqual([
      ['m1', 'executor'],
      ['m2', 'beneficiary'],
    ]);
    partyAt(fs, 'org-a', 'm3', 'p4', 'c1', 'client');
    fs.set('orgs/org-a/matters/m1/parties/p1', {
      contactId: 'c1',
      role: 'executor',
      orgId: 'org-a',
      matterId: 'm1',
      deletedAt: new Date(),
    });
    expect(parties.value().map((p) => p.matterId)).toEqual(['m2', 'm3']);
  });

  it('queries and counts once, scoped to the org', async () => {
    setup((f) => {
      partyAt(f, 'org-a', 'm1', 'p1', 'c1');
      partyAt(f, 'org-b', 'm9', 'p9', 'c1');
    });
    const parties = TestBed.runInInjectionContext(() => contactPartiesRepository());
    expect((await parties.query(contactPartiesQuery('c1'))).map((p) => p.id)).toEqual(['p1']);
    expect(await parties.count(contactPartiesQuery('c1'))).toBe(1);
  });

  it('pages with cursors across collections, ordered by full path on ties', async () => {
    setup((f) => {
      for (let i = 1; i <= 5; i++) partyAt(f, 'org-a', `m${i}`, 'p', 'c1');
    });
    const parties = TestBed.runInInjectionContext(() =>
      contactPartiesRepository().watchQuery({ ...contactPartiesQuery('c1'), pageSize: 2 }),
    );
    TestBed.tick();
    expect(parties.value().map((p) => p.matterId)).toEqual(['m1', 'm2']);
    await parties.loadMore();
    await parties.loadMore();
    expect(parties.value().map((p) => p.matterId)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
  });

  it('is read-only in the in-memory driver', async () => {
    const fs = new InMemoryFirestore();
    const group = fs.driver('parties', { group: true });
    await expect(group.create({}, { uid: 'u', schemaVersion: 1 })).rejects.toThrow('read-only');
    await expect(group.getDoc('p1')).rejects.toThrow('read-only');
    expect(() =>
      group.watchDoc(
        'p1',
        () => undefined,
        () => undefined,
      ),
    ).toThrow();
  });
});

describe('matterSummariesRepository', () => {
  it('reads a matter for its number and title', async () => {
    setup((f) =>
      f.set('orgs/org-a/matters/m1', {
        number: 'WE-0001',
        title: 'Estate of Fictional Person',
        type: 'probate',
        status: 'open',
        fee: {},
      }),
    );
    const matters = TestBed.runInInjectionContext(() => matterSummariesRepository());
    expect(await matters.get('m1')).toEqual({
      id: 'm1',
      number: 'WE-0001',
      title: 'Estate of Fictional Person',
      type: 'probate',
      status: 'open',
    });
  });
});

describe('referredMattersRepository (CORE-18)', () => {
  const matter = (extra: Record<string, unknown>) => ({
    number: 'WE-0001',
    title: 'Will of Fictional Person',
    type: 'will',
    status: 'open',
    privileged: false,
    referrerContactId: 'c-ref',
    deletedAt: null,
    fee: {},
    ...extra,
  });

  it('asks for the live matters a contact referred, and only unprivileged ones without privileged.view', () => {
    expect(referredMattersQuery('c-ref', true).where).toEqual([
      ['referrerContactId', '==', 'c-ref'],
      ['deletedAt', '==', null],
    ]);
    expect(referredMattersQuery('c-ref', false).where).toEqual([
      ['referrerContactId', '==', 'c-ref'],
      ['deletedAt', '==', null],
      ['privileged', '==', false],
    ]);
  });

  it('reads them with their type, status, created date and budget', async () => {
    setup((f) => {
      f.set(
        'orgs/org-a/matters/m1',
        matter({
          createdAt: new Date('2026-05-01T00:00:00Z'),
          budget: { recordedCents: 52800, billedCents: 44000, timeCents: 52800 },
        }),
      );
      f.set('orgs/org-a/matters/m2', matter({ referrerContactId: 'c-other' }));
      f.set('orgs/org-a/matters/m3', matter({ deletedAt: new Date() }));
      f.set('orgs/org-a/matters/m4', matter({ privileged: true }));
    });
    const repo = TestBed.runInInjectionContext(() => referredMattersRepository());
    const rows = await repo.query(referredMattersQuery('c-ref', false));
    expect(rows.map((row) => row.id)).toEqual(['m1']);
    expect(rows[0]).toMatchObject({
      type: 'will',
      status: 'open',
      createdAt: new Date('2026-05-01T00:00:00Z'),
      budget: { billedCents: 44000 },
    });
  });
});
