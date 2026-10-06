import {
  feeTerms,
  PERMISSIONS,
  UpdateFeeInput,
  type FeeRevision,
  type FeeTerms,
  type UpdateFeeResult,
} from '@materia/domain';

import { recomputeBudget } from './budget';
import { audit } from '../audit/audit';
import { stamp } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { requireFlag } from '../core/flags';
import { liveMatter, matterPath } from '../matters/shared';

/** Terms in a stable form, to tell whether a revision changes anything. */
function canonical(terms: FeeTerms): string {
  const record = terms as Record<string, unknown>;
  return JSON.stringify(
    Object.keys(record)
      .sort()
      .map((key) => [key, record[key]]),
  );
}

/**
 * `fees-update` (BILL-05; `matter.fee`: lawyer and above; flag `billing.feeBudgets`). Revises a
 * matter's fee arrangement: the terms are replaced, `fee.revision` goes up by one (re-arming the
 * budget alerts) and `fee.history` gains `{at, by, from, to, reason}`. The change applies forward
 * only: final, billed and written-off time keeps its snapshot and issued invoices are untouched.
 * Terms identical to the current ones change nothing. Audited as `matter.fee_revised`; then the
 * budget is recomputed against the new basis.
 */
export const updateDefinition = {
  name: 'fees-update',
  input: UpdateFeeInput,
  roles: PERMISSIONS['matter.fee'],
  idempotent: true,
  handler: async (ctx): Promise<UpdateFeeResult> => {
    const { input, orgId, uid, role, db, clock, requestId, log } = ctx;
    await requireFlag({ orgId, db, clock }, 'billing.feeBudgets');
    const ref = db.doc(matterPath(orgId, input.matterId));
    const reason = input.reason.trim();
    const next = feeTerms(input.fee);
    const now = clock.now();

    const result = await db.runTransaction(async (tx) => {
      const matter = liveMatter(await tx.get(ref), role, input.matterId);
      const fee = (matter['fee'] ?? {}) as Partial<FeeTerms> & { revision?: number; history?: FeeRevision[] };
      const current = fee.arrangement ? feeTerms(fee as FeeTerms) : undefined;
      const revision = typeof fee.revision === 'number' ? fee.revision : 0;
      if (current && canonical(current) === canonical(next)) return { revision, changed: false, from: current };
      const entry: FeeRevision = { at: now, by: uid, ...(current ? { from: current } : {}), to: next, reason };
      tx.update(ref, {
        fee: { ...next, revision: revision + 1, history: [...(fee.history ?? []), entry] },
        ...stamp(uid, now, requestId),
      });
      return { revision: revision + 1, changed: true, from: current };
    });

    if (result.changed) {
      await audit(ctx, {
        action: 'matter.fee_revised',
        entity: { path: ref.path },
        summary: `Fee on matter ${input.matterId} revised (revision ${result.revision})`,
        data: {
          revision: result.revision,
          ...(result.from ? { fromArrangement: result.from.arrangement } : {}),
          toArrangement: next.arrangement,
          reason,
        },
      });
      await recomputeBudget({ db, orgId, clock, log, ports: ctx.ports }, input.matterId);
    }
    log.info('fee updated', { matterId: input.matterId, revision: result.revision, changed: result.changed });
    return { matterId: input.matterId, revision: result.revision, changed: result.changed };
  },
} satisfies CallableDefinition<typeof UpdateFeeInput, UpdateFeeResult>;

export const update = defineCallable(updateDefinition);
