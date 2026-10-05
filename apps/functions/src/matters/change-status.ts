import { FieldValue } from 'firebase-admin/firestore';

import {
  can,
  canTransition,
  ChangeMatterStatusInput,
  conflictAllowsOpening,
  ConflictStatusSchema,
  contactDisplayName,
  DEFAULT_ORG_TIMEZONE,
  DomainError,
  MATTER_TRANSITIONS,
  MatterStatusSchema,
  PERMISSIONS,
  referrerThankYouEnabled,
  referrerThankYouTitle,
  today,
  transitionRequirements,
  type ChangeMatterStatusResult,
  type Contact,
  type MatterStatus,
} from '@materia/domain';

import { thankYouTaskData, thankYouTaskPath } from './referral';
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
    // CORE-18: a referred lead that opens gets a "Thank referrer" task when the org asks for it.
    const org = input.to === 'open' ? (await db.doc(`orgs/${orgId}`).get()).data() : undefined;
    const thankYou = referrerThankYouEnabled(org);
    let thankYouTask = false;

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
      }

      const patch: Record<string, unknown> = { status: input.to, ...stamp(uid, now, requestId) };
      // Reads first: the task (one per matter, so a retry or a second opening never adds another)
      // and the referrer's name for its title.
      const referrerId = data['referrerContactId'];
      thankYouTask = false;
      let taskData: Record<string, unknown> | undefined;
      if (thankYou && current === 'lead' && input.to === 'open' && typeof referrerId === 'string' && referrerId) {
        const taskRef = db.doc(thankYouTaskPath(orgId, input.matterId));
        const [task, referrer] = await Promise.all([
          tx.get(taskRef),
          tx.get(db.doc(`orgs/${orgId}/contacts/${referrerId}`)),
        ]);
        if (!task.exists) {
          const timeZone =
            typeof org?.['timezone'] === 'string' && org['timezone'] ? org['timezone'] : DEFAULT_ORG_TIMEZONE;
          const name = referrer.exists ? contactDisplayName(referrer.data() as Partial<Contact>) : undefined;
          taskData = thankYouTaskData({
            orgId,
            matterId: input.matterId,
            title: referrerThankYouTitle(name),
            assigneeUid: typeof data['responsibleUid'] === 'string' ? data['responsibleUid'] : undefined,
            openedOn: today(timeZone, now),
            uid,
            now,
            requestId,
          });
          patch['openTaskCount'] = FieldValue.increment(1);
        }
      }
      if (input.to === 'closed') {
        patch['closedAt'] = now;
        patch['closeReason'] = reason ?? FieldValue.delete();
      }
      if (current === 'closed' && input.to === 'open') {
        patch['closedAt'] = FieldValue.delete();
        patch['closeReason'] = FieldValue.delete();
      }
      tx.update(ref, patch);
      if (taskData) {
        tx.create(db.doc(thankYouTaskPath(orgId, input.matterId)), taskData);
        thankYouTask = true;
      }
      return current;
    });

    await audit(ctx, {
      action: 'matter.status_changed',
      entity: { path: ref.path },
      summary: `Matter ${input.matterId} moved from ${from} to ${input.to}`,
      data: {
        from,
        to: input.to,
        ...(reason ? { reason } : {}),
        ...(thankYouTask ? { referrerThankYouTask: true } : {}),
      },
    });
    log.info('matter status changed', { matterId: input.matterId, from, to: input.to });
    return { matterId: input.matterId, status: input.to };
  },
} satisfies CallableDefinition<typeof ChangeMatterStatusInput, ChangeMatterStatusResult>;

export const changeStatus = defineCallable(changeStatusDefinition);
