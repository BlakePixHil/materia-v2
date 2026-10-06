import { FieldValue } from 'firebase-admin/firestore';

import { disbursementPath, planDisbursementSync, type DisbursementSyncPlan } from './shared';
import { defineTrigger, type TriggerChange, type TriggerContext, type TriggerDefinition } from '../core/trigger';
import { recordMatterActivity } from '../matters/denormalise';
import { matterPath } from '../matters/shared';

type Data = Record<string, unknown>;

export interface DisbursementWriteOutcome {
  wipDelta: DisbursementSyncPlan['wipDelta'];
  patched: string[];
}

/**
 * `disbursements-onWrite` (BILL-04), on every write of
 * `orgs/{orgId}/matters/{matterId}/disbursements/{id}`:
 *
 * 1. In one transaction on the disbursement, recomputes an unbilled one's `amountExGstCents` and
 *    `gstCents` (`planDisbursementSync`; the client's values are only a preview) and moves the
 *    matter's `disbursementWipCents` by the change in its contribution (a server increment),
 *    recording it in `wipCountedCents`. The transaction reads the disbursement again, so concurrent
 *    and out-of-order events converge on the exact total. Time stays in `wipCents` (BILL-01).
 * 2. A new disbursement moves the matter's `lastActivityAt` forward.
 *
 * Budgets (BILL-05) aggregate disbursements in their own trigger.
 */
export async function syncDisbursement(change: TriggerChange, ctx: TriggerContext): Promise<DisbursementWriteOutcome> {
  const { db, log } = ctx;
  const orgId = ctx.params['orgId'] as string;
  const matterId = ctx.params['matterId'] as string;
  const disbursementId = ctx.params['disbursementId'] as string;
  const before = change.before?.data() as Data | undefined;
  const after = change.after?.data() as Data | undefined;
  const ref = db.doc(disbursementPath(orgId, matterId, disbursementId));
  const matterRef = db.doc(matterPath(orgId, matterId));
  const matter = await matterRef.get();

  const plan = await db.runTransaction(async (tx) => {
    const current = await tx.get(ref);
    const planned = planDisbursementSync(current.exists ? (current.data() as Data) : undefined, before);
    // Without the matter there's no total to keep; leave the count alone so nothing is lost.
    if (!matter.exists) {
      delete planned.patch['wipCountedCents'];
      planned.wipDelta = 0;
    }
    if (planned.wipDelta) tx.update(matterRef, { disbursementWipCents: FieldValue.increment(planned.wipDelta) });
    if (current.exists && Object.keys(planned.patch).length) tx.update(ref, planned.patch);
    return planned;
  });

  if (!before && after && matter.exists) await recordMatterActivity(db, orgId, matterId, ctx.time);

  const outcome = { wipDelta: plan.wipDelta, patched: Object.keys(plan.patch) };
  log.info('disbursement synced', { matterId, disbursementId, ...outcome });
  return outcome;
}

export const onWriteDefinition: TriggerDefinition = {
  name: 'disbursements-onWrite',
  document: 'orgs/{orgId}/matters/{matterId}/disbursements/{disbursementId}',
  on: 'written',
  handler: async (change, ctx) => void (await syncDisbursement(change, ctx)),
};

export const onWrite = defineTrigger(onWriteDefinition);
