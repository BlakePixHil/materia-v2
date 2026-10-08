import type { DocumentReference, Firestore } from 'firebase-admin/firestore';

import { deadlineMatterCopy, matterCopyIsCurrent } from '@materia/domain';

/**
 * A matter's number, title, type, people and jurisdiction, copied to its deadlines
 * (`Deadline.matter`, SEC-07c), so the Deadlines and Today screens name and filter their rows
 * without reading each one's matter. Writers that read the matter stamp the copy;
 * `deadlines-onWrite` fills or refreshes it after any other write (`refreshDeadlineMatterCopy`),
 * and `matters-denormalise` rewrites it with the matter's other copies (`syncMatterCopies` in
 * matters/copies.ts). Both write only a copy that differs and leave `updatedAt` alone, so they
 * converge and stop.
 */

type Data = Record<string, unknown>;

const isLive = (data: Data | undefined) => !!data && (data['deletedAt'] ?? null) === null;

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
