import { TestBed } from '@angular/core/testing';
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';

import type { DomainError, Role } from '@materia/domain';

import { clearFirestore, getDoc, member, setDoc } from './emulator';
import {
  ACCESS_REVOKED_HANDLER,
  DataLifecycle,
  FIREBASE_SETUP,
  FirestoreClient,
  ListenerRegistry,
  OrgContext,
} from '../src/index';
import type { MemberListItem } from '../src/lib/members';
import { MEMBER_LIST_QUERY, membersRepository, type QueryResource } from '../src/repository';

/**
 * FND-19 against the Firestore emulator: the members repository through the real full SDK and the
 * real rules — reads, cursor paging, live updates, client-direct writes, and the listener lifecycle
 * on an org switch, a revoked membership and sign-out.
 */

const OWNER = 'u-owner';
const ORG_A = 'org-int-a';
const ORG_B = 'org-int-b';
const NAMES = ['Bea Fictional', 'Cal Fictional', 'Dee Fictional', 'Eli Fictional', 'Fay Fictional', 'Gus Fictional'];

let apps: FirebaseApp[] = [];
const revoked: DomainError[] = [];

/** A data layer signed in as `uid` with the given claims (the emulator's mock token). */
function signIn(uid: string, orgId: string, role: Role) {
  const app = initializeApp({ projectId: 'demo-materia', apiKey: 'demo-api-key' }, `int-${apps.length}`);
  apps.push(app);
  TestBed.configureTestingModule({
    providers: [
      {
        provide: FIREBASE_SETUP,
        useValue: {
          app: async () => app,
          useEmulators: true,
          firestoreEmulator: process.env['FIRESTORE_EMULATOR_HOST'] ?? '127.0.0.1:8080',
          emulatorUserToken: { sub: uid, orgId, role },
          cacheMode: () => 'memory',
        },
      },
      { provide: ACCESS_REVOKED_HANDLER, useValue: (error: DomainError) => revoked.push(error) },
    ],
  });
  const context = TestBed.inject(OrgContext);
  context.setSession({ uid, orgId, role });
  const members = TestBed.runInInjectionContext(() => membersRepository());
  return { context, members, registry: TestBed.inject(ListenerRegistry), lifecycle: TestBed.inject(DataLifecycle) };
}

const names = (query: QueryResource<MemberListItem>) => query.value().map((m) => m.displayName);

async function until(check: () => void, timeout = 10_000) {
  await vi.waitFor(check, { timeout, interval: 50 });
}

beforeEach(async () => {
  revoked.length = 0;
  await clearFirestore();
  await setDoc(`orgs/${ORG_A}/members/${OWNER}`, member('Ada Fictional', 'owner'));
  for (const [i, name] of NAMES.entries()) await setDoc(`orgs/${ORG_A}/members/u${i}`, member(name, 'lawyer'));
  await setDoc(`orgs/${ORG_A}/members/u-removed`, member('Ann Removed', 'lawyer', 'removed'));
  await setDoc(`orgs/${ORG_B}/members/${OWNER}`, member('Ada Fictional', 'owner'));
  await setDoc(`orgs/${ORG_B}/members/u-b`, member('Zed Fictional', 'admin'));
});

afterEach(async () => {
  await TestBed.inject(DataLifecycle).signOut();
  TestBed.resetTestingModule();
  await Promise.all(apps.map((app) => deleteApp(app)));
  apps = [];
});

