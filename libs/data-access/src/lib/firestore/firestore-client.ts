import { Injectable, InjectionToken, computed, inject, signal } from '@angular/core';
import type { Firestore } from 'firebase/firestore';

import { FIREBASE_SETUP } from '../firebase-setup';

/** The full Firestore SDK, as `./sdk` re-exports it. */
export type FirestoreSdk = typeof import('./sdk');

export interface FirestoreHandle {
  sdk: FirestoreSdk;
  db: Firestore;
}

/** What a live listener's latest snapshot says about syncing (MOB-01's offline indicators). */
export interface ListenerSyncState {
  /** The snapshot came from the cache: the server hasn't confirmed it. */
  fromCache: boolean;
  /** Paths of its documents with local changes the server hasn't acknowledged yet. */
  pending: readonly string[];
}

/** Anything that hands out the Firestore instance (the client, or a test double). */
export interface FirestoreSource {
  get(): Promise<FirestoreHandle>;
  /** Counts a write until the server acknowledges it (or it fails), for "You have unsynced changes". */
  track?<T>(write: Promise<T>): Promise<T>;
  /** Records a live listener's latest snapshot (`listener` is any stable key), or `null` once it stops. */
  observe?(listener: object, state: ListenerSyncState | null): void;
}

/**
 * Loads the SDK in two lazy chunks that download in parallel: Firestore itself and `re2js` (the
 * regex engine Firestore bundles for pipeline queries). Together they are over the 150 kB lazy
 * chunk budget; importing `re2js` on its own here makes the bundler give it its own chunk
 * (ADR-024). The root package.json pins `re2js` to Firestore's range so both resolve to one copy.
 */
export function loadFirestoreSdk(): Promise<FirestoreSdk> {
  return Promise.all([import('./sdk'), import('re2js')]).then(([sdk]) => sdk);
}

export const FIRESTORE_SDK_LOADER = new InjectionToken<() => Promise<FirestoreSdk>>('FIRESTORE_SDK_LOADER', {
  providedIn: 'root',
  factory: () => loadFirestoreSdk,
});

/** `persistent` keeps a cache in IndexedDB shared by tabs; `memory` (a shared computer) keeps nothing on disk. */
export type FirestoreCacheMode = 'persistent' | 'memory';

const CACHE_MODE_KEY = 'materia.firestoreCache';

/**
 * Records the cache for this tab's session: the sign-in screen's "shared computer" option means
 * `memory`. Kept in sessionStorage, which lives exactly as long as a shared-computer sign-in.
 */
export function setFirestoreCacheMode(mode: FirestoreCacheMode): void {
  try {
    if (mode === 'memory') globalThis.sessionStorage?.setItem(CACHE_MODE_KEY, mode);
    else globalThis.sessionStorage?.removeItem(CACHE_MODE_KEY);
  } catch {
    // Storage may be unavailable; the default is the persistent cache.
  }
}

export function firestoreCacheMode(): FirestoreCacheMode {
  try {
    return globalThis.sessionStorage?.getItem(CACHE_MODE_KEY) === 'memory' ? 'memory' : 'persistent';
  } catch {
    return 'persistent';
  }
}

/** How long sign-out waits for the Firestore cache to be deleted before moving on. */
export const CLEAR_CACHE_WAIT_MS = 2000;

/** How long `hasPendingWrites` waits for the write queue to drain, offline, before saying it hasn't. */
const PENDING_WRITES_PROBE_MS = 300;

/**
 * The one full-SDK Firestore instance (FND-19). It loads on first use, outside the initial bundle,
 * with `persistentLocalCache` and the multi-tab manager (ADR-020), or a memory cache on a shared
 * computer, and `ignoreUndefinedProperties`. `shutdown` terminates it and clears its IndexedDB
 * cache on sign-out; the next `get()` starts a fresh instance.
 */
@Injectable({ providedIn: 'root' })
export class FirestoreClient implements FirestoreSource {
  private readonly setup = inject(FIREBASE_SETUP, { optional: true });
  private readonly loadSdk = inject(FIRESTORE_SDK_LOADER);
  private current: Promise<FirestoreHandle> | null = null;
  /** The last shutdown; a new instance waits for it so it can't block the cache being deleted. */
  private closing: Promise<unknown> = Promise.resolve();
  /** Writes made through `track` that the server hasn't acknowledged yet. */
  private unacknowledged = new Set<Promise<unknown>>();
  private readonly writesInFlight = signal(0);
  private readonly listeners = signal<ReadonlyMap<object, ListenerSyncState>>(new Map());

  /**
   * Documents with local changes the server hasn't acknowledged (MOB-01's "Pending sync"): those
   * the live listeners show, or this page's writes in flight when that's more (a deleted
   * document drops out of its listener).
   */
  readonly pendingWrites = computed(() => {
    const paths = new Set<string>();
    for (const state of this.listeners().values()) for (const path of state.pending) paths.add(path);
    return Math.max(paths.size, this.writesInFlight());
  });

