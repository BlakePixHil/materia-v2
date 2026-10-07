import type { FirestoreSdk } from './firestore-client';

/*
 * A Firestore reads counter for development and e2e builds (SEC-07). It wraps the SDK module the
 * data layer loads (`FIRESTORE_SDK_LOADER`), so every read path is counted: repositories, the
 * tenancy listeners, jobs and the timer. The app installs it only when the build defines
 * `MATERIA_READS_COUNTER` (apps/web/project.json: development and e2e), so production bundles
 * don't contain it.
 *
 * What counts as a read follows Firestore's billing, as the client can see it:
 *
 * - `getDocs` from the server: one per document returned, at least one for an empty result;
 *   `getDoc`: one; transaction `get`: one.
 * - `getCountFromServer`: one per 1,000 index entries counted, at least one.
 * - A listener's first answer from the server: every document in it (at least one for a query).
 *   Later answers: one per document added, changed or removed. Firestore bills a resumed listener
 *   (back within 30 minutes) only for what changed, so this is an upper bound for a reopened screen.
 * - Anything answered from the local cache costs nothing; it is tallied as `cached`.
 *
 * Reads are labelled by path pattern (`orgs/*\/matters/*`, `tasks (group)`), so a test can tell
 * an N+1 (many single-document reads of one pattern) from a list.
 */

/** Reads by label, plus the totals. */
export interface ReadCountSnapshot {
  reads: number;
  cached: number;
  byLabel: Record<string, { reads: number; cached: number; requests: number }>;
}

export interface ReadCounter {
  /** Adds billed reads for one request or listener answer. */
  record(label: string, reads: number): void;
  /** Adds documents served from the local cache (free). */
  recordCached(label: string, docs: number): void;
  reset(): void;
  snapshot(): ReadCountSnapshot;
}

export function createReadCounter(): ReadCounter {
  let byLabel: ReadCountSnapshot['byLabel'] = {};
  const entry = (label: string) => (byLabel[label] ??= { reads: 0, cached: 0, requests: 0 });
  return {
    record(label, reads) {
      const e = entry(label);
      e.reads += reads;
      e.requests += 1;
    },
    recordCached(label, docs) {
      entry(label).cached += docs;
    },
    reset() {
      byLabel = {};
    },
    snapshot() {
      const copy = Object.fromEntries(Object.entries(byLabel).map(([label, e]) => [label, { ...e }]));
      const sum = (key: 'reads' | 'cached') => Object.values(copy).reduce((total, e) => total + e[key], 0);
      return { reads: sum('reads'), cached: sum('cached'), byLabel: copy };
    },
  };
}

/** The name tests read the counter from: `window.__materiaReads.snapshot()`. */
export const READ_COUNTER_GLOBAL = '__materiaReads';

/** Puts the counter on the global object (development and e2e builds only), for Playwright. */
export function exposeReadCounter(counter: ReadCounter, target: object = globalThis): ReadCounter {
  Object.defineProperty(target, READ_COUNTER_GLOBAL, {
    value: { snapshot: () => counter.snapshot(), reset: () => counter.reset() },
    configurable: true,
  });
  return counter;
}

/** `orgs/o1/matters/m1/tasks` → `orgs/*\/matters/*\/tasks`: document ids become `*`. */
export function pathPattern(path: string): string {
  return path
    .split('/')
    .map((segment, i) => (i % 2 ? '*' : segment))
    .join('/');
}

type Snap = {
  size?: number;
  metadata: { fromCache: boolean };
  docChanges?: () => unknown[];
  exists?: () => boolean;
  data?: () => unknown;
};
type Ref = { type?: string; path?: string };

/** Counts one listener's answers as described at the top of this file. */
function listenerMeter(counter: ReadCounter, label: string, isDocument: boolean): (snap: Snap) => void {
  let answered = false;
  let last = '';
  return (snap) => {
    if (snap.metadata.fromCache) {
      counter.recordCached(label, isDocument ? 1 : (snap.size ?? 0));
      return;
    }
    if (isDocument) {
      const data = JSON.stringify(snap.exists?.() ? snap.data?.() : null);
      if (!answered || data !== last) counter.record(label, 1);
      answered = true;
      last = data;
      return;
    }
    if (!answered) {
      answered = true;
      counter.record(label, Math.max(1, snap.size ?? 0));
      return;
    }
    const changes = snap.docChanges?.().length ?? 0;
    if (changes) counter.record(label, changes);
  };
}

