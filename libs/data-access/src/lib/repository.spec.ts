import { Component, Injector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import * as z from 'zod';

import { DomainError } from '@materia/domain';

import { Connectivity } from './connectivity';
import { ListenerRegistry } from './listener-registry';
import { MEMBER_LIST_QUERY, membersRepository } from './members';
import { OrgContext } from './org-context';
import { repo, type Repository } from './repository';
import { InMemoryFirestore, provideInMemoryFirestore } from './testing/in-memory-firestore';
import { ACCESS_REVOKED_HANDLER, DATA_CLOCK } from './tokens';

const Note = {
  schema: z.object({
    title: z.string().min(1),
    rank: z.number(),
    createdAt: z.date().optional(),
    createdBy: z.string().optional(),
    updatedAt: z.date().optional(),
    updatedBy: z.string().optional(),
    schemaVersion: z.number().optional(),
    deletedAt: z.date().optional(),
    deletedBy: z.string().optional(),
  }),
  version: 1,
  create: z.object({ title: z.string().min(1), rank: z.number() }).strict(),
  update: z
    .object({ title: z.string().min(1) })
    .partial()
    .strict(),
};
type Note = z.infer<typeof Note.schema>;

let now = 1_000;
const revoked: DomainError[] = [];

function setup(seed: (fs: InMemoryFirestore) => void = () => undefined) {
  const fs = new InMemoryFirestore();
  seed(fs);
  TestBed.configureTestingModule({
    providers: [
      provideInMemoryFirestore(fs),
      { provide: DATA_CLOCK, useValue: () => now },
      { provide: ACCESS_REVOKED_HANDLER, useValue: (e: DomainError) => revoked.push(e) },
    ],
  });
  const context = TestBed.inject(OrgContext);
  context.setSession({ uid: 'u-owner', orgId: 'org-a', role: 'owner' });
  const notes = TestBed.runInInjectionContext(() => repo<Note>((orgId) => `orgs/${orgId}/notes`, Note));
  return { fs, context, notes, registry: TestBed.inject(ListenerRegistry) };
}

const seedNotes = (fs: InMemoryFirestore, org: string, count: number, prefix = 'n') => {
  for (let i = 1; i <= count; i++) fs.set(`orgs/${org}/notes/${prefix}${i}`, { title: `${prefix}${i}`, rank: i * 10 });
};

const byRank = { orderBy: [['rank', 'asc']] as const, pageSize: 3 };
const titles = (rows: readonly { title: string }[]) => rows.map((r) => r.title);

beforeEach(() => {
  now = 1_000;
  revoked.length = 0;
});

describe('repo: one-shot reads', () => {
  it('gets a document (Timestamps as Dates, with its id) and null when missing', async () => {
    const { fs, notes } = setup();
    fs.set('orgs/org-a/notes/x', { title: 'Hello', rank: 1, updatedAt: new Date(5) });
    expect(await notes.get('x')).toEqual({ id: 'x', title: 'Hello', rank: 1, updatedAt: new Date(5) });
    expect(await notes.get('nope')).toBeNull();
  });

  it('queries the first page and hides soft-deleted documents', async () => {
    const { fs, notes } = setup((f) => seedNotes(f, 'org-a', 4));
    fs.set('orgs/org-a/notes/n2', { title: 'n2', rank: 20, deletedAt: new Date() });
    expect(titles(await notes.query({ orderBy: [['rank', 'desc']], pageSize: 3 }))).toEqual(['n4', 'n3']);
    expect(titles(await notes.query({ ...byRank, includeDeleted: true }))).toEqual(['n1', 'n2', 'n3']);
    expect(titles(await notes.query({ where: [['rank', '>=', 30]] }))).toEqual(['n3', 'n4']);
  });

  it('reads paths from the active org, and refuses without one', async () => {
    const { fs, notes, context } = setup();
    fs.set('orgs/org-b/notes/b', { title: 'B', rank: 1 });
    context.setSession({ uid: 'u-owner', orgId: 'org-b', role: 'owner' });
    expect(await notes.get('b')).toMatchObject({ title: 'B' });
    context.setSession(null);
    await expect(notes.get('b')).rejects.toMatchObject({ code: 'ORG_CLAIM_MISSING' });
  });

  it('maps a refused read to ACCESS_REVOKED and an invalid document to an error in strict mode', async () => {
    const { fs, notes } = setup();
    fs.failNext({ code: 'permission-denied' });
    await expect(notes.get('x')).rejects.toMatchObject({ code: 'ACCESS_REVOKED' });
    fs.set('orgs/org-a/notes/bad', { title: '', rank: 'high' });
    await expect(notes.get('bad')).rejects.toBeInstanceOf(DomainError);
  });

  it('flags invalid documents instead of failing in lenient mode', async () => {
    const { fs } = setup();
    const lenient = TestBed.runInInjectionContext(() =>
      repo<Note>((orgId) => `orgs/${orgId}/notes`, Note, { mode: 'lenient' }),
    );
    fs.set('orgs/org-a/notes/bad', { title: '', rank: 1 });
    expect(await lenient.get('bad')).toMatchObject({ id: 'bad', _invalid: ['title: too_small'] });
  });

  it('counts from the server, cached for a minute per query', async () => {
    const { fs, notes } = setup((f) => seedNotes(f, 'org-a', 3));
    expect(await notes.count()).toBe(3);
    fs.set('orgs/org-a/notes/n9', { title: 'n9', rank: 90 });
    now += 59_000;
    expect(await notes.count()).toBe(3);
    expect(await notes.count({ where: [['rank', '>', 20]] })).toBe(2);
    now += 2_000;
    expect(await notes.count()).toBe(4);
  });
});

describe('repo: writes', () => {
  it('creates, updates and soft-deletes with meta fields stamped', async () => {
    const { fs, notes } = setup();
    const id = await notes.create({ title: 'New', rank: 5 });
    expect(fs.get(`orgs/org-a/notes/${id}`)).toMatchObject({
      title: 'New',
      createdBy: 'u-owner',
      updatedBy: 'u-owner',
      schemaVersion: 1,
    });
    await notes.update(id, { title: 'Renamed' });
    expect(fs.writes.at(-1)).toMatchObject({ op: 'update', data: { title: 'Renamed', updatedBy: 'u-owner' } });
    await notes.softDelete(id);
    expect(fs.get(`orgs/org-a/notes/${id}`)).toMatchObject({ deletedBy: 'u-owner' });
    await notes.hardDelete(id);
    expect(fs.get(`orgs/org-a/notes/${id}`)).toBeUndefined();
    expect(fs.writes.at(-1)).toEqual({ op: 'delete', path: `orgs/org-a/notes/${id}` });
  });

  it('validates input against the entity schemas before writing', async () => {
    const { fs, notes } = setup();
    await expect(notes.create({ title: '', rank: 1 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(notes.update('x', { rank: 2 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(notes.update('missing', { title: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(fs.writes).toEqual([]);
  });

  it('writes only the fields in the patch, not the update schema’s defaults', async () => {
    const fs = new InMemoryFirestore();
    fs.set('orgs/org-a/things/t1', { title: 'One', tags: ['kept'], flagged: true });
    TestBed.configureTestingModule({ providers: [provideInMemoryFirestore(fs)] });
    TestBed.inject(OrgContext).setSession({ uid: 'u-owner', orgId: 'org-a', role: 'owner' });
    const things = TestBed.runInInjectionContext(() =>
      repo((orgId) => `orgs/${orgId}/things`, {
        schema: z.object({ title: z.string(), tags: z.array(z.string()), flagged: z.boolean() }),
        version: 1,
        update: z
          .object({ title: z.string(), tags: z.array(z.string()).default([]), flagged: z.boolean().default(false) })
          .partial()
          .strict(),
      }),
    );
    await things.update('t1', { title: 'Renamed' });
    expect(fs.writes.at(-1)?.data).not.toHaveProperty('tags');
    expect(fs.get('orgs/org-a/things/t1')).toMatchObject({ title: 'Renamed', tags: ['kept'], flagged: true });
  });

  it('sets stamped fields to the server’s time, and only whitelisted ones', async () => {
    const fs = new InMemoryFirestore();
    fs.set('orgs/org-a/things/t1', { title: 'One', seenAt: null });
    TestBed.configureTestingModule({ providers: [provideInMemoryFirestore(fs)] });
    TestBed.inject(OrgContext).setSession({ uid: 'u-owner', orgId: 'org-a', role: 'owner' });
    const things = TestBed.runInInjectionContext(() =>
      repo((orgId) => `orgs/${orgId}/things`, {
        schema: z.object({ title: z.string(), seenAt: z.date().nullable() }),
        version: 1,
        update: z.object({ seenAt: z.date().nullable() }).partial().strict(),
      }),
    );
    await things.update('t1', {}, { stamp: ['seenAt'] });
    expect(fs.get('orgs/org-a/things/t1')?.['seenAt']).toBeInstanceOf(Date);
    await expect(things.update('t1', {}, { stamp: ['title'] })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('refuses writes when signed out', async () => {
    const { notes, context } = setup();
    context.setSession({ uid: '', orgId: 'org-a', role: 'owner' });
    await expect(notes.softDelete('x')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});

describe('repo: watchQuery', () => {
  function watch(notesRepo: Repository<Note>, spec = byRank, live = true) {
    const query = TestBed.runInInjectionContext(() => notesRepo.watchQuery(spec, { live }));
    TestBed.tick();
    return query;
  }

  it('is loading, then ready with the first page; empty is ready with no rows', () => {
    const { notes } = setup((f) => seedNotes(f, 'org-a', 2));
    const query = TestBed.runInInjectionContext(() => notes.watchQuery(byRank));
    expect(query.status()).toBe('loading');
    TestBed.tick();
    expect(query.status()).toBe('ready');
    expect(titles(query.value())).toEqual(['n1', 'n2']);
    expect(query.hasMore()).toBe(false);

    const empty = watch(notes, { ...byRank, where: [['rank', '>', 1000]] } as never);
    expect(empty.status()).toBe('ready');
    expect(empty.value()).toEqual([]);
  });

  it('pages with cursors and follows live changes', async () => {
    const { fs, notes } = setup((f) => seedNotes(f, 'org-a', 7));
    const query = watch(notes);
    expect(titles(query.value())).toEqual(['n1', 'n2', 'n3']);
    expect(query.hasMore()).toBe(true);
    await query.loadMore();
    expect(titles(query.value())).toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
    await query.loadMore();
    expect(titles(query.value())).toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7']);
    expect(query.hasMore()).toBe(false);
    expect(query.loadingMore()).toBe(false);
    await query.loadMore();

    fs.set('orgs/org-a/notes/n4', { title: 'n4 edited', rank: 40 });
    fs.set('orgs/org-a/notes/m', { title: 'between', rank: 45 });
    fs.delete('orgs/org-a/notes/n2');
    expect(titles(query.value())).toEqual(['n1', 'n3', 'n4 edited', 'between', 'n5', 'n6', 'n7']);
    fs.set('orgs/org-a/notes/n8', { title: 'n8', rank: 80 });
    expect(titles(query.value()).at(-1)).toBe('n8');
  });

  it('holds back rows inserted above the first page once paging started, until refresh', async () => {
    const { fs, notes } = setup((f) => seedNotes(f, 'org-a', 5));
    const query = watch(notes);
    await query.loadMore();
    fs.set('orgs/org-a/notes/top1', { title: 'top1', rank: 1 });
    fs.set('orgs/org-a/notes/top2', { title: 'top2', rank: 2 });
    expect(query.newItems()).toBe(2);
    expect(titles(query.value())).toEqual(['n1', 'n2', 'n3', 'n4', 'n5']);

    query.refresh();
    expect(query.newItems()).toBe(0);
    expect(titles(query.value())).toEqual(['top1', 'top2', 'n1']);
  });

  it('a one-shot query pages without listeners', async () => {
    const { fs, notes, registry } = setup((f) => seedNotes(f, 'org-a', 4));
    const query = watch(notes, byRank, false);
    await vi.waitFor(() => expect(query.status()).toBe('ready'));
    expect(registry.active()).toBe(0);
    expect(fs.listenerCount).toBe(0);
    await query.loadMore();
    expect(titles(query.value())).toEqual(['n1', 'n2', 'n3', 'n4']);
  });

  it('is offline when the rows come from the cache while the browser is offline', () => {
    const { fs, notes } = setup((f) => seedNotes(f, 'org-a', 1));
    const connectivity = TestBed.inject(Connectivity);
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const online = {
      set: (value: boolean) => {
        onLine.mockReturnValue(value);
        window.dispatchEvent(new Event(value ? 'online' : 'offline'));
      },
    };
    const query = watch(notes);
    online.set(false);
    expect(connectivity.online()).toBe(false);
    fs.setOffline(true);
    expect(query.status()).toBe('offline');
    expect(query.fromCache()).toBe(true);
    expect(titles(query.value())).toEqual(['n1']);
    online.set(true);
    fs.setOffline(false);
    expect(query.status()).toBe('ready');
    onLine.mockRestore();
  });

  it('a refused listener surfaces ACCESS_REVOKED once, clears the rows and does not retry', () => {
    const { fs, notes, registry } = setup((f) => seedNotes(f, 'org-a', 2));
    const query = watch(notes);
    fs.breakListeners('orgs/org-a/notes', { code: 'permission-denied' });
    expect(query.status()).toBe('error');
    expect(query.error()?.code).toBe('ACCESS_REVOKED');
    expect(query.value()).toEqual([]);
    expect(revoked.map((e) => e.code)).toEqual(['ACCESS_REVOKED']);
    expect(registry.active()).toBe(0);
    expect(fs.listenerCount).toBe(0);
  });

  it('reports other listener failures as errors that refresh can recover from', () => {
    const { fs, notes } = setup((f) => seedNotes(f, 'org-a', 2));
    fs.failNext({ code: 'unavailable' });
    const query = watch(notes);
    return vi
      .waitFor(() => expect(query.error()?.code).toBe('UNAVAILABLE'))
      .then(() => {
        query.refresh();
        expect(query.status()).toBe('ready');
        expect(revoked).toEqual([]);
      });
  });

  it('leaves zero listeners after an org switch, and restarts on the new org', async () => {
    const { fs, notes, context, registry } = setup((f) => {
      seedNotes(f, 'org-a', 5, 'a');
      seedNotes(f, 'org-b', 2, 'b');
    });
    const query = watch(notes);
    await query.loadMore();
    expect(registry.active()).toBe(2);
    expect(fs.listenerCount).toBe(2);

    context.setSession({ uid: 'u-owner', orgId: 'org-b', role: 'owner' });
    expect(registry.active()).toBe(0);
    expect(fs.listenerCount).toBe(0);
    expect(query.value()).toEqual([]);

    TestBed.tick();
    expect(titles(query.value())).toEqual(['b1', 'b2']);
    expect(registry.labels()).toEqual(['orgs/org-b/notes']);

    context.setSession(null);
    TestBed.tick();
    expect(registry.active()).toBe(0);
    expect(fs.listenerCount).toBe(0);
    expect(query.status()).toBe('loading');
  });

  it('stops when its component is destroyed', () => {
    const fs = new InMemoryFirestore();
    seedNotes(fs, 'org-a', 1);
    @Component({ selector: 'mt-notes-test', template: '{{ notes.value().length }}' })
    class NotesTest {
      readonly notes = repo<Note>((orgId) => `orgs/${orgId}/notes`, Note).watchQuery(byRank);
    }
    TestBed.configureTestingModule({ providers: [provideInMemoryFirestore(fs)] });
    TestBed.inject(OrgContext).setSession({ uid: 'u', orgId: 'org-a', role: 'owner' });
    const fixture = TestBed.createComponent(NotesTest);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toBe('1');
    expect(fs.listenerCount).toBe(1);
    fixture.destroy();
    expect(fs.listenerCount).toBe(0);
    expect(TestBed.inject(ListenerRegistry).active()).toBe(0);
  });

  it('follows a spec function and waits while it returns null', () => {
    const { notes } = setup((f) => seedNotes(f, 'org-a', 3));
    let min: number | null = null;
    const spec = TestBed.runInInjectionContext(() => {
      const injector = TestBed.inject(Injector);
      return notes.watchQuery(() => (min === null ? null : { ...byRank, where: [['rank', '>=', min]] }), {
        injector,
      });
    });
    TestBed.tick();
    expect(spec.status()).toBe('loading');
    expect(spec.hasMore()).toBe(false);
    void spec.loadMore();
    spec.refresh();
    min = 20;
    expect(spec.value()).toEqual([]);
  });
});

describe('repo: watch', () => {
  it('follows one document: loading, value, deleted, and org switches', () => {
    const { fs, notes, context, registry } = setup();
    fs.set('orgs/org-a/notes/x', { title: 'X', rank: 1 });
    const doc = TestBed.runInInjectionContext(() => notes.watch('x'));
    expect(doc.status()).toBe('loading');
    TestBed.tick();
    expect(doc.value()).toMatchObject({ id: 'x', title: 'X' });
    expect(doc.exists()).toBe(true);
    fs.set('orgs/org-a/notes/x', { title: 'X2', rank: 1 });
    expect(doc.value()?.title).toBe('X2');
    fs.delete('orgs/org-a/notes/x');
    expect(doc.value()).toBeNull();
    expect(doc.exists()).toBe(false);
    expect(doc.status()).toBe('ready');

    context.setSession({ uid: 'u', orgId: 'org-b', role: 'owner' });
    expect(registry.active()).toBe(0);
    TestBed.tick();
    expect(registry.labels()).toEqual(['orgs/org-b/notes']);
  });

  it('surfaces a refused or invalid document as an error', () => {
    const { fs, notes } = setup();
    fs.set('orgs/org-a/notes/bad', { title: '', rank: 1 });
    const bad = TestBed.runInInjectionContext(() => notes.watch('bad'));
    TestBed.tick();
    expect(bad.status()).toBe('error');

    fs.set('orgs/org-a/notes/y', { title: 'Y', rank: 1 });
    const id = { current: 'y' as string | null };
    const doc = TestBed.runInInjectionContext(() => notes.watch(() => id.current));
    TestBed.tick();
    fs.breakListeners('orgs/org-a/notes', { code: 'permission-denied' });
    expect(doc.error()?.code).toBe('ACCESS_REVOKED');
    expect(revoked).toHaveLength(1);
  });
});

describe('membersRepository', () => {
  it('lists active and suspended members by name, dropping fields the list does not use', () => {
    const fs = new InMemoryFirestore();
    fs.set('orgs/org-a/members/u2', {
      displayName: 'Sam Lee',
      role: 'paralegal',
      status: 'suspended',
      rates: [],
      legacyRef: 'L-0000',
    });
    fs.set('orgs/org-a/members/u1', {
      displayName: 'Alex Fictional',
      role: 'owner',
      status: 'active',
      email: 'A@x.test',
    });
    fs.set('orgs/org-a/members/u3', { displayName: 'Gone Person', role: 'lawyer', status: 'removed' });
    TestBed.configureTestingModule({ providers: [provideInMemoryFirestore(fs)] });
    TestBed.inject(OrgContext).setSession({ uid: 'u1', orgId: 'org-a', role: 'owner' });
    const members = TestBed.runInInjectionContext(() => membersRepository().watchQuery(MEMBER_LIST_QUERY));
    TestBed.tick();
    expect(members.value()).toEqual([
      {
        id: 'u1',
        displayName: 'Alex Fictional',
        role: 'owner',
        status: 'active',
        email: 'a@x.test',
        rates: [],
        budgets: {},
      },
      { id: 'u2', displayName: 'Sam Lee', role: 'paralegal', status: 'suspended', rates: [], budgets: {} },
    ]);
  });
});
