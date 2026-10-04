import {
  canRestoreMatter,
  DomainError,
  MATTER_RESTORE_WINDOW_DAYS,
  PERMISSIONS,
  RestoreMatterInput,
  type RestoreMatterResult,
} from '@materia/domain';

import { matterPath } from './shared';
import { audit } from '../audit/audit';
import { isDeleted, stamp } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';

const toDate = (value: unknown): Date | undefined => {
  if (value instanceof Date) return value;
  const toDateFn = (value as { toDate?: () => Date } | undefined)?.toDate;
  return typeof toDateFn === 'function' ? toDateFn.call(value) : undefined;
};

/**
 * `matters-restore` (CORE-03, `matter.restore`: owner and admin). Brings back a soft-deleted
 * matter within MATTER_RESTORE_WINDOW_DAYS of its delete; later it is refused with
 * FAILED_PRECONDITION (`details.reason: 'restore_window_passed'`). A live matter is left alone
 * (`restored: false`). Audited as `matter.restored`.
 */
export const restoreDefinition = {
  name: 'matters-restore',
  input: RestoreMatterInput,
  roles: PERMISSIONS['matter.restore'],
  idempotent: true,
  handler: async (ctx): Promise<RestoreMatterResult> => {
    const { input, orgId, uid, db, clock, requestId, log } = ctx;
    const ref = db.doc(matterPath(orgId, input.matterId));
    const now = clock.now();
    const restored = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new DomainError('NOT_FOUND', 'Matter not found', { matterId: input.matterId });
      const data = snap.data() ?? {};
      if (!isDeleted(data)) return false;
      const deletedAt = toDate(data['deletedAt']);
      if (!deletedAt || !canRestoreMatter(deletedAt, now)) {
        throw new DomainError(
          'FAILED_PRECONDITION',
          `Deleted matters can be restored for ${MATTER_RESTORE_WINDOW_DAYS} days`,
          {
            reason: 'restore_window_passed',
            matterId: input.matterId,
            windowDays: MATTER_RESTORE_WINDOW_DAYS,
          },
        );
      }
      tx.update(ref, { deletedAt: null, deletedBy: null, ...stamp(uid, now, requestId) });
      return true;
    });
    if (restored) {
      await audit(ctx, {
        action: 'matter.restored',
        entity: { path: ref.path },
        summary: `Matter ${input.matterId} restored`,
      });
    }
    log.info('matter restore', { matterId: input.matterId, restored });
    return { matterId: input.matterId, restored };
  },
} satisfies CallableDefinition<typeof RestoreMatterInput, RestoreMatterResult>;

export const restore = defineCallable(restoreDefinition);
