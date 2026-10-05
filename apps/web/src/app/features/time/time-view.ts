import {
  addDays,
  DateOnlySchema,
  formatHm,
  isFixedFee,
  TIME_DAY_WARN_MINUTES,
  type DateOnly,
  type RateMatter,
  type TimeEntryStatus,
} from '@materia/domain';
import { formatShortDate, type TimeEntryVm } from '@materia/ui';

/**
 * The Time tab and quick entry's view logic (BILL-01): date typing, entry rows for the TimeEntry
 * component, day headings and the 24-hour check. Pure: no data access.
 */

const LOCAL_DATE_RE = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/;

/**
 * A date as typed in an entry: `today`, `yesterday` (or `t`, `y`), DD/MM, DD/MM/YY, DD/MM/YYYY or
 * YYYY-MM-DD. DD/MM is this year. `null` when it isn't a real date.
 */
export function parseEntryDate(text: string, today: DateOnly): DateOnly | null {
  const value = text.trim().toLowerCase();
  if (!value || value === 'today' || value === 't') return value ? today : null;
  if (value === 'yesterday' || value === 'y') return addDays(today, -1);
  let iso: string | null = null;
  const local = LOCAL_DATE_RE.exec(value);
  if (local) {
    const [, day = '', month = '', year] = local;
    const fullYear = !year ? today.slice(0, 4) : year.length === 2 ? `20${year}` : year;
    iso = `${fullYear}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    iso = value;
  }
  const parsed = iso ? DateOnlySchema.safeParse(iso) : null;
  return parsed?.success ? parsed.data : null;
}

/** DD/MM/YYYY for the date field. */
export function formatEntryDate(date: DateOnly | string): string {
  const [year, month, day] = date.split('-');
  return `${day}/${month}/${year}`;
}

/** A day's heading: "Today", "Yesterday", then "Thu 1 Oct" (with the year when it isn't this one). */
export function dayHeading(date: DateOnly | string, today: DateOnly): string {
  if (date === today) return 'Today';
  if (date === addDays(today, -1)) return 'Yesterday';
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const weekday = new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', weekday: 'short' }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
  return `${weekday} ${formatShortDate(date as DateOnly, today)}`;
}

export const TIME_STATUS_LABELS: Record<TimeEntryStatus, string> = {
  draft: 'Draft',
  final: 'Final',
  billed: 'Billed',
  written_off: 'Written off',
};

/** The fields of an entry a row shows. */
export interface TimeRow {
  id: string;
  uid: string;
  minutes: number;
  units: number;
  amountCents: number;
  narrative: string;
  billable: boolean;
  status: TimeEntryStatus;
}

/**
 * A row for `mt-time-entry`: the narrative, then who, the duration and the status; the recorded
 * units and value ("Fixed fee" on a fixed-fee matter, "Non-billable" otherwise when not billable).
 */
export function timeEntryRow(
  entry: TimeRow,
  options: { memberName: (uid: string) => string; matter: RateMatter | null | undefined; unitMinutes?: number },
): TimeEntryVm {
  const meta = [options.memberName(entry.uid), formatHm(entry.minutes)];
  if (entry.status !== 'draft') meta.push(TIME_STATUS_LABELS[entry.status]);
  const fixedFee = isFixedFee(options.matter);
  return {
    id: entry.id,
    description: entry.narrative.trim() || 'No narrative',
    meta: meta.join(' · '),
    minutes: entry.minutes,
    units: entry.units,
    amountCents: entry.amountCents,
    source: 'manual',
    ...(options.unitMinutes ? { unit: options.unitMinutes } : {}),
    ...(entry.billable ? {} : fixedFee ? { fixedFee: true } : { valueLabel: 'Non-billable' }),
  };
}

/** Whether saving `minutes` more on a day that already has `existing` minutes goes over 24 hours. */
export function overDayLimit(existing: number, minutes: number): boolean {
  return existing + minutes > TIME_DAY_WARN_MINUTES;
}

/** The 24-hour warning, e.g. "That makes 25h 30m on Thu 1 Oct." */
export function dayLimitWarning(existing: number, minutes: number, heading: string): string {
  return `That makes ${formatHm(existing + minutes)} on ${heading === 'Today' || heading === 'Yesterday' ? heading.toLowerCase() : heading}, over 24 hours. Save anyway?`;
}
