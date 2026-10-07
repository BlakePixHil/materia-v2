import type { DateOnly } from './values/date-only';
import {
  weeklyReportDue,
  weeklyReportModel,
  weeklyReportRange,
  weeklyReportStats,
  weeklyReportWeek,
} from './weekly-report';

/** INS-03: when the weekly practice report is due and what it says. All fictional. */

const MONDAY = '2026-10-05' as DateOnly;

describe('weeklyReportDue', () => {
  it('is due on Mondays from 07:00 in the org’s time zone', () => {
    // 06:59 and 07:00 on Monday 5 October 2026 in Melbourne (UTC+11).
    expect(weeklyReportDue(new Date('2026-10-04T19:59:00Z'), 'Australia/Melbourne')).toBeNull();
    expect(weeklyReportDue(new Date('2026-10-04T20:00:00Z'), 'Australia/Melbourne')).toBe(MONDAY);
    expect(weeklyReportDue(new Date('2026-10-05T12:59:00Z'), 'Australia/Melbourne')).toBe(MONDAY);
    // Tuesday in Melbourne, still Monday in UTC.
    expect(weeklyReportDue(new Date('2026-10-05T13:00:00Z'), 'Australia/Melbourne')).toBeNull();
    // 07:00 Monday in Perth (UTC+8) is 10:00 in Melbourne.
    expect(weeklyReportDue(new Date('2026-10-04T22:59:00Z'), 'Australia/Perth')).toBeNull();
    expect(weeklyReportDue(new Date('2026-10-04T23:00:00Z'), 'Australia/Perth')).toBe(MONDAY);
  });
});

describe('the report', () => {
  it('covers Monday to Sunday of the week before', () => {
    const week = weeklyReportWeek(MONDAY);
    expect(week.from).toBe('2026-09-28');
    expect(week.to).toBe('2026-10-04');
    expect(week.days).toHaveLength(7);
    expect(weeklyReportRange(MONDAY)).toMatch(/^28 Sept? – 4 Oct$/);
  });

  it('adds the week’s days into six figures', () => {
    const stats = weeklyReportStats({
      days: [
        { 'billing.invoicedCents': 110000, 'time.billable.minutes': 360, 'deadlines.metOnTime': 3 },
        { 'billing.collectedCents': 55000, 'matters.opened': 2, 'deadlines.missed': 1 },
        undefined,
      ],
      wipCents: 1234500,
    });
    expect(stats).toEqual([
      { label: 'Billed (ex GST)', value: '$1,100.00' },
      { label: 'Collected', value: '$550.00' },
      { label: 'Billable time', value: '6.0 h' },
      { label: 'Work in progress', value: '$12,345.00' },
      { label: 'Matters opened', value: '2' },
      { label: 'Deadlines met on time', value: '75%' },
    ]);
  });

  it('names matters by number only and counts critical deadlines without naming them', () => {
    const model = weeklyReportModel(
      {
        orgName: 'Fictional Harbour Legal',
        monday: MONDAY,
        days: [],
        wipCents: 0,
        topMatters: [{ matterId: 'm1', number: '0042', wipCents: 98765 }],
        criticalDue: 2,
      },
      'https://materia.example',
    );
    expect(model).toMatchObject({
      orgName: 'Fictional Harbour Legal',
      topMatters: [{ number: '0042', wip: '$987.65', link: 'https://materia.example/matters/m1' }],
      criticalLabel: '2 critical deadlines due this week',
      insightsLink: 'https://materia.example/insights',
      settingsLink: 'https://materia.example/settings/preferences',
    });
    expect(String(model['subject'])).toMatch(/^Weekly practice report for Fictional Harbour Legal: 28 Sept? – 4 Oct$/);
    expect(JSON.stringify(model)).not.toContain('title');
  });
});
