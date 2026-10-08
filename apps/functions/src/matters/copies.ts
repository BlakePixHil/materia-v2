import type { DocumentReference, Firestore } from 'firebase-admin/firestore';

import { deadlineMatterCopy, matterCopyIsCurrent, recentMatterCopy, taskMatterCopy } from '@materia/domain';

import { matterPath } from './shared';
import { changesPath, deadlinesPath, tasksPath } from '../deadlines/shared';

/**
 * A matter's copies on the records other screens list (SEC-07c, SEC-07e): its live deadlines and
 * pending proposals (`deadlineMatterCopy`), its live tasks (`taskMatterCopy`) and everyone's recent
 * entries for it (`recentMatterCopy`). The Deadlines and Today screens name their rows from these
 * instead of reading each row's matter. Writers that read the matter stamp the copy as they write;
 * `deadlines-onWrite` and `tasks-onWrite` fill or refresh it after any other write; the person
 * writes it on their recent entry when they open the matter; and `matters-denormalise` calls
 * `syncMatterCopies` when what the copies say changes. Every writer writes only a copy that differs
 * and leaves `updatedAt` alone (a recent entry's is when it was last opened), so they converge.
 */

type Data = Record<string, unknown>;

/** Writes per batch (Firestore allows 500). */
const BATCH_SIZE = 400;

const isLive = (data: Data | undefined) => !!data && (data['deletedAt'] ?? null) === null;

/** Whether a matter write changed what any of its copies say (a create or delete never does here). */
export function matterCopiesChanged(before: Data | undefined, after: Data | undefined): boolean {
  if (!before || !after) return false;
  return (
    !matterCopyIsCurrent(deadlineMatterCopy(before), deadlineMatterCopy(after)) ||
    !matterCopyIsCurrent(taskMatterCopy(before), taskMatterCopy(after)) ||
    !matterCopyIsCurrent(recentMatterCopy(before), recentMatterCopy(after))
  );
}

/** How many records `syncMatterCopies` rewrote, by kind. */
export interface MatterCopyWrites {
  deadlines: number;
  proposals: number;
  tasks: number;
  recents: number;
}

/**
 * Brings every copy of a matter in line with it. Reads the matter's current fields, not the
 * triggering event's, so events delivered out of order converge; a repeat writes nothing. A
 * destroyed matter's tombstone (CORE-19) is left alone: `matters-destroy` deletes what was under
 * it and the recent entries.
 */
export async function syncMatterCopies(db: Firestore, orgId: string, matterId: string): Promise<MatterCopyWrites> {
  const writes: MatterCopyWrites = { deadlines: 0, proposals: 0, tasks: 0, recents: 0 };
  const matter = await db.doc(matterPath(orgId, matterId)).get();
  if (!matter.exists || matter.get('destroyedAt')) return writes;
  const data = matter.data() ?? {};
  const deadline = deadlineMatterCopy(data);
  const task = taskMatterCopy(data);
  const recent = recentMatterCopy(data);
  const [deadlines, proposals, tasks, recents] = await Promise.all([
    db.collection(deadlinesPath(orgId, matterId)).get(),
    db.collection(changesPath(orgId, matterId)).where('status', '==', 'pending').get(),
    db.collection(tasksPath(orgId, matterId)).get(),
    // Indexed (collection group): orgId, matterId. Tasks and documents opened on the matter too.
    db.collectionGroup('recent').where('orgId', '==', orgId).where('matterId', '==', matterId).get(),
  ]);
  const stale = (docs: typeof deadlines.docs, copy: object | null, keep: (data: Data) => boolean) =>
    copy ? docs.filter((doc) => keep(doc.data()) && !matterCopyIsCurrent(doc.get('matter'), copy)) : [];
  writes.deadlines = await writeCopies(db, stale(deadlines.docs, deadline, isLive), deadline);
  writes.proposals = await writeCopies(
    db,
    stale(proposals.docs, deadline, () => true),
    deadline,
  );
  writes.tasks = await writeCopies(db, stale(tasks.docs, task, isLive), task);
  writes.recents = await writeCopies(
    db,
    stale(recents.docs, recent, (entry) => (entry['kind'] ?? 'matter') === 'matter'),
    recent,
  );
  return writes;
}

async function writeCopies(
  db: Firestore,
  docs: readonly { ref: DocumentReference }[],
  copy: object | null,
): Promise<number> {
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = db.batch();
    for (const doc of docs.slice(i, i + BATCH_SIZE)) batch.update(doc.ref, { matter: copy });
    await batch.commit();
  }
  return docs.length;
}
