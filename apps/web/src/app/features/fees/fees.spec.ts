import { feeFieldsFor, feeFormOf, feeFromForm } from './fee-form';
import { cleanUpOverlays, MATTER, meta, openMatter, PARALEGAL } from '../matter-detail/testing';
import { parseAlertPcts } from '../settings/billing-page';

/** BILL-05: the fee panel on the Overview and the Edit fee arrangement dialog. Fictional data only. */

afterEach(cleanUpOverlays);

const ON = { 'billing.feeBudgets': true };
const fixedFee = {
  arrangement: 'fixed',
  amountCents: 330_000,
  revision: 1,
  history: [
    {
      at: new Date('2026-09-20T00:00:00Z'),
      by: 'user-jordan',
      from: { arrangement: 'hourly', estimateCents: 300_000 },
      to: { arrangement: 'fixed', amountCents: 330_000 },
      reason: 'Client asked for certainty on costs',
    },
  ],
};
const budget = { recordedCents: 270_600, billedCents: 0, basisCents: 330_000, pct: 82, revision: 1, alerted: [80] };

describe('fee form', () => {
  it('reads a fee into the form and back', () => {
    const form = feeFormOf({ arrangement: 'capped', capCents: 500_000 as never, estimateHighCents: 450_000 as never });
    expect(form).toMatchObject({ arrangement: 'capped', cap: '5000.00', estimateHigh: '4500.00', reason: '' });
    expect(feeFromForm({ ...form, reason: 'Scope agreed' })).toEqual({
      fee: { arrangement: 'capped', capCents: 500_000, estimateHighCents: 450_000 },
      reason: 'Scope agreed',
      errors: {},
    });
    expect(feeFormOf(undefined).arrangement).toBe('hourly');
  });

  it('only sends the amounts the arrangement takes', () => {
    expect(feeFieldsFor('pro_bono')).toEqual([]);
    const form = { ...feeFormOf(undefined), arrangement: 'pro_bono' as const, estimate: '900', reason: 'Pro bono' };
    expect(feeFromForm(form).fee).toEqual({ arrangement: 'pro_bono' });
  });

  it('reports problems in place: a reason, amounts, the cap and the success definition', () => {
    expect(feeFromForm(feeFormOf(undefined)).errors).toEqual({ reason: 'Say why the fee is changing.' });
    const base = { ...feeFormOf(undefined), reason: 'Revised' };
    expect(feeFromForm({ ...base, estimateHigh: 'lots' }).errors).toEqual({
      estimateHigh: 'Enter an amount in dollars.',
    });
    expect(feeFromForm({ ...base, arrangement: 'fixed' }).errors).toEqual({ amount: 'Enter the fixed fee' });
    // Every problem shows at once, the reason with the rest.
    expect(feeFromForm({ ...base, arrangement: 'fixed', reason: '' }).errors).toEqual({
      amount: 'Enter the fixed fee',
      reason: 'Say why the fee is changing.',
    });
    expect(feeFromForm({ ...base, arrangement: 'capped', cap: '5000', estimateHigh: '6000' }).errors).toEqual({
      estimateHigh: 'The estimate cannot be more than the cap',
    });
    expect(feeFromForm({ ...base, estimateLow: '6000', estimateHigh: '5000' }).errors).toEqual({
      estimateLow: 'The low estimate cannot be more than the high estimate',
    });
    expect(feeFromForm({ ...base, arrangement: 'conditional', upliftPct: '30' }).errors).toEqual({
      upliftPct: 'Enter an uplift from 0% to 25%.',
      condition: 'Say what counts as success.',
    });
    expect(
      feeFromForm({ ...base, arrangement: 'conditional', upliftPct: '25', condition: 'A settlement for the plaintiff' })
        .fee,
    ).toEqual({
      arrangement: 'conditional',
      conditional: { upliftPct: 25, condition: 'A settlement for the plaintiff' },
    });
  });
});

