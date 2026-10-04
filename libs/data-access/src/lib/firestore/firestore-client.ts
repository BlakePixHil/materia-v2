import { Injectable, InjectionToken, inject } from '@angular/core';
import type { Firestore } from 'firebase/firestore';

import { FIREBASE_SETUP } from '../firebase-setup';

/** The full Firestore SDK, as `./sdk` re-exports it. */
export type FirestoreSdk = typeof import('./sdk');

export interface FirestoreHandle {
  sdk: FirestoreSdk;
  db: Firestore;
}

/** Anything that hands out the Firestore instance (the client, or a test double). */
export interface FirestoreSource {
  get(): Promise<FirestoreHandle>;
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

/** How long `hasPendingWrites` waits for the write queue to drain before saying it hasn't. */
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
    const [sdk, app] = await Promise.all([this.loadSdk(), setup.app(), this.closing]);
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

  /** True when local writes are still waiting for the server (offline edits). */
  async hasPendingWrites(probeMs = PENDING_WRITES_PROBE_MS): Promise<boolean> {
    if (!this.current) return false;
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
