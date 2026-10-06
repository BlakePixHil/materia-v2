import type { DocumentReference } from 'firebase-admin/firestore';

import {
  chunkWrites,
  PERMISSIONS,
  SetDisbursementStatusInput,
  type SetDisbursementStatusResult,
} from '@materia/domain';

import { disbursementPath } from './shared';
import { isDeleted } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { requireFlag } from '../core/flags';
import { matterPath, writableMatter } from '../matters/shared';

type Data = Record<string, unknown>;

/** Writes per batch (a Firestore batch takes 500). */
const BATCH_SIZE = 250;

/** The change for one disbursement, or `null` to skip it (missing, deleted, billed or already so). */
export function disbursementStatusPatch(data: Data | undefined, status: 'unbilled' | 'written_off'): Data | null {
  if (!data || isDeleted(data)) return null;
  const from = data['status'];
  if (status === 'written_off' ? from !== 'unbilled' : from !== 'written_off') return null;
  return { status };
}

/**
 * `disbursements-setStatus` (BILL-04; `time.approve`, idempotent, behind `billing.disbursements`):
 * writes off a matter's unbilled disbursements or restores written-off ones. `disbursements-onWrite`
 * then takes them out of (or puts them back into) the matter's `disbursementWipCents`. Billed ones
 * never change here (invariant 5); missing, deleted and already-set ones are skipped and listed.
 * The matter must be live, not archived (CORE-19), and visible to the caller. Audited by the audit trigger.
 */
export const setStatusDefinition = {
  name: 'disbursements-setStatus',
  input: SetDisbursementStatusInput,
  roles: PERMISSIONS['time.approve'],
  idempotent: true,
  handler: async ({ input, orgId, uid, role, db, requestId, clock, log }): Promise<SetDisbursementStatusResult> => {
    await requireFlag({ orgId, db, clock }, 'billing.disbursements');
    writableMatter(await db.doc(matterPath(orgId, input.matterId)).get(), role, input.matterId);
    const ids = [...new Set(input.disbursementIds)];
    const snaps = await db.getAll(...ids.map((id) => db.doc(disbursementPath(orgId, input.matterId, id))));

    const now = clock.now();
    const updated: string[] = [];
    const skipped: string[] = [];
    const writes: { ref: DocumentReference; patch: Data }[] = [];
    for (const snap of snaps) {
      const patch = disbursementStatusPatch(snap.exists ? (snap.data() as Data) : undefined, input.status);
      if (!patch) {
        skipped.push(snap.id);
        continue;
      }
      writes.push({ ref: snap.ref, patch: { ...patch, updatedAt: now, updatedBy: uid, _requestId: requestId } });
      updated.push(snap.id);
    }

    for (const batchWrites of chunkWrites(writes, BATCH_SIZE)) {
      const batch = db.batch();
      for (const write of batchWrites) batch.update(write.ref, write.patch);
      await batch.commit();
    }
    log.info('disbursement status set', {
      matterId: input.matterId,
      status: input.status,
      updated: updated.length,
      skipped: skipped.length,
    });
    return { updated, skipped };
  },
} satisfies CallableDefinition<typeof SetDisbursementStatusInput, SetDisbursementStatusResult>;

export const setStatus = defineCallable(setStatusDefinition);
