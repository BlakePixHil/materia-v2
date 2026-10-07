import { deadlinesMetPct, sumMetricValues } from './insights';
import type { MetricValues } from './metrics';
import { wallClockAt } from './notifications';
import type { Role } from './schemas/enums';
import { addDays, weekday, type DateOnly } from './values/date-only';
import { formatCents, type Cents } from './values/money';

/**
 * The weekly practice report (INS-03, ADR-055): each Monday from 07:00 in the org's time zone,
 * owners and admins who opted in (Settings → Preferences) get last week's headline figures, the
 * five matters holding the most WIP and how many critical deadlines fall due this week. The email
 * carries matter numbers and figures only: no titles, client names or deadline names.
 */

/** The local hour the report goes out on Mondays. */
export const WEEKLY_REPORT_HOUR = 7;
/** Who may opt in: the people who run the practice. */
export const WEEKLY_REPORT_ROLES: readonly Role[] = ['owner', 'admin'];
/** Matters listed by WIP. */
export const WEEKLY_REPORT_TOP_MATTERS = 5;
/** Critical deadlines counted: due from Monday to Sunday of the week the report arrives. */
export const WEEKLY_REPORT_AHEAD_DAYS = 7;

/** The Monday (org time) whose report is due at `now`: Mondays from 07:00 to midnight, else null. */
export function weeklyReportDue(now: Date, timeZone: string): DateOnly | null {
  const { date, minutes } = wallClockAt(now, timeZone);
  return weekday(date) === 1 && minutes >= WEEKLY_REPORT_HOUR * 60 ? date : null;
}

/** The week a report covers: Monday to Sunday before `monday`. */
export function weeklyReportWeek(monday: DateOnly): { from: DateOnly; to: DateOnly; days: DateOnly[] } {
  const from = addDays(monday, -7);
  const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  return { from, to: addDays(monday, -1), days };
}

/** The report's idempotency key and record id: one per person per week. */
export const weeklyReportId = (uid: string, monday: DateOnly) => `weekly-${uid}-${monday}`;

/** A matter in the top five: its number only when it is privileged (and always without a title). */
export interface WeeklyReportMatter {
  matterId: string;
  number: string;
  wipCents: number;
}

export interface WeeklyReportInput {
  orgName: string;
  monday: DateOnly;
  /** The week's days' figures (`metrics/day-…`), each with its shards added. */
  days: readonly (MetricValues | undefined)[];
  /** WIP now: unbilled time and disbursements on live matters. */
  wipCents: number;
  topMatters: readonly WeeklyReportMatter[];
  /** Critical deadlines due this week (Monday to Sunday), still upcoming. */
  criticalDue: number;
}

export interface WeeklyReportStat {
  label: string;
  value: string;
}

const get = (values: MetricValues, key: string) => values[key] ?? 0;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const shortDay = new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', day: 'numeric', month: 'short' });
const dayLabel = (date: DateOnly) => shortDay.format(new Date(`${date}T00:00:00Z`));

/** "29 Sept – 5 Oct". */
export function weeklyReportRange(monday: DateOnly): string {
  const week = weeklyReportWeek(monday);
  return `${dayLabel(week.from)} – ${dayLabel(week.to)}`;
}

/** Hours to one decimal place: 750 minutes → "12.5 h". */
const hours = (minutes: number) => `${(Math.round(minutes / 6) / 10).toFixed(1)} h`;

/** The six headline figures, in the order the email shows them. */
export function weeklyReportStats(input: Pick<WeeklyReportInput, 'days' | 'wipCents'>): WeeklyReportStat[] {
  const values = sumMetricValues(input.days);
  const met = deadlinesMetPct(values);
  return [
    { label: 'Billed (ex GST)', value: formatCents(get(values, 'billing.invoicedCents') as Cents) },
    { label: 'Collected', value: formatCents(get(values, 'billing.collectedCents') as Cents) },
    { label: 'Billable time', value: hours(get(values, 'time.billable.minutes')) },
    { label: 'Work in progress', value: formatCents(input.wipCents as Cents) },
    { label: 'Matters opened', value: String(get(values, 'matters.opened')) },
    { label: 'Deadlines met on time', value: met === null ? 'None due' : `${met}%` },
  ];
}

/** The subject: the org and the week, never matter content. */
export const weeklyReportSubject = (orgName: string, monday: DateOnly) =>
  `Weekly practice report for ${orgName}: ${weeklyReportRange(monday)}`;

/**
 * What the `weekly_report` email template is filled with. `appUrl` is the app's origin; links go
 * to Insights, each matter, Deadlines (critical only) and the notification settings.
 */
export function weeklyReportModel(input: WeeklyReportInput, appUrl: string): Record<string, unknown> {
  return {
    subject: weeklyReportSubject(input.orgName, input.monday),
    orgName: input.orgName,
    rangeLabel: weeklyReportRange(input.monday),
    stats: weeklyReportStats(input),
    topMatters: input.topMatters.map((matter) => ({
      number: matter.number,
      wip: formatCents(matter.wipCents as Cents),
      link: `${appUrl}/matters/${matter.matterId}`,
    })),
    criticalLabel: input.criticalDue
      ? `${plural(input.criticalDue, 'critical deadline')} due this week`
      : 'No critical deadlines due this week',
    deadlinesLink: `${appUrl}/deadlines`,
    insightsLink: `${appUrl}/insights`,
    settingsLink: `${appUrl}/settings/preferences`,
  };
}
