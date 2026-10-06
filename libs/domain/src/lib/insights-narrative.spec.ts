import {
  checkNarrativeParagraph,
  citedFigure,
  ExplainInsightsInputSchema,
  figureChange,
  figureValue,
  narrativeContextJson,
  narrativeFigures,
  narrativeKey,
  narrativeNumberAccuracy,
  narrativeValue,
  numbersIn,
  verifiedNarrative,
  type NarrativeFigure,
} from './insights-narrative';
import type { MetricValues } from './metrics';

const values = new Map<string, MetricValues>([
  [
    '2026-04',
    {
      'billing.invoicedCents': 4_000_000,
      'billing.collectedCents': 3_000_000,
      'matters.opened': 3,
      'matters.opened.type.probate': 2,
      'matters.opened.type.will': 1,
      'deadlines.due': 4,
      'deadlines.metOnTime': 4,
      'matters.opened.referrer.c-referrer-1': 1,
      'referrals.referrer.c-referrer-1.billedCents': 500_000,
      'referrals.billedCents': 500_000,
      'debtors.total': 1_000_000,
      'debtors.d61_90': 250_000,
    },
  ],
  [
    '2026-05',
    {
      'billing.invoicedCents': 5_000_050,
      'billing.collectedCents': 2_460_000,
      'matters.opened': 2,
      'matters.opened.type.probate': 2,
      'deadlines.due': 5,
      'deadlines.metOnTime': 3,
      'deadlines.missed': 1,
      'time.billable.minutes': 750,
      'wip.timeCents': 800_000,
      'wip.disbursementsCents': 20_000,
      'cycle.probate.instructionsToGrant.d40': 1,
      'cycle.probate.instructionsToGrant.d50': 1,
      'clerk.calls': 40,
      'debtors.total': 1_800_000,
      'debtors.d61_90': 900_000,
    },
  ],
  ['2025-05', { 'billing.invoicedCents': 4_000_000, 'billing.collectedCents': 3_000_000, 'matters.opened': 4 }],
]);

const byMetric = (figures: NarrativeFigure[], metric: string, dimension?: string) =>
  citedFigure(figures, { metric, dimension });

describe('narrativeFigures', () => {
  const figures = narrativeFigures({ current: ['2026-05'], comparison: ['2026-04'], values });

  it('adds up flows, takes snapshots from the last month and works out medians and shares', () => {
    expect(byMetric(figures, 'billing.invoicedCents')).toMatchObject({ current: 5_000_050, comparison: 4_000_000 });
    expect(byMetric(figures, 'wip')).toMatchObject({ current: 820_000, comparison: null });
    expect(byMetric(figures, 'deadlines.metOnTimePct')).toMatchObject({ current: 75, comparison: 100 });
    expect(byMetric(figures, 'cycle.probate.instructionsToGrant')).toMatchObject({ current: 45, comparison: null });
    expect(byMetric(figures, 'matters.opened.type', 'probate')).toMatchObject({ current: 2, comparison: 2 });
    expect(byMetric(figures, 'matters.opened.type', 'will')).toMatchObject({ current: 0, comparison: 1 });
    expect(byMetric(figures, 'debtors.d61_90')).toMatchObject({ current: 900_000, comparison: 250_000 });
    expect(byMetric(figures, 'referrals.netBilledCents')).toMatchObject({ current: 0, comparison: 500_000 });

    const months = narrativeFigures({ current: ['2026-04', '2026-05'], comparison: null, values });
    expect(byMetric(months, 'billing.invoicedCents')).toMatchObject({ current: 9_000_050, comparison: null });
    // A snapshot is the last month's, never a sum.
    expect(byMetric(months, 'debtors.total')).toMatchObject({ current: 1_800_000 });
  });

  it('leaves out figures that are zero or missing in both periods, and anything but org totals', () => {
    expect(byMetric(figures, 'billing.writtenOff.timeCents')).toBeUndefined();
    expect(byMetric(figures, 'matters.opened.type', 'trust')).toBeUndefined();
    const text = JSON.stringify(figures);
    expect(text).not.toContain('c-referrer-1');
    expect(text).not.toContain('clerk');
    expect(narrativeFigures({ current: ['2027-01'], comparison: ['2026-01'], values })).toEqual([]);
  });
});

