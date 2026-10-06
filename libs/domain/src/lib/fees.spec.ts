import {
  budgetAlertPcts,
  budgetPct,
  capExcessCents,
  DEFAULT_BUDGET_ALERT_PCTS,
  feeBasisCents,
  feeChanges,
  feeEstimateText,
  feeTerms,
  planBudget,
  reachedThresholds,
  sameBudget,
  UpdateFeeInput,
} from './fees';
import { FeeInput } from './intake';
import { BillingSettingsInput } from './org-settings';
import { Matter } from './schemas/contacts-matters';
import type { Cents } from './values/money';

/** BILL-05: fee arrangements, the budget maths and the alert thresholds. Amounts are fictional. */

const c = (value: number) => value as Cents;
const sums = (timeCents: number, disbursementsCents = 0, billedCents = 0) => ({
  timeCents,
  disbursementsCents,
  billedCents,
});
const PCTS = [80, 100];

describe('feeBasisCents', () => {
  it('is the fixed fee, the cap, or the top of the estimate', () => {
    expect(feeBasisCents({ arrangement: 'fixed', amountCents: c(330000), estimateCents: c(900000) })).toBe(330000);
    expect(feeBasisCents({ arrangement: 'capped', capCents: c(500000), estimateHighCents: c(450000) })).toBe(500000);
    expect(feeBasisCents({ arrangement: 'hourly', estimateCents: c(400000), estimateHighCents: c(600000) })).toBe(
      600000,
    );
    expect(feeBasisCents({ arrangement: 'hourly', estimateCents: c(400000) })).toBe(400000);
    expect(feeBasisCents({ arrangement: 'conditional', estimateHighCents: c(2500000) })).toBe(2500000);
  });

  it('has no basis for pro bono, an hourly matter without an estimate, or no fee', () => {
    expect(feeBasisCents({ arrangement: 'pro_bono' })).toBeUndefined();
    expect(feeBasisCents({ arrangement: 'hourly' })).toBeUndefined();
    expect(feeBasisCents(null)).toBeUndefined();
  });
});

describe('budgetPct and reachedThresholds', () => {
  it('rounds to a whole percentage and may pass 100', () => {
    expect(budgetPct(258000, 300000)).toBe(86);
    expect(budgetPct(331650, 330000)).toBe(101);
    expect(budgetPct(1000, undefined)).toBeUndefined();
    expect(budgetPct(0, 0)).toBe(0);
    expect(budgetPct(1, 0)).toBe(100);
  });

  it('compares exactly: 79.6% has not reached 80%', () => {
    expect(reachedThresholds(79600, 100000, PCTS)).toEqual([]);
    expect(reachedThresholds(80000, 100000, PCTS)).toEqual([80]);
    expect(reachedThresholds(100000, 100000, PCTS)).toEqual([80, 100]);
    expect(reachedThresholds(5000, undefined, PCTS)).toEqual([]);
    expect(reachedThresholds(1, 0, PCTS)).toEqual([80, 100]);
  });
});

