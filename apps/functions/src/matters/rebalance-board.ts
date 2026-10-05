import {
  can,
  PERMISSIONS,
  RebalanceBoardInput,
  rebalanceBoardOrders,
  type RebalanceBoardResult,
} from '@materia/domain';

import { matterPath } from './shared';
import { isDeleted } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';

/**
 * `matters-rebalanceBoard` (CORE-04, `matter.edit`). When a board column's fractional
 * `boardOrder`s run out of precision (or some cards were never placed), the board sends the
 * column's matters in their order on screen and this writes evenly spaced orders in one batch, so
 * no card visibly moves. Only `boardOrder` is written: it isn't activity, isn't audited and leaves
 * `updatedAt` alone. Missing, deleted and (for roles without `privileged.view`) privileged matters
 * are skipped, not revealed.
 */
export const rebalanceBoardDefinition = {
  name: 'matters-rebalanceBoard',
  input: RebalanceBoardInput,
  roles: PERMISSIONS['matter.edit'],
  idempotent: true,
  handler: async ({ input, orgId, role, db, log }): Promise<RebalanceBoardResult> => {
    const refs = input.matterIds.map((id) => db.doc(matterPath(orgId, id)));
    const snaps = await db.getAll(...refs);
    const privileged = can(role, 'privileged.view');
    const visible = new Set(
      snaps
        .filter((snap) => {
          const data = snap.data();
          return snap.exists && !!data && !isDeleted(data) && (privileged || data['privileged'] !== true);
        })
        .map((snap) => snap.id),
    );
    const batch = db.batch();
    // Spaced over every id given, so the visible ones keep their gaps around the skipped ones.
    const orders = rebalanceBoardOrders(input.matterIds).filter((entry) => visible.has(entry.id));
    for (const { id, boardOrder } of orders) batch.update(db.doc(matterPath(orgId, id)), { boardOrder });
    if (orders.length) await batch.commit();
    const skipped = input.matterIds.filter((id) => !visible.has(id));
    log.info('board rebalanced', { updated: orders.length, skipped: skipped.length });
    return { updated: orders.length, skipped };
  },
} satisfies CallableDefinition<typeof RebalanceBoardInput, RebalanceBoardResult>;

export const rebalanceBoard = defineCallable(rebalanceBoardDefinition);
