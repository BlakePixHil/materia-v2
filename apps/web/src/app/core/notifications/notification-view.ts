import type { NotificationItem } from '@materia/data-access/repository';
import type { DateOnly, NotificationKind } from '@materia/domain';
import type { MtIconName } from '@materia/ui';

/*
 * How a notification looks in the Inbox and the bell's popover (CORE-22, DES-01 NotificationRow):
 * its glyph and tone by kind, its time, and the day it is grouped under. Pure functions.
 */

/** The glyph's tint (`.mt-notif .ic[data-kind]`); `null` is the neutral one. */
export type NotificationTone = 'mention' | 'deadline' | 'overdue' | 'clerk' | null;

const GLYPHS: Record<NotificationKind, readonly [MtIconName, NotificationTone]> = {
  mention: ['at-sign', 'mention'],
  assignment: ['user-plus', null],
  task_assigned: ['user-plus', null],
  task_reminder: ['clock', 'deadline'],
  deadline_reminder: ['clock', 'deadline'],
  deadline_escalation: ['alert', 'overdue'],
  deadline_changed: ['calendar', 'deadline'],
  deadline_missed: ['alert', 'overdue'],
  suggestion: ['sparkle', 'clerk'],
  suggestion_ready: ['sparkle', 'clerk'],
  conflict_alert: ['shield', 'overdue'],
  document_ready: ['document', null],
  document_infected: ['shield', 'overdue'],
  integration_error: ['alert', 'overdue'],
  export_ready: ['arrow-down', null],
  safe_custody: ['archive', 'overdue'],
  invite: ['mail', null],
  invite_accepted: ['user-plus', null],
  budget_alert: ['billing', 'deadline'],
  system: ['bell', null],
};

/** The glyph and its tint for a notification (a burst summary is the inbox glyph). */
export function notificationGlyph(item: Pick<NotificationItem, 'kind' | 'collapsedCount'>): {
  icon: MtIconName;
  tone: NotificationTone;
} {
  if (item.collapsedCount) return { icon: 'inbox', tone: null };
  const [icon, tone] = GLYPHS[item.kind];
  return { icon, tone };
}

/** The matter a notification is about, if any. */
export function notificationMatterId(item: NotificationItem): string | null {
  return 'matterId' in item && typeof item.matterId === 'string' ? item.matterId : null;
}

const dayFormats = new Map<string, Intl.DateTimeFormat>();
function format(timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  let found = dayFormats.get(key);
  if (!found) {
    found = new Intl.DateTimeFormat('en-AU', { timeZone, ...options });
    dayFormats.set(key, found);
  }
  return found;
}

/** `YYYY-MM-DD` of an instant in a time zone. */
export function dayKey(at: Date, timeZone: string): DateOnly {
  const parts = Object.fromEntries(
    format(timeZone, { year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  return `${parts['year']}-${parts['month']}-${parts['day']}` as DateOnly;
}

const DAY_MS = 86_400_000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** The design's short months ("Sep", not the locale's "Sept"). */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const daysBetween = (from: DateOnly, to: DateOnly) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/**
 * The heading a day's notifications sit under: "Today · Mon 5 Oct", "Yesterday", then the weekday
 * and date ("Wednesday 30 Sep"), with the year once it isn't this year's.
 */
export function dayLabel(day: DateOnly, today: DateOnly): string {
  const ago = daysBetween(day, today);
  if (ago === 1) return 'Yesterday';
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, date)).getUTCDay()] as string;
  const dayMonth = `${date} ${MONTHS[month - 1]}`;
  if (ago === 0) return `Today · ${weekday.slice(0, 3)} ${dayMonth}`;
  return `${weekday} ${dayMonth}${day.slice(0, 4) === today.slice(0, 4) ? '' : ` ${year}`}`;
}

/**
 * When it arrived, for the row: the time ("9:14 am") on the days the list groups by. The popover,
 * which doesn't group, adds the day once it isn't today ("Yesterday", "Wed 30 Sep").
 */
export function notificationTime(at: Date, timeZone: string, today?: DateOnly): string {
  const time = format(timeZone, { hour: 'numeric', minute: '2-digit' }).format(at);
  if (!today) return time;
  const day = dayKey(at, timeZone);
  const ago = daysBetween(day, today);
  if (ago === 0) return time;
  if (ago === 1) return 'Yesterday';
  return dayLabel(day, today).replace(/^(\w{3})\w* /, '$1 ');
}
