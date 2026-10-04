import { Timestamp, type Firestore } from 'firebase-admin/firestore';

import { DomainError } from '@materia/domain';

import type { Clock } from '../ports';

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/** A pending record older than this is treated as abandoned (the call crashed). */
const STALE_PENDING_MS = 2 * 60 * 1000;

export interface IdempotencyStore {
  /** Claims the key. Returns the stored result if the call already completed. */
  begin(orgId: string, requestId: string, fn: string): Promise<{ replay: true; result: unknown } | { replay: false }>;
  complete(orgId: string, requestId: string, result: unknown): Promise<void>;
  /** Releases the key after a failure, so the client can retry. */
  abandon(orgId: string, requestId: string): Promise<void>;
}

/**
 * `orgs/{orgId}/requests/{requestId}` → `{fn, status, result, expiresAt}` (Domain doc: server-only,
 * 24 h TTL on `expiresAt`). `begin` runs in a transaction, so of two concurrent calls with the same
 * key exactly one executes; the other gets REQUEST_IN_PROGRESS (retry shortly).
 */
export function firestoreIdempotency(db: () => Firestore, clock: Clock): IdempotencyStore {
  const ref = (orgId: string, requestId: string) => db().doc(`orgs/${orgId}/requests/${requestId}`);
  return {
    begin: (orgId, requestId, fn) =>
      db().runTransaction(async (tx) => {
        const now = clock.now().getTime();
        const snap = await tx.get(ref(orgId, requestId));
        if (snap.exists) {
          const data = snap.data() as { fn: string; status: string; result?: unknown; startedAt: Timestamp };
          if (data.fn !== fn) {
            throw new DomainError('CONFLICT', 'requestId was already used by another function', { requestId });
          }
          if (data.status === 'done') return { replay: true as const, result: data.result ?? null };
          if (now - data.startedAt.toMillis() < STALE_PENDING_MS) {
            throw new DomainError('REQUEST_IN_PROGRESS', 'A call with this requestId is still running', {
              requestId,
              retryAfterSeconds: 2,
            });
          }
        }
        tx.set(ref(orgId, requestId), {
          fn,
          status: 'pending',
          startedAt: Timestamp.fromMillis(now),
          expiresAt: Timestamp.fromMillis(now + IDEMPOTENCY_TTL_MS),
        });
        return { replay: false as const };
      }),
    complete: async (orgId, requestId, result) => {
      await ref(orgId, requestId).update({ status: 'done', result: result ?? null });
    },
    abandon: async (orgId, requestId) => {
      await ref(orgId, requestId).delete();
    },
  };
}
