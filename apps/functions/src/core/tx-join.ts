import type { Transaction } from 'firebase-admin/firestore';

/**
 * Lets a caller join its own reads and writes to another function's transaction (AI-07, ADR-037):
 * accepting a Clerk suggestion re-checks and resolves the suggestion in the same transaction as the
 * domain write it applies, so exactly one of two concurrent accepts commits.
 *
 * The host transaction calls `read` before it writes anything (Firestore needs every read first)
 * and `write` after its own writes, with the path of the record it created or changed. Both run
 * again when the transaction retries; `read` may throw to abort it.
 */
export interface TxJoin {
  read(tx: Transaction): Promise<void>;
  write(tx: Transaction, resultRef: string): void;
}
