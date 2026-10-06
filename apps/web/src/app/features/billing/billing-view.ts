import {
  addDays,
  WIP_AGE_WARN_DAYS,
  type DateOnly,
  type MatterType,
  type SetTimeEntryStatusResult,
  type WipRow,
} from '@materia/domain';
import { formatAud, MATTER_TYPE_LABELS, type MtBadgeTone } from '@materia/ui';

/**
 * The Time and billing screen's view logic (BILL-03): labels for fees, ages, weeks and hours, the
 * WIP row flags and how bulk review results read. Pure: no data access.
 */

/** The matter types, in the order the WIP filter lists them. */
export const MATTER_TYPES = Object.keys(MATTER_TYPE_LABELS) as MatterType[];

/** "Hourly · $440", "Fixed · $2,200", "Capped · $22,000", "Conditional", "Pro bono". */
export function feeLabel(fee: WipRow['fee']): string {
  const money = (cents: number | null) => (cents === null ? null : formatAud(cents).replace(/\.00$/, ''));
  switch (fee.arrangement) {
    case 'fixed':
      return ['Fixed', money(fee.amountCents)].filter(Boolean).join(' · ');
    case 'capped':
      return ['Capped', money(fee.capCents)].filter(Boolean).join(' · ');
    case 'conditional':
      return 'Conditional';
    case 'pro_bono':
      return 'Pro bono';
    default:
      return ['Hourly', money(fee.rateOverrideCents)].filter(Boolean).join(' · ');
  }
}

/** "Today", "1 day", "47 days". */
export function ageText(days: number | null): string {
  if (days === null) return '—';
  if (days === 0) return 'Today';
  return days === 1 ? '1 day' : `${days} days`;
}

export interface WipFlag {
  label: string;
  tone: MtBadgeTone;
}

/** What a WIP row is flagged for: a closed matter, old WIP, or a budget near or over its estimate. */
export function wipFlags(row: WipRow): WipFlag[] {
  const flags: WipFlag[] = [];
  if (row.closed) flags.push({ label: 'Matter closed', tone: 'danger' });
  if (row.budgetPct !== null && row.budgetPct >= 100) flags.push({ label: 'Over estimate', tone: 'danger' });
  else if (row.budgetPct !== null && row.budgetPct >= 80) flags.push({ label: 'Near estimate', tone: 'warning' });
  if (row.ageDays !== null && row.ageDays >= WIP_AGE_WARN_DAYS)
    flags.push({ label: `Unbilled ${row.ageDays} days`, tone: 'warning' });
  return flags;
}

/** Hours to one decimal: 0 → "0", 90 → "1.5". */
export function hoursText(minutes: number): string {
  const hours = Math.round((minutes / 60) * 10) / 10;
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

const dayFormat = new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', day: 'numeric', month: 'short' });
const yearFormat = new Intl.DateTimeFormat('en-AU', {
  timeZone: 'UTC',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
const weekdayFormat = new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', weekday: 'short' });
const monthFormat = new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', month: 'long', year: 'numeric' });

const utc = (date: string) => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
};

/** "29 Jun – 5 Jul 2026" for a week of dates. */
export function weekLabel(dates: readonly DateOnly[]): string {
  const first = dates[0];
  const last = dates[dates.length - 1];
  if (!first || !last) return '';
  return `${dayFormat.format(utc(first))} – ${yearFormat.format(utc(last))}`;
}

/** "Mon" and "29" for a calendar strip day. */
export function stripDay(date: DateOnly): { weekday: string; day: string } {
  return { weekday: weekdayFormat.format(utc(date)), day: String(Number(date.slice(8, 10))) };
}

/** "October 2026". */
export function monthLabel(date: DateOnly): string {
  return monthFormat.format(utc(date));
}

/** The Monday a week before or after `monday`. */
export function shiftWeek(monday: DateOnly, weeks: number): DateOnly {
  return addDays(monday, weeks * 7);
}

/** Bulk review calls (one per matter) added up. */
export function mergeResults(results: readonly SetTimeEntryStatusResult[]): SetTimeEntryStatusResult {
  return {
    updated: results.flatMap((result) => result.updated),
    skipped: results.flatMap((result) => result.skipped),
    conflicts: results.flatMap((result) => result.conflicts ?? []),
  };
}

/** Entries grouped by matter, for review callables (each takes one matter). */
export function byMatter<T extends { matterId?: string | undefined }>(entries: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const entry of entries) {
    if (!entry.matterId) continue;
    groups.set(entry.matterId, [...(groups.get(entry.matterId) ?? []), entry]);
  }
  return groups;
}

/** Each entry's `updatedAt` as the reviewer saw it (optimistic concurrency). */
export function expectedUpdatedAt(
  entries: readonly { id: string; updatedAt?: Date | null | undefined }[],
): Record<string, number> {
  const seen: Record<string, number> = {};
  for (const entry of entries) {
    if (entry.updatedAt instanceof Date) seen[entry.id] = entry.updatedAt.getTime();
  }
  return seen;
}

/** What a review did, in a sentence ("Approved 3 entries. 1 changed meanwhile: review it again."). */
export function reviewSummary(result: SetTimeEntryStatusResult, verb: string): string {
  const parts: string[] = [];
  const n = result.updated.length;
  if (n) parts.push(`${verb} ${n} ${n === 1 ? 'entry' : 'entries'}.`);
  if (result.conflicts.length) {
    const c = result.conflicts.length;
    parts.push(
      `${c} ${c === 1 ? 'entry was' : 'entries were'} changed by ${c === 1 ? 'its author' : 'their authors'} meanwhile: review ${c === 1 ? 'it' : 'them'} again.`,
    );
  }
  if (result.skipped.length && !n && !result.conflicts.length)
    parts.push('Nothing changed: the time was already reviewed, billed or deleted.');
  return parts.join(' ');
}