describe('planBudget', () => {
  const fixed = { arrangement: 'fixed' as const, amountCents: c(330000), revision: 0 };

  it('records all time and disbursements against a fixed fee, so profitability shows', () => {
    const { budget, fire } = planBudget({
      fee: fixed,
      previous: null,
      sums: sums(200000, 15000, 50000),
      pcts: PCTS,
      alertsOn: true,
    });
    expect(budget).toEqual({
      recordedCents: 215000,
      billedCents: 50000,
      basisCents: 330000,
      pct: 65,
      timeCents: 200000,
      disbursementsCents: 15000,
      revision: 0,
      alerted: [],
    });
    expect(fire).toEqual([]);
  });

  it('gives each arrangement its own basis', () => {
    const at = (fee: Parameters<typeof planBudget>[0]['fee']) =>
      planBudget({ fee, previous: null, sums: sums(240000), pcts: PCTS, alertsOn: true }).budget;
    expect(at({ arrangement: 'capped', capCents: c(300000) })).toMatchObject({ basisCents: 300000, pct: 80 });
    expect(at({ arrangement: 'hourly', estimateCents: c(200000), estimateHighCents: c(400000) })).toMatchObject({
      basisCents: 400000,
      pct: 60,
    });
    expect(at({ arrangement: 'conditional', estimateCents: c(240000) })).toMatchObject({
      basisCents: 240000,
      pct: 100,
    });
  });

  it('fires each threshold once per revision', () => {
    const first = planBudget({ fee: fixed, previous: null, sums: sums(270000), pcts: PCTS, alertsOn: true });
    expect(first.fire).toEqual([80]);
    expect(first.budget.alerted).toEqual([80]);
    const again = planBudget({ fee: fixed, previous: first.budget, sums: sums(280000), pcts: PCTS, alertsOn: true });
    expect(again.fire).toEqual([]);
    const over = planBudget({ fee: fixed, previous: again.budget, sums: sums(340000), pcts: PCTS, alertsOn: true });
    expect(over.fire).toEqual([100]);
    expect(over.budget.alerted).toEqual([80, 100]);
    // Recorded value falling back (an entry deleted) doesn't fire or re-arm anything.
    const back = planBudget({ fee: fixed, previous: over.budget, sums: sums(100000), pcts: PCTS, alertsOn: true });
    expect(back.fire).toEqual([]);
    expect(back.budget.alerted).toEqual([80, 100]);
  });

  it('re-arms every threshold when the fee is revised after the 100% alert', () => {
    const over = planBudget({ fee: fixed, previous: null, sums: sums(340000), pcts: PCTS, alertsOn: true });
    expect(over.fire).toEqual([80, 100]);
    const revised = { arrangement: 'fixed' as const, amountCents: c(400000), revision: 1 };
    const next = planBudget({ fee: revised, previous: over.budget, sums: sums(340000), pcts: PCTS, alertsOn: true });
    expect(next.fire).toEqual([80]);
    expect(next.budget).toMatchObject({ revision: 1, alerted: [80], pct: 85 });
  });

  it('never alerts on pro bono but still records value for reporting', () => {
    const { budget, fire } = planBudget({
      fee: { arrangement: 'pro_bono' },
      previous: null,
      sums: sums(990000, 4000),
      pcts: PCTS,
      alertsOn: true,
    });
    expect(fire).toEqual([]);
    expect(budget).toEqual({
      recordedCents: 994000,
      billedCents: 0,
      timeCents: 990000,
      disbursementsCents: 4000,
      revision: 0,
      alerted: [],
    });
  });

  it('marks nothing alerted while alerts are off, so they fire once turned on', () => {
    const off = planBudget({ fee: fixed, previous: null, sums: sums(340000), pcts: PCTS, alertsOn: false });
    expect(off.fire).toEqual([]);
    expect(off.budget.alerted).toEqual([]);
    const on = planBudget({ fee: fixed, previous: off.budget, sums: sums(340000), pcts: PCTS, alertsOn: true });
    expect(on.fire).toEqual([80, 100]);
  });

  it('uses the org’s thresholds', () => {
    expect(planBudget({ fee: fixed, previous: null, sums: sums(170000), pcts: [50, 75], alertsOn: true }).fire).toEqual(
      [50],
    );
  });
});

describe('sameBudget', () => {
  it('compares every figure and the alerted list', () => {
    const { budget } = planBudget({
      fee: { arrangement: 'fixed', amountCents: c(100) },
      previous: null,
      sums: sums(10),
      pcts: PCTS,
      alertsOn: true,
    });
    expect(sameBudget(budget, { ...budget })).toBe(true);
    expect(sameBudget(null, budget)).toBe(false);
    expect(sameBudget(budget, { ...budget, recordedCents: c(11) })).toBe(false);
    expect(sameBudget(budget, { ...budget, alerted: [80] })).toBe(false);
    expect(sameBudget({ ...budget, alerted: [80] }, { ...budget, alerted: [100] })).toBe(false);
    expect(sameBudget(budget, { ...budget, pct: undefined })).toBe(false);
  });
});

describe('capExcessCents', () => {
  it('is the recorded value over a cap (BILL-07 bills no more than the cap)', () => {
    expect(capExcessCents({ arrangement: 'capped', capCents: c(500000) }, 560000)).toBe(60000);
    expect(capExcessCents({ arrangement: 'capped', capCents: c(500000) }, 400000)).toBe(0);
    expect(capExcessCents({ arrangement: 'fixed', amountCents: c(100) }, 400000)).toBe(0);
    expect(capExcessCents(null, 400000)).toBe(0);
  });
});

