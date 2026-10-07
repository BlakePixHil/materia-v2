import { TestBed } from '@angular/core/testing';

import { FIREBASE_SETUP, type FirebaseSetup } from './firebase-setup';
import {
  FIRESTORE_SDK_LOADER,
  FirestoreClient,
  firestoreCacheMode,
  setFirestoreCacheMode,
  type FirestoreSdk,
} from './firestore/firestore-client';
import { DataLifecycle } from './lifecycle';
import { ListenerRegistry } from './listener-registry';
import { OrgContext } from './org-context';

/** A fake SDK that records the calls the client makes, in order. */
function fakeSdk(options: { pendingWrites?: boolean; clearFails?: boolean } = {}) {
  const calls: string[] = [];
  let instance = 0;
  const sdk = {
    initializeFirestore: (_app: unknown, settings: { localCache: string; ignoreUndefinedProperties: boolean }) => {
      calls.push(`init:${settings.localCache}:${settings.ignoreUndefinedProperties}`);
      return { instance: ++instance };
    },
    persistentLocalCache: (settings: { tabManager: string }) => `persistent(${settings.tabManager})`,
    persistentMultipleTabManager: () => 'multi-tab',
    memoryLocalCache: () => 'memory',
    connectFirestoreEmulator: (_db: unknown, host: string, port: number) => calls.push(`emulator:${host}:${port}`),
    terminate: async (db: { instance: number }) => void calls.push(`terminate:${db.instance}`),
    clearIndexedDbPersistence: async (db: { instance: number }) => {
      if (options.clearFails) throw new Error('in use by another tab');
      calls.push(`clear:${db.instance}`);
    },
    waitForPendingWrites: () =>
      options.pendingWrites
        ? new Promise<void>(() => undefined)
        : Promise.resolve(calls.push('synced')).then(() => undefined),
  };
  return { sdk: sdk as unknown as FirestoreSdk, calls };
}

function setup(fake = fakeSdk(), setup: Partial<FirebaseSetup> = {}) {
  TestBed.configureTestingModule({
    providers: [
      { provide: FIRESTORE_SDK_LOADER, useValue: async () => fake.sdk },
      { provide: FIREBASE_SETUP, useValue: { app: async () => ({}), useEmulators: false, ...setup } },
    ],
  });
  return { ...fake, client: TestBed.inject(FirestoreClient), lifecycle: TestBed.inject(DataLifecycle) };
}

afterEach(() => setFirestoreCacheMode('persistent'));

