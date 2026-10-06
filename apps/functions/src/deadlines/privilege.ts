import type { Firestore } from 'firebase-admin/firestore';

import { changesPath, deadlinesPath, eventsPath } from './shared';
import { matterPath } from '../matters/shared';

/**
 * A matter's privileged flag, copied to its events, deadlines and deadline proposals (CORE-10b).
 * The rules read the copy in cross-matter queries ("deadlines this week"), which can't read each
 * record's matter, so roles without `privileged.view` only see records that prove
 * `privileged == false`. Every writer copies the flag from the matter it reads in the same
 * transaction; `matters-denormalise` calls `syncMatterPrivilege` when the matter's flag changes.
 */

type Data = Record<string, unknown>;

/** The subcollections that carry the copy. */
export const PRIVILEGE_COPIES = [
  { collection: 'events', path: eventsPath },
  { collection: 'deadlines', path: deadlinesPath },
  { collection: 'deadlineChanges', path: changesPath },
] as const;

/** Writes per batch (Firestore allows 500). */
const BATCH_SIZE = 400;

/** Whether a matter write changed its privileged flag (a create or delete never does here). */
export function privilegeChanged(before: Data | undefined, after: Data | undefined): boolean {
  return !!before && !!after && (before['privileged'] === true) !== (after['privileged'] === true);
}

/**
 * Brings the copies on a matter's events, deadlines and proposals in line with the matter's flag.
 * Reads the matter's current flag, not the triggering event's, so events delivered out of order
 * converge; writes only the records that differ (a repeat writes nothing) and leaves `updatedAt`
 * alone. Returns how many records it wrote.
 */
export async function syncMatterPrivilege(db: Firestore, orgId: string, matterId: string): Promise<number> {
  const matter = await db.doc(matterPath(orgId, matterId)).get();
  // Gone, or a destroyed matter's tombstone (CORE-19).
  if (!matter.exists || matter.get('destroyedAt')) return 0;
  const privileged = matter.get('privileged') === true;
  let written = 0;
  for (const { path } of PRIVILEGE_COPIES) {
    const snap = await db.collection(path(orgId, matterId)).get();
    const stale = snap.docs.filter((doc) => doc.get('privileged') !== privileged);
    for (let i = 0; i < stale.length; i += BATCH_SIZE) {
      const batch = db.batch();
      for (const doc of stale.slice(i, i + BATCH_SIZE)) batch.update(doc.ref, { privileged });
      await batch.commit();
    }
    written += stale.length;
  }
  return written;
}
