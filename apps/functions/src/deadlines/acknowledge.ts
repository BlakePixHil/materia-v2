import {
  AcknowledgeDeadlineInput,
  DomainError,
  PERMISSIONS,
  type AcknowledgeDeadlineResult,
} from '@materia/domain';

import { deadlinesPath } from './shared';
import { audit } from '../audit/audit';
import { isDeleted, stamp } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { orgClock } from '../core/emulator-clock';
import { liveMatter, matterPath } from '../matters/shared';
import { toDate } from '../reminders/schedule';

/**
 * `deadlines-acknowledge` (CORE-11; task.edit, idempotent): records who acknowledged an upcoming
 * deadline and when (`ackBy`, `ackAt`), which stops a critical one escalating and takes it off
 * the Today screen's escalations. Already acknowledged: the first acknowledgement stands.
 * Audited as `deadline.acknowledged`.
 */
export const acknowledgeDefinition = {
  name: 'deadlines-acknowledge',
  input: AcknowledgeDeadlineInput,
  roles: PERMISSIONS['task.edit'],
  idempotent: true,
  handler: async (ctx): Promise<AcknowledgeDeadlineResult> => {
    const { input, orgId, uid, role, db, requestId, log } = ctx;
    const clock = await orgClock(db, orgId, ctx.clock);
    const now = clock.now();
    const ref = db.doc(`${deadlinesPath(orgId, input.matterId)}/${input.deadlineId}`);
    const result = await db.runTransaction(async (tx) => {
      liveMatter(await tx.get(db.doc(matterPath(orgId, input.matterId))), role, input.matterId);
      const deadline = (await tx.get(ref)).data();
      if (!deadline || isDeleted(deadline)) {
        throw new DomainError('NOT_FOUND', 'Deadline not found', { deadlineId: input.deadlineId });
      }
      if (deadline['status'] !== 'upcoming') {
        throw new DomainError('FAILED_PRECONDITION', 'Only an upcoming deadline can be acknowledged', {
          reason: 'deadline_not_open',
          deadlineId: input.deadlineId,
          status: String(deadline['status']),
        });
      }
      const ackAt = toDate(deadline['ackAt']);
      if (ackAt && typeof deadline['ackBy'] === 'string') {
        return { ackBy: deadline['ackBy'], ackAt, acknowledged: false };
      }
      tx.update(ref, { ackBy: uid, ackAt: now, ...stamp(uid, now, requestId) });
      return { ackBy: uid, ackAt: now, acknowledged: true };
    });
    if (result.acknowledged) {
      await audit(
        { uid, orgId, requestId, db, clock },
        {
          action: 'deadline.acknowledged',
          entity: { path: ref.path },
          summary: `Deadline ${input.deadlineId} acknowledged`,
        },
      );
    }
    log.info('deadline acknowledged', {
      matterId: input.matterId,
      deadlineId: input.deadlineId,
      acknowledged: result.acknowledged,
    });
    return {
      deadlineId: input.deadlineId,
      ackBy: result.ackBy,
      ackAt: result.ackAt.toISOString(),
      acknowledged: result.acknowledged,
    };
  },
} satisfies CallableDefinition<typeof AcknowledgeDeadlineInput, AcknowledgeDeadlineResult>;

export const acknowledge = defineCallable(acknowledgeDefinition);