describe('FirestoreClient', () => {
  it('starts once, with the multi-tab persistent cache and ignoreUndefinedProperties', async () => {
    const { client, calls } = setup();
    expect(client.started).toBe(false);
    const [a, b] = await Promise.all([client.get(), client.get()]);
    expect(a).toBe(b);
    expect(client.started).toBe(true);
    expect(calls).toEqual(['init:persistent(multi-tab):true']);
  });

  it('keeps the cache in memory after a shared-computer sign-in, and connects to the emulator', async () => {
    setFirestoreCacheMode('memory');
    expect(firestoreCacheMode()).toBe('memory');
    const { client, calls } = setup(fakeSdk(), { useEmulators: true });
    await client.get();
    expect(calls).toEqual(['init:memory:true', 'emulator:127.0.0.1:8080']);
  });

  it('fails clearly without FIREBASE_SETUP', async () => {
    TestBed.configureTestingModule({ providers: [{ provide: FIRESTORE_SDK_LOADER, useValue: async () => ({}) }] });
    await expect(TestBed.inject(FirestoreClient).get()).rejects.toThrow('FIREBASE_SETUP');
  });

  it('reports writes the server hasn’t acknowledged, and probes the write queue only offline', async () => {
    const synced = setup();
    expect(await synced.client.hasPendingWrites()).toBe(false);
    await synced.client.get();
    expect(await synced.client.hasPendingWrites(5)).toBe(false);
    await synced.client.waitForPendingWrites();

    // A write counts until the server acknowledges it.
    let acknowledge: () => void = () => undefined;
    const write = synced.client.track(new Promise<void>((resolve) => (acknowledge = resolve)));
    expect(await synced.client.hasPendingWrites(5)).toBe(true);
    acknowledge();
    await write;
    expect(await synced.client.hasPendingWrites(5)).toBe(false);
    // Signing out discards it with the instance.
    synced.client.track(new Promise<void>(() => undefined));
    await synced.client.shutdown({ clearCache: false });
    expect(await synced.client.hasPendingWrites(5)).toBe(false);
    TestBed.resetTestingModule();

    // A slow write queue isn't a pending write while online (a busy page)…
    const pending = setup(fakeSdk({ pendingWrites: true }));
    await pending.client.get();
    expect(await pending.client.hasPendingWrites(5)).toBe(false);
    // …but offline it may hold edits from before a reload.
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      expect(await pending.client.hasPendingWrites(5)).toBe(true);
    } finally {
      onLine.mockRestore();
    }
  });

  it('counts documents waiting to sync and knows when no listener has reached the server', async () => {
    const { client } = setup();
    expect(client.pendingWrites()).toBe(0);
    expect(client.cacheOnly()).toBe(false);

    const tasks = {};
    const matter = {};
    client.observe(tasks, { fromCache: true, pending: ['orgs/o1/tasks/t1', 'orgs/o1/tasks/t2'] });
    client.observe(matter, { fromCache: true, pending: ['orgs/o1/tasks/t1'] });
    // A document two listeners show counts once.
    expect(client.pendingWrites()).toBe(2);
    expect(client.cacheOnly()).toBe(true);

    client.observe(matter, { fromCache: false, pending: [] });
    expect(client.cacheOnly()).toBe(false);
    client.observe(tasks, null);
    expect(client.pendingWrites()).toBe(0);

    // This page's writes count too, when no listener shows them (a deleted document).
    let acknowledge: () => void = () => undefined;
    const write = client.track(new Promise<void>((resolve) => (acknowledge = resolve)));
    expect(client.pendingWrites()).toBe(1);
    acknowledge();
    await write;
    expect(client.pendingWrites()).toBe(0);

    // Signing out forgets both.
    client.track(new Promise<void>(() => undefined));
    client.observe(tasks, { fromCache: true, pending: ['orgs/o1/tasks/t1'] });
    await client.shutdown({ clearCache: false });
    expect(client.pendingWrites()).toBe(0);
    expect(client.cacheOnly()).toBe(false);
  });
});

describe('DataLifecycle', () => {
  it('sign-out stops listeners, forgets the session, terminates Firestore, then clears IndexedDB', async () => {
    const { lifecycle, client, calls } = setup();
    const registry = TestBed.inject(ListenerRegistry);
    const context = TestBed.inject(OrgContext);
    context.setSession({ uid: 'u', orgId: 'o', role: 'owner' });
    setFirestoreCacheMode('memory');
    await client.get();
    const stop = vi.fn();
    registry.add(stop);

    await lifecycle.signOut();
    expect(stop).toHaveBeenCalled();
    expect(registry.active()).toBe(0);
    expect(context.session()).toBeNull();
    expect(calls).toEqual(['init:memory:true', 'terminate:1', 'clear:1']);
    expect(firestoreCacheMode()).toBe('persistent');
    expect(client.started).toBe(false);

    // The next sign-in gets a fresh instance.
    await client.get();
    expect(calls.at(-1)).toBe('init:persistent(multi-tab):true');
  });

  it('sign-out before Firestore ever started has nothing to terminate; a cache another tab holds is left to it', async () => {
    const idle = setup();
    await idle.lifecycle.signOut();
    expect(idle.calls).toEqual([]);
    TestBed.resetTestingModule();
    const busy = setup(fakeSdk({ clearFails: true }));
    await busy.client.get();
    expect(await busy.client.shutdown({ clearCache: true })).toBe(false);
    expect(busy.calls).toEqual(['init:persistent(multi-tab):true', 'terminate:1']);
  });

  it('an org switch stops every listener; unsynced changes are reported and can be awaited', async () => {
    const { lifecycle, client, calls } = setup();
    const registry = TestBed.inject(ListenerRegistry);
    registry.add(() => undefined);
    lifecycle.orgSwitch();
    expect(registry.active()).toBe(0);
    await client.get();
    expect(await lifecycle.hasUnsyncedChanges()).toBe(false);
    await lifecycle.waitForSync();
    expect(calls).toContain('synced');
  });
});
