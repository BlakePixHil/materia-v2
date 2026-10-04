import { dateOnly } from '@materia/domain';

import { DEADLINE_RELATIVE_DAYS, DEADLINE_SOON_DAYS, deadlineLabel, deadlineTone } from './tone';

const TODAY = dateOnly('2026-10-03');

describe('deadlineTone', () => {
  it('is overdue before today, today, soon up to 3 days ahead, then upcoming', () => {
    expect(deadlineTone(dateOnly('2026-10-02'), TODAY)).toBe('overdue');
    expect(deadlineTone(dateOnly('2026-10-03'), TODAY)).toBe('today');
    expect(deadlineTone(dateOnly('2026-10-04'), TODAY)).toBe('soon');
    expect(deadlineTone(dateOnly('2026-10-06'), TODAY)).toBe('soon');
    expect(deadlineTone(dateOnly('2026-10-07'), TODAY)).toBe('upcoming');
    expect(DEADLINE_SOON_DAYS).toBe(3);
  });

  it('is done when completed, whatever the date', () => {
    expect(deadlineTone(dateOnly('2026-09-01'), TODAY, true)).toBe('done');
  });

  it('uses the org-timezone day: due today is not overdue at 11pm, and is overdue after midnight', () => {
    // Today's DateOnly comes from the org timezone, so the boundary is Melbourne midnight.
    expect(deadlineTone(dateOnly('2026-10-03'), dateOnly('2026-10-03'))).toBe('today');
    expect(deadlineTone(dateOnly('2026-10-03'), dateOnly('2026-10-04'))).toBe('overdue');
  });
});

describe('deadlineLabel', () => {
  it('is relative within 7 days, otherwise a short date', () => {
    expect(deadlineLabel(dateOnly('2026-10-01'), TODAY)).toBe('Overdue 2d');
    expect(deadlineLabel(dateOnly('2026-10-03'), TODAY)).toBe('Today');
    expect(deadlineLabel(dateOnly('2026-10-04'), TODAY)).toBe('Tomorrow');
    expect(deadlineLabel(dateOnly('2026-10-10'), TODAY)).toBe('In 7 days');
    expect(deadlineLabel(dateOnly('2026-10-11'), TODAY)).toBe('11 Oct');
    expect(deadlineLabel(dateOnly('2027-10-22'), TODAY)).toBe('22 Oct 2027');
    expect(DEADLINE_RELATIVE_DAYS).toBe(7);
  });

  it('reads Done when completed', () => {
    expect(deadlineLabel(dateOnly('2026-09-01'), TODAY, true)).toBe('Done');
  });
});
