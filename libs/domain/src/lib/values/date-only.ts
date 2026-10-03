import { z } from 'zod';

import { DEFAULT_ORG_TIMEZONE } from '../constants';
import { DomainValueError } from './errors';

/**
 * A legal or calendar date, `YYYY-MM-DD`, in the org timezone (ADR-008). It is a calendar value:
 * arithmetic on it involves no timezone at all. Never represent a legal date as a JS `Date`.
 */
export type DateOnly = string & { readonly __brand: 'DateOnly' };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(value: string): [number, number, number] | null {
  const match = DATE_RE.exec(value);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return [y, m, d];
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function format(y: number, m: number, d: number): DateOnly {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` as DateOnly;
}

export function isDateOnly(value: unknown): value is DateOnly {
  return typeof value === 'string' && parts(value) !== null;
}

/** Validates and brands a `YYYY-MM-DD` string. Throws `DomainValueError` for impossible dates. */
export function dateOnly(value: string): DateOnly {
  if (!isDateOnly(value)) throw new DomainValueError('DateOnly', value, `Invalid DateOnly: ${JSON.stringify(value)}`);
  return value;
}

export const DateOnlySchema = z
  .string()
  .refine(isDateOnly, { message: 'Expected a valid date in YYYY-MM-DD format' })
  .transform((value) => value as DateOnly);

function toParts(value: DateOnly): [number, number, number] {
  const p = parts(value);
  if (!p) throw new DomainValueError('DateOnly', value, `Invalid DateOnly: ${JSON.stringify(value)}`);
  return p;
}

/** Calendar day arithmetic (negative `days` goes backwards). */
export function addDays(value: DateOnly, days: number): DateOnly {
  const [y, m, d] = toParts(value);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return format(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Calendar month arithmetic, clamped to the end of the month: 2026-01-31 + 1 month → 2026-02-28. */
export function addMonths(value: DateOnly, months: number): DateOnly {
  const [y, m, d] = toParts(value);
  const index = y * 12 + (m - 1) + months;
  const year = Math.floor(index / 12);
  const month = index - year * 12 + 1;
  return format(year, month, Math.min(d, daysInMonth(year, month)));
}

/** -1, 0 or 1. Lexical order equals chronological order for valid DateOnly values. */
export function compareDates(a: DateOnly, b: DateOnly): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Whole days from `a` to `b` (positive when `b` is later). */
export function daysBetween(a: DateOnly, b: DateOnly): number {
  const [ay, am, ad] = toParts(a);
  const [by, bm, bd] = toParts(b);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export function weekday(value: DateOnly): number {
  const [y, m, d] = toParts(value);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 ? 7 : day;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function ymdFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    // en-CA formats as YYYY-MM-DD.
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The calendar date of an instant in a timezone (timezone-aware via Intl, never naive maths). */
export function dateOnlyAt(instant: Date, timeZone: string = DEFAULT_ORG_TIMEZONE): DateOnly {
  if (Number.isNaN(instant.getTime())) throw new DomainValueError('Instant', instant, 'Invalid instant');
  return dateOnly(ymdFormatter(timeZone).format(instant));
}

/** Today's date in the org timezone. */
export function today(timeZone: string = DEFAULT_ORG_TIMEZONE, now: Date = new Date()): DateOnly {
  return dateOnlyAt(now, timeZone);
}

const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Converts an ISO-8601 instant to the calendar date in `timeZone`. Critical for migration:
 * legacy stored legal dates as UTC midnights of the local date, so
 * `2025-03-13T13:00:00.000Z` in Australia/Melbourne is `2025-03-14`.
 */
export function fromIsoInstant(iso: string, timeZone: string = DEFAULT_ORG_TIMEZONE): DateOnly {
  // The calendar part must be a real date: JS Date would silently roll 2025-02-30 into March.
  if (typeof iso !== 'string' || !ISO_INSTANT_RE.test(iso) || !isDateOnly(iso.slice(0, 10))) {
    throw new DomainValueError('Instant', iso, `Invalid ISO instant: ${JSON.stringify(iso)}`);
  }
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime()))
    throw new DomainValueError('Instant', iso, `Invalid ISO instant: ${JSON.stringify(iso)}`);
  return dateOnlyAt(instant, timeZone);
}

/** Display form, e.g. `14 Mar 2025` (en-AU). Formatting only, never stored. */
export function toDisplay(value: DateOnly, locale = 'en-AU'): string {
  const [y, m, d] = toParts(value);
  return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
}
