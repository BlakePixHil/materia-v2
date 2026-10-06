import { comparisonPeriod, dateOnly, insightsPeriod, type MetricValues } from '@materia/domain';

import {
  buildInsights,
  chartCsv,
  deltaView,
  memberNames,
  trendMonthsOf,
  visibleMembers,
  type InsightsInput,
  type InsightsMember,
} from './insights-view';

/** INS-02: the Insights screen's figures from INS-01 metrics. A fictional Geelong practice. */

const today = dateOnly('2026-10-06');

const members: InsightsMember[] = [
  { uid: 'u-mia', name: 'Mia Torres', role: 'owner', status: 'active', budgets: { '2026': 30_000_000 } },
  { uid: 'u-jordan', name: 'Jordan Price', role: 'lawyer', status: 'active', budgets: { '2026': 20_000_000 } },
  { uid: 'u-priya', name: 'Priya Shah', role: 'paralegal', status: 'active', budgets: {} },
  { uid: 'u-sam', name: 'Sam Okafor', role: 'admin', status: 'active', budgets: {} },
  { uid: 'u-daniel', name: 'Daniel Kim', role: 'lawyer', status: 'removed', budgets: { '2026': 10_000_000 } },
];

const MONTHS: Record<string, MetricValues> = {
  '2025-07': { 'billing.invoicedCents': 3_000_000, 'cycle.probate.instructionsToGrant.d50': 1 },
  '2025-10': { 'billing.invoicedCents': 4_000_000, 'matters.opened': 2 },
  '2026-07': {
    'billing.invoicedCents': 5_000_000,
    'billing.collectedCents': 4_000_000,
    'time.billable.minutes': 12_000,
    'matters.opened': 3,
    'matters.opened.type.probate': 2,
    'matters.opened.type.will': 1,
    'matters.opened.referrer.c-hale': 2,
    'referrals.referrer.c-hale.billedCents': 900_000,
    'deadlines.due': 4,
    'deadlines.metOnTime': 3,
    'deadlines.missed': 1,
    'cycle.probate.instructionsToGrant.d40': 1,
  },
  '2026-08': {
    'billing.invoicedCents': 7_000_000,
    'billing.collectedCents': 6_000_000,
    'time.billable.minutes': 13_000,
    'matters.opened': 1,
    'matters.opened.type.admin': 1,
    'deadlines.due': 2,
    'deadlines.metLate': 1,
    'deadlines.waived': 1,
  },
  '2026-10': {
    'billing.invoicedCents': 1_500_000,
    'wip.timeCents': 2_000_000,
    'wip.disbursementsCents': 50_000,
  },
};

function input(overrides: Partial<InsightsInput> = {}): InsightsInput {
  const period = insightsPeriod({ range: 'this_fy' }, today);
  return {
    period,
    comparison: null,
    trendMonths: trendMonthsOf(period),
    months: new Map(Object.entries(MONTHS)),
    members,
    memberValues: new Map([
      ['u-mia', { 'time.billable.minutes': 9_000 }],
      ['u-jordan', { 'time.billable.minutes': 6_000 }],
      ['u-daniel', { 'time.billable.minutes': 1_200 }],
    ]),
    fyMemberValues: new Map([
      ['u-mia', { 'time.recordedCents': 9_000_000 }],
      ['u-jordan', { 'time.recordedCents': 4_000_000 }],
      ['u-daniel', { 'time.recordedCents': 1_000_000 }],
    ]),
    referrerNames: new Map([['c-hale', 'Hale Accounting']]),
    me: { uid: 'u-mia', role: 'owner' },
    visibility: undefined,
    dailyTargetMinutes: 360,
    fyStartMonth: 7,
    today,
    ...overrides,
  };
}

