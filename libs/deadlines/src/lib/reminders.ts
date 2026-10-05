import { addDays, daysBetween, type DateOnly, wallClockAt, weekday } from '@materia/domain';

import { addBusinessDays, rollToBusinessDay } from './calendar';
import { DeadlineEngineError, type CalendarSet } from './model';

/*
 * Reminders and escalation (CORE-11): when each reminder for a deadline goes out, and when a
 * critical deadline escalates. Pure: `reminders-dispatch` and `deadlines-onWrite` (apps/functions)
 * apply it with the org's time zone and locality calendar.
 */

/** Days before a critical deadline that a reminder goes out when the deadline names none. */
export const DEFAULT_CRITICAL_REMINDER_OFFSETS: readonly number[] = [30, 14, 7, 3, 1];
/** Days before any other deadline. */
export const DEFAULT_REMINDER_OFFSETS: readonly number[] = [7, 1];
/** Reminders and escalations go out at 08:00 in the org's time zone. */
export const REMINDER_MINUTE_OF_DAY = 8 * 60;
/** A critical deadline this many business days away, unacknowledged, escalates. */
export const ESCALATION_BUSINESS_DAYS = 3;
/** A reminder sent this long after its time is marked late (the scheduler was down). */
export const LATE_REMINDER_MS = 60 * 60_000;

/** A stored reminder: its offset and, once sent, when. */
export interface StoredReminder {
  offsetDays: number;
  sentAt?: Date | undefined;
}

/** One reminder of a deadline: the business day it falls on and the instant it is due. */
export interface ReminderSlot {
  offsetDays: number;
  date: DateOnly;
  at: Date;
  sentAt?: Date | undefined;
}

export interface ReminderCalendar {
  timeZone: string;
  calendars: CalendarSet;
  /** The org's locality calendar (`org.holidayLocality`). */
  locality: string;
}

/** The deadline's own offsets, else the defaults for its criticality; largest first, no repeats. */
export function reminderOffsets(deadline: { critical: boolean; reminders?: readonly StoredReminder[] }): number[] {
  const stored = (deadline.reminders ?? []).map((r) => r.offsetDays).filter((n) => Number.isInteger(n) && n >= 0);
  const offsets = stored.length
    ? stored
    : deadline.critical
      ? DEFAULT_CRITICAL_REMINDER_OFFSETS
      : DEFAULT_REMINDER_OFFSETS;
  return [...new Set(offsets)].sort((a, b) => b - a);
}

/**
 * The previous business day on the locality calendar (the date itself if it is one). Past the years
 * the calendar data covers, only weekends are skipped: a reminder still goes out.
 */
export function businessDayOnOrBefore(cal: ReminderCalendar, date: DateOnly): DateOnly {
  try {
    return rollToBusinessDay(cal.calendars, cal.locality, date, -1);
  } catch (error) {
    if (!(error instanceof DeadlineEngineError)) throw error;
    let current = date;
    while (weekday(current) >= 6) current = addDays(current, -1);
    return current;
  }
}

/** `count` business days before `date`, with the same fallback as `businessDayOnOrBefore`. */
function businessDaysBefore(cal: ReminderCalendar, date: DateOnly, count: number): DateOnly {
  try {
    return addBusinessDays(cal.calendars, cal.locality, date, count, -1);
  } catch (error) {
    if (!(error instanceof DeadlineEngineError)) throw error;
    let current = date;
    for (let left = count; left > 0; ) {
      current = addDays(current, -1);
      if (weekday(current) < 6) left -= 1;
    }
    return current;
  }
}

function utcMidnight(date: DateOnly): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

/**
 * The instant a wall-clock time on a date occurs in a time zone. Across a daylight-saving change
 * it lands on the same wall-clock time (or the hour after it, when that time doesn't exist).
 */