describe('budgetAlertPcts', () => {
  it('reads the org’s thresholds sorted, else 80 and 100', () => {
    expect(budgetAlertPcts({ billing: { budgetAlertPcts: [100, 75] } })).toEqual([75, 100]);
    expect(budgetAlertPcts({ billing: {} })).toEqual([...DEFAULT_BUDGET_ALERT_PCTS]);
    expect(budgetAlertPcts({ billing: { budgetAlertPcts: [80, 80] } })).toEqual([80, 100]);
    expect(budgetAlertPcts({ billing: { budgetAlertPcts: [] } })).toEqual([80, 100]);
    expect(budgetAlertPcts(undefined)).toEqual([80, 100]);
  });

  it('is part of the billing settings', () => {
    const billing = {
      defaultRateCents: 30000,
      unitMinutes: 6,
      rounding: 'up',
      gstRegistered: true,
      invoicePrefix: 'INV-',
      paymentTermsDays: 14,
    };
    expect(BillingSettingsInput.parse({ ...billing, budgetAlertPcts: [100, 90] }).budgetAlertPcts).toEqual([90, 100]);
    expect(BillingSettingsInput.safeParse({ ...billing, budgetAlertPcts: [0] }).success).toBe(false);
    expect(BillingSettingsInput.safeParse(billing).success).toBe(true);
  });
});

describe('describing a fee', () => {
  it('reads the estimate', () => {
    expect(feeEstimateText({ estimateLowCents: c(400000), estimateHighCents: c(600000) })).toBe(
      '$4,000.00 to $6,000.00',
    );
    expect(feeEstimateText({ estimateHighCents: c(600000) })).toBe('up to $6,000.00');
    expect(feeEstimateText({ estimateLowCents: c(400000) })).toBe('from $4,000.00');
    expect(feeEstimateText({ estimateCents: c(500000) })).toBe('$5,000.00');
    expect(feeEstimateText({})).toBeUndefined();
  });

  it('lists what a revision changed', () => {
    expect(
      feeChanges(
        { arrangement: 'hourly', estimateCents: c(500000) },
        { arrangement: 'capped', capCents: c(700000), estimateCents: c(500000) },
      ),
    ).toEqual(['Arrangement: Hourly → Capped fee', 'Cap: none → $7,000.00']);
    expect(
      feeChanges(undefined, {
        arrangement: 'conditional',
        conditional: { upliftPct: 25, condition: 'Judgment or settlement for the plaintiff' },
      }),
    ).toEqual([
      'Arrangement: none → Conditional (no win, no fee)',
      'Uplift: none → 25%',
      'Success means: none → Judgment or settlement for the plaintiff',
    ]);
    expect(feeChanges({ arrangement: 'hourly' }, undefined)).toEqual([]);
  });

  it('strips the revision and history from the terms', () => {
    expect(
      feeTerms({ arrangement: 'fixed', amountCents: c(100), estimateCents: undefined, revision: 3, history: [] }),
    ).toEqual({ arrangement: 'fixed', amountCents: 100 });
  });
});

describe('UpdateFeeInput and the stored fee', () => {
  const base = { requestId: '7d4f8f7e-2a6b-4c1e-9b7a-0d5c2e1f3a4b', matterId: 'm1', reason: 'Scope widened' };

  it('needs a reason and a valid fee', () => {
    expect(UpdateFeeInput.safeParse({ ...base, fee: { arrangement: 'hourly' } }).success).toBe(true);
    expect(UpdateFeeInput.safeParse({ ...base, reason: '  ', fee: { arrangement: 'hourly' } }).success).toBe(false);
  });

  it('refuses a conditional fee without its success definition', () => {
    expect(
      UpdateFeeInput.safeParse({ ...base, fee: { arrangement: 'conditional', conditional: { upliftPct: 10 } } })
        .success,
    ).toBe(false);
    expect(FeeInput.safeParse({ arrangement: 'conditional' }).success).toBe(false);
  });

  it('checks the estimate range', () => {
    expect(FeeInput.safeParse({ arrangement: 'hourly', estimateLowCents: 500, estimateHighCents: 400 }).success).toBe(
      false,
    );
    expect(FeeInput.safeParse({ arrangement: 'capped', capCents: 1000, estimateHighCents: 2000 }).success).toBe(false);
    expect(FeeInput.safeParse({ arrangement: 'pro_bono', estimateHighCents: 2000 }).success).toBe(false);
    expect(FeeInput.safeParse({ arrangement: 'hourly', estimateLowCents: 400, estimateHighCents: 500 }).success).toBe(
      true,
    );
  });

  it('reads old history entries and defaults the revision', () => {
    const fee = Matter.schema.shape.fee.parse({
      arrangement: 'hourly',
      history: [{ at: new Date('2026-01-01T00:00:00Z'), by: 'u1', change: 'Created' }],
    });
    expect(fee.revision).toBeUndefined();
    expect(fee.history[0]?.change).toBe('Created');
  });
});
