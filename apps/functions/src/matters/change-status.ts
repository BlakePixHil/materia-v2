import {
  can,
  canTransition,
  ChangeMatterStatusInput,
  conflictAllowsOpening,
  ConflictStatusSchema,
  DomainError,
  MATTER_TRANSITIONS,
  MatterStatusSchema,
  PERMISSIONS,
  transitionRequirements,
  type ChangeMatterStatusResult,
  type MatterStatus,
} from '@materia/domain';

import { cancelQueuedDestruction, reopenPatch } from './reopen';
import { matterPath } from './shared';
import { audit } from '../audit/audit';
import { isDeleted, stamp } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';

/**
 * `matters-changeStatus` (CORE-03, `matter.status`: lawyer and above). Moves a live matter along
 * MATTER_TRANSITIONS, else MATTER_INVALID_TRANSITION (`details.from`, `details.to`,
 * `details.allowed`). `lead → open` needs a conflict determination that allows opening, `clear` or
 * `potential` (CORE-02); `pending` and `conflict` are FAILED_PRECONDITION with
 * `details.reason: 'conflict_check_not_clear'` and `details.conflictStatus`. Reopening a closed matter needs a reason
 * (INVALID_ARGUMENT on `reason`). Closing goes through `matters-close` and its checklist (CORE-19):
 * here it is FAILED_PRECONDITION with `details.reason: 'closing_checklist_required'`. Reopening a
 * closed or archived matter clears the closing and retention fields and cancels a queued destruction,
 * as `matters-reopen` does; archiving stamps `archivedAt`. Audited as `matter.status_changed`.
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
        if (requirement === 'conflict_openable') {
          const stored = ConflictStatusSchema.safeParse(
            (data['conflictCheck'] as { status?: unknown } | undefined)?.status,
          );
          const conflictStatus = stored.success ? stored.data : 'pending';
          if (!conflictAllowsOpening(conflictStatus)) {
            const message =
              conflictStatus === 'conflict'
                ? 'The conflict check found a conflict: the matter cannot be opened'
                : 'Record a conflict determination before opening the matter';
            throw new DomainError('FAILED_PRECONDITION', message, {
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
        if (requirement === 'closing_checklist') {
          throw new DomainError('FAILED_PRECONDITION', 'Close the matter with its closing checklist', {
            reason: 'closing_checklist_required',
            matterId: input.matterId,
          });
        }
      }

      const reopening = (current === 'closed' || current === 'archived') && input.to === 'open';
      const cancel = reopening
        ? await cancelQueuedDestruction(tx, db, orgId, input.matterId, 'reopened', now)
        : () => undefined;
      const patch: Record<string, unknown> = { status: input.to, ...stamp(uid, now, requestId) };
      if (reopening) Object.assign(patch, reopenPatch());
      if (input.to === 'archived') patch['archivedAt'] = now;
      tx.update(ref, patch);
      cancel();
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
