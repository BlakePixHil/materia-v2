import { type DateOnly, daysBetween } from '@materia/domain';

import { formatShortDate } from '../pipes/format';

/** Visual tone of a deadline. */
export type DeadlineTone = 'overdue' | 'today' | 'soon' | 'upcoming' | 'done';

/** Days ahead that count as "soon" (amber). */
export const DEADLINE_SOON_DAYS = 3;

/**
 * Tone from the due date relative to `today` (both DateOnly in the org timezone, so the day boundary
 * is the org's midnight): before today = overdue (red), today = today (brand, as in the design),
 * 1 to 3 days ahead = soon (amber), otherwise upcoming (neutral). A completed deadline is `done`.
 */
export function deadlineTone(due: DateOnly, today: DateOnly, completed = false): DeadlineTone {
  if (completed) return 'done';
  const days = daysBetween(today, due);
  if (days < 0) return 'overdue';
  if (days === 0) return 'today';
  if (days <= DEADLINE_SOON_DAYS) return 'soon';
  return 'upcoming';
}

/** Days ahead within which the label is relative (`In 5 days`) rather than a date. */
export const DEADLINE_RELATIVE_DAYS = 7;

/**
 * The chip label, in the design system's wording: `Overdue 2d`, `Today`, `Tomorrow`, `In 5 days`, then a
 * short date (`28 Oct`, or `22 Jul 2027` in another year). A completed deadline reads `Done`.
 */
export function deadlineLabel(due: DateOnly, today: DateOnly, completed = false): string {
  if (completed) return 'Done';
  const days = daysBetween(today, due);
  if (days < 0) return `Overdue ${-days}d`;
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days <= DEADLINE_RELATIVE_DAYS) return `In ${days} days`;
  return formatShortDate(due, today);
}
