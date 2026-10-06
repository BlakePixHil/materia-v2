import { FeeInput, type FeeArrangement, type FeeTerms } from '@materia/domain';

import { dollarsText, parseDollars } from '../settings/money';

/** The Edit fee arrangement form as typed (dollars and percentages as text). */
export interface FeeForm {
  arrangement: FeeArrangement;
  amount: string;
  cap: string;
  estimate: string;
  estimateLow: string;
  estimateHigh: string;
  rateOverride: string;
  upliftPct: string;
  condition: string;
  reason: string;
}

/** The form for a matter's current fee (hourly with nothing filled in when it has none). */
export function feeFormOf(fee: Partial<FeeTerms> | null | undefined): FeeForm {
  return {
    arrangement: fee?.arrangement ?? 'hourly',
    amount: dollarsText(fee?.amountCents),
    cap: dollarsText(fee?.capCents),
    estimate: dollarsText(fee?.estimateCents),
    estimateLow: dollarsText(fee?.estimateLowCents),
    estimateHigh: dollarsText(fee?.estimateHighCents),
    rateOverride: dollarsText(fee?.rateOverrideCents),
    upliftPct: fee?.conditional ? String(fee.conditional.upliftPct) : '',
    condition: fee?.conditional?.condition ?? '',
    reason: '',
  };
}

const MONEY_FIELDS = {
  amount: 'amountCents',
  cap: 'capCents',
  estimate: 'estimateCents',
  estimateLow: 'estimateLowCents',
  estimateHigh: 'estimateHighCents',
  rateOverride: 'rateOverrideCents',
} as const;
type MoneyField = keyof typeof MONEY_FIELDS;

/** Which amounts each arrangement takes (the rest are dropped, not sent). */
const FIELDS_FOR: Record<FeeArrangement, readonly MoneyField[]> = {
  hourly: ['estimate', 'estimateLow', 'estimateHigh', 'rateOverride'],
  fixed: ['amount', 'estimate', 'estimateLow', 'estimateHigh'],
  capped: ['cap', 'estimate', 'estimateLow', 'estimateHigh', 'rateOverride'],
  conditional: ['estimate', 'estimateLow', 'estimateHigh', 'rateOverride'],
  pro_bono: [],
};

export function feeFieldsFor(arrangement: FeeArrangement): readonly MoneyField[] {
  return FIELDS_FOR[arrangement];
}

const FIELD_OF_PATH: Record<string, keyof FeeForm> = {
  amountCents: 'amount',
  capCents: 'cap',
  estimateCents: 'estimate',
  estimateLowCents: 'estimateLow',
  estimateHighCents: 'estimateHigh',
  rateOverrideCents: 'rateOverride',
  conditional: 'condition',
  upliftPct: 'upliftPct',
  condition: 'condition',
};

export interface FeeFormResult {
  /** The fee to send, when the form is valid. */
  fee?: FeeInput;
  reason?: string;
  /** A message per form field. */
  errors: Partial<Record<keyof FeeForm, string>>;
}

/** The fee the form describes, checked as `fees-update` will check it, or the problems. */
export function feeFromForm(form: FeeForm): FeeFormResult {
  const errors: FeeFormResult['errors'] = {};
  const fee: Record<string, unknown> = { arrangement: form.arrangement };
  for (const field of FIELDS_FOR[form.arrangement]) {
    const value = parseDollars(form[field]);
    if (value === undefined) errors[field] = 'Enter an amount in dollars.';
    else if (value !== null) fee[MONEY_FIELDS[field]] = value;
  }
  if (form.arrangement === 'conditional') {
    const uplift = form.upliftPct.trim() === '' ? 0 : Number(form.upliftPct.trim().replace(/%$/, ''));
    if (!Number.isFinite(uplift) || uplift < 0 || uplift > 25) errors.upliftPct = 'Enter an uplift from 0% to 25%.';
    if (!form.condition.trim()) errors.condition = 'Say what counts as success.';
    fee['conditional'] = { upliftPct: uplift, condition: form.condition.trim() };
  }
  const parsed = FeeInput.safeParse(fee);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.map(String);
      const field = FIELD_OF_PATH[path.at(-1) ?? ''] ?? FIELD_OF_PATH[path[0] ?? ''] ?? 'reason';
      errors[field] ??= issue.message;
    }
  }
  const reason = form.reason.trim();
  if (!reason) errors.reason = 'Say why the fee is changing.';
  if (Object.keys(errors).length || !parsed.success) return { errors };
  return { fee: parsed.data, reason, errors };
}
