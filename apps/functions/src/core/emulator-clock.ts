import type { Firestore } from 'firebase-admin/firestore';

import type { Clock } from '../ports';
import { isEmulator } from './env';

/**
 * Emulator only: integration tests pin "now" for one org by writing `emulatorClock/{orgId}` with a
 * `now` Timestamp (server-only, like `emulatorOutbox`), so date logic such as the matter number
 * year (CORE-03) can be tested at a boundary through the deployed callable. Outside the emulator
 * this returns `clock` without reading anything.
 */
export async function orgClock(
  db: Firestore,
  orgId: string,
  clock: Clock,
  emulator: boolean = isEmulator(),
): Promise<Clock> {
  if (!emulator) return clock;
  const pinned = (await db.doc(`emulatorClock/${orgId}`).get()).get('now') as { toDate?: () => Date } | undefined;
  const at = pinned?.toDate?.();
  return at ? { now: () => new Date(at) } : clock;
}
