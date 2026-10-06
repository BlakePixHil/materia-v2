import {
  computeTimeEntry,
  PERMISSIONS,
  SetTimeEntryStatusInput,
  type RateMatter,
  type RateMember,
  type SetTimeEntryStatusResult,
} from '@materia/domain';

import { auditReview, REMOVE, reviewEntries } from './review';
import { rateOrg, timeEntryPath } from './shared';
import { isDeleted } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { liveMatter, matterPath } from '../matters/shared';

type Data = Record<string, unknown>;

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
 * from the rate in force on its date one last time, and clears a send-back note (BILL-03); after
 * that `time-onWrite` leaves the values alone and only keeps the matter's WIP. Entries that are
 * missing, deleted, billed, written off or already in that status are skipped and listed; entries
 * changed since the caller saw them (`expectedUpdatedAt`) are conflicts. One transaction, so an
 * author's edit can't slip in between the check and the approval. The matter must be live and
 * visible to the caller. Audited as `time.finalised` or `time.returned_to_draft`.
 */
export const setStatusDefinition = {
  name: 'time-setStatus',
  input: SetTimeEntryStatusInput,
  roles: PERMISSIONS['time.approve'],
  idempotent: true,
  handler: async (ctx): Promise<SetTimeEntryStatusResult> => {
    const { input, orgId, role, db, log } = ctx;
    const matter = liveMatter(await db.doc(matterPath(orgId, input.matterId)).get(), role, input.matterId);
    const ids = [...new Set(input.entryIds)];
    const org = input.status === 'final' ? rateOrg((await db.doc(`orgs/${orgId}`).get()).data()) : null;
    const members = new Map<string, RateMember | null>();
    if (org) {
      // Rates are read before the transaction: they don't change with the entries.
      const snaps = await db.getAll(...ids.map((id) => db.doc(timeEntryPath(orgId, input.matterId, id))));
      const authors = [...new Set(snaps.flatMap((snap) => (snap.exists ? [String(snap.get('uid'))] : [])))];
      if (authors.length) {
        const memberSnaps = await db.getAll(...authors.map((author) => db.doc(`orgs/${orgId}/members/${author}`)));
        for (const snap of memberSnaps) members.set(snap.id, (snap.data() as RateMember | undefined) ?? null);
      }
    }
    const result = await reviewEntries(ctx, input, (data) => {
      const patch = statusPatch(data, input.status);
      if (!patch) return null;
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
      if (input.status === 'final' && data['rejection'] !== undefined) patch['rejection'] = REMOVE;
      return patch;
    });
    await auditReview(
      ctx,
      input.matterId,
      input.status === 'final' ? 'time.finalised' : 'time.returned_to_draft',
      input.status === 'final' ? 'marked final' : 'returned to draft',
      result,
    );
    log.info('time entry status set', {
      matterId: input.matterId,
      status: input.status,
      updated: result.updated.length,
      skipped: result.skipped.length,
      conflicts: result.conflicts.length,
    });
    return result;
  },
} satisfies CallableDefinition<typeof SetTimeEntryStatusInput, SetTimeEntryStatusResult>;

export const setStatus = defineCallable(setStatusDefinition);
