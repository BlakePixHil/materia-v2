import { addDays, addMonths, type DateOnly, weekday } from '@materia/domain';

import { type CalendarSet, type CalendarYear, DeadlineEngineError } from './model';

const WEEKDAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

/** `Monday` … `Sunday`. */
export function weekdayName(date: DateOnly): string {
  return WEEKDAYS[weekday(date)] as string;
}

/** Builds a CalendarSet from calendar-year files. */
export function buildCalendarSet(years: readonly CalendarYear[]): CalendarSet {
  const set: Record<string, Record<number, CalendarYear>> = {};
  for (const year of years) (set[year.calendarId] ??= {})[year.year] = year;
  return set;
}

/** The calendar data for `date`'s year. Throws CALENDAR_MISSING rather than guessing. */
export function calendarYear(calendars: CalendarSet, calendarId: string, date: DateOnly): CalendarYear {
  const calendar = calendars[calendarId];
  if (!calendar) throw new DeadlineEngineError('CALENDAR_UNKNOWN', `No calendar "${calendarId}"`, { calendarId });
  const year = Number(date.slice(0, 4));
  const data = calendar[year];
  if (!data) {
    throw new DeadlineEngineError('CALENDAR_MISSING', `No ${calendarId} calendar data for ${year}`, {
      calendarId,
      year,
    });
  }
  return data;
}

/** Why a date isn't a business day (weekend, holiday or closure name), or null if it is one. */
export function nonBusinessReason(calendars: CalendarSet, calendarId: string, date: DateOnly): string | null {
  const data = calendarYear(calendars, calendarId, date);
  const day = weekday(date);
  if (day === 6) return 'Saturday';
  if (day === 7) return 'Sunday';
  const holiday = data.holidays.find((h) => h.date === date);
  if (holiday) return holiday.name;
  const closure = data.closures.find((c) => c.from <= date && date <= c.to);
  return closure ? closure.name : null;
}

export function isBusinessDay(calendars: CalendarSet, calendarId: string, date: DateOnly): boolean {
  return nonBusinessReason(calendars, calendarId, date) === null;
}

/** Moves to the nearest business day in a direction (the date itself if it is one). */
export function rollToBusinessDay(calendars: CalendarSet, calendarId: string, date: DateOnly, step: 1 | -1): DateOnly {
  let current = date;
  while (!isBusinessDay(calendars, calendarId, current)) current = addDays(current, step);
  return current;
}

/** Counts `count` business days from `date` (not counting `date` itself), forwards or backwards. */
export function addBusinessDays(
  calendars: CalendarSet,
  calendarId: string,
  date: DateOnly,
  count: number,
  step: 1 | -1,
): DateOnly {
  let current = date;
  let remaining = count;
  while (remaining > 0) {
    current = addDays(current, step);
    if (isBusinessDay(calendars, calendarId, current)) remaining -= 1;
  }
  return current;
}

/** Months with the day clamped to the month's end; reports whether it clamped. */
export function addMonthsClamped(date: DateOnly, months: number): { date: DateOnly; clamped: boolean } {
  const result = addMonths(date, months);
  return { date: result, clamped: result.slice(8) !== date.slice(8) };
}

/**
 * The first `month`/`day` after the end of the financial year that contains `date` (FY starts on
 * `fyStartMonth`): 31 Oct after the 30 June FY end in Australia.
 */
export function afterFyEnd(date: DateOnly, fy: { month: number; day: number; fyStartMonth: number }): DateOnly {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  // The FY containing `date` ends in the year after it started.
  const fyEndYear = month >= fy.fyStartMonth ? (fy.fyStartMonth === 1 ? year : year + 1) : year;
  const fyEndMonth = fy.fyStartMonth === 1 ? 12 : fy.fyStartMonth - 1;
  const target = fy.month > fyEndMonth ? fyEndYear : fyEndYear + 1;
  const mm = String(fy.month).padStart(2, '0');
  const lastDay = new Date(Date.UTC(target, fy.month, 0)).getUTCDate();
  const dd = String(Math.min(fy.day, lastDay)).padStart(2, '0');
  return `${target}-${mm}-${dd}` as DateOnly;
}
