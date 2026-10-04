import { Timestamp, type Firestore } from 'firebase-admin/firestore';

import { firestoreIdempotency, IDEMPOTENCY_TTL_MS } from './idempotency';
import { FakeClock } from '../ports/fakes';

/** Just enough Firestore for the store: doc refs, update/delete and a serial transaction. */
function memoryDb() {
  const docs = new Map<string, Record<string, unknown>>();
  const ref = (path: string) => ({
    path,
    update: async (data: Record<string, unknown>) => void docs.set(path, { ...docs.get(path), ...data }),
    delete: async () => void docs.delete(path),
  });
  const db = {
    doc: ref,
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>) =>
      fn({
        get: async (r: { path: string }) => ({ exists: docs.has(r.path), data: () => docs.get(r.path) }),
        set: (r: { path: string }, data: Record<string, unknown>) => void docs.set(r.path, data),
      }),
  } as unknown as Firestore;
  return { db, docs };
}

const ID = '6f1c1c2e-8a43-4b8e-9d0e-0a3f5b1d2c4e';

describe('firestoreIdempotency', () => {
  it('claims a key, stores the result with a 24 h expiry, and replays it', async () => {
    const clock = new FakeClock();
    const { db, docs } = memoryDb();
    const store = firestoreIdempotency(() => db, clock);

    expect(await store.begin('org-a', ID, 'system-echo')).toEqual({ replay: false });
    const record = docs.get(`orgs/org-a/requests/${ID}`) as { status: string; expiresAt: Timestamp };
    expect(record.status).toBe('pending');
    expect(record.expiresAt.toMillis() - clock.now().getTime()).toBe(IDEMPOTENCY_TTL_MS);

    await store.complete('org-a', ID, { ok: 1 });
    expect(await store.begin('org-a', ID, 'system-echo')).toEqual({ replay: true, result: { ok: 1 } });
  });

  it('rejects a concurrent call while the first is running, and reclaims an abandoned one', async () => {
    const clock = new FakeClock();
    const { db } = memoryDb();
    const store = firestoreIdempotency(() => db, clock);
    await store.begin('org-a', ID, 'system-echo');
    await expect(store.begin('org-a', ID, 'system-echo')).rejects.toMatchObject({ code: 'REQUEST_IN_PROGRESS' });
    clock.advance(3 * 60 * 1000);
    expect(await store.begin('org-a', ID, 'system-echo')).toEqual({ replay: false });
  });

  it('rejects a key reused by another function, and frees a key on abandon', async () => {
    const clock = new FakeClock();
    const { db, docs } = memoryDb();
    const store = firestoreIdempotency(() => db, clock);
    await store.begin('org-a', ID, 'system-echo');
    await expect(store.begin('org-a', ID, 'matters-create')).rejects.toMatchObject({ code: 'CONFLICT' });
    await store.abandon('org-a', ID);
    expect(docs.size).toBe(0);
    expect(await store.begin('org-a', ID, 'system-echo')).toEqual({ replay: false });
    await store.complete('org-a', ID, undefined);
    expect(await store.begin('org-a', ID, 'system-echo')).toEqual({ replay: true, result: null });
  });
});
