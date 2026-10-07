import type { FirestoreSdk } from './firestore-client';
import { countReads, createReadCounter, exposeReadCounter, pathPattern, READ_COUNTER_GLOBAL } from './read-counter';

type Listener = (snap: unknown) => void;

/** Just enough of the SDK for the wrapper: references carry `type` and `path` as the real ones do. */
function fakeSdk() {
  const listeners: Listener[] = [];
  const results = { docs: 0, fromCache: false, count: 0 };
  const sdk = {
    collection: (_db: unknown, path: string) => ({ type: 'collection', path }),
    collectionGroup: (_db: unknown, id: string) => ({ type: 'query', id }),
    doc: (_db: unknown, path: string) => ({ type: 'document', path }),
    query: (base: object) => ({ type: 'query', base }),
    where: () => ({}),
    getDoc: async () => ({ metadata: { fromCache: results.fromCache } }),
    getDocs: async () => ({ size: results.docs, metadata: { fromCache: results.fromCache } }),
    getDocsFromCache: async () => ({ size: results.docs, metadata: { fromCache: true } }),
    getCountFromServer: async () => ({ data: () => ({ count: results.count }) }),
    onSnapshot: (_ref: unknown, ...args: unknown[]) => {
      const next = args.find((a) => typeof a === 'function') as Listener | undefined;
      const observer = args.find((a) => a && typeof a === 'object' && 'next' in a) as { next: Listener } | undefined;
      const listener = next ?? observer?.next;
      if (listener) listeners.push(listener);
      return () => undefined;
    },
    runTransaction: async (_db: unknown, update: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        writes: 0,
        get: async () => ({ exists: () => true }),
        set(this: { writes: number }) {
          this.writes++;
          return this;
        },
      };
      const result = await update(tx);
      return { result, writes: tx.writes };
    },
  };
  /** The `n`th listener registered. */
  const listener = (n: number): Listener => {
    const found = listeners[n];
    if (!found) throw new Error(`No listener ${n}`);
    return found;
  };
  return { sdk: sdk as unknown as FirestoreSdk, listener, results };
}

const querySnap = (size: number, fromCache: boolean, changes = 0) => ({
  size,
  metadata: { fromCache },
  docChanges: () => Array.from({ length: changes }),
});
const docSnap = (data: unknown, fromCache = false) => ({
  metadata: { fromCache },
  exists: () => data !== null,
  data: () => data,
});

describe('countReads', () => {
  it('labels reads by path pattern, and counts one-shot reads as Firestore bills them', async () => {
    const { sdk, results } = fakeSdk();
    const counter = createReadCounter();
    const s = countReads(sdk, counter);
    const db = {} as never;

    results.docs = 12;
    await s.getDocs(s.query(s.collection(db, 'orgs/o1/matters')));
    results.docs = 0;
    await s.getDocs(s.query(s.collectionGroup(db, 'tasks')));
    await s.getDoc(s.doc(db, 'orgs/o1/matters/m1'));
    await s.getDoc(s.doc(db, 'orgs/o1/matters/m2'));
    results.count = 2_400;
    await s.getCountFromServer(s.query(s.collection(db, 'orgs/o1/matters')));
    results.docs = 7;
    await s.getDocsFromCache(s.query(s.collection(db, 'orgs/o1/matters')));
    results.fromCache = true;
    await s.getDocs(s.query(s.collectionGroup(db, 'deadlines')));

    const snap = counter.snapshot();
    expect(snap.byLabel).toEqual({
      'orgs/*/matters': { reads: 12, cached: 7, requests: 1 },
      'tasks (group)': { reads: 1, cached: 0, requests: 1 },
      'orgs/*/matters/* (doc)': { reads: 2, cached: 0, requests: 2 },
      'orgs/*/matters (count)': { reads: 3, cached: 0, requests: 1 },
      'deadlines (group)': { reads: 0, cached: 7, requests: 0 },
    });
    expect(snap.reads).toBe(18);
    expect(snap.cached).toBe(14);

    counter.reset();
    expect(counter.snapshot()).toEqual({ reads: 0, cached: 0, byLabel: {} });
  });

  it('counts a query listener’s first server answer in full, then only what changed', () => {
    const { sdk, listener } = fakeSdk();
    const counter = createReadCounter();
    const s = countReads(sdk, counter);
    const seen: unknown[] = [];
    s.onSnapshot(s.query(s.collectionGroup({} as never, 'deadlines')), { includeMetadataChanges: true }, (snap) =>
      seen.push(snap),
    );
    const emit = listener(0);
    emit(querySnap(5, true, 5)); // the cache first: free
    emit(querySnap(6, false, 1)); // the server's first answer: every document
    emit(querySnap(6, false, 0)); // metadata only
    emit(querySnap(6, false, 2)); // two documents changed
    expect(seen).toHaveLength(4);
    expect(counter.snapshot().byLabel['deadlines (group)']).toEqual({ reads: 8, cached: 5, requests: 2 });

    // An empty result is still one read.
    s.onSnapshot(s.collection({} as never, 'orgs/o1/members'), { next: () => undefined });
    listener(1)(querySnap(0, false));
    expect(counter.snapshot().byLabel['orgs/*/members']).toEqual({ reads: 1, cached: 0, requests: 1 });
  });

  it('counts a document listener once, then again only when the data changes', () => {
    const { sdk, listener } = fakeSdk();
    const counter = createReadCounter();
    const s = countReads(sdk, counter);
    s.onSnapshot(
      s.doc({} as never, 'users/u1'),
      () => undefined,
      () => undefined,
    );
    const emit = listener(0);
    emit(docSnap({ a: 1 }, true));
    emit(docSnap({ a: 1 }));
    emit(docSnap({ a: 1 }));
    emit(docSnap({ a: 2 }));
    emit(docSnap(null));
    expect(counter.snapshot().byLabel['users/* (doc)']).toEqual({ reads: 3, cached: 1, requests: 3 });
  });

  it('counts transaction reads and leaves the other transaction methods working', async () => {
    const { sdk } = fakeSdk();
    const counter = createReadCounter();
    const s = countReads(sdk, counter);
    const ref = s.doc({} as never, 'users/u1/timers/t1');
    const outcome = (await s.runTransaction({} as never, async (tx) => {
      await tx.get(ref);
      tx.set(ref, {});
      return 'done';
    })) as unknown as { result: string; writes: number };
    expect(outcome).toEqual({ result: 'done', writes: 1 });
    expect(counter.snapshot().byLabel['users/*/timers/* (doc)']).toEqual({ reads: 1, cached: 0, requests: 1 });
  });

  it('exposes the counter for e2e tests, and writes path patterns', () => {
    const counter = createReadCounter();
    const target: Record<string, { snapshot(): unknown; reset(): void }> = {};
    exposeReadCounter(counter, target);
    counter.record('x', 2);
    expect(target[READ_COUNTER_GLOBAL]?.snapshot()).toMatchObject({ reads: 2 });
    target[READ_COUNTER_GLOBAL]?.reset();
    expect(counter.snapshot().reads).toBe(0);
    expect(pathPattern('orgs/o1/matters/m1/tasks')).toBe('orgs/*/matters/*/tasks');
  });
});
