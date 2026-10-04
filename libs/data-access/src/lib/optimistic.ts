import type { WritableSignal } from '@angular/core';

import { toDomainError } from './errors';

/**
 * Optimistic updates (FND-19) for state Firestore's latency compensation doesn't cover, such as a
 * store behind a callable: applies `mutate` to the store now, runs `action`, and on failure rolls
 * back (by default to the value before the change) and rethrows the error as a `DomainError`.
 *
 * ```ts
 * await optimistic(this.items, (items) => items.filter((i) => i.id !== id), () => archive.run({ id }));
 * ```
 *
 * Client-direct writes through a repository don't need this: listeners already show the local
 * write before the server confirms it.
 */
export async function optimistic<T, R>(
  store: WritableSignal<T>,
  mutate: (current: T) => T,
  action: () => Promise<R>,
  rollback: (current: T, before: T) => T = (_current, before) => before,
): Promise<R> {
  const before = store();
  store.set(mutate(before));
  try {
    return await action();
  } catch (error) {
    store.set(rollback(store(), before));
    throw toDomainError(error, 'callable');
  }
}
