import type { FirestoreHandle, FirestoreSource, ListenerSyncState } from './firestore-client';
import { firestoreDriver } from './firestore-driver';

/** A snapshot's metadata and document refs, as much of the SDK's shape as the driver reads. */
function docSnap(path: string, pending = false, fromCache = false) {
  return {
    id: path.split('/').pop(),
    ref: { path },
    exists: () => true,
    metadata: { hasPendingWrites: pending, fromCache },
  };
}

function querySnap(docs: ReturnType<typeof docSnap>[], fromCache: boolean) {
  return { docs, metadata: { fromCache, hasPendingWrites: docs.some((d) => d.metadata.hasPendingWrites) } };
}

/** An SDK whose listeners the test drives: `emit` sends the latest listener a snapshot, `fail` an error. */
function fakeSource() {
  const states: [object, ListenerSyncState | null][] = [];
  let emit: (snap: unknown) => void = () => undefined;
  let fail: (e: unknown) => void = () => undefined;
  const unsubscribed: number[] = [];
  const sdk = {
    collection: (_db: unknown, path: string) => path,
    query: (base: string) => base,
    doc: (_db: unknown, path: string, id: string) => `${path}/${id}`,
    onSnapshot: (_target: unknown, _options: unknown, next: (snap: unknown) => void, error: (e: unknown) => void) => {
      emit = next;
      fail = error;
      return () => unsubscribed.push(1);
    },
  };
  const handle = { sdk, db: {} } as unknown as FirestoreHandle;
  const source: FirestoreSource = {
    get: async () => handle,
    observe: (listener, state) => states.push([listener, state]),
  };
  return {
    source,
    states,
    unsubscribed,
    emit: (snap: unknown) => emit(snap),
    fail: (e: unknown) => fail(e),
  };
}

const page = { spec: {}, after: null, end: null, limit: null };
const settle = () => new Promise((resolve) => setTimeout(resolve));

describe('firestoreDriver sync reporting (MOB-01)', () => {
  it('reports each query snapshot’s cache state and pending documents, then forgets the listener', async () => {
    const fake = fakeSource();
    const pages: unknown[] = [];
    const stop = firestoreDriver(fake.source, 'orgs/o1/tasks').listen(page, (p) => pages.push(p), vi.fn());
    await settle();

    fake.emit(querySnap([docSnap('orgs/o1/tasks/t1', true, true), docSnap('orgs/o1/tasks/t2')], true));
    fake.emit(querySnap([docSnap('orgs/o1/tasks/t1'), docSnap('orgs/o1/tasks/t2')], false));
    expect(pages).toHaveLength(2);
    const [first, second] = fake.states;
    expect(first?.[1]).toEqual({ fromCache: true, pending: ['orgs/o1/tasks/t1'] });
    expect(second?.[1]).toEqual({ fromCache: false, pending: [] });
    // One listener, one key.
    expect(second?.[0]).toBe(first?.[0]);

    stop();
    expect(fake.unsubscribed).toHaveLength(1);
    expect(fake.states.at(-1)).toEqual([first?.[0], null]);
  });

  it('reports a watched document, and forgets a listener that fails', async () => {
    const fake = fakeSource();
    const error = vi.fn();
    firestoreDriver(fake.source, 'orgs/o1/matters').watchDoc('m1', vi.fn(), error);
    await settle();

    fake.emit(docSnap('orgs/o1/matters/m1', true, true));
    expect(fake.states.at(-1)?.[1]).toEqual({ fromCache: true, pending: ['orgs/o1/matters/m1'] });
    const denied = { code: 'permission-denied' };
    fake.fail(denied);
    expect(fake.states.at(-1)?.[1]).toBeNull();
    expect(error).toHaveBeenCalledWith(denied);
  });
});
