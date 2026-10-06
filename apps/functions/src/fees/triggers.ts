import { recomputeBudget, type BudgetOutcome } from './budget';
import { defineTrigger, type TriggerContext, type TriggerDefinition } from '../core/trigger';

/** Recomputes the written document's matter budget (BILL-05). */
export function budgetForEvent(ctx: TriggerContext): Promise<BudgetOutcome | null> {
  const orgId = ctx.params['orgId'] as string;
  const matterId = ctx.params['matterId'] as string;
  return recomputeBudget({ db: ctx.db, orgId, clock: ctx.clock, log: ctx.log, ports: ctx.ports }, matterId);
}

/**
 * `fees-budgetOnTime`: any time entry write (new, edited, repriced by `time-onWrite`, approved,
 * billed, deleted) recomputes the matter's budget. `time-onWrite`'s repricing write fires it again,
 * which then finds the budget already right.
 */
export const budgetOnTimeDefinition: TriggerDefinition = {
  name: 'fees-budgetOnTime',
  document: 'orgs/{orgId}/matters/{matterId}/timeEntries/{entryId}',
  on: 'written',
  handler: async (_change, ctx) => void (await budgetForEvent(ctx)),
};

/** `fees-budgetOnDisbursement`: the same for disbursements (BILL-04), counted ex GST. */
export const budgetOnDisbursementDefinition: TriggerDefinition = {
  name: 'fees-budgetOnDisbursement',
  document: 'orgs/{orgId}/matters/{matterId}/disbursements/{disbursementId}',
  on: 'written',
  handler: async (_change, ctx) => void (await budgetForEvent(ctx)),
};

/**
 * `fees-budgetOnCreditNote` (BILL-07): a credit note lowers what its matter has billed, so the
 * budget is recomputed for the credit note's matter.
 */
export const budgetOnCreditNoteDefinition: TriggerDefinition = {
  name: 'fees-budgetOnCreditNote',
  document: 'orgs/{orgId}/creditNotes/{creditNoteId}',
  on: 'written',
  handler: async (change, ctx) => {
    const matterId = (change.after?.get('matterId') ?? change.before?.get('matterId')) as unknown;
    if (typeof matterId !== 'string' || !matterId) return;
    const orgId = ctx.params['orgId'] as string;
    await recomputeBudget({ db: ctx.db, orgId, clock: ctx.clock, log: ctx.log, ports: ctx.ports }, matterId);
  },
};

export const budgetOnTime = defineTrigger(budgetOnTimeDefinition);
export const budgetOnDisbursement = defineTrigger(budgetOnDisbursementDefinition);
export const budgetOnCreditNote = defineTrigger(budgetOnCreditNoteDefinition);
