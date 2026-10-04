import { FieldValue } from 'firebase-admin/firestore';

import {
  can,
  ConflictHitSchema,
  DetermineConflictInput,
  DomainError,
  hasAdverseHit,
  PERMISSIONS,
  type DetermineConflictResult,
} from '@materia/domain';

import { conflictChecksPath } from './shared';
import { audit } from '../audit/audit';
import { isDeleted, stamp } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { matterPath } from '../matters/shared';

/**
 * `conflicts-determine` (CORE-02, `conflict.determine`: lawyer and above). Records the outcome of a
 * conflict check on a matter: `matter.conflictCheck = { status, checkedAt, checkedBy, resultId,
 * reason }`. The check must exist (NOT_FOUND) and be for this matter or for a matter not created
 * yet (no `excludeMatterId`); a check for another matter is FAILED_PRECONDITION
 * (`details.reason: 'check_for_another_matter'`). `potential` and `conflict` need a reason (input
 * validation). A conflict alert raised by the same check is cleared. Audited as
 * `matter.conflict_determined` with the reason. Idempotent on `requestId`.
 */
export const determineDefinition = {
  name: 'conflicts-determine',
  input: DetermineConflictInput,
  roles: PERMISSIONS['conflict.determine'],
  idempotent: true,
  handler: async (ctx): Promise<DetermineConflictResult> => {
    const { input, orgId, uid, role, db, clock, requestId, log } = ctx;
    const matterRef = db.doc(matterPath(orgId, input.matterId));
    const checkRef = db.doc(`${conflictChecksPath(orgId)}/${input.checkId}`);
    const reason = input.reason?.trim() || undefined;
    const now = clock.now();

    const outcome = await db.runTransaction(async (tx) => {
      const check = await tx.get(checkRef);
      const matter = await tx.get(matterRef);
      const checkData = check.data();
      if (!check.exists || !checkData) {
        throw new DomainError('NOT_FOUND', 'Conflict check not found', { checkId: input.checkId });
      }
      const data = matter.data();
      if (
        !matter.exists ||
        !data ||
        isDeleted(data) ||
        (data['privileged'] === true && !can(role, 'privileged.view'))
      ) {
        throw new DomainError('NOT_FOUND', 'Matter not found', { matterId: input.matterId });
      }
      const forMatter = checkData['excludeMatterId'];
      if (typeof forMatter === 'string' && forMatter && forMatter !== input.matterId) {
        throw new DomainError('FAILED_PRECONDITION', 'That conflict check was run for another matter', {
          reason: 'check_for_another_matter',
          checkId: input.checkId,
          matterId: input.matterId,
        });
      }
      const previous = (data['conflictCheck'] as { status?: string } | undefined)?.status ?? 'pending';
      const alertCleared = (data['conflictAlert'] as { checkId?: string } | undefined)?.checkId === input.checkId;
      const patch: Record<string, unknown> = {
        conflictCheck: {
          status: input.status,
          checkedAt: now,
          checkedBy: uid,
          resultId: input.checkId,
          ...(reason ? { reason } : {}),
        },
        ...stamp(uid, now, requestId),
      };
      if (alertCleared) patch['conflictAlert'] = FieldValue.delete();
      tx.update(matterRef, patch);
      const hits = ConflictHitSchema.array().safeParse(checkData['hits']);
      return {
        previous,
        alertCleared,
        hitCount: hits.success ? hits.data.length : 0,
        adverse: hits.success ? hasAdverseHit(hits.data) : false,
      };
    });

    await audit(ctx, {
      action: 'matter.conflict_determined',
      entity: { path: matterRef.path },
      summary: `Conflict check ${input.checkId} determined ${input.status} on matter ${input.matterId}`,
      data: {
        status: input.status,
        previousStatus: outcome.previous,
        checkId: input.checkId,
        hitCount: outcome.hitCount,
        adverse: outcome.adverse,
        ...(reason ? { reason } : {}),
      },
    });
    log.info('conflict determined', {
      matterId: input.matterId,
      checkId: input.checkId,
      status: input.status,
      alertCleared: outcome.alertCleared,
    });
    return { matterId: input.matterId, status: input.status };
  },
} satisfies CallableDefinition<typeof DetermineConflictInput, DetermineConflictResult>;

export const determine = defineCallable(determineDefinition);