describe('fee panel', () => {
  const panel = () => document.body.querySelector<HTMLElement>('[data-testid="fee-panel"]');

  it('stays hidden while the flag is off', async () => {
    await openMatter(undefined, { matter: { fee: fixedFee, budget } });
    expect(panel()).toBeNull();
  });

  it('shows the arrangement, the Meter against the fixed fee and the revision history', async () => {
    const page = await openMatter(undefined, { flags: ON, matter: { fee: fixedFee, budget } });
    await page.stable(50);
    expect(page.text(panel()?.querySelector('[data-testid="fee-arrangement"]'))).toBe('Fixed fee');
    expect(page.text(panel()?.querySelector('[data-testid="budget-figures"]'))).toBe(
      '$2,706.00 recorded of $3,300.00 fixed fee · 82%',
    );
    const meter = panel()?.querySelector('mt-meter');
    expect(meter?.getAttribute('aria-valuenow')).toBe('270600');
    expect(meter?.getAttribute('data-tone')).toBe('warning');
    expect(page.text(panel()?.querySelector('details'))).toContain('Client asked for certainty on costs');
    expect(page.text(panel()?.querySelector('details'))).toContain('Arrangement: Hourly → Fixed fee');
  });

  it('says when there is no budget to track', async () => {
    const page = await openMatter(undefined, { flags: ON, matter: { fee: { arrangement: 'pro_bono', history: [] } } });
    await page.stable(50);
    expect(page.text(panel()?.querySelector('[data-testid="budget-figures"]'))).toBe(
      '$0.00 recorded. Pro bono: no budget alerts.',
    );
  });

  it('revises the fee with a reason through fees-update', async () => {
    const calls: Record<string, unknown>[] = [];
    const page = await openMatter(undefined, {
      flags: ON,
      matter: { fee: fixedFee, budget },
      callables: {
        'fees-update': (data, fs) => {
          calls.push(data);
          const fee = data['fee'] as Record<string, unknown>;
          fs.set(MATTER, { ...(fs.get(MATTER) ?? {}), fee: { ...fee, revision: 2, history: [] }, ...meta });
          return { matterId: 'm-whitfield', revision: 2, changed: true };
        },
      },
    });
    await page.stable(50);
    await page.click('Edit fee arrangement');
    // The dialog is a lazy chunk: under a busy full run it can take longer than a fixed pause.
    await vi.waitFor(() => expect(page.dialog()).not.toBeNull());
    await page.stable(50);
    await page.fill('Fixed fee', '4,000');
    await page.submit(page.dialog());
    expect(page.text(page.dialog())).toContain('Say why the fee is changing.');
    expect(calls).toHaveLength(0);
    await page.fill('Reason for the change', 'Contested application');
    await page.submit(page.dialog());
    await page.stable(50);
    expect(calls).toEqual([
      expect.objectContaining({
        matterId: 'm-whitfield',
        fee: { arrangement: 'fixed', amountCents: 400_000 },
        reason: 'Contested application',
      }),
    ]);
    expect(page.dialog()).toBeNull();
    expect(page.text(panel()?.querySelector('[data-testid="budget-figures"]'))).toBe(
      '$2,706.00 recorded of $4,000.00 fixed fee · 68%',
    );
  });

  it('hides Edit from paralegals', async () => {
    const page = await openMatter(undefined, { session: PARALEGAL, flags: ON, matter: { fee: fixedFee, budget } });
    await page.stable(50);
    // Paralegals don't see billing at all (billing.view).
    expect(panel()).toBeNull();
    expect(page.text()).not.toContain('Edit fee arrangement');
  });
});

describe('budget alert thresholds in Settings → Billing and rates', () => {
  it('reads "80, 100%" as thresholds', () => {
    expect(parseAlertPcts('80, 100%')).toEqual([80, 100]);
    expect(parseAlertPcts('75 90')).toEqual([75, 90]);
    expect(parseAlertPcts('')).toBeUndefined();
    expect(parseAlertPcts('80, lots')).toBeUndefined();
    expect(parseAlertPcts('80.5')).toBeUndefined();
  });
});
