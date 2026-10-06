import { FieldValue } from 'firebase-admin/firestore';

import type { SetTimeEntryStatusResult } from '@materia/domain';

import { timeEntryPath } from './shared';
import { audit } from '../audit/audit';
import { isDeleted } from '../contacts/shared';
import type { CallableContext } from '../core/callable';
import { matterPath } from '../matters/shared';
import { millis } from '../notes/shared';

type Data = Record<string, unknown>;

/** `FieldValue.delete()` for a patch: clears a field such as `rejection`. */
export const REMOVE = FieldValue.delete();

/**
 * Reviews a matter's entries in one transaction (BILL-03): each entry is read again, skipped when
 * missing or deleted, reported as a conflict when its `updatedAt` isn't the one the caller saw
 * (`expectedUpdatedAt`, optimistic concurrency: the author edited it meanwhile), and otherwise
 * patched with what `plan` returns (`null` skips it). Every patch is stamped with the caller and
 * the request, so the audit trigger links the entry's own audit row to the call.
 */
export async function reviewEntries(
  ctx: Pick<CallableContext<unknown>, 'db' | 'orgId' | 'uid' | 'requestId' | 'clock'>,
  input: { matterId: string; entryIds: readonly string[]; expectedUpdatedAt?: Record<string, number> | undefined },
  plan: (entry: Data, id: string) => Data | null,
): Promise<SetTimeEntryStatusResult> {
  const { db, orgId, uid, requestId, clock } = ctx;
  const ids = [...new Set(input.entryIds)];
  const refs = ids.map((id) => db.doc(timeEntryPath(orgId, input.matterId, id)));
  return db.runTransaction(async (tx) => {
    const snaps = await tx.getAll(...refs);
    const now = clock.now();
    const result: SetTimeEntryStatusResult = { updated: [], skipped: [], conflicts: [] };
    for (const snap of snaps) {
      const data = snap.exists ? (snap.data() as Data) : undefined;
      if (!data || isDeleted(data)) {
        result.skipped.push(snap.id);
        continue;
      }
      const expected = input.expectedUpdatedAt?.[snap.id];
      if (expected !== undefined && millis(data['updatedAt']) !== expected) {
        result.conflicts.push(snap.id);
        continue;
      }
      const patch = plan(data, snap.id);
      if (!patch) {
        result.skipped.push(snap.id);
        continue;
      }
      tx.update(snap.ref, { ...patch, updatedAt: now, updatedBy: uid, _requestId: requestId });
      result.updated.push(snap.id);
    }
    return result;
  });
}

/** One semantic audit row for a review call on a matter (`time.finalised`, `time.written_down`…). */
export async function auditReview(
  ctx: Parameters<typeof audit>[0],
  matterId: string,
  action: string,
  verb: string,
  result: SetTimeEntryStatusResult,
  data: Data = {},
): Promise<void> {
  if (!result.updated.length) return;
  const count = result.updated.length;
  await audit(ctx, {
    action,
    entity: { path: matterPath(ctx.orgId, matterId) },
    summary: `${count} time ${count === 1 ? 'entry' : 'entries'} ${verb}`,
    data: { entryIds: result.updated, ...data },
  });
}
