import { can, DomainError, PERMISSIONS, RunConflictCheckInput, type RunConflictCheckResult } from '@materia/domain';

import { findConflictHits, storeConflictCheck } from './shared';
import { isDeleted } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { isEnabled } from '../core/flags';
import { matterPath } from '../matters/shared';

/**
 * `conflicts-run` (CORE-02, `conflict.run`: paralegal and above). Scores each subject against the
 * org's contacts and lists every matter each matching contact is a party on (closed, archived and
 * deleted ones included, `excludeMatterId` left out), best hit first. With the `conflicts.enforced`
 * flag on, matters whose role is adverse to the subject's role carry `adverse` (the matrix label).
 * Stores the run as `orgs/{orgId}/conflictChecks/{checkId}`. It never changes a matter: a lawyer
 * records the outcome with `conflicts-determine` (common names never clear themselves).
 * Idempotent on `requestId`.
 */
export const runDefinition = {
  name: 'conflicts-run',
  input: RunConflictCheckInput,
  roles: PERMISSIONS['conflict.run'],
  idempotent: true,
  handler: async ({ input, orgId, uid, role, db, clock, log }): Promise<RunConflictCheckResult> => {
    if (input.excludeMatterId) {
      const matter = await db.doc(matterPath(orgId, input.excludeMatterId)).get();
      const data = matter.data();
      if (
        !matter.exists ||
        !data ||
        isDeleted(data) ||
        (data['privileged'] === true && !can(role, 'privileged.view'))
      ) {
        throw new DomainError('NOT_FOUND', 'Matter not found', { matterId: input.excludeMatterId });
      }
    }
    const adverse = await isEnabled({ orgId, db, clock }, 'conflicts.enforced');
    const hits = await findConflictHits(db, orgId, input.subjects, {
      excludeMatterId: input.excludeMatterId,
      adverse,
    });
    const checkId = await storeConflictCheck(db, orgId, {
      subjects: input.subjects,
      hits,
      excludeMatterId: input.excludeMatterId,
      adverseRolesChecked: adverse,
      ranBy: uid,
      now: clock.now(),
    });
    log.info('conflict check ran', {
      checkId,
      subjects: input.subjects.length,
      hits: hits.length,
      adverseRolesChecked: adverse,
    });
    return { checkId, hits, adverseRolesChecked: adverse };
  },
} satisfies CallableDefinition<typeof RunConflictCheckInput, RunConflictCheckResult>;

export const run = defineCallable(runDefinition);
