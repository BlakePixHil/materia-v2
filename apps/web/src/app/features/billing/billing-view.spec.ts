import type { DateOnly, WipRow } from '@materia/domain';

import {
  ageText,
  byMatter,
  expectedUpdatedAt,
  feeLabel,
  hoursText,
  mergeResults,
  reviewSummary,
  shiftWeek,
  weekLabel,
  wipFlags,
} from './billing-view';

/** The Time and billing screen's view helpers (BILL-03). */

const d = (date: string) => date as DateOnly;
const fee = { arrangement: 'hourly', amountCents: null, capCents: null, rateOverrideCents: null };
const row = (data: Partial<WipRow>): WipRow => ({ closed: false, budgetPct: null, ageDays: 3, ...data }) as WipRow;

describe('billing view', () => {
  it('labels fees', () => {
    expect(feeLabel(fee)).toBe('Hourly');
    expect(feeLabel({ ...fee, rateOverrideCents: 44000 })).toBe('Hourly · $440');
    expect(feeLabel({ ...fee, arrangement: 'fixed', amountCents: 220050 })).toBe('Fixed · $2,200.50');
    expect(feeLabel({ ...fee, arrangement: 'capped', capCents: 2200000 })).toBe('Capped · $22,000');
    expect(feeLabel({ ...fee, arrangement: 'conditional' })).toBe('Conditional');
    expect(feeLabel({ ...fee, arrangement: 'pro_bono' })).toBe('Pro bono');
  });

  it('labels ages, hours and weeks', () => {
    expect([ageText(null), ageText(0), ageText(1), ageText(47)]).toEqual(['—', 'Today', '1 day', '47 days']);
    expect([hoursText(0), hoursText(90), hoursText(420), hoursText(20)]).toEqual(['0', '1.5', '7', '0.3']);
    expect(shiftWeek(d('2026-06-29'), 1)).toBe('2026-07-06');
    expect(shiftWeek(d('2026-06-29'), -1)).toBe('2026-06-22');
    expect(weekLabel([d('2026-12-28'), d('2027-01-03')])).toBe('28 Dec – 3 Jan 2027');
    expect(weekLabel([])).toBe('');
  });

  it('flags closed matters, old WIP and budgets near or over the estimate', () => {
    expect(wipFlags(row({}))).toEqual([]);
    expect(wipFlags(row({ closed: true, budgetPct: 104, ageDays: 45 })).map((flag) => flag.label)).toEqual([
      'Matter closed',
      'Over estimate',
      'Unbilled 45 days',
    ]);
    expect(wipFlags(row({ budgetPct: 80 }))).toEqual([{ label: 'Near estimate', tone: 'warning' }]);
  });

  it('groups entries by matter and keeps the updatedAt each was seen with', () => {
    const at = new Date('2026-10-03T00:00:00Z');
    const entries = [
      { id: 'a', matterId: 'm1', updatedAt: at },
      { id: 'b', matterId: 'm2', updatedAt: null },
      { id: 'c', matterId: 'm1' },
      { id: 'd' },
    ];
    expect([...byMatter(entries)].map(([matter, group]) => [matter, group.map((e) => e.id)])).toEqual([
      ['m1', ['a', 'c']],
      ['m2', ['b']],
    ]);
    expect(expectedUpdatedAt(entries)).toEqual({ a: at.getTime() });
  });

  it('sums review results and says what happened', () => {
    const merged = mergeResults([
      { updated: ['a', 'b'], skipped: [], conflicts: ['c'] },
      { updated: [], skipped: ['d'], conflicts: [] },
    ]);
    expect(merged).toEqual({ updated: ['a', 'b'], skipped: ['d'], conflicts: ['c'] });
    expect(reviewSummary(merged, 'Approved')).toBe(
      'Approved 2 entries. 1 entry was changed by its author meanwhile: review it again.',
    );
    expect(reviewSummary({ updated: [], skipped: ['d'], conflicts: ['e', 'f'] }, 'Approved')).toBe(
      '2 entries were changed by their authors meanwhile: review them again.',
    );
    expect(reviewSummary({ updated: [], skipped: ['d'], conflicts: [] }, 'Approved')).toBe(
      'Nothing changed: the time was already reviewed, billed or deleted.',
    );
    expect(reviewSummary({ updated: ['a'], skipped: [], conflicts: [] }, 'Sent back')).toBe('Sent back 1 entry.');
  });
});
