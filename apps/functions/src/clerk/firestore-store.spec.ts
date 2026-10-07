import type { Firestore } from 'firebase-admin/firestore';

import { firestoreClerkStore } from './firestore-store';
import type { MeterEntry } from './store';
import { memoryFirestore } from '../orgs/testing';

/** The gateway's Firestore store (AI-02). Every org and member is fictional. */

const PERIOD_PATH = 'orgs/org-a/metrics/clerk-2026-10';
const AT = new Date('2026-10-05T00:00:00.000Z');
const entry = (uid: string): MeterEntry => ({
  feature: 'chat',
  uid,
  usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 0 },
  costMicros: 500,
  costEstimated: false,
});

describe('firestoreClerkStore.meter', () => {
  it('meters each call with blind increments, never a transaction on the month (SEC-07)', async () => {
    const store = memoryFirestore();
    // Every Clerk call in the org meters onto this one document: a transaction that reads it
    // first makes concurrent calls contend for it (a fifth failed to meter at 10x peak).
    const db = store.db as unknown as { runTransaction: (...args: unknown[]) => Promise<unknown> };
    const run = db.runTransaction.bind(db);
    let transactions = 0;
    db.runTransaction = (...args) => {
      transactions++;
      return run(...args);
    };
    const clerk = firestoreClerkStore(store.db as unknown as Firestore);

    await Promise.all(
      ['user-a', 'user-a', 'user-b'].map((uid) => clerk.meter('org-a', 'clerk-2026-10', entry(uid), AT)),
    );
    await clerk.meter('org-a', 'clerk-2026-10', entry('user-b'), AT);

    expect(transactions).toBe(0);
    const doc = store.docs.get(PERIOD_PATH) as Record<string, unknown>;
    expect(doc).toMatchObject({ period: 'clerk-2026-10', createdBy: 'system', updatedBy: 'system', schemaVersion: 1 });
    expect(doc['values']).toEqual({
      calls: 4,
      tokens: 600,
      inputTokens: 400,
      outputTokens: 80,
      cacheReadTokens: 120,
      cacheWriteTokens: 0,
      costMicros: 2000,
      'feature.chat.calls': 4,
      'feature.chat.tokens': 600,
      'feature.chat.costMicros': 2000,
      'user.user-a.calls': 2,
      'user.user-a.tokens': 300,
      'user.user-a.costMicros': 1000,
      'user.user-b.calls': 2,
      'user.user-b.tokens': 300,
      'user.user-b.costMicros': 1000,
    });
  });

  it('adds to a month another instance created', async () => {
    const store = memoryFirestore({
      [PERIOD_PATH]: { period: 'clerk-2026-10', values: { calls: 7, tokens: 1_000 }, createdBy: 'system' },
    });
    await firestoreClerkStore(store.db as unknown as Firestore).meter('org-a', 'clerk-2026-10', entry('user-a'), AT);
    expect((store.docs.get(PERIOD_PATH) as Record<string, unknown>)['values']).toMatchObject({
      calls: 8,
      tokens: 1_150,
    });
  });
});