export function instantAt(date: DateOnly, minuteOfDay: number, timeZone: string): Date {
  const target = utcMidnight(date) + minuteOfDay * 60_000;
  const localOf = (at: number) => {
    const local = wallClockAt(new Date(at), timeZone);
    return utcMidnight(local.date) + local.minutes * 60_000;
  };
  // The zone's offset a day either side of the target gives every candidate instant.
  const candidates = [target - 86_400_000, target + 86_400_000].map((probe) => target - (localOf(probe) - probe));
  const exact = candidates.filter((at) => localOf(at) === target).sort((a, b) => a - b)[0];
  return new Date(exact ?? Math.max(...candidates));
}

/**
 * Every reminder of a deadline due on `dueDate`: `offsetDays` before it, moved back to a business
 * day, at 08:00 org time. Sent reminders keep their `sentAt`.
 */
export function reminderSlots(
  deadline: { dueDate: DateOnly; critical: boolean; reminders?: readonly StoredReminder[] },
  cal: ReminderCalendar,
): ReminderSlot[] {
  const sent = new Map((deadline.reminders ?? []).map((r) => [r.offsetDays, r.sentAt]));
  return reminderOffsets(deadline).map((offsetDays) => {
    const date = businessDayOnOrBefore(cal, addDays(deadline.dueDate, -offsetDays));
    const sentAt = sent.get(offsetDays);
    return { offsetDays, date, at: instantAt(date, REMINDER_MINUTE_OF_DAY, cal.timeZone), ...(sentAt ? { sentAt } : {}) };
  });
}

/**
 * When the next reminder is due: the earliest unsent one after `from`. Reminders already due when
 * a deadline is scheduled (created, or its date moved earlier) are not sent; `undefined` when none
 * is left.
 */
export function nextReminderAt(slots: readonly ReminderSlot[], from: Date): Date | undefined {
  const next = slots
    .filter((slot) => !slot.sentAt && slot.at.getTime() > from.getTime())
    .sort((a, b) => a.at.getTime() - b.at.getTime())[0];
  return next?.at;
}

/** What the dispatcher sends for one deadline at `now`. */
export interface DueReminder {
  /** The reminder to send: the latest of those due (the one nearest the deadline). */
  slot: ReminderSlot;
  /** Every unsent reminder now covered, the sent one included: all are marked sent. */
  covered: number[];
  /** Due more than an hour ago, or several at once: the scheduler missed its time. */
  late: boolean;
}

/**
 * The reminder to send now: the unsent ones due between `scheduledFrom` (the stored
 * `nextReminderAt`) and `now` collapse into one, so a scheduler that was down catches up once,
 * without duplicates. `null` when nothing is due.
 */
export function dueReminder(slots: readonly ReminderSlot[], scheduledFrom: Date, now: Date): DueReminder | null {
  const due = slots
    .filter((s) => !s.sentAt && s.at.getTime() >= scheduledFrom.getTime() && s.at.getTime() <= now.getTime())
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const slot = due.at(-1);
  if (!slot) return null;
  return {
    slot,
    covered: due.map((s) => s.offsetDays),
    late: due.length > 1 || now.getTime() - slot.at.getTime() > LATE_REMINDER_MS,
  };
}

/**
 * When a critical deadline escalates if nobody has acknowledged it: 08:00 org time, three business
 * days before it is due.
 */
export function escalationAt(dueDate: DateOnly, cal: ReminderCalendar): Date {
  const date = businessDaysBefore(cal, businessDayOnOrBefore(cal, dueDate), ESCALATION_BUSINESS_DAYS);
  return instantAt(date, REMINDER_MINUTE_OF_DAY, cal.timeZone);
}

/**
 * The latest due date that may have reached its escalation time by `today`: the query bound for
 * the dispatcher (three business days after today, plus slack for holidays; it filters exactly).
 */
export function escalationHorizon(today: DateOnly): DateOnly {
  return addDays(today, ESCALATION_BUSINESS_DAYS + 7);
}

/** "today", "tomorrow" or "in 3 days" (calendar days from `today`). */
export function dueInWords(today: DateOnly, dueDate: DateOnly): string {
  const days = daysBetween(today, dueDate);
  if (days < 0) return days === -1 ? 'yesterday' : `${-days} days ago`;
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}
