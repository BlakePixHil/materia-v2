import * as z from 'zod';

import { FeeInput } from './intake';
import { DocIdSchema } from './schemas/common';
import type { FeeTerms, MatterBudget } from './schemas/contacts-matters';
import { cents, formatCents, type Cents } from './values/money';

/*
 * Fee arrangements and matter budgets (BILL-05). A matter's fee (hourly, fixed, capped, conditional
 * or pro bono) and its estimate give the budget's basis; recorded value (all time at its rate plus
 * disbursements) is measured against it, and the responsible lawyer and their supervisor are
 * alerted at the org's thresholds (80% and 100% unless set), once per threshold per revision.
 * Ships behind `billing.feeBudgets` until a practitioner signs it off (BILL-05a).
 */

/** The thresholds (percent of the basis) budget alerts fire at unless the org sets its own. */
export const DEFAULT_BUDGET_ALERT_PCTS: readonly number[] = [80, 100];

/** Thresholds as an org may set them: 1 to 5 distinct whole percentages from 1 to 200. */
export const BudgetAlertPctsSchema = z
  .array(z.number().int().min(1).max(200))
  .min(1)
  .max(5)
  .refine((pcts) => new Set(pcts).size === pcts.length, { message: 'Each threshold can be listed once' })
  .transform((pcts) => [...pcts].sort((a, b) => a - b));

/** The org's alert thresholds (`org.billing.budgetAlertPcts`), sorted; the default when unset or malformed. */
export function budgetAlertPcts(
  org: { billing?: { budgetAlertPcts?: unknown } | undefined } | null | undefined,
): number[] {
  const parsed = BudgetAlertPctsSchema.safeParse(org?.billing?.budgetAlertPcts);
  return parsed.success ? parsed.data : [...DEFAULT_BUDGET_ALERT_PCTS];
}

/** The terms a basis is read from (optional fields may be present as undefined, as zod parses them). */
type BasisFee = Pick<FeeTerms, 'arrangement'> & {
  [K in 'amountCents' | 'capCents' | 'estimateCents' | 'estimateHighCents']?: FeeTerms[K] | undefined;
};

/**
 * What a matter's budget is measured against: the fixed fee, the cap, or the top of the estimate
 * (the single estimate when no range is given). Undefined for pro bono and for an hourly or
 * conditional matter without an estimate.
 */
export function feeBasisCents(fee: BasisFee | null | undefined): Cents | undefined {
  if (!fee || fee.arrangement === 'pro_bono') return undefined;
  if (fee.arrangement === 'fixed') return fee.amountCents;
  if (fee.arrangement === 'capped') return fee.capCents;
  return fee.estimateHighCents ?? fee.estimateCents;
}

/** Recorded against the basis as a whole-number percentage (86 = 86%, may pass 100); undefined without a basis. */
export function budgetPct(recordedCents: number, basisCents: number | undefined): number | undefined {
  if (basisCents === undefined) return undefined;
  if (basisCents <= 0) return recordedCents > 0 ? 100 : 0;
  return Math.round((recordedCents * 100) / basisCents);
}

/** The totals the budget is built from, as the triggers sum them. */
export interface BudgetSums {
  /** Every live time entry at its rate, billable or not, any status. */
  timeCents: number;
  /** Every live disbursement, ex GST. */
  disbursementsCents: number;
  /** Time and disbursements already billed. */
  billedCents: number;
}

/**
 * The thresholds `recordedCents` has reached against `basisCents`, compared exactly (79.6% has not
 * reached 80%). A zero basis is reached by any recorded value.
 */
export function reachedThresholds(recordedCents: number, basisCents: number | undefined, pcts: readonly number[]) {
  if (basisCents === undefined) return [];
  if (basisCents <= 0) return recordedCents > 0 ? [...pcts] : [];
  return pcts.filter((pct) => recordedCents * 100 >= basisCents * pct);
}

export interface BudgetPlan {
  budget: MatterBudget;
  /** Thresholds to alert now (reached, not yet alerted this revision, and alerts are on). */
  fire: number[];
}

/**
 * The budget a matter should hold, and the alerts to send. A new fee revision re-arms every
 * threshold; pro bono never alerts but still records value for reporting. With `alertsOn` false
 * (the flag is off) nothing is marked alerted, so the alerts still fire once it's turned on.
 */
export function planBudget(options: {
  fee: (BasisFee & { revision?: number | undefined }) | null | undefined;
  previous: MatterBudget | null | undefined;
  sums: BudgetSums;
  pcts: readonly number[];
  alertsOn: boolean;
}): BudgetPlan {
  const { fee, previous, sums } = options;
  const revision = fee?.revision ?? 0;
  const timeCents = cents(sums.timeCents);
  const disbursementsCents = cents(sums.disbursementsCents);
  const recordedCents = cents(timeCents + disbursementsCents);
  const basisCents = feeBasisCents(fee);
  const pct = budgetPct(recordedCents, basisCents);
  const already = previous?.revision === revision ? (previous.alerted ?? []) : [];
  const fire = options.alertsOn
    ? reachedThresholds(recordedCents, basisCents, options.pcts).filter((t) => !already.includes(t))
    : [];
  const budget: MatterBudget = {
    recordedCents,
    billedCents: cents(sums.billedCents),
    ...(basisCents !== undefined ? { basisCents } : {}),
    ...(pct !== undefined ? { pct } : {}),
    timeCents,
    disbursementsCents,
    revision,
    alerted: [...already, ...fire].sort((a, b) => a - b),
  };
  return { budget, fire };
}

