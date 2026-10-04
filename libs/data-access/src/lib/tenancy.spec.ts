import { firebaseTenancyPort, sortMembers, toUserTenancy, type TeamMember } from './tenancy';

const member = (over: Partial<TeamMember>): TeamMember => ({
  uid: 'u',
  displayName: 'Alex Fictional',
  email: null,
  initials: 'AF',
  role: 'lawyer',
  status: 'active',
  colour: '#346CFC',
  ...over,
});

describe('toUserTenancy', () => {
  it('reads the claims version and memberships, defaulting what is missing', () => {
    expect(toUserTenancy(undefined)).toBeNull();
    expect(toUserTenancy({})).toEqual({ claimsVersion: 0, activeOrgId: null, memberships: {} });
    expect(
      toUserTenancy({ claimsVersion: 3, activeOrgId: 'org-1', memberships: { 'org-1': { role: 'owner', name: 'A' } } }),
    ).toEqual({ claimsVersion: 3, activeOrgId: 'org-1', memberships: { 'org-1': { role: 'owner', name: 'A' } } });
  });
});

describe('sortMembers', () => {
  it('hides removed members, lists suspended ones last, and tells same names apart by email', () => {
    const sorted = sortMembers([
      member({ uid: 'c', displayName: 'Sam Lee', email: 'sam.b@example.test' }),
      member({ uid: 'r', displayName: 'Aaron Gone', status: 'removed' }),
      member({ uid: 's', displayName: 'Abby Paused', status: 'suspended' }),
      member({ uid: 'a', displayName: 'Sam Lee', email: 'sam.a@example.test' }),
      member({ uid: 'b', displayName: 'Bea Fictional' }),
    ]);
    expect(sorted.map((m) => m.uid)).toEqual(['b', 'a', 'c', 's']);
  });
});

const firestoreMock = vi.hoisted(() => {
  const docs: Record<string, { id: string; data: () => Record<string, unknown> }[]> = {};
  const state = { user: undefined as Record<string, unknown> | undefined, connected: 0, reads: 0 };
  return {
    docs,
    state,
    module: {
      getFirestore: () => ({ name: 'fs' }),
      connectFirestoreEmulator: () => {
        state.connected++;
      },
      doc: (_fs: unknown, ...path: string[]) => path.join('/'),
      collection: (_fs: unknown, ...path: string[]) => path.join('/'),
      query: (path: string) => path,
      where: () => undefined,
      getDoc: async () => {
        state.reads++;
        return { data: () => state.user };
      },
      getDocs: async (path: string) => ({ docs: docs[path] ?? [] }),
    },
  };
});
vi.mock('firebase/firestore/lite', () => firestoreMock.module);

describe('firebaseTenancyPort', () => {
  const port = firebaseTenancyPort({ app: async () => ({}) as never, useEmulators: true }, 20);

  it('re-reads users/{uid}, reports changes only, and stops on unsubscribe', async () => {
    firestoreMock.state.user = { claimsVersion: 2 };
    const seen: unknown[] = [];
    const stop = port.watchUser('u1', (value) => seen.push(value));
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toEqual({ claimsVersion: 2, activeOrgId: null, memberships: {} });
    expect(firestoreMock.state.connected).toBe(1);
    await vi.waitFor(() => expect(firestoreMock.state.reads).toBeGreaterThan(2));
    expect(seen).toHaveLength(1);
    firestoreMock.state.user = { claimsVersion: 3 };
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    document.dispatchEvent(new Event('visibilitychange'));
    stop();
    const reads = firestoreMock.state.reads;
    firestoreMock.state.user = { claimsVersion: 4 };
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(seen).toHaveLength(2);
    expect(firestoreMock.state.reads).toBeLessThanOrEqual(reads + 1);
  });

  it('lists members and pending invites', async () => {
    firestoreMock.docs['orgs/org-1/members'] = [
      { id: 'b', data: () => ({ displayName: 'Bea', role: 'owner', status: 'active', email: 'bea@example.test' }) },
      { id: 'a', data: () => ({ displayName: 'Al', role: 'lawyer', status: 'active' }) },
    ];
    firestoreMock.docs['orgs/org-1/invites'] = [
      {
        id: 'i1',
        data: () => ({ email: 'new@example.test', role: 'paralegal', expiresAt: { toDate: () => new Date(0) } }),
      },
    ];
    expect((await port.members('org-1')).map((m) => [m.uid, m.email])).toEqual([
      ['a', null],
      ['b', 'bea@example.test'],
    ]);
    expect(await port.invites('org-1')).toEqual([
      { id: 'i1', email: 'new@example.test', role: 'paralegal', expiresAt: new Date(0) },
    ]);
  });
});
