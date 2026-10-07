import type { DocumentReference, Firestore } from 'firebase-admin/firestore';

import { deadlineMatterCopy, matterCopyIsCurrent } from '@materia/domain';

import { deadlinesPath } from './shared';
import { matterPath } from '../matters/shared';

/**
 * A matter's number, title, people and jurisdiction, copied to its deadlines (`Deadline.matter`,
 * SEC-07c), so the Deadlines screen names and filters its rows without reading each one's matter.
 * Writers that read the matter stamp the copy; `deadlines-onWrite` fills or refreshes it after any
 * other write (`refreshDeadlineMatterCopy`), and `matters-denormalise` rewrites it on the matter's
 * deadlines when these fields change (`syncDeadlineMatterCopies`). Both write only a copy that
 * differs and leave `updatedAt` alone, so they converge and stop.
 */

type Data = Record<string, unknown>;

/** Writes per batch (Firestore allows 500). */
const BATCH_SIZE = 400;

const isLive = (data: Data | undefined) => !!data && (data['deletedAt'] ?? null) === null;

/** Whether a matter write changed what its deadlines copy (a create or delete never does here). */
export function matterCopyChanged(before: Data | undefined, after: Data | undefined): boolean {
  if (!before || !after) return false;
  return !matterCopyIsCurrent(deadlineMatterCopy(before), deadlineMatterCopy(after));
}

/**
 * Brings one deadline's copy in line with `matter` (the matter's data, read just before). `written`
 * is the deadline as the triggering write left it: when its copy is already current (most writes),
 * nothing is read. Otherwise reads the deadline in a transaction and writes only a live deadline
 * whose copy differs. Returns whether it wrote. A copy written from a matter that changed meanwhile
 * is caught by the write it causes: that write runs `deadlines-onWrite` again, which reads the
 * matter again.
 */
export async function refreshDeadlineMatterCopy(
  db: Firestore,
  ref: DocumentReference,
  matter: Readonly<Data>,
  written?: Data,
): Promise<boolean> {
  const copy = deadlineMatterCopy(matter);
  if (!copy) return false;
  if (written && (!isLive(written) || matterCopyIsCurrent(written['matter'], copy))) return false;
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data();
    if (!snap.exists || !isLive(data) || matterCopyIsCurrent(data?.['matter'], copy)) return false;
    tx.update(ref, { matter: copy });
    return true;
  });
}

/**
 * Brings the copies on a matter's live deadlines in line with the matter. Reads the matter's current
 * fields, not the triggering event's, so events delivered out of order converge; a repeat writes
 * nothing. Returns how many deadlines it wrote.
 */
export async function syncDeadlineMatterCopies(db: Firestore, orgId: string, matterId: string): Promise<number> {
  const matter = await db.doc(matterPath(orgId, matterId)).get();
  // Gone, or a destroyed matter's tombstone (CORE-19).
  if (!matter.exists || matter.get('destroyedAt')) return 0;
  const copy = deadlineMatterCopy(matter.data() ?? {});
  if (!copy) return 0;
  const snap = await db.collection(deadlinesPath(orgId, matterId)).get();
  const stale = snap.docs.filter((doc) => isLive(doc.data()) && !matterCopyIsCurrent(doc.get('matter'), copy));
  for (let i = 0; i < stale.length; i += BATCH_SIZE) {
    const batch = db.batch();
    for (const doc of stale.slice(i, i + BATCH_SIZE)) batch.update(doc.ref, { matter: copy });
    await batch.commit();
  }
  return stale.length;
}
