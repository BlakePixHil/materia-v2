import fc from 'fast-check';

import {
  addDays,
  addMonths,
  compareDates,
  dateOnly,
  dateOnlyAt,
  DateOnlySchema,
  daysBetween,
  fromIsoInstant,
  isDateOnly,
  today,
  toDisplay,
  weekday,
  type DateOnly,
} from './date-only';
import { DomainValueError } from './errors';

const d = (value: string): DateOnly => dateOnly(value);

describe('DateOnly', () => {
  it.each([
    ['2026-01-31', 1, '2026-02-28'],
    ['2024-02-29', 12, '2025-02-28'],
    ['2024-01-31', 1, '2024-02-29'],
    ['2026-03-31', -1, '2026-02-28'],
    ['2026-12-15', 1, '2027-01-15'],
    ['2026-01-15', -13, '2024-12-15'],
  ])('addMonths(%s, %i) = %s (clamped)', (start, months, expected) => {
    expect(addMonths(d(start), months)).toBe(expected);
  });

  it('adds days across month, year and leap boundaries', () => {
    expect(addDays(d('2026-12-31'), 1)).toBe('2027-01-01');
    expect(addDays(d('2024-02-28'), 1)).toBe('2024-02-29');
    expect(addDays(d('2026-03-01'), -1)).toBe('2026-02-28');
  });

  it('validates real calendar dates only', () => {
    expect(isDateOnly('2026-02-29')).toBe(false);
    expect(isDateOnly('2024-02-29')).toBe(true);
    expect(isDateOnly('2026-13-01')).toBe(false);
    expect(isDateOnly('2026-1-01')).toBe(false);
    expect(isDateOnly(20260101)).toBe(false);
    expect(() => dateOnly('31/01/2026')).toThrow(DomainValueError);
    expect(DateOnlySchema.safeParse('2026-04-31').success).toBe(false);
    expect(DateOnlySchema.parse('2026-04-30')).toBe('2026-04-30');
  });

  it('compares, measures and names days', () => {
    expect(compareDates(d('2026-01-01'), d('2026-01-02'))).toBe(-1);
    expect(compareDates(d('2026-01-02'), d('2026-01-02'))).toBe(0);
    expect(compareDates(d('2026-01-03'), d('2026-01-02'))).toBe(1);
    expect(daysBetween(d('2026-01-01'), d('2026-03-01'))).toBe(59);
    expect(weekday(d('2026-10-03'))).toBe(6); // Saturday
    expect(weekday(d('2026-10-04'))).toBe(7); // Sunday
    expect(toDisplay(d('2025-03-14'))).toBe('14 Mar 2025');
  });

  it('converts instants to the Melbourne calendar date (legacy UTC midnights)', () => {
    expect(fromIsoInstant('2025-03-13T13:00:00.000Z')).toBe('2025-03-14');
    expect(fromIsoInstant('2025-03-13T12:59:59.999Z')).toBe('2025-03-13');
    expect(fromIsoInstant('2025-03-14T00:00:00+11:00', 'Australia/Melbourne')).toBe('2025-03-14');
    expect(fromIsoInstant('2025-03-13T13:00:00Z', 'Australia/Perth')).toBe('2025-03-13');
  });

  it('handles DST transition days in Melbourne', () => {
    // DST ends 2026-04-05 03:00 AEDT (UTC+11 → +10); starts 2026-10-04 02:00 AEST (+10 → +11).
    expect(fromIsoInstant('2026-04-04T13:30:00Z')).toBe('2026-04-05');
    expect(fromIsoInstant('2026-04-05T13:59:00Z')).toBe('2026-04-05');
    expect(fromIsoInstant('2026-04-05T14:00:00Z')).toBe('2026-04-06');
    expect(fromIsoInstant('2026-10-03T13:59:00Z')).toBe('2026-10-03');
    expect(fromIsoInstant('2026-10-03T14:00:00Z')).toBe('2026-10-04');
    expect(fromIsoInstant('2026-10-04T12:59:00Z')).toBe('2026-10-04');
    expect(fromIsoInstant('2026-10-04T13:00:00Z')).toBe('2026-10-05');
  });

  it('rejects invalid instants with a typed error', () => {
    for (const bad of ['', '2025-03-13', 'yesterday', '2025-02-30T00:00:00Z', '2025-03-13T25:00:00Z']) {
      expect(() => fromIsoInstant(bad)).toThrow(DomainValueError);
    }
    expect(() => dateOnlyAt(new Date('nope'))).toThrow(DomainValueError);
  });

  it('computes today in a timezone', () => {
    const now = new Date('2026-10-03T15:00:00Z');
    expect(today('Australia/Melbourne', now)).toBe('2026-10-04');
    expect(today('UTC', now)).toBe('2026-10-03');
  });

  // Property tests (Testing & quality strategy).
  const anyDate = fc
    .date({ min: new Date('1900-01-01T00:00:00Z'), max: new Date('2199-12-31T00:00:00Z'), noInvalidDate: true })
    .map((date) => dateOnly(date.toISOString().slice(0, 10)));

  it('addMonths is monotonic', () => {
    fc.assert(
      fc.property(anyDate, anyDate, fc.integer({ min: -240, max: 240 }), (a, b, months) => {
        if (compareDates(a, b) <= 0)
          expect(compareDates(addMonths(a, months), addMonths(b, months))).toBeLessThanOrEqual(0);
      }),
    );
  });

  it('addDays round-trips and agrees with daysBetween', () => {
    fc.assert(
      fc.property(anyDate, fc.integer({ min: -5000, max: 5000 }), (a, days) => {
        expect(addDays(addDays(a, days), -days)).toBe(a);
        expect(daysBetween(a, addDays(a, days))).toBe(days);
      }),
    );
  });
});