describe('how figures are written', () => {
  it('writes money in whole dollars, hours and days to one place, and shares as percentages', () => {
    expect(narrativeValue('money', 5_000_050)).toBe('$50,001');
    expect(narrativeValue('money', -12_345)).toBe('-$123');
    expect(narrativeValue('hours', 750)).toBe('12.5 hours');
    expect(narrativeValue('days', 45.5)).toBe('45.5 days');
    expect(narrativeValue('percent', 75)).toBe('75%');
    expect(narrativeValue('count', 1234)).toBe('1,234');
  });

  it('works out the change and the relative change, or percentage points for a share', () => {
    const figures = narrativeFigures({ current: ['2026-05'], comparison: ['2026-04'], values });
    expect(figureChange(byMetric(figures, 'billing.collectedCents') as NarrativeFigure)).toEqual({
      change: '-$5,400',
      changePct: '-18%',
    });
    expect(figureChange(byMetric(figures, 'deadlines.metOnTimePct') as NarrativeFigure)).toEqual({
      change: '-25 percentage points',
      changePct: null,
    });
    expect(figureChange(byMetric(figures, 'matters.opened.type', 'probate') as NarrativeFigure)).toEqual({
      change: 'no change',
      changePct: '0%',
    });
    expect(figureChange(byMetric(figures, 'wip') as NarrativeFigure)).toBeNull();
    expect(figureValue(byMetric(figures, 'wip') as NarrativeFigure, 'comparison')).toBeNull();
  });

  it('gives Clerk the periods and every figure as written, with no ids or member figures', () => {
    const figures = narrativeFigures({ current: ['2026-05'], comparison: ['2026-04'], values });
    const json = narrativeContextJson({
      current: { label: 'May 2026', months: ['2026-05'], toDate: false },
      comparison: { label: 'April 2026', months: ['2026-04'], toDate: false },
      figures,
    });
    expect(json['current']).toEqual({ label: 'May 2026', firstMonth: '2026-05', lastMonth: '2026-05', toDate: false });
    expect(json['figures']).toContainEqual({
      metric: 'billing.collectedCents',
      label: 'Collected (payments received, net of refunds)',
      current: '$24,600',
      comparison: '$30,000',
      change: '-$5,400',
      changePct: '-18%',
    });
    expect(json['figures']).toContainEqual({
      metric: 'wip',
      label: 'Work in progress at the end of the period (unbilled time and disbursements)',
      current: '$8,200',
      comparison: null,
    });
    const alone = narrativeContextJson({
      current: { label: 'May 2026', months: ['2026-05'], toDate: false },
      comparison: null,
      figures: narrativeFigures({ current: ['2026-05'], comparison: null, values }),
    });
    expect(alone['comparison']).toBeNull();
    expect((alone['figures'] as Record<string, unknown>[])[0]).not.toHaveProperty('change');
  });
});

