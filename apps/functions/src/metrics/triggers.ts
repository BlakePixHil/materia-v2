import type { MetricsSourceKind } from '@materia/domain';

import { changedFields, type MetricsDeps } from './shared';
import { resyncMatterRecords, syncMetrics } from './sync';
import { defineTrigger, type TriggerContext, type TriggerDefinition } from '../core/trigger';

/**
 * The INS-01 sync triggers (ADR-048): every write of a record that rolls up re-syncs its figures.
 * Each is idempotent (the record's ledger says what was counted), so a redelivered or late event
 * changes nothing; the nightly `metrics-recompute` catches anything a failed run left behind.
 */

type Data = Record<string, unknown>;

const depsOf = (ctx: TriggerContext): MetricsDeps => ({ db: ctx.db, clock: ctx.clock, log: ctx.log });

/** A matter record (`matters/{matterId}/{collection}/{id}`) that rolls up. */
function matterRecordTrigger(
  name: string,
  collection: string,
  kind: Extract<MetricsSourceKind, 'time' | 'disbursement' | 'deadline'>,
): TriggerDefinition {
  return {
    name,
    document: `orgs/{orgId}/matters/{matterId}/${collection}/{recordId}`,
    on: 'written',
    handler: async (_change, ctx) => {
      const matterId = ctx.params['matterId'] as string;
      const outcome = await syncMetrics(depsOf(ctx), ctx.params['orgId'] as string, {
        kind,
        matterId,
        sourceId: ctx.params['recordId'] as string,
      });
      ctx.log.info('metrics synced', { kind, matterId, outcome });
    },
  };
}

/** `metrics-onTimeEntry`: time recorded, repriced, approved, billed, written off or deleted. */
export const onTimeEntryDefinition = matterRecordTrigger('metrics-onTimeEntry', 'timeEntries', 'time');
/** `metrics-onDisbursement`: disbursements recorded, billed, written off or deleted (BILL-04). */
export const onDisbursementDefinition = matterRecordTrigger('metrics-onDisbursement', 'disbursements', 'disbursement');
/** `metrics-onDeadline`: deadlines due, met, missed, waived, overridden or moved (CORE-10). */
export const onDeadlineDefinition = matterRecordTrigger('metrics-onDeadline', 'deadlines', 'deadline');

/** The matter fields its own figures read; other writes (WIP, activity, search) change nothing. */
const MATTER_FIELDS = [
  'status',
  'type',
  'createdAt',
  'closedAt',
  'estate',
  'closing',
  'stageId',
  'stageEnteredOn',
  'referrerContactId',
  'referralSource',
  'legacyBilling',
  'deletedAt',
  'destroyedAt',
] as const;

/**
 * `metrics-onMatter`: opened, closed, cycle times, stage durations, referrals and legacy billing.
 * A new type relabels the matter's time (`time.type.*`); a new referrer moves its billing between
 * referrers (`referrals.*`), so those records are re-synced too.
 */
export const onMatterDefinition: TriggerDefinition = {
  name: 'metrics-onMatter',
  document: 'orgs/{orgId}/matters/{matterId}',
  on: 'written',
  handler: async (change, ctx) => {
    const before = change.before?.data() as Data | undefined;
    const after = change.after?.data() as Data | undefined;
    if (!changedFields(before, after, MATTER_FIELDS)) return;
    const orgId = ctx.params['orgId'] as string;
    const matterId = ctx.params['matterId'] as string;
    const deps = depsOf(ctx);
    const outcome = await syncMetrics(deps, orgId, { kind: 'matter', matterId, sourceId: matterId });
    let resynced = 0;
    if (outcome !== 'skipped' && before && after) {
      const kinds = [
        ...(changedFields(before, after, ['type']) ? (['time'] as const) : []),
        ...(changedFields(before, after, ['referrerContactId']) ? (['invoice', 'creditNote'] as const) : []),
      ];
      if (kinds.length) resynced = await resyncMatterRecords(deps, orgId, matterId, kinds);
    }
    ctx.log.info('metrics synced', { kind: 'matter', matterId, outcome, resynced });
  },
};

/** An org-level billing document (`invoices`, `creditNotes`), counted in its matter's ledger. */
function billingTrigger(name: string, collection: string, kind: 'invoice' | 'creditNote'): TriggerDefinition {
  return {
    name,
    document: `orgs/{orgId}/${collection}/{recordId}`,
    on: 'written',
    handler: async (change, ctx) => {
      const matterId = (change.after?.get('matterId') ?? change.before?.get('matterId')) as unknown;
      if (typeof matterId !== 'string' || !matterId) return;
      const outcome = await syncMetrics(depsOf(ctx), ctx.params['orgId'] as string, {
        kind,
        matterId,
        sourceId: ctx.params['recordId'] as string,
      });
      ctx.log.info('metrics synced', { kind, matterId, outcome });
    },
  };
}

/** `metrics-onInvoice`: issued, paid, refunded, reversed or voided (BILL-07, BILL-08). */
export const onInvoiceDefinition = billingTrigger('metrics-onInvoice', 'invoices', 'invoice');
/** `metrics-onCreditNote`: credit notes on their issue date (BILL-07). */
export const onCreditNoteDefinition = billingTrigger('metrics-onCreditNote', 'creditNotes', 'creditNote');

const industryOf = (contact: Data | undefined) => (contact?.['referrerMeta'] as Data | undefined)?.['industry'] ?? null;

/**
 * `metrics-onContact`: a referrer's new industry moves its referred matters and their billing to
 * the new industry. Every other contact write changes nothing.
 */
export const onContactDefinition: TriggerDefinition = {
  name: 'metrics-onContact',
  document: 'orgs/{orgId}/contacts/{contactId}',
  on: 'updated',
  handler: async (change, ctx) => {
    if (industryOf(change.before?.data()) === industryOf(change.after?.data())) return;
    const orgId = ctx.params['orgId'] as string;
    const contactId = ctx.params['contactId'] as string;
    const deps = depsOf(ctx);
    const matters = await ctx.db.collection(`orgs/${orgId}/matters`).where('referrerContactId', '==', contactId).get();
    let resynced = 0;
    for (const matter of matters.docs) {
      await syncMetrics(deps, orgId, { kind: 'matter', matterId: matter.id, sourceId: matter.id });
      resynced += await resyncMatterRecords(deps, orgId, matter.id, ['invoice', 'creditNote']);
    }
    ctx.log.info('metrics synced', { kind: 'contact', matters: matters.size, resynced });
  },
};

export const onTimeEntry = defineTrigger(onTimeEntryDefinition);
export const onDisbursement = defineTrigger(onDisbursementDefinition);
export const onDeadline = defineTrigger(onDeadlineDefinition);
export const onMatter = defineTrigger(onMatterDefinition);
export const onInvoice = defineTrigger(onInvoiceDefinition);
export const onCreditNote = defineTrigger(onCreditNoteDefinition);
export const onContact = defineTrigger(onContactDefinition);