describe('Insights figures', () => {
  it('adds up the FY to date for the overview, with the practice budget', () => {
    const view = buildInsights(input());
    expect(view.hasFigures).toBe(true);
    expect(view.summary).toMatchObject({
      billedCents: 13_500_000,
      collectedCents: 10_000_000,
      wipCents: 2_050_000,
      mattersOpened: 4,
      deadlinesDue: 6,
      // 3 met on time of 5 resolved (1 late, 1 missed).
      deadlinesMetPct: 60,
      billableMinutes: 25_000,
    });
    // July 23, August 21, September 22 and 4 October weekdays to the 6th: 70 days × 6 h × 3 fee earners.
    expect(view.summary.targetMinutes).toBe(70 * 360 * 3);
    expect(view.summary.utilisationPct).toBe(33);
    expect(view.fyLabel).toBe('FY2026–27');
    expect(view.fyElapsedPct).toBe(27);
    // Every member's FY budget, the former member's included: $600,000.
    expect(view.heroBudget).toEqual({ budgetCents: 60_000_000, pct: 23 });
  });

  it('charts months, matter types, deadlines and referrers, and keeps what each bar drills into', () => {
    const view = buildInsights(input());
    expect(view.trendLabel).toBe('12 months to October 2026');
    expect(view.billedByMonth).toHaveLength(12);
    expect(view.billedByMonth.at(-1)).toEqual({ label: 'Oct 26', value: 1_500_000, meta: 'October 2026' });
    expect(view.collectedByMonth.find((d) => d.meta === 'August 2026')?.value).toBe(6_000_000);
    expect(view.mattersByType).toEqual([
      { label: 'Probate', value: 2 },
      { label: 'Estate admin', value: 1 },
      { label: 'Will', value: 1 },
    ]);
    expect(view.matterTypes).toEqual(['probate', 'admin', 'will']);
    expect(view.deadlines.map((d) => [d.label, d.value])).toEqual([
      ['Met on time', 3],
      ['Met late', 1],
      ['Missed', 1],
      ['Waived', 1],
    ]);
    expect(view.deadlineKeys).toEqual(['metOnTime', 'metLate', 'missed', 'waived']);
    expect(view.referrers).toEqual([{ label: 'Hale Accounting', value: 900_000 }]);
    expect(view.referrerIds).toEqual(['c-hale']);
    expect(view.grantDays).toEqual([{ label: 'Jul 26', value: 40, meta: 'July 2026' }]);
    expect(view.grantDaysComparison).toBeNull();
  });

  it('compares with the year before: deltas, and the grant line a year earlier', () => {
    const period = insightsPeriod({ range: 'this_fy' }, today);
    const view = buildInsights(input({ comparison: comparisonPeriod(period, 'previous', today) }));
    expect(view.previous?.billedCents).toBe(7_000_000);
    expect(view.deltas.billed).toEqual({ text: '+$65,000.00', direction: 'up', good: true });
    expect(view.deltas.opened).toEqual({ text: '+2', direction: 'up', good: true });
    // No WIP snapshot a year ago, so no change to show.
    expect(view.deltas.wip).toBeNull();
    expect(view.grantDaysComparison).toEqual([{ label: 'Jul 26', value: 50, meta: 'July 2025' }]);
  });

  it('shows utilisation and budgets by fee earner, a former member as such', () => {
    const view = buildInsights(input());
    // Each fee earner's target: 70 working days at 6 hours = 25,200 minutes.
    expect(view.utilisation).toEqual([
      { label: 'Mia Torres', value: 36 },
      { label: 'Jordan Price', value: 24 },
      { label: 'Former member', value: 5 },
      { label: 'Priya Shah', value: 0 },
    ]);
    expect(view.ownFiguresOnly).toBe(false);
    expect(view.budgets).toEqual([
      expect.objectContaining({ name: 'Mia Torres', pct: 30, expectedCents: 8_100_000, behind: false }),
      expect.objectContaining({ name: 'Jordan Price', pct: 20, expectedCents: 5_400_000, behind: true }),
      expect.objectContaining({ name: 'Former member', pct: 10, behind: true }),
    ]);
  });

  it('shows a paralegal only their own figures while the org keeps them to lawyers', () => {
    const view = buildInsights(input({ me: { uid: 'u-priya', role: 'paralegal' } }));
    expect(view.ownFiguresOnly).toBe(true);
    expect(view.utilisation).toEqual([{ label: 'Priya Shah', value: 0 }]);
    expect(view.budgets).toEqual([]);
    expect(visibleMembers(members, { uid: 'u-priya', role: 'paralegal' }, 'everyone')).toHaveLength(5);
    expect(visibleMembers(members, { uid: 'u-jordan', role: 'lawyer' }, 'admins').map((m) => m.uid)).toEqual([
      'u-jordan',
    ]);
  });

  it('has nothing to chart for a month with no figures', () => {
    const period = insightsPeriod({ range: 'custom', from: '2026-09', to: '2026-09' }, today);
    const view = buildInsights(input({ period, trendMonths: trendMonthsOf(period), memberValues: new Map() }));
    expect(view.hasFigures).toBe(false);
    expect(view.mattersByType).toEqual([]);
    expect(view.deadlines).toEqual([]);
    expect(view.heroBudget).toBeNull();
  });

  it('numbers former members when several left', () => {
    const names = memberNames([
      ...members,
      { uid: 'u-ella', name: 'Ella Brook', role: 'paralegal', status: 'removed', budgets: {} },
    ]);
    expect(names.get('u-daniel')).toBe('Former member 1');
    expect(names.get('u-ella')).toBe('Former member 2');
    expect(names.get('u-mia')).toBe('Mia Torres');
  });

  it('writes deltas with a sign, and points for percentages', () => {
    expect(deltaView(5, 8, (n) => `${n} pts`)).toEqual({ text: '−3 pts', direction: 'down', good: false });
    expect(deltaView(100, 90, (n) => `$${n}`, false)).toEqual({ text: '+$10', direction: 'up', good: false });
    expect(deltaView(null, 3, String)).toBeNull();
    expect(deltaView(4, 4, String)).toEqual({ text: '±0', direction: 'up', good: true });
  });

  it('downloads each chart as CSV, named for the chart and period', () => {
    const view = buildInsights(input());
    const label = view.trendLabel;
    expect(chartCsv('referrers', view, 'FY2026–27 to date')).toEqual({
      name: 'insights-referrers-by-fees-fy2026-27-to-date.csv',
      text: 'Referrer,Matters opened,Billed (ex GST)\r\nHale Accounting,2,9000.00\r\n',
    });
    const billed = chartCsv('billed', view, label);
    expect(billed.name).toBe('insights-billed-by-month-12-months-to-october-2026.csv');
    expect(billed.text.split('\r\n').at(-2)).toBe('October 2026,15000.00');
    expect(chartCsv('budgets', view, label).text).toContain('Mia Torres,90000.00,300000.00,30');
    expect(chartCsv('deadlines', view, 'x').text).toBe(
      'Result,Deadlines\r\nMet on time,3\r\nMet late,1\r\nMissed,1\r\nWaived,1\r\n',
    );
  });
});