/**
 * The SDK with its reads counted: the same functions, with `getDoc`, `getDocs`,
 * `getDocsFromCache`, `getCountFromServer`, `onSnapshot` and `runTransaction` wrapped.
 */
export function countReads(sdk: FirestoreSdk, counter: ReadCounter): FirestoreSdk {
  const labels = new WeakMap<object, string>();
  const labelOf = (ref: unknown): string => {
    if (ref && typeof ref === 'object') {
      const known = labels.get(ref);
      if (known) return known;
      const { path, type } = ref as Ref;
      if (typeof path === 'string') return type === 'document' ? `${pathPattern(path)} (doc)` : pathPattern(path);
    }
    return 'unknown';
  };
  const isDocument = (ref: unknown) => !!ref && (ref as Ref).type === 'document';

  const collectionGroup: FirestoreSdk['collectionGroup'] = (db, id) => {
    const q = sdk.collectionGroup(db, id);
    labels.set(q, `${id} (group)`);
    return q;
  };
  const query = ((base: object, ...constraints: unknown[]) => {
    const q = (sdk.query as (...args: unknown[]) => object)(base, ...constraints);
    labels.set(q, labelOf(base));
    return q;
  }) as FirestoreSdk['query'];

  const getDoc: FirestoreSdk['getDoc'] = async (ref) => {
    const snap = await sdk.getDoc(ref);
    if (snap.metadata.fromCache) counter.recordCached(labelOf(ref), 1);
    else counter.record(labelOf(ref), 1);
    return snap;
  };
  const getDocs: FirestoreSdk['getDocs'] = async (q) => {
    const snap = await sdk.getDocs(q);
    if (snap.metadata.fromCache) counter.recordCached(labelOf(q), snap.size);
    else counter.record(labelOf(q), Math.max(1, snap.size));
    return snap;
  };
  const getDocsFromCache: FirestoreSdk['getDocsFromCache'] = async (q) => {
    const snap = await sdk.getDocsFromCache(q);
    counter.recordCached(labelOf(q), snap.size);
    return snap;
  };
  const getCountFromServer: FirestoreSdk['getCountFromServer'] = async (q) => {
    const result = await sdk.getCountFromServer(q);
    counter.record(`${labelOf(q)} (count)`, Math.max(1, Math.ceil(result.data().count / 1000)));
    return result;
  };
  const onSnapshot = ((ref: unknown, ...args: unknown[]) => {
    const meter = listenerMeter(counter, labelOf(ref), isDocument(ref));
    let wrapped = false;
    const wrappedArgs = args.map((arg) => {
      if (wrapped) return arg;
      if (typeof arg === 'function') {
        wrapped = true;
        return (snap: Snap) => {
          meter(snap);
          return (arg as (snap: Snap) => unknown)(snap);
        };
      }
      if (arg && typeof arg === 'object' && typeof (arg as { next?: unknown }).next === 'function') {
        wrapped = true;
        const observer = arg as { next: (snap: Snap) => unknown };
        return {
          ...observer,
          next: (snap: Snap) => {
            meter(snap);
            return observer.next(snap);
          },
        };
      }
      return arg;
    });
    return (sdk.onSnapshot as (...a: unknown[]) => () => void)(ref, ...wrappedArgs);
  }) as FirestoreSdk['onSnapshot'];
  const runTransaction: FirestoreSdk['runTransaction'] = (db, update, options) =>
    sdk.runTransaction(
      db,
      (tx) => {
        const get = (async (ref: Parameters<typeof tx.get>[0]) => {
          const snap = await tx.get(ref);
          counter.record(labelOf(ref), 1);
          return snap;
        }) as typeof tx.get;
        const counted = new Proxy(tx, {
          get(target, prop) {
            if (prop === 'get') return get;
            const value: unknown = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        return update(counted);
      },
      options,
    );

  return {
    ...sdk,
    collectionGroup,
    query,
    getDoc,
    getDocs,
    getDocsFromCache,
    getCountFromServer,
    onSnapshot,
    runTransaction,
  };
}
