import { disbursementAmounts, disbursementWipContribution, GstTreatmentSchema } from '@materia/domain';

import { matterPath } from '../matters/shared';

type Data = Record<string, unknown>;

export const disbursementPath = (orgId: string, matterId: string, disbursementId: string) =>
  `${matterPath(orgId, matterId)}/disbursements/${disbursementId}`;

export interface DisbursementSyncPlan {
  /** Fields to write on the disbursement (recomputed amounts, `wipCountedCents`). */
  patch: Data;
  /** What to add to the matter's `disbursementWipCents`. */
  wipDelta: number;
}

const counted = (data: Data | undefined): number => {
  const value = data?.['wipCountedCents'];
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : 0;
};

const cents = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/**
 * What `disbursements-onWrite` writes for a disbursement's current state (`current`; `before` only
 * matters once the document is gone). A live, unbilled one gets `amountExGstCents` and `gstCents`
 * recomputed from what was entered (`amountIncGstCents` when entered GST-inclusive) and the GST
 * treatment, overwriting the client's preview; billed and written-off ones keep their amounts. Then
 * its WIP contribution is compared with what it has counted so far (`wipCountedCents`) and the
 * difference goes to the matter. Planning the next event against its own write finds nothing to do.
 */
export function planDisbursementSync(current: Data | undefined, before: Data | undefined): DisbursementSyncPlan {
  if (!current) return { patch: {}, wipDelta: -counted(before) };
  const patch: Data = {};
  const treatment = GstTreatmentSchema.safeParse(current['gstTreatment']);
  const inclusive = cents(current['amountIncGstCents']);
  const exclusive = cents(current['amountExGstCents']);
  if (
    current['status'] === 'unbilled' &&
    !current['deletedAt'] &&
    treatment.success &&
    (inclusive !== null || exclusive !== null)
  ) {
    const amounts = disbursementAmounts({
      amountExGstCents: exclusive,
      amountIncGstCents: inclusive,
      gstTreatment: treatment.data,
    });
    for (const key of ['amountExGstCents', 'gstCents'] as const) {
      if (current[key] !== amounts[key]) patch[key] = amounts[key];
    }
  }
  const contribution = disbursementWipContribution({ ...current, ...patch });
  const wipDelta = contribution - counted(current);
  if (wipDelta || current['wipCountedCents'] === undefined) patch['wipCountedCents'] = contribution;
  return { patch, wipDelta };
}
