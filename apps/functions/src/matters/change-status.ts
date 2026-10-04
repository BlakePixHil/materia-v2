import { FieldValue } from 'firebase-admin/firestore';

import {
  can,
  canTransition,
  ChangeMatterStatusInput,
  DomainError,
  MATTER_TRANSITIONS,
  MatterStatusSchema,
  PERMISSIONS,
  transitionRequirements,
  type ChangeMatterStatusResult,
  type MatterStatus,
} from '@materia/domain';

import { matterPath } from './shared';
import { audit } from '../audit/audit';
import { isDeleted, stamp } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';

/**
 * `matters-changeStatus` (CORE-03, `matter.status`: lawyer and above). Moves a live matter along
 * MATTER_TRANSITIONS, else MATTER_INVALID_TRANSITION (`details.from`, `details.to`,
 * `details.allowed`). `lead → open` needs a clear conflict check (FAILED_PRECONDITION,
 * `details.reason: 'conflict_check_not_clear'`); reopening a closed matter needs a reason
 * (INVALID_ARGUMENT on `reason`). Closing sets `closedAt` and `closeReason` (the reason, when
 * given); reopening clears both. Audited as `matter.status_changed`.
 */
export const changeStatusDefinition = {
  name: 'matters-changeStatus',
  input: ChangeMatterStatusInput,
  roles: PERMISSIONS['matter.status'],
  idempotent: true,
  handler: async (ctx): Promise<ChangeMatterStatusResult> => {
    const { input, orgId, uid, role, db, clock, requestId, log } = ctx;
    const ref = db.doc(matterPath(orgId, input.matterId));
    const reason = input.reason?.trim() || undefined;
    const now = clock.now();

    const from = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data();
      // A deleted matter, or a privileged one the caller can't see, is not found.
      if (!snap.exists || !data || isDeleted(data) || (data['privileged'] === true && !can(role, 'privileged.view'))) {
        throw new DomainError('NOT_FOUND', 'Matter not found', { matterId: input.matterId });
      }
      const parsed = MatterStatusSchema.safeParse(data['status']);
      if (!parsed.success) {
        throw new DomainError('FAILED_PRECONDITION', 'The matter has no valid status', {
          reason: 'invalid_status',
          matterId: input.matterId,
        });
      }
      const current: MatterStatus = parsed.data;
      if (!canTransition(current, input.to)) {
        throw new DomainError('MATTER_INVALID_TRANSITION', `A ${current} matter can't move to ${input.to}`, {
          matterId: input.matterId,
          from: current,
          to: input.to,
          allowed: [...MATTER_TRANSITIONS[current]],
        });
      }
      for (const requirement of transitionRequirements(current, input.to)) {
        if (requirement === 'conflict_clear') {
          const conflictStatus = (data['conflictCheck'] as { status?: string } | undefined)?.status ?? 'pending';
          if (conflictStatus !== 'clear') {
            throw new DomainError('FAILED_PRECONDITION', 'Clear the conflict check before opening the matter', {
              reason: 'conflict_check_not_clear',
              matterId: input.matterId,
              conflictStatus,
            });
          }
        }
        if (requirement === 'reason' && !reason) {
          throw new DomainError('INVALID_ARGUMENT', 'Give a reason for reopening the matter', {
            fields: { reason: ['Enter a reason for reopening'] },
          });
        }
      }

      const patch: Record<string, unknown> = { status: input.to, ...stamp(uid, now, requestId) };
      if (input.to === 'closed') {
        patch['closedAt'] = now;
        patch['closeReason'] = reason ?? FieldValue.delete();
      }
      if (current === 'closed' && input.to === 'open') {
        patch['closedAt'] = FieldValue.delete();
        patch['closeReason'] = FieldValue.delete();
      }
      tx.update(ref, patch);
      return current;
    });

    await audit(ctx, {
      action: 'matter.status_changed',
      entity: { path: ref.path },
      summary: `Matter ${input.matterId} moved from ${from} to ${input.to}`,
      data: { from, to: input.to, ...(reason ? { reason } : {}) },
    });
    log.info('matter status changed', { matterId: input.matterId, from, to: input.to });
    return { matterId: input.matterId, status: input.to };
  },
} satisfies CallableDefinition<typeof ChangeMatterStatusInput, ChangeMatterStatusResult>;

export const changeStatus = defineCallable(changeStatusDefinition);
