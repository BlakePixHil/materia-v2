import { PERMISSIONS, RejectTimeEntriesInput, type SetTimeEntryStatusResult } from '@materia/domain';

import { auditReview, reviewEntries } from './review';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { liveMatter, matterPath } from '../matters/shared';

/**
 * `time-reject` (BILL-03; `time.approve`, idempotent): sends a matter's drafts back to their
 * authors with a note (`rejection {note, by, at}`). They stay drafts: the author sees the note on
 * My time, and the draft returns to Approvals once they edit it (`awaitingApproval`). Entries that
 * aren't drafts are skipped; entries changed since the caller saw them are conflicts. Audited as
 * `time.rejected` (the note itself stays on the entry, not in the audit summary).
 */
export const rejectDefinition = {
  name: 'time-reject',
  input: RejectTimeEntriesInput,
  roles: PERMISSIONS['time.approve'],
  idempotent: true,
  handler: async (ctx): Promise<SetTimeEntryStatusResult> => {
    const { input, orgId, uid, role, db, clock, log } = ctx;
    liveMatter(await db.doc(matterPath(orgId, input.matterId)).get(), role, input.matterId);
    const at = clock.now();
    const result = await reviewEntries(ctx, input, (data) =>
      data['status'] === 'draft' ? { rejection: { note: input.note, by: uid, at } } : null,
    );
    await auditReview(ctx, input.matterId, 'time.rejected', 'sent back', result);
    log.info('time sent back', {
      matterId: input.matterId,
      updated: result.updated.length,
      skipped: result.skipped.length,
      conflicts: result.conflicts.length,
    });
    return result;
  },
} satisfies CallableDefinition<typeof RejectTimeEntriesInput, SetTimeEntryStatusResult>;

export const reject = defineCallable(rejectDefinition);