describe('checking a narrative', () => {
  const figures = narrativeFigures({ current: ['2026-05'], comparison: ['2026-04'], values });
  const labels = ['May 2026', 'April 2026'];
  const both = (metric: string, dimension?: string) => [
    { metric, period: 'current' as const, ...(dimension ? { dimension } : {}) },
    { metric, period: 'comparison' as const, ...(dimension ? { dimension } : {}) },
  ];

  it('reads numbers as written', () => {
    expect(numbersIn('Collections fell 18% to $24,600.50 in May 2026, and 3 of 5 were met.')).toEqual([
      18, 24600.5, 2026, 3, 5,
    ]);
    expect(numbersIn('FY2026–27')).toEqual([2026, 27]);
  });

  it('accepts numbers from the cited figures, their change, their labels and the period names', () => {
    const paragraph = {
      text: 'Collections fell 18% (-$5,400) to $24,600 in May 2026, compared with $30,000 in April 2026. Of the debts, $9,000 was 61 to 90 days past due.',
      citations: [...both('billing.collectedCents'), { metric: 'debtors.d61_90', period: 'current' as const }],
    };
    expect(checkNarrativeParagraph(paragraph, figures, labels)).toEqual({
      ok: true,
      unmatched: [],
      unknownCitations: 0,
    });
  });

  it('fails a number that is rounded, added up, uncited or invented', () => {
    const cite = both('billing.collectedCents');
    expect(
      checkNarrativeParagraph({ text: 'Collected about $25,000.', citations: cite }, figures, labels),
    ).toMatchObject({
      ok: false,
      unmatched: [25000],
    });
    // The change needs both periods cited.
    expect(
      checkNarrativeParagraph(
        { text: 'Collections fell 18%.', citations: [{ metric: 'billing.collectedCents', period: 'current' }] },
        figures,
        labels,
      ).ok,
    ).toBe(false);
    expect(checkNarrativeParagraph({ text: 'Billed $50,001.', citations: [] }, figures, labels).ok).toBe(false);
    expect(
      checkNarrativeParagraph(
        { text: 'Three large probate invoices ($12,000) are unpaid.', citations: both('debtors.total') },
        figures,
        labels,
      ).unmatched,
    ).toEqual([12000]);
  });

  it('fails a citation of a figure that is not in the context, or of a period it has no value for', () => {
    expect(
      checkNarrativeParagraph(
        { text: 'Utilisation rose.', citations: [{ metric: 'utilisation', period: 'current' }] },
        figures,
        labels,
      ),
    ).toMatchObject({ ok: false, unknownCitations: 1 });
    expect(
      checkNarrativeParagraph(
        { text: 'WIP was recorded.', citations: [{ metric: 'wip', period: 'comparison' }] },
        figures,
        labels,
      ).ok,
    ).toBe(false);
  });

  it('shows only the paragraphs that pass, with each citation’s label and value', () => {
    const result = verifiedNarrative(
      [
        { text: 'Probate matters opened held at 2.', citations: both('matters.opened.type', 'probate') },
        { text: 'Billed rose to $51,000.', citations: both('billing.invoicedCents') },
        { text: '  ', citations: [] },
      ],
      figures,
      labels,
    );
    expect(result.omitted).toBe(2);
    expect(result.paragraphs).toEqual([
      {
        text: 'Probate matters opened held at 2.',
        citations: [
          {
            metric: 'matters.opened.type',
            dimension: 'probate',
            period: 'current',
            label: 'Matters opened: Probate',
            value: '2',
          },
          {
            metric: 'matters.opened.type',
            dimension: 'probate',
            period: 'comparison',
            label: 'Matters opened: Probate',
            value: '2',
          },
        ],
      },
    ]);
    expect(
      narrativeNumberAccuracy(
        [
          { text: 'Probate matters opened held at 2.', citations: both('matters.opened.type', 'probate') },
          { text: 'Billed rose to $51,000.', citations: both('billing.invoicedCents') },
        ],
        figures,
        labels,
      ),
    ).toBe(0.5);
    expect(narrativeNumberAccuracy([], figures, labels)).toBe(1);
  });
});

describe('the callable', () => {
  it('keys an explanation by its months and the comparison’s', () => {
    expect(narrativeKey({ months: ['2026-07', '2026-10'] }, { months: ['2025-07', '2025-10'] })).toBe(
      '2026-07_2026-10__2025-07_2025-10',
    );
    expect(narrativeKey({ months: ['2026-10'] }, null)).toBe('2026-10_2026-10__none');
  });

  it('takes the screen’s selection and defaults to explain', () => {
    expect(ExplainInsightsInputSchema.parse({ range: 'this_fy', compare: 'previous' })).toEqual({
      range: 'this_fy',
      compare: 'previous',
      mode: 'explain',
    });
    expect(ExplainInsightsInputSchema.safeParse({ range: 'custom', from: '2026-13', compare: 'none' }).success).toBe(
      false,
    );
  });
});
