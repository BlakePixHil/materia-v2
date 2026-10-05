import type { DateOnly } from '@materia/domain';

import { dayHeading, dayLimitWarning, formatEntryDate, overDayLimit, parseEntryDate, timeEntryRow } from './time-view';

/** The Time tab's view logic (BILL-01). */

const TODAY = '2026-10-04' as DateOnly;

describe('parseEntryDate', () => {
  it.each([
    ['', null],
    ['t', '2026-10-04'],
    ['today', '2026-10-04'],
    ['y', '2026-10-03'],
    ['Yesterday', '2026-10-03'],
    ['1/10', '2026-10-01'],
    ['01/10/2026', '2026-10-01'],
    ['30.9.26', '2026-09-30'],
    ['2026-09-15', '2026-09-15'],
    ['31/02/2026', null],
    ['next week', null],
  ])('%j → %j', (text, expected) => {
    expect(parseEntryDate(text, TODAY)).toBe(expected);
  });
});

describe('time view', () => {
  it('formats dates and day headings', () => {
    expect(formatEntryDate('2026-10-01')).toBe('01/10/2026');
    expect(dayHeading('2026-10-04', TODAY)).toBe('Today');
    expect(dayHeading('2026-10-03', TODAY)).toBe('Yesterday');
    expect(dayHeading('2026-10-01', TODAY)).toMatch(/^Thu 1 Oct/);
  });

  it('warns past 24 hours on a day', () => {
    expect(overDayLimit(1380, 60)).toBe(false);
    expect(overDayLimit(1380, 61)).toBe(true);
    expect(dayLimitWarning(1380, 90, 'Today')).toBe('That makes 24h 30m on today, over 24 hours. Save anyway?');
  });

  it('shows fixed-fee and non-billable rows without a value', () => {
    const entry = {
      id: 'te-1',
      uid: 'u1',
      minutes: 18,
      units: 3,
      amountCents: 13200,
      narrative: '  ',
      billable: false,
      status: 'final' as const,
    };
    const memberName = () => 'Jordan Price';
    expect(timeEntryRow(entry, { memberName, matter: { fee: { arrangement: 'fixed' } } })).toMatchObject({
      description: 'No narrative',
      meta: 'Jordan Price · 18m · Final',
      fixedFee: true,
    });
    expect(timeEntryRow(entry, { memberName, matter: null })).toMatchObject({ valueLabel: 'Non-billable' });
    expect(timeEntryRow({ ...entry, billable: true }, { memberName, matter: null, unitMinutes: 6 })).toMatchObject({
      amountCents: 13200,
      unit: 6,
    });
  });
});