/** Whether two budgets hold the same figures (so the trigger needn't write). */
export function sameBudget(a: MatterBudget | null | undefined, b: MatterBudget): boolean {
  if (!a) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof MatterBudget>;
  for (const key of keys) {
    const x = a[key];
    const y = b[key];
    if (Array.isArray(x) || Array.isArray(y)) {
      if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length || x.some((v, i) => v !== y[i])) return false;
    } else if (x !== y) return false;
  }
  return true;
}

/**
 * On a capped matter, the recorded value over the cap: BILL-07 bills no more than the cap and
 * marks this much WIP non-billable on the invoice. Zero for every other arrangement.
 */
export function capExcessCents(fee: BasisFee | null | undefined, recordedCents: number): Cents {
  if (fee?.arrangement !== 'capped' || fee.capCents === undefined) return cents(0);
  return cents(Math.max(0, recordedCents - fee.capCents));
}

// ---------- describing a fee ----------

export const FEE_ARRANGEMENT_LABELS: Record<FeeTerms['arrangement'], string> = {
  hourly: 'Hourly',
  fixed: 'Fixed fee',
  capped: 'Capped fee',
  conditional: 'Conditional (no win, no fee)',
  pro_bono: 'Pro bono',
};

const money = (value: number | undefined) => (value === undefined ? undefined : formatCents(value as Cents));

/** The estimate as a person reads it: "$4,000.00 to $6,000.00", "$5,000.00", or undefined. */
export function feeEstimateText(fee: Pick<FeeTerms, 'estimateCents' | 'estimateLowCents' | 'estimateHighCents'>) {
  const low = money(fee.estimateLowCents);
  const high = money(fee.estimateHighCents);
  if (low && high) return `${low} to ${high}`;
  if (high) return `up to ${high}`;
  if (low) return `from ${low}`;
  return money(fee.estimateCents);
}

/** One line per term that differs between two fee arrangements ("Cap: $5,000.00 → $6,000.00"). */
export function feeChanges(from: FeeTerms | undefined, to: FeeTerms | undefined): string[] {
  if (!to) return [];
  const lines: string[] = [];
  const before = (from ?? {}) as Partial<FeeTerms>;
  const line = (label: string, a: string | undefined, b: string | undefined) => {
    if (a !== b) lines.push(`${label}: ${a ?? 'none'} → ${b ?? 'none'}`);
  };
  line(
    'Arrangement',
    before.arrangement && FEE_ARRANGEMENT_LABELS[before.arrangement],
    FEE_ARRANGEMENT_LABELS[to.arrangement],
  );
  line('Fixed fee', money(before.amountCents), money(to.amountCents));
  line('Cap', money(before.capCents), money(to.capCents));
  line('Estimate', feeEstimateText(before), feeEstimateText(to));
  line('Hourly rate', money(before.rateOverrideCents), money(to.rateOverrideCents));
  line(
    'Uplift',
    before.conditional ? `${before.conditional.upliftPct}%` : undefined,
    to.conditional ? `${to.conditional.upliftPct}%` : undefined,
  );
  line('Success means', before.conditional?.condition, to.conditional?.condition);
  return lines;
}

/** The terms of a fee, without its revision count and history (what a revision records). */
export function feeTerms(fee: FeeTerms & { revision?: unknown; history?: unknown }): FeeTerms {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fee)) {
    if (value !== undefined && key !== 'revision' && key !== 'history') clean[key] = value;
  }
  return clean as FeeTerms;
}

// ---------- the fees-update callable ----------

export const FEE_CALLABLES = {
  update: 'fees-update',
} as const;

/**
 * `fees-update` (`matter.fee`: lawyer and above; flag `billing.feeBudgets`; idempotent): revises a
 * matter's fee arrangement with a reason. It counts as a new revision (budget alerts re-arm) and
 * applies from now on: final, billed and written-off time keeps its snapshot, and invoices already
 * issued are unaffected. A conditional fee needs its success definition.
 */
export const UpdateFeeInput = /* @__PURE__ */ z.object({
  requestId: z.uuid(),
  matterId: DocIdSchema,
  fee: FeeInput,
  reason: z.string().trim().min(1, { message: 'Say why the fee is changing' }).max(500),
});
export type UpdateFeeInput = z.infer<typeof UpdateFeeInput>;

export interface UpdateFeeResult {
  matterId: string;
  revision: number;
  /** False when the terms didn't change (nothing was written). */
  changed: boolean;
}