describe('repositories against the emulator', () => {
  it('reads one document, the first page of a query, and a server count', async () => {
    const { members } = signIn(OWNER, ORG_A, 'owner');
    expect(await members.get('u0')).toMatchObject({ id: 'u0', displayName: 'Bea Fictional', role: 'lawyer' });
    expect(await members.get('nobody')).toBeNull();
    const first = await members.query({ ...MEMBER_LIST_QUERY, pageSize: 3 });
    expect(first.map((m) => m.displayName)).toEqual(['Ada Fictional', 'Bea Fictional', 'Cal Fictional']);
    expect(await members.count(MEMBER_LIST_QUERY)).toBe(7);
  });

  it('pages a live query with cursors, follows changes, and holds back rows added above page one', async () => {
    const { members, registry } = signIn(OWNER, ORG_A, 'owner');
    const query = TestBed.runInInjectionContext(() => members.watchQuery({ ...MEMBER_LIST_QUERY, pageSize: 3 }));
    TestBed.tick();
    await until(() => expect(query.status()).toBe('ready'));
    expect(names(query)).toEqual(['Ada Fictional', 'Bea Fictional', 'Cal Fictional']);
    expect(query.hasMore()).toBe(true);

    await query.loadMore();
    await until(() => expect(query.hasMore()).toBe(true));
    await query.loadMore();
    await until(() => expect(names(query)).toHaveLength(7));
    expect(names(query)).toEqual(['Ada Fictional', ...NAMES]);
    expect(query.hasMore()).toBe(false);
    expect(registry.active()).toBe(3);

    // Inserted in the middle: shown in place. Above the first page: held back as "new".
    await setDoc(`orgs/${ORG_A}/members/u-mid`, member('Dan Fictional', 'paralegal'));
    await setDoc(`orgs/${ORG_A}/members/u-top`, member('Aaron Fictional', 'paralegal'));
    await until(() => expect(names(query)).toContain('Dan Fictional'));
    await until(() => expect(query.newItems()).toBe(1));
    expect(names(query)).not.toContain('Aaron Fictional');
    expect(names(query).indexOf('Dan Fictional')).toBe(names(query).indexOf('Cal Fictional') + 1);

    query.refresh();
    await until(() => expect(names(query).slice(0, 2)).toEqual(['Aaron Fictional', 'Ada Fictional']));
    expect(query.newItems()).toBe(0);
  });

  it('writes client-direct where the rules allow, stamping updatedBy and a server updatedAt', async () => {
    const { members } = signIn(OWNER, ORG_A, 'owner');
    const doc = TestBed.runInInjectionContext(() => members.watch('u0'));
    TestBed.tick();
    await until(() => expect(doc.value()?.displayName).toBe('Bea Fictional'));
    await members.update('u0', { displayName: 'Bea Renamed' });
    await until(() => expect(doc.value()?.displayName).toBe('Bea Renamed'));
    const stored = await getDoc(`orgs/${ORG_A}/members/u0`);
    expect(stored?.['updatedBy']).toEqual({ stringValue: OWNER });
    expect(stored?.['updatedAt']?.['timestampValue']).not.toBe('2026-10-01T00:00:00Z');

    // Role changes go through the callables: the update schema refuses them before they're sent
    // (the rules refuse them too; see firestore.rules.spec.ts).
    await expect(members.update('u0', { role: 'owner' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('refuses writes for roles without members.manage', async () => {
    await setDoc(`orgs/${ORG_A}/members/u-para`, member('Pat Fictional', 'paralegal'));
    const { members } = signIn('u-para', ORG_A, 'paralegal');
    expect(await members.get('u0')).toMatchObject({ displayName: 'Bea Fictional' });
    await expect(members.update('u0', { title: 'Partner' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});

describe('listener lifecycle against the emulator', () => {
  it('an org switch leaves zero active listeners, and nothing from the old org streams in', async () => {
    const { members, context, registry } = signIn(OWNER, ORG_A, 'owner');
    const query = TestBed.runInInjectionContext(() => members.watchQuery({ ...MEMBER_LIST_QUERY, pageSize: 3 }));
    const doc = TestBed.runInInjectionContext(() => members.watch('u0'));
    TestBed.tick();
    await until(() => expect(query.status()).toBe('ready'));
    await query.loadMore();
    await until(() => expect(doc.value()).not.toBeNull());
    expect(registry.active()).toBe(3);

    context.setSession({ uid: OWNER, orgId: ORG_B, role: 'owner' });
    expect(registry.active()).toBe(0);
    expect(query.value()).toEqual([]);
    expect(doc.value()).toBeNull();

    await setDoc(`orgs/${ORG_A}/members/u-late`, member('Abe Late', 'lawyer'));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(query.value()).toEqual([]);
    expect(registry.active()).toBe(0);
  });

  it('a membership suspended mid-session surfaces ACCESS_REVOKED once, with no retry loop', async () => {
    const { members, registry } = signIn(OWNER, ORG_A, 'owner');
    const query = TestBed.runInInjectionContext(() => members.watchQuery(MEMBER_LIST_QUERY));
    TestBed.tick();
    await until(() => expect(query.status()).toBe('ready'));

    await setDoc(`orgs/${ORG_A}/members/${OWNER}`, member('Ada Fictional', 'owner', 'suspended'));
    await until(() => expect(query.status()).toBe('error'));
    expect(query.error()?.code).toBe('ACCESS_REVOKED');
    expect(query.value()).toEqual([]);
    expect(revoked.map((e) => e.code)).toEqual(['ACCESS_REVOKED']);
    expect(registry.active()).toBe(0);
  });

  it('sign-out stops every listener and terminates Firestore; the next session starts a fresh instance', async () => {
    const { members, registry, lifecycle } = signIn(OWNER, ORG_A, 'owner');
    const query = TestBed.runInInjectionContext(() => members.watchQuery(MEMBER_LIST_QUERY));
    TestBed.tick();
    await until(() => expect(query.status()).toBe('ready'));
    const client = TestBed.inject(FirestoreClient);
    const before = (await client.get()).db;

    await lifecycle.signOut();
    expect(registry.active()).toBe(0);
    expect(client.started).toBe(false);
    expect(TestBed.inject(OrgContext).session()).toBeNull();

    const after = (await client.get()).db;
    expect(after).not.toBe(before);
  });
});
