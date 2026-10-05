import { FieldValue } from 'firebase-admin/firestore';

import {
  canCompleteDeadline,
  compareDates,
  CompleteDeadlineInput,
  DomainError,
  isOpenTask,
  PERMISSIONS,
  today,
  type CompleteDeadlineResult,
} from '@materia/domain';

import { changesPath, deadlinesPath, tasksPath } from './shared';
import { audit } from '../audit/audit';
import { isDeleted, stamp } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { orgClock } from '../core/emulator-clock';
import { liveMatter, matterPath } from '../matters/shared';
import { orgTimeZone } from '../templates/shared';

const STATUS = { done: 'done', waived: 'waived', missed: 'missed' } as const;

/**
 * `deadlines-complete` (CORE-10; task.edit, idempotent): closes an upcoming deadline as
 *
 * - `done` on `completedOn` (default today in the org's time zone; a future date is INVALID_ARGUMENT);
 * - `waived`, with a reason (deadline.override, else PERMISSION_DENIED);
 * - `missed` (deadline.override): only once the daily missed check has asked (`missedCheck`) or for
 *   a deadline past on creation, else FAILED_PRECONDITION (`not_past_due`). Nothing marks a
 *   deadline missed by itself.
 *
 * Pending proposals for it are superseded. With `completeLinkedTasks`, its open linked tasks are
 * marked done; the result lists those still open so the UI can offer to. Audited as
 * `deadline.done`, `deadline.waived` or `deadline.missed`.
 */
export const completeDefinition = {
  name: 'deadlines-complete',
  input: CompleteDeadlineInput,
  roles: PERMISSIONS['task.edit'],
  idempotent: true,
  handler: async (ctx): Promise<CompleteDeadlineResult> => {
    const { input, orgId, uid, role, db, requestId, log } = ctx;
    if (!canCompleteDeadline(role, input.outcome)) {
      throw new DomainError('PERMISSION_DENIED', `Marking a deadline ${input.outcome} needs a lawyer`, {
        reason: 'deadline_outcome_requires_lawyer',
      });
    }
    const clock = await orgClock(db, orgId, ctx.clock);
    const now = clock.now();
    const todayDate = today(await orgTimeZone(db, orgId), now);
    const on = input.completedOn ?? todayDate;
    if (compareDates(on, todayDate) > 0) {
      throw new DomainError('INVALID_ARGUMENT', 'The completion date can’t be in the future', {
        fields: { completedOn: ['Choose today or an earlier date'] },
      });
    }
    const ref = db.doc(`${deadlinesPath(orgId, input.matterId)}/${input.deadlineId}`);

    const result = await db.runTransaction(async (tx) => {
      liveMatter(await tx.get(db.doc(matterPath(orgId, input.matterId))), role, input.matterId);
      const snap = await tx.get(ref);
      const deadline = snap.data();
      if (!snap.exists || !deadline || isDeleted(deadline)) {
        throw new DomainError('NOT_FOUND', 'Deadline not found', { deadlineId: input.deadlineId });
      }
      if (deadline['status'] !== 'upcoming') {
        throw new DomainError('FAILED_PRECONDITION', 'Only an upcoming deadline can be closed', {
          reason: 'deadline_not_open',
          deadlineId: input.deadlineId,
          status: String(deadline['status']),
        });
      }
      if (input.outcome === 'missed' && !deadline['missedCheck'] && deadline['pastOnCreation'] !== true) {
        throw new DomainError('FAILED_PRECONDITION', 'A deadline is marked missed only after the missed check asks', {
          reason: 'not_past_due',
          deadlineId: input.deadlineId,
        });
      }
      const [pending, linked] = await Promise.all([
        tx.get(
          db
            .collection(changesPath(orgId, input.matterId))
            .where('deadlineId', '==', input.deadlineId)
            .where('status', '==', 'pending'),
        ),
        tx.get(db.collection(tasksPath(orgId, input.matterId)).where('deadlineId', '==', input.deadlineId)),
      ]);
      const meta = stamp(uid, now, requestId);
      tx.update(ref, {
        status: STATUS[input.outcome],
        resolution: { on, by: uid, at: now, ...(input.reason ? { reason: input.reason } : {}) },
        missedCheck: FieldValue.delete(),
        ...meta,
      });
      for (const change of pending.docs) tx.update(change.ref, { status: 'superseded', ...meta });
      const open = linked.docs.filter((task) => !isDeleted(task.data()) && isOpenTask(task.data()));
      const completed: string[] = [];
      if (input.completeLinkedTasks && input.outcome === 'done') {
        for (const task of open) {
          tx.update(task.ref, { status: 'done', ...meta });
          completed.push(task.id);
        }
      }
      return { open: open.map((task) => task.id).filter((id) => !completed.includes(id)), completed };
    });

    await audit(
      { uid, orgId, requestId, db, clock },
      {
        action: `deadline.${input.outcome}`,
        entity: { path: ref.path },
        summary: `Deadline ${input.deadlineId} marked ${input.outcome} on ${on}`,
        data: {
          on,
          ...(input.reason ? { reason: input.reason } : {}),
          ...(result.completed.length ? { completedTasks: result.completed.length } : {}),
        },
      },
    );
    log.info('deadline closed', { matterId: input.matterId, deadlineId: input.deadlineId, outcome: input.outcome });
    return {
      deadlineId: input.deadlineId,
      status: STATUS[input.outcome],
      openLinkedTaskIds: result.open,
      completedTaskIds: result.completed,
    };
  },
} satisfies CallableDefinition<typeof CompleteDeadlineInput, CompleteDeadlineResult>;

export const complete = defineCallable(completeDefinition);
