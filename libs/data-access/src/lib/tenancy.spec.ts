import { TestBed } from '@angular/core/testing';

import { ListenerRegistry } from './listener-registry';
import { firestoreTenancyPort, NULL_TENANCY_PORT, toUserTenancy } from './tenancy';

describe('toUserTenancy', () => {
  it('reads the claims version and memberships, defaulting what is missing', () => {
    expect(toUserTenancy(undefined)).toBeNull();
    expect(toUserTenancy({})).toEqual({ claimsVersion: 0, activeOrgId: null, memberships: {} });
    expect(
      toUserTenancy({ claimsVersion: 3, activeOrgId: 'org-1', memberships: { 'org-1': { role: 'owner', name: 'A' } } }),
    ).toEqual({ claimsVersion: 3, activeOrgId: 'org-1', memberships: { 'org-1': { role: 'owner', name: 'A' } } });
  });
});

/** A fake full-SDK Firestore: `onSnapshot` on a document path, `getDocs` on a collection. */
function fakeFirestore() {
  const listeners = new Map<string, { next: (snap: unknown) => void; error: (e: unknown) => void }>();
  const collections: Record<string, { id: string; data: () => Record<string, unknown> }[]> = {};
  const sdk = {
    doc: (_db: unknown, ...path: string[]) => path.join('/'),
    collection: (_db: unknown, ...path: string[]) => path.join('/'),
    query: (path: string) => path,
    where: () => undefined,
    onSnapshot: (path: string, next: (snap: unknown) => void, error: (e: unknown) => void) => {
      listeners.set(path, { next, error });
      return () => listeners.delete(path);
    },
    getDocs: async (path: string) => ({ docs: collections[path] ?? [] }),
  };
  const emit = (path: string, data: Record<string, unknown> | undefined) =>
    listeners.get(path)?.next({ data: () => data });
  return { source: { get: async () => ({ sdk, db: {} }) as never }, listeners, collections, emit };
}

describe('firestoreTenancyPort', () => {
  it('follows users/{uid} live, reports changes only, and is tracked by the registry', async () => {
    const fs = fakeFirestore();
    const registry = TestBed.inject(ListenerRegistry);
    const port = firestoreTenancyPort(fs.source, registry);
    const seen: unknown[] = [];
    const stop = port.watchUser('u1', (value) => seen.push(value));
    expect(registry.labels()).toEqual(['users/u1']);
    await vi.waitFor(() => expect(fs.listeners.has('users/u1')).toBe(true));
    fs.emit('users/u1', { claimsVersion: 2 });
    fs.emit('users/u1', { claimsVersion: 2 });
    expect(seen).toEqual([{ claimsVersion: 2, activeOrgId: null, memberships: {} }]);
    fs.emit('users/u1', { claimsVersion: 3 });
    expect(seen).toHaveLength(2);
    fs.listeners.get('users/u1')?.error({ code: 'permission-denied' });

    stop();
    expect(fs.listeners.has('users/u1')).toBe(false);
    expect(registry.active()).toBe(0);
  });

  it('stops with the registry (an org switch), and never attaches when stopped before Firestore loads', async () => {
    const fs = fakeFirestore();
    const registry = TestBed.inject(ListenerRegistry);
    const port = firestoreTenancyPort(fs.source, registry);
    port.watchUser('u1', () => undefined);
    await vi.waitFor(() => expect(fs.listeners.size).toBe(1));
    registry.stopAll();
    expect(fs.listeners.size).toBe(0);

    port.watchUser('u2', () => undefined)();
    await new Promise((resolve) => setTimeout(resolve));
    expect(fs.listeners.size).toBe(0);
  });

  it('lists pending invites by email', async () => {
    const fs = fakeFirestore();
    fs.collections['orgs/org-1/invites'] = [
      {
        id: 'i2',
        data: () => ({ email: 'zed@example.test', role: 'lawyer', expiresAt: { toDate: () => new Date(1) } }),
      },
      {
        id: 'i1',
        data: () => ({ email: 'new@example.test', role: 'paralegal', expiresAt: { toDate: () => new Date(0) } }),
      },
    ];
    const port = firestoreTenancyPort(fs.source, TestBed.inject(ListenerRegistry));
    expect(await port.invites('org-1')).toEqual([
      { id: 'i1', email: 'new@example.test', role: 'paralegal', expiresAt: new Date(0) },
      { id: 'i2', email: 'zed@example.test', role: 'lawyer', expiresAt: new Date(1) },
    ]);
    expect(NULL_TENANCY_PORT.watchUser('u', () => undefined)()).toBeUndefined();
    expect(await NULL_TENANCY_PORT.invites('o')).toEqual([]);
  });
});
