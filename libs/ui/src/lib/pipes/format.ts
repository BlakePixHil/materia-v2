import { InjectionToken } from '@angular/core';

import {
  type Cents,
  DEFAULT_ORG_TIMEZONE,
  type DateOnly,
  dateOnlyAt,
  daysBetween,
  formatCents,
  isDateOnly,
  type RoundingMode,
  today,
  toDisplay,
  toUnits,
  formatUnits,
} from '@materia/domain';

/** Shown for missing values. */
export const MT_EMPTY_VALUE = '—';

/** The org's timezone (default `Australia/Melbourne`); provide it from the active org. */
export const MT_ORG_TIMEZONE = new InjectionToken<string>('MT_ORG_TIMEZONE', {
  factory: () => DEFAULT_ORG_TIMEZONE,
});

/** Today's date in the org timezone. Override in tests and stories for a fixed date. */
export const MT_TODAY = new InjectionToken<() => DateOnly>('MT_TODAY', {
  factory: () => () => today(DEFAULT_ORG_TIMEZONE),
});

/** A Firestore Timestamp or anything else with `toDate()`. */
interface DateLike {
  toDate(): Date;
}

export type MtDateInput = DateOnly | Date | DateLike | string | null | undefined;

/** Cents → `$1,234.50`; negative (credit) → `-$12.00`; null → `—`. */
export function formatAud(amount: Cents | number | null | undefined): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return MT_EMPTY_VALUE;
  return formatCents(amount as Cents);
}

export type MtUnitsFormat = 'decimal' | 'hm';

/**
 * Minutes → billing units as decimal hours (`0.4` for 24 minutes in 6-minute units), or `0h 24m`.
 * `rounding` follows the org setting (`up` by default).
 */
export function formatMinutes(
  value: number | null | undefined,
  format: MtUnitsFormat = 'decimal',
  options: { unit?: number; rounding?: RoundingMode } = {},
): string {
  if (value === null || value === undefined || Number.isNaN(value)) return MT_EMPTY_VALUE;
  if (format === 'hm') {
    const total = Math.max(0, Math.round(value));
    return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`;
  }
  const unit = options.unit ?? 6;
  return formatUnits(toUnits(Math.max(0, Math.round(value)), unit, options.rounding ?? 'up'), unit);
}

/** Any supported date input as a DateOnly in `timeZone`, or null. */
export function toDateOnly(value: MtDateInput, timeZone: string = DEFAULT_ORG_TIMEZONE): DateOnly | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') {
    if (isDateOnly(value)) return value;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : dateOnlyAt(parsed, timeZone);
  }
  const instant = value instanceof Date ? value : value.toDate();
  return Number.isNaN(instant.getTime()) ? null : dateOnlyAt(instant, timeZone);
}

/** `3 Oct 2026` (en-AU); `—` when missing. Instants are converted to the org timezone first. */
export function formatDateOnly(value: MtDateInput, timeZone: string = DEFAULT_ORG_TIMEZONE): string {
  const date = toDateOnly(value, timeZone);
  return date ? toDisplay(date) : MT_EMPTY_VALUE;
}

const shortFormatter = new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', day: 'numeric', month: 'short' });

/** `3 Oct`, with the year only when it differs from `today`'s. */
export function formatShortDate(date: DateOnly, todayDate: DateOnly): string {
  if (date.slice(0, 4) !== todayDate.slice(0, 4)) return toDisplay(date);
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return shortFormatter.format(new Date(Date.UTC(y, m - 1, d)));
}

/**
 * Relative within a week (`Today`, `Tomorrow`, `Yesterday`, `in 3 days`, `3 days ago`), otherwise
 * `3 Oct` (or `3 Oct 2027` in another year). `—` when missing.
 */
export function formatRelativeDate(
  value: MtDateInput,
  todayDate: DateOnly,
  timeZone: string = DEFAULT_ORG_TIMEZONE,
): string {
  const date = toDateOnly(value, timeZone);
  if (!date) return MT_EMPTY_VALUE;
  const days = daysBetween(todayDate, date);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  if (days > 1 && days <= 7) return `in ${days} days`;
  if (days < -1 && days >= -7) return `${-days} days ago`;
  return formatShortDate(date, todayDate);
}
