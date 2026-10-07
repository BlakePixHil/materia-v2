import {
  comparisonPeriod,
  deadlineResults,
  deadlinesMetPct,
  fyElapsedPct,
  hoursText,
  insightsCsv,
  insightsPeriod,
  insightsSummary,
  medianDaysByMonth,
  memberInsights,
  metricsByKey,
  monthAxisLabels,
  monthsFrom,
  monthsTargetMinutes,
  referrerFigures,
  shiftMonth,
  sumMetricValues,
  wipCentsOf,
} from './insights';
import type { DateOnly } from './values/date-only';

/** INS-02: the Insights screen's periods and figures. Fictional figures only. */

const today = '2026-10-06' as DateOnly;

describe('insights periods', () => {
  it('shifts months across years and lists a run of them', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-10', 12)).toBe('2027-10');
    expect(monthsFrom('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(monthsFrom('2026-03', '2026-01')).toEqual([]);
    expect(monthsFrom('2020-01', '2026-12')).toHaveLength(24);
    expect(monthsFrom('2020-01', '2026-12').at(-1)).toBe('2026-12');
  });

  it('covers this month to date and last month whole', () => {
    expect(insightsPeriod({ range: 'this_month' }, today)).toEqual({
      months: ['2026-10'],
      start: '2026-10-01',
      end: '2026-10-06',
      toDate: true,
      fy: null,
      label: 'October 2026 to date',
    });
    expect(insightsPeriod({ range: 'last_month' }, today)).toMatchObject({
      months: ['2026-09'],
      end: '2026-09-30',
      toDate: false,
      label: 'September 2026',
    });
  });

  it('covers this FY to date and the last whole FY from the org’s start month', () => {
    expect(insightsPeriod({ range: 'this_fy' }, today)).toMatchObject({
      months: ['2026-07', '2026-08', '2026-09', '2026-10'],
      fy: 2026,
      toDate: true,
      label: 'FY2026–27 to date',
    });
    const last = insightsPeriod({ range: 'last_fy' }, today);
    expect(last.months).toHaveLength(12);
    expect(last).toMatchObject({ start: '2025-07-01', end: '2026-06-30', fy: 2025, label: 'FY2025–26' });
    // A calendar-year FY.
    expect(insightsPeriod({ range: 'this_fy' }, today, 1)).toMatchObject({ fy: 2026, label: 'FY2026 to date' });
    expect(insightsPeriod({ range: 'this_fy' }, today, 1).months).toHaveLength(10);
  });

  it('covers chosen months, never past this month, and falls back to this month', () => {
    expect(insightsPeriod({ range: 'custom', from: '2026-03', to: '2026-06' }, today)).toMatchObject({
      months: ['2026-03', '2026-04', '2026-05', '2026-06'],
      label: 'Mar 2026 – Jun 2026',
      toDate: false,
    });
    expect(insightsPeriod({ range: 'custom', from: '2026-09', to: '2027-02' }, today)).toMatchObject({
      months: ['2026-09', '2026-10'],
      toDate: true,
    });
    expect(insightsPeriod({ range: 'custom', from: '2026-08', to: '2026-08' }, today).label).toBe('August 2026');
    expect(insightsPeriod({ range: 'custom', from: 'nope' }, today).months).toEqual(['2026-10']);
  });

  it('compares with the period before, or the same months a year earlier', () => {
    const month = insightsPeriod({ range: 'this_month' }, today);
    expect(comparisonPeriod(month, 'previous', today)?.months).toEqual(['2026-09']);
    expect(comparisonPeriod(month, 'last_year', today)?.months).toEqual(['2025-10']);
    expect(comparisonPeriod(month, 'none', today)).toBeNull();
    // An FY to date is compared month for month with the year before.
    const fy = insightsPeriod({ range: 'this_fy' }, today);
    expect(comparisonPeriod(fy, 'previous', today)).toMatchObject({
      months: ['2025-07', '2025-08', '2025-09', '2025-10'],
      label: 'Jul 2025 – Oct 2025',
      fy: null,
    });
    const chosen = insightsPeriod({ range: 'custom', from: '2026-03', to: '2026-06' }, today);
    expect(comparisonPeriod(chosen, 'previous', today)?.months).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });

  it('labels chart months, with the year once they span two', () => {
    expect(monthAxisLabels(['2026-07', '2026-08'])).toEqual(['Jul', 'Aug']);
    expect(monthAxisLabels(['2025-12', '2026-01'])).toEqual(['Dec 25', 'Jan 26']);
  });
});

describe('insights figures', () => {
  const july = {
    'billing.invoicedCents': 1_250_000,
    'billing.collectedCents': 900_000,
    'time.billable.minutes': 6_000,
    'matters.opened': 3,
    'matters.opened.type.probate': 2,
    'matters.opened.type.will': 1,
    'deadlines.due': 5,
    'deadlines.metOnTime': 3,
    'deadlines.metLate': 1,
    'deadlines.missed': 0,
    'deadlines.waived': 1,
  };
  const august = {
    'billing.invoicedCents': 750_000,
    'matters.opened': 1,
    'matters.opened.type.probate': 1,
    'deadlines.missed': 1,
    'wip.timeCents': 420_000,
    'wip.disbursementsCents': 8_600,
  };

  it('adds months up and lists one level under a prefix, largest first', () => {
    const total = sumMetricValues([july, august, undefined]);
    expect(total['billing.invoicedCents']).toBe(2_000_000);
    expect(metricsByKey(total, 'matters.opened.type.')).toEqual([
      { key: 'probate', value: 3 },
      { key: 'will', value: 1 },
    ]);
    expect(metricsByKey({ 'a.b.c': 1, 'a.b': 2 }, 'a.')).toEqual([{ key: 'b', value: 2 }]);
  });

  it('works out the overview: billed, collected, WIP, utilisation, matters and deadlines met', () => {
    const months = ['2026-07', '2026-08'];
    // July 2026 has 23 weekdays and August 21: 44 days at 6 hours for 2 fee earners.
    expect(monthsTargetMinutes(months, 360, today)).toBe(44 * 360);
    expect(
      insightsSummary({
        values: sumMetricValues([july, august]),
        latest: august,
        months,
        dailyTargetMinutes: 360,
        feeEarners: 2,
        today,
      }),
    ).toEqual({
      billedCents: 2_000_000,
      legacyBilledCents: 0,
      collectedCents: 900_000,
      wipCents: 428_600,
      mattersOpened: 4,
      mattersClosed: 0,
      deadlinesDue: 5,
      deadlinesMetPct: 60,
      billableMinutes: 6_000,
      targetMinutes: 44 * 360 * 2,
      utilisationPct: 19,
    });
    expect(wipCentsOf(july)).toBeNull();
    expect(deadlinesMetPct({})).toBeNull();
  });

  it('counts the legacy system’s billing, imported by the migration, as billed in its month (MIG-09)', () => {
    const legacy = { 'billing.invoicedCents': 100_000, 'legacy.billed': 2, 'legacy.billedCents': 350_000 };
    const summary = insightsSummary({
      values: legacy,
      months: ['2024-03'],
      dailyTargetMinutes: 360,
      feeEarners: 1,
      today,
    });
    expect(summary).toMatchObject({ billedCents: 450_000, legacyBilledCents: 350_000 });
  });

  it('counts this month’s target only to today', () => {
    // 1 to 6 October 2026: Thursday to Tuesday, 4 weekdays.
    expect(monthsTargetMinutes(['2026-10'], 360, today)).toBe(4 * 360);
  });

  it('lists deadlines by how they ended', () => {
    expect(deadlineResults(sumMetricValues([july, august]))).toEqual([
      { key: 'metOnTime', label: 'Met on time', value: 3 },
      { key: 'metLate', label: 'Met late', value: 1 },
      { key: 'missed', label: 'Missed', value: 1 },
      { key: 'waived', label: 'Waived', value: 1 },
    ]);
  });

  it('ranks referrers by fees net of credits, then matters', () => {
    expect(
      referrerFigures({
        'matters.opened.referrer.c-hale': 2,
        'matters.opened.referrer.c-lin': 1,
        'matters.opened.referrer.c-quiet': 1,
        'referrals.referrer.c-hale.billedCents': 400_000,
        'referrals.referrer.c-hale.creditedCents': 50_000,
        'referrals.referrer.c-lin.billedCents': 500_000,
      }),
    ).toEqual([
      { id: 'c-lin', mattersOpened: 1, billedCents: 500_000 },
      { id: 'c-hale', mattersOpened: 2, billedCents: 350_000 },
      { id: 'c-quiet', mattersOpened: 1, billedCents: 0 },
    ]);
  });

  it('takes the median days to grant by month of grant', () => {
    expect(
      medianDaysByMonth([
        {
          month: '2026-07',
          values: { 'cycle.probate.instructionsToGrant.d40': 1, 'cycle.probate.instructionsToGrant.d60': 2 },
        },
        { month: '2026-08', values: undefined },
      ]),
    ).toEqual([
      { month: '2026-07', days: 60 },
      { month: '2026-08', days: null },
    ]);
  });

  it('works out a member’s utilisation and the FY elapsed', () => {
    expect(
      memberInsights(
        'user-jordan',
        { 'time.minutes': 600, 'time.billable.minutes': 540, 'time.recordedCents': 405_000 },
        720,
      ),
    ).toEqual({
      uid: 'user-jordan',
      minutes: 600,
      billableMinutes: 540,
      recordedCents: 405_000,
      billedCents: 0,
      utilisationPct: 75,
    });
    expect(memberInsights('user-x', undefined, 0).utilisationPct).toBeNull();
    expect(fyElapsedPct(2026, today)).toBe(27);
    expect(fyElapsedPct(2025, today)).toBe(100);
    expect(hoursText(90)).toBe('1.5 h');
  });

  it('writes a chart as CSV, keeping text from starting formulas', () => {
    expect(
      insightsCsv(
        ['Referrer', 'Matters', 'Billed'],
        [
          ['=Hale', 2, '3500.00'],
          ['Lin, Sarah', 1, '-12.50'],
        ],
      ),
    ).toBe('Referrer,Matters,Billed\r\n\'=Hale,2,3500.00\r\n"Lin, Sarah",1,-12.50\r\n');
  });
});
