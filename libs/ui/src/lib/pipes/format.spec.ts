import { TestBed } from '@angular/core/testing';

import { type Cents, type DateOnly, dateOnly } from '@materia/domain';

import {
  formatAud,
  formatDateOnly,
  formatMinutes,
  formatRelativeDate,
  formatShortDate,
  MT_EMPTY_VALUE,
  MT_ORG_TIMEZONE,
  MT_TODAY,
  toDateOnly,
} from './format';
import { MtAudPipe, MtDateOnlyPipe, MtRelativeDatePipe, MtUnitsPipe } from './pipes';

const TODAY = dateOnly('2026-10-03');

describe('formatAud', () => {
  it('formats cents, credits and missing values', () => {
    expect(formatAud(123450 as Cents)).toBe('$1,234.50');
    expect(formatAud(0)).toBe('$0.00');
    expect(formatAud(-1200)).toBe('-$12.00');
    expect(formatAud(null)).toBe(MT_EMPTY_VALUE);
    expect(formatAud(undefined)).toBe('—');
    expect(formatAud(Number.NaN)).toBe('—');
  });
});

describe('formatMinutes', () => {
  it('formats billing units as decimal hours, rounding up by default', () => {
    expect(formatMinutes(24)).toBe('0.4');
    expect(formatMinutes(25)).toBe('0.5');
    expect(formatMinutes(25, 'decimal', { rounding: 'nearest' })).toBe('0.4');
    expect(formatMinutes(90)).toBe('1.5');
    expect(formatMinutes(0)).toBe('0.0');
    expect(formatMinutes(10, 'decimal', { unit: 15 })).toBe('0.25');
  });

  it('formats hours and minutes, clamping negatives', () => {
    expect(formatMinutes(24, 'hm')).toBe('0h 24m');
    expect(formatMinutes(125, 'hm')).toBe('2h 05m');
    expect(formatMinutes(-5, 'hm')).toBe('0h 00m');
    expect(formatMinutes(-5)).toBe('0.0');
  });

  it('shows — for missing values', () => {
    expect(formatMinutes(null)).toBe('—');
    expect(formatMinutes(undefined, 'hm')).toBe('—');
    expect(formatMinutes(Number.NaN)).toBe('—');
  });
});

describe('toDateOnly and formatDateOnly', () => {
  it('accepts DateOnly strings, instants, ISO strings and Timestamp-like values', () => {
    expect(toDateOnly('2026-10-03')).toBe('2026-10-03');
    // 13:30 UTC on 2 Oct is 3 Oct in Melbourne (AEST, +10:00).
    expect(toDateOnly(new Date('2026-10-02T14:30:00Z'))).toBe('2026-10-03');
    expect(toDateOnly('2026-10-02T14:30:00Z')).toBe('2026-10-03');
    expect(toDateOnly({ toDate: () => new Date('2026-10-02T14:30:00Z') })).toBe('2026-10-03');
    expect(toDateOnly(new Date('2026-10-02T14:30:00Z'), 'UTC')).toBe('2026-10-02');
  });

  it('returns null for missing or invalid input', () => {
    expect(toDateOnly(null)).toBeNull();
    expect(toDateOnly(undefined)).toBeNull();
    expect(toDateOnly('')).toBeNull();
    expect(toDateOnly('not a date')).toBeNull();
    expect(toDateOnly(new Date('invalid'))).toBeNull();
  });

  it('formats as 3 Oct 2026', () => {
    expect(formatDateOnly('2026-10-03')).toBe('3 Oct 2026');
    expect(formatDateOnly(null)).toBe('—');
  });
});

describe('formatRelativeDate', () => {
  const rel = (d: string) => formatRelativeDate(d as DateOnly, TODAY);

  it('is relative within a week either side', () => {
    expect(rel('2026-10-03')).toBe('Today');
    expect(rel('2026-10-04')).toBe('Tomorrow');
    expect(rel('2026-10-02')).toBe('Yesterday');
    expect(rel('2026-10-06')).toBe('in 3 days');
    expect(rel('2026-10-10')).toBe('in 7 days');
    expect(rel('2026-09-30')).toBe('3 days ago');
    expect(rel('2026-09-26')).toBe('7 days ago');
  });

  it('uses the short date beyond a week, with the year when it differs', () => {
    expect(rel('2026-10-11')).toBe('11 Oct');
    expect(rel('2026-09-25')).toBe('25 Sept');
    expect(rel('2027-01-04')).toBe('4 Jan 2027');
    expect(formatShortDate(dateOnly('2025-12-31'), TODAY)).toBe('31 Dec 2025');
    expect(formatRelativeDate(null, TODAY)).toBe('—');
  });
});

describe('pipes', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        { provide: MT_ORG_TIMEZONE, useValue: 'Australia/Perth' },
        { provide: MT_TODAY, useValue: () => TODAY },
      ],
    });
  });

  it('aud and units delegate to the formatters', () => {
    expect(new MtAudPipe().transform(-1200)).toBe('-$12.00');
    expect(new MtUnitsPipe().transform(24)).toBe('0.4');
    expect(new MtUnitsPipe().transform(24, 'hm')).toBe('0h 24m');
    expect(new MtUnitsPipe().transform(25, 'decimal', 'nearest')).toBe('0.4');
  });

  it('dateOnly and relativeDate use the org timezone and today', () => {
    TestBed.runInInjectionContext(() => {
      // 17:00 UTC on 2 Oct is 1am on 3 Oct in Perth (+08:00).
      expect(new MtDateOnlyPipe().transform(new Date('2026-10-02T17:00:00Z'))).toBe('3 Oct 2026');
      expect(new MtRelativeDatePipe().transform('2026-10-04')).toBe('Tomorrow');
    });
  });

  it('default tokens use Melbourne and the real today', () => {
    TestBed.resetTestingModule();
    expect(TestBed.inject(MT_ORG_TIMEZONE)).toBe('Australia/Melbourne');
    expect(TestBed.inject(MT_TODAY)()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