  /** True while every live listener shows cached data: none has heard from the server. */
  readonly cacheOnly = computed(() => {
    const states = [...this.listeners().values()];
    return states.length > 0 && states.every((state) => state.fromCache);
  });

  get(): Promise<FirestoreHandle> {
    return (this.current ??= this.start());
  }

  /** Whether an instance is running (it starts on the first read). */
  get started(): boolean {
    return this.current !== null;
  }

  private async start(): Promise<FirestoreHandle> {
    const setup = this.setup;
    if (!setup) throw new Error('FIREBASE_SETUP is not provided');
    const [sdk, app] = await Promise.all([this.loadSdk(), setup.app(), this.closing, setup.ready?.()]);
    const mode = setup.cacheMode?.() ?? firestoreCacheMode();
    const db = sdk.initializeFirestore(app, {
      localCache:
        mode === 'memory'
          ? sdk.memoryLocalCache()
          : sdk.persistentLocalCache({ tabManager: sdk.persistentMultipleTabManager() }),
      ignoreUndefinedProperties: true,
    });
    if (setup.useEmulators) {
      const [host, port] = (setup.firestoreEmulator ?? '127.0.0.1:8080').split(':');
      sdk.connectFirestoreEmulator(
        db,
        host ?? '127.0.0.1',
        Number(port ?? 8080),
        setup.emulatorUserToken ? { mockUserToken: setup.emulatorUserToken } : {},
      );
    }
    return { sdk, db };
  }

  track<T>(write: Promise<T>): Promise<T> {
    const writes = this.unacknowledged;
    writes.add(write);
    this.writesInFlight.set(writes.size);
    const settle = () => {
      writes.delete(write);
      // After a shutdown these writes are gone with their instance; the count started again.
      if (writes === this.unacknowledged) this.writesInFlight.set(writes.size);
    };
    write.then(settle, settle);
    return write;
  }

  observe(listener: object, state: ListenerSyncState | null): void {
    const current = this.listeners();
    const previous = current.get(listener);
    if (state ? previous && sameState(previous, state) : !previous) return;
    const next = new Map(current);
    if (state) next.set(listener, state);
    else next.delete(listener);
    this.listeners.set(next);
  }

  /**
   * True when local writes are still waiting for the server (offline edits): this page's writes
   * the server hasn't acknowledged, or, while the browser is offline, anything left in Firestore's
   * write queue (say, from before a reload). Online, the queue isn't probed: draining it waits
   * behind everything else Firestore is doing, so a busy page read as "unsynced" with no writes.
   */
  async hasPendingWrites(probeMs = PENDING_WRITES_PROBE_MS): Promise<boolean> {
    if (this.unacknowledged.size > 0) return true;
    if (!this.current || globalThis.navigator?.onLine !== false) return false;
    const { sdk, db } = await this.current;
    let drained = false;
    const wait = sdk.waitForPendingWrites(db).then(
      () => (drained = true),
      () => (drained = true),
    );
    await Promise.race([wait, new Promise((resolve) => setTimeout(resolve, probeMs))]);
    return !drained;
  }

  /** Resolves when every local write has reached the server. */
  async waitForPendingWrites(): Promise<void> {
    if (!this.current) return;
    const { sdk, db } = await this.current;
    await sdk.waitForPendingWrites(db);
  }

  /**
   * Terminates the instance and, with `clearCache`, deletes its IndexedDB cache. Deleting waits
   * while another tab still has the cache open, so it gives up after `CLEAR_CACHE_WAIT_MS` (the
   * delete stays queued and lands when that tab closes it on seeing the sign-out). Returns whether
   * the cache was cleared.
   */
  shutdown(options: { clearCache: boolean }): Promise<boolean> {
    const current = this.current;
    this.current = null;
    // A terminated instance never settles its writes; they're discarded with it, and its
    // listeners stop.
    this.unacknowledged = new Set();
    this.writesInFlight.set(0);
    this.listeners.set(new Map());
    if (!current) return Promise.resolve(false);
    const done = this.close(current, options);
    this.closing = done.catch(() => undefined);
    return done;
  }

  private async close(current: Promise<FirestoreHandle>, options: { clearCache: boolean }): Promise<boolean> {
    const handle = await current.catch(() => null);
    if (!handle) return false;
    await handle.sdk.terminate(handle.db);
    if (!options.clearCache) return false;
    const cleared = handle.sdk.clearIndexedDbPersistence(handle.db).then(
      () => true,
      () => false,
    );
    return Promise.race([
      cleared,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), CLEAR_CACHE_WAIT_MS)),
    ]);
  }
}

function sameState(a: ListenerSyncState, b: ListenerSyncState): boolean {
  return (
    a.fromCache === b.fromCache &&
    a.pending.length === b.pending.length &&
    a.pending.every((p, i) => p === b.pending[i])
  );
}
