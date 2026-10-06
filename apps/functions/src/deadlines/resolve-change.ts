import { FieldValue } from 'firebase-admin/firestore';

import {
  confirmationMatches,
  DomainError,
  isOpenTask,
  PERMISSIONS,
  ResolveDeadlineChangeInput,
  type ResolveDeadlineChangeResult,
} from '@materia/domain';

import { changesPath, deadlinesPath, tasksPath } from './shared';
import { audit } from '../audit/audit';
import { isDeleted, stamp } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { orgClock } from '../core/emulator-clock';
import { writableMatter, matterPath } from '../matters/shared';

type Data = Record<string, unknown>;

/**
 * `deadlines-resolveChange` (CORE-10; deadline.override, idempotent): decides a pending proposal.
 *
 * - Accepting a `moved` proposal sets the deadline's date and provenance to the proposal's (and the
 *   due date of its open linked tasks); accepting `removed` marks the deadline superseded.
 *   A critical deadline needs `confirmation`, the matter number as typed (INVALID_ARGUMENT on
 *   `confirmation`).
 * - Rejecting keeps the deadline and records the decision (`declined`), so the same proposal isn't
 *   made again.
 * - A proposal that no longer matches its deadline (it was overridden, completed or moved since)
 *   is marked superseded and returned as such; one already decided is FAILED_PRECONDITION
 *   (`details.reason: 'change_not_pending'`).
 *
 * Audited as `deadline.change_accepted` or `deadline.change_rejected`.
 */
export const resolveChangeDefinition = {
  name: 'deadlines-resolveChange',
  input: ResolveDeadlineChangeInput,
  roles: PERMISSIONS['deadline.override'],
  idempotent: true,
  handler: async (ctx): Promise<ResolveDeadlineChangeResult> => {
    const { input, orgId, uid, role, db, requestId, log } = ctx;
    const clock = await orgClock(db, orgId, ctx.clock);
    const now = clock.now();
    const matterRef = db.doc(matterPath(orgId, input.matterId));
    const changeRef = db.doc(`${changesPath(orgId, input.matterId)}/${input.changeId}`);

    const result = await db.runTransaction(async (tx) => {
      const matter = writableMatter(await tx.get(matterRef), role, input.matterId);
      const changeSnap = await tx.get(changeRef);
      const change = changeSnap.data();
      if (!changeSnap.exists || !change) {
        throw new DomainError('NOT_FOUND', 'Proposal not found', { changeId: input.changeId });
      }
      if (change['status'] !== 'pending') {
        throw new DomainError('FAILED_PRECONDITION', 'This proposal has already been decided', {
          reason: 'change_not_pending',
          changeId: input.changeId,
          status: String(change['status']),
        });
      }
      const deadlineId = String(change['deadlineId']);
      const deadlineRef = db.doc(`${deadlinesPath(orgId, input.matterId)}/${deadlineId}`);
      const deadline = (await tx.get(deadlineRef)).data();
      const linked = await tx.get(
        db.collection(tasksPath(orgId, input.matterId)).where('deadlineId', '==', deadlineId),
      );

      const stale =
        !deadline ||
        isDeleted(deadline) ||
        deadline['status'] !== 'upcoming' ||
        !!deadline['override'] ||
        deadline['dueDate'] !== change['fromDueDate'];
      if (stale) {
        tx.update(changeRef, { status: 'superseded', ...stamp(uid, now, requestId) });
        return { status: 'superseded' as const, deadlineId, change };
      }

      if (input.accept && change['critical'] === true) {
        const number = typeof matter['number'] === 'string' ? matter['number'] : '';
        if (!confirmationMatches(input.confirmation, number)) {
          throw new DomainError('INVALID_ARGUMENT', 'Type the matter number to confirm a critical deadline change', {
            fields: { confirmation: ['Type the matter number exactly to confirm'] },
          });
        }
      }

      const decided = { resolvedBy: uid, resolvedAt: now, ...stamp(uid, now, requestId) };
      if (!input.accept) {
        tx.update(changeRef, { status: 'rejected', ...decided });
        tx.update(deadlineRef, {
          declined: {
            kind: change['kind'],
            ...(typeof change['toDueDate'] === 'string' ? { dueDate: change['toDueDate'] } : {}),
            by: uid,
            at: now,
          },
          ...stamp(uid, now, requestId),
        });
        return { status: 'rejected' as const, deadlineId, change };
      }

      tx.update(changeRef, { status: 'accepted', ...decided });
      if (change['kind'] === 'removed') {
        tx.update(deadlineRef, { status: 'superseded', declined: FieldValue.delete(), ...stamp(uid, now, requestId) });
      } else {
        const toDueDate = change['toDueDate'] as string;
        tx.update(deadlineRef, {
          dueDate: toDueDate,
          ...(change['computed'] ? { computed: change['computed'] } : {}),
          declined: FieldValue.delete(),
          overrideConflict: FieldValue.delete(),
          missedCheck: FieldValue.delete(),
          ...stamp(uid, now, requestId),
        });
        for (const task of linked.docs) {
          const data = task.data() as Data;
          if (isDeleted(data) || !isOpenTask(data)) continue;
          tx.update(task.ref, { dueDate: toDueDate, ...stamp(uid, now, requestId) });
        }
      }
      return { status: 'accepted' as const, deadlineId, change };
    });

    if (result.status !== 'superseded') {
      await audit(
        { uid, orgId, requestId, db, clock },
        {
          action: result.status === 'accepted' ? 'deadline.change_accepted' : 'deadline.change_rejected',
          entity: { path: `${deadlinesPath(orgId, input.matterId)}/${result.deadlineId}` },
          summary: `Deadline ${result.deadlineId} ${String(result.change['kind'])} proposal ${result.status}`,
          data: {
            changeId: input.changeId,
            kind: result.change['kind'],
            fromDueDate: result.change['fromDueDate'],
            toDueDate: result.change['toDueDate'] ?? null,
            critical: result.change['critical'] === true,
          },
        },
      );
    }
    log.info('deadline change resolved', {
      matterId: input.matterId,
      changeId: input.changeId,
      deadlineId: result.deadlineId,
      status: result.status,
    });
    return { changeId: input.changeId, deadlineId: result.deadlineId, status: result.status };
  },
} satisfies CallableDefinition<typeof ResolveDeadlineChangeInput, ResolveDeadlineChangeResult>;

export const resolveChange = defineCallable(resolveChangeDefinition);
