import type { ReviewCode, TransformContext } from './context.ts';
import { legacyDateOnly } from './dates.ts';
import { centsOf } from './values.ts';
import { obj, str } from '../legacy/snapshot.ts';

/**
 * A card's `fee` and `billable` (D-06). The fee's `value` is the estimate the legacy fee dialog
 * took, in dollars; the billing type maps by the profile (folio → hourly with a note). The raw fee
 * stays on the matter as `legacy.fee`. `billable` becomes read-only `legacyBilling`, never a v2
 * invoice (gapless numbering), with `billingTotalCents` for Insights (INS-01 `legacyBilledCents`).
 */

export interface FeeResult {
  fee: Record<string, unknown>;
  review: ReviewCode[];
  /** Note texts the matter gets (the folio arrangement, disbursements recorded on the fee). */
  notes: { key: string; text: string }[];
  /** The raw legacy fee and the billed amount it recorded, for `matter.legacy`. */
  legacy?: Record<string, unknown>;
}

export function mapFee(ctx: TransformContext, raw: unknown, legacyPath: string): FeeResult {
  const fee = obj(raw);
  const review: ReviewCode[] = [];
  const notes: FeeResult['notes'] = [];
  const type = str(fee?.['billingType'])?.trim() ?? '';
  const estimate = centsOf(ctx, fee?.['value']);
  // 0 is what the dialog stores when nothing was entered (the badge shows nothing for it).
  const amount = estimate && estimate > 0 ? estimate : undefined;
  const types = ctx.profile.fees.billingTypes;

  let terms: Record<string, unknown>;
  switch (type) {
    case 'fixed':
      terms = { arrangement: types.fixed, ...(amount ? { amountCents: amount } : {}) };
      if (!amount) review.push('fee_amount_missing');
      break;
    case 'hourly':
      terms = { arrangement: types.hourly, ...(amount ? { estimateCents: amount } : {}) };
      break;
    case 'nowin':
      // A conditional fee needs its uplift and condition, which legacy never held.
      terms = { arrangement: types.nowin, ...(amount ? { estimateCents: amount } : {}) };
      review.push('fee_conditional_terms');
      break;
    case 'folio': {
      const field = { hourly: 'estimateCents', fixed: 'amountCents', capped: 'capCents' }[types.folio];
      terms = { arrangement: types.folio, ...(amount ? { [field]: amount } : {}) };
      if (types.folio !== 'hourly' && !amount) review.push('fee_amount_missing');
      ctx.warnings.add('MIG_W_FEE_FOLIO', legacyPath);
      notes.push({
        key: 'fee-folio',
        text: `**Fee (imported)**\n\nThis matter was billed by folio in the legacy app. It is set up as ${types.folio} here.`,
      });
      break;
    }
    default:
      // No billing type (or none the legacy app had): hourly with no estimate, for review.
      terms = { arrangement: 'hourly' };
      review.push('fee_type_missing');
      ctx.warnings.add(type ? 'MIG_W_FEE_TYPE_UNKNOWN' : 'MIG_W_FEE_TYPE_MISSING', legacyPath);
  }

  // Older cards recorded disbursements on the fee. They stay on the matter for review rather than
  // become disbursement records, which would enter WIP and could be billed a second time.
  const disbursements = centsOf(ctx, fee?.['disbursements']);
  if (fee?.['hasDisbursements'] === true || (disbursements !== undefined && disbursements > 0)) {
    review.push('fee_disbursements');
    ctx.warnings.add('MIG_W_FEE_DISBURSEMENTS', legacyPath);
    notes.push({
      key: 'fee-disbursements',
      text:
        '**Disbursements (imported)**\n\nThe legacy fee recorded disbursements' +
        (disbursements ? ` of ${dollars(disbursements)}` : '') +
        '. Add them as disbursements here if they are still to be billed.',
    });
  }

  const billed = centsOf(ctx, fee?.['billedFees'] ?? fee?.['realisedFees']);
  return {
    fee: { ...terms, history: [] },
    review,
    notes,
    ...(fee ? { legacy: { fee, ...(billed !== undefined ? { billedFeesCents: billed } : {}) } } : {}),
  };
}

function dollars(cents: number): string {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(cents / 100);
}

/** A card's `billable` as `legacyBilling`: the raw fields, the total in cents, the billing date checked. */
export function mapLegacyBilling(
  ctx: TransformContext,
  raw: unknown,
  legacyPath: string,
): Record<string, unknown> | undefined {
  const billable = obj(raw);
  if (!billable) return undefined;
  const total = centsOf(ctx, billable['billingTotal']);
  const billingDate = legacyDateOnly(ctx, billable['billingDate'], legacyPath);
  const rest: Record<string, unknown> = { ...billable };
  delete rest['billingDate'];
  return {
    ...rest,
    ...(billingDate ? { billingDate } : {}),
    ...(total !== undefined ? { billingTotalCents: total } : {}),
  };
}
