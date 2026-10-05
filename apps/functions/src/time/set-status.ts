import type { DocumentReference } from 'firebase-admin/firestore';

import {
  chunkWrites,
  computeTimeEntry,
  PERMISSIONS,
  SetTimeEntryStatusInput,
  type RateMatter,
  type RateMember,
  type SetTimeEntryStatusResult,
} from '@materia/domain';

import { rateOrg, timeEntryPath } from './shared';
import { isDeleted } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { liveMatter, matterPath } from '../matters/shared';

type Data = Record<string, unknown>;

/** Writes per batch (a Firestore batch takes 500). */
const BATCH_SIZE = 250;

/** The change for one entry, or `null` to skip it (missing, deleted, billed, written off or already so). */
export function statusPatch(entry: Data | undefined, status: 'draft' | 'final'): Data | null {
  if (!entry || isDeleted(entry)) return null;
  const from = entry['status'];
  if (status === 'final' ? from !== 'draft' : from !== 'final') return null;
  return { status };
}

/**
 * `time-setStatus` (BILL-01; `time.approve`, idempotent): approves a matter's draft entries
 * (`final`) or returns final ones to draft. Approval snapshots each entry's units, rate and amount
 * from the rate in force on its date one last time; after that `time-onWrite` leaves the values
 * alone and only keeps the matter's WIP. Entries that are missing, deleted, billed, written off or
 * already in that status are skipped and listed. The matter must be live and visible to the caller.
 */
export const setStatusDefinition = {
  name: 'time-setStatus',
  input: SetTimeEntryStatusInput,
  roles: PERMISSIONS['time.approve'],
  idempotent: true,
  handler: async ({ input, orgId, uid, role, db, requestId, clock, log }): Promise<SetTimeEntryStatusResult> => {
    const matter = liveMatter(await db.doc(matterPath(orgId, input.matterId)).get(), role, input.matterId);
    const ids = [...new Set(input.entryIds)];
    const snaps = await db.getAll(...ids.map((id) => db.doc(timeEntryPath(orgId, input.matterId, id))));
    const org = input.status === 'final' ? rateOrg((await db.doc(`orgs/${orgId}`).get()).data()) : null;
    const authors = [...new Set(snaps.flatMap((snap) => (snap.exists ? [String(snap.get('uid'))] : [])))];
    const members = new Map(
      org && authors.length
        ? (await db.getAll(...authors.map((author) => db.doc(`orgs/${orgId}/members/${author}`)))).map((snap) => [
            snap.id,
            (snap.data() as RateMember | undefined) ?? null,
          ])
        : [],
    );

    const now = clock.now();
    const updated: string[] = [];
    const skipped: string[] = [];
    const writes: { ref: DocumentReference; patch: Data }[] = [];
    snaps.forEach((snap) => {
      const id = snap.id;
      const data = snap.exists ? (snap.data() as Data) : undefined;
      const patch = statusPatch(data, input.status);
      if (!data || !patch) {
        skipped.push(id);
        return;
      }
      if (org && typeof data['minutes'] === 'number' && typeof data['date'] === 'string') {
        const values = computeTimeEntry({
          minutes: data['minutes'],
          date: data['date'],
          org,
          matter: matter as RateMatter,
          member: members.get(String(data['uid'])) ?? null,
        });
        Object.assign(patch, { units: values.units, rateCents: values.rateCents, amountCents: values.amountCents });
      }
      writes.push({ ref: snap.ref, patch: { ...patch, updatedAt: now, updatedBy: uid, _requestId: requestId } });
      updated.push(id);
    });

    for (const batchWrites of chunkWrites(writes, BATCH_SIZE)) {
      const batch = db.batch();
      for (const write of batchWrites) batch.update(write.ref, write.patch);
      await batch.commit();
    }
    log.info('time entry status set', {
      matterId: input.matterId,
      status: input.status,
      updated: updated.length,
      skipped: skipped.length,
    });
    return { updated, skipped };
  },
} satisfies CallableDefinition<typeof SetTimeEntryStatusInput, SetTimeEntryStatusResult>;

export const setStatus = defineCallable(setStatusDefinition);
