import { FieldValue } from 'firebase-admin/firestore';

import {
  DomainError,
  OverrideDeadlineInput,
  PERMISSIONS,
  type DeadlineComputed,
  type OverrideDeadlineResult,
} from '@materia/domain';

import { changesPath, deadlinesPath } from './shared';
import { audit } from '../audit/audit';
import { isDeleted, stamp } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { orgClock } from '../core/emulator-clock';
import { liveMatter, matterPath } from '../matters/shared';

/**
 * `deadlines-override` (CORE-10; deadline.override, idempotent): sets an upcoming (or blocked)
 * computed deadline's date with a reason, or clears the override (`dueDate: null`), which puts the
 * engine's date back in force. The engine keeps computing behind an override: the recompute flags
 * the deadline (`overrideConflict`) when its date moves earlier than the override. Pending
 * proposals for the deadline are superseded. A manual deadline is FAILED_PRECONDITION
 * (`manual_deadline`: edit it directly); a closed one `deadline_not_open`.
 * Audited as `deadline.overridden` or `deadline.override_cleared`.
 */
export const overrideDefinition = {
  name: 'deadlines-override',
  input: OverrideDeadlineInput,
  roles: PERMISSIONS['deadline.override'],
  idempotent: true,
  handler: async (ctx): Promise<OverrideDeadlineResult> => {
    const { input, orgId, uid, role, db, requestId, log } = ctx;
    const clock = await orgClock(db, orgId, ctx.clock);
    const now = clock.now();
    const ref = db.doc(`${deadlinesPath(orgId, input.matterId)}/${input.deadlineId}`);

    const result = await db.runTransaction(async (tx) => {
      liveMatter(await tx.get(db.doc(matterPath(orgId, input.matterId))), role, input.matterId);
      const snap = await tx.get(ref);
      const deadline = snap.data();
      if (!snap.exists || !deadline || isDeleted(deadline)) {
        throw new DomainError('NOT_FOUND', 'Deadline not found', { deadlineId: input.deadlineId });
      }
      const computed = deadline['computed'] as DeadlineComputed | undefined;
      if (!computed) {
        throw new DomainError('FAILED_PRECONDITION', 'Edit a manual deadline’s date directly', {
          reason: 'manual_deadline',
          deadlineId: input.deadlineId,
        });
      }
      if (deadline['status'] !== 'upcoming' && deadline['status'] !== 'blocked') {
        throw new DomainError('FAILED_PRECONDITION', 'Only an open deadline can be overridden', {
          reason: 'deadline_not_open',
          deadlineId: input.deadlineId,
          status: String(deadline['status']),
        });
      }
      const pending = await tx.get(
        db
          .collection(changesPath(orgId, input.matterId))
          .where('deadlineId', '==', input.deadlineId)
          .where('status', '==', 'pending'),
      );
      const meta = stamp(uid, now, requestId);
      for (const change of pending.docs) tx.update(change.ref, { status: 'superseded', ...meta });

      if (input.dueDate === null) {
        if (!deadline['override'])
          return { dueDate: String(deadline['dueDate'] ?? ''), conflict: false, cleared: false };
        const engineDate = computed.dueDate;
        tx.update(ref, {
          override: FieldValue.delete(),
          overrideConflict: FieldValue.delete(),
          ...(engineDate
            ? { dueDate: engineDate, status: 'upcoming' }
            : { dueDate: FieldValue.delete(), status: 'blocked' }),
          ...meta,
        });
        return { dueDate: engineDate ?? '', conflict: false, cleared: true };
      }
      tx.update(ref, {
        override: { dueDate: input.dueDate, reason: input.reason as string, by: uid, at: now },
        // The lawyer chose this date knowing the rule's: flagged only if the rule moves earlier later.
        overrideConflict: false,
        dueDate: input.dueDate,
        status: 'upcoming',
        blockedReason: FieldValue.delete(),
        blockedCode: FieldValue.delete(),
        declined: FieldValue.delete(),
        ...meta,
      });
      return { dueDate: input.dueDate, conflict: false, cleared: false };
    });

    const path = ref.path;
    if (input.dueDate !== null || result.cleared) {
      await audit(
        { uid, orgId, requestId, db, clock },
        {
          action: input.dueDate === null ? 'deadline.override_cleared' : 'deadline.overridden',
          entity: { path },
          summary:
            input.dueDate === null
              ? `Deadline ${input.deadlineId} override cleared`
              : `Deadline ${input.deadlineId} overridden to ${input.dueDate}`,
          data: { dueDate: result.dueDate, ...(input.reason ? { reason: input.reason } : {}) },
        },
      );
    }
    log.info('deadline override', {
      matterId: input.matterId,
      deadlineId: input.deadlineId,
      cleared: input.dueDate === null,
    });
    return { deadlineId: input.deadlineId, dueDate: result.dueDate, overrideConflict: result.conflict };
  },
} satisfies CallableDefinition<typeof OverrideDeadlineInput, OverrideDeadlineResult>;

export const override = defineCallable(overrideDefinition);
