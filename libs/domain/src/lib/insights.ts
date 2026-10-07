import { centsToDecimal, csvCell } from './billing';
import { medianDays, periodTargetMinutes, utilisationPct, type MetricValues } from './metrics';
import { fyLabel, fyStartYear } from './org-settings';
import { addDays, addMonths, dateOnly, type DateOnly } from './values/date-only';

/**
 * The Insights screen (INS-02): which months a period covers, what it is compared with, and the
 * figures each chart shows, worked out from the INS-01 metrics documents (`metrics/month-YYYY-MM`,
 * `metrics/fy-YYYY` and their `byMember/{uid}`). Pure, so the page, its tests and the e2e fixtures
 * agree on every number.
 */

// ---------- periods ----------

export const INSIGHTS_RANGES = ['this_month', 'last_month', 'this_fy', 'last_fy', 'custom'] as const;
export type InsightsRange = (typeof INSIGHTS_RANGES)[number];

export const INSIGHTS_RANGE_LABELS: Readonly<Record<InsightsRange, string>> = {
  this_month: 'This month',
  last_month: 'Last month',
  this_fy: 'This financial year',
  last_fy: 'Last financial year',
  custom: 'Choose months',
};

export const INSIGHTS_COMPARISONS = ['none', 'previous', 'last_year'] as const;
export type InsightsComparison = (typeof INSIGHTS_COMPARISONS)[number];

export const INSIGHTS_COMPARISON_LABELS: Readonly<Record<InsightsComparison, string>> = {
  none: 'No comparison',
  previous: 'Previous period',
  last_year: 'Same period last year',
};

/** The most months a chosen range covers (two years of month documents). */
export const INSIGHTS_MAX_MONTHS = 24;

export interface InsightsSelection {
  range: InsightsRange;
  /** First and last month of a chosen range (`2026-03`). */
  from?: string | undefined;
  to?: string | undefined;
}

/** A period the screen shows: calendar months, so every figure comes from `month-` documents. */
export interface InsightsPeriod {
  /** The months it covers, oldest first (`2026-07`). */
  months: string[];
  start: DateOnly;
  /** Its last day, or today while it is still running. */
  end: DateOnly;
  /** Still running, so its figures are to date. */
  toDate: boolean;
  /** The FY's start year when the period is a whole financial year (or one to date), else null. */
  fy: number | null;
  /** "October 2026 to date", "FY2026–27", "Mar 2026 – Jun 2026". */
  label: string;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** `2026-10`: a calendar month id. */
export const isMonthId = (value: unknown): value is string => typeof value === 'string' && MONTH_RE.test(value);

/** The month `by` months after `month` (negative for before). */
export function shiftMonth(month: string, by: number): string {
  return addMonths(dateOnly(`${month}-01`), by).slice(0, 7);
}

const lastDayOf = (month: string): DateOnly => addDays(addMonths(dateOnly(`${month}-01`), 1), -1);

/** Every month from `from` to `to`, inclusive and oldest first; the latest `max` when there are more. */
export function monthsFrom(from: string, to: string, max = INSIGHTS_MAX_MONTHS): string[] {
  if (!isMonthId(from) || !isMonthId(to) || from > to) return [];
  const months: string[] = [];
  for (let month = from; month <= to; month = shiftMonth(month, 1)) months.push(month);
  return months.slice(-max);
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** "Oct 2026", or "October 2026" with `long`. */
export function monthLabel(month: string, style: 'short' | 'long' = 'short'): string {
  const [year, index] = month.split('-').map(Number);
  if (style === 'short') return `${SHORT_MONTHS[(index ?? 1) - 1] ?? ''} ${year ?? ''}`;
  return new Date(Date.UTC(year ?? 2026, (index ?? 1) - 1, 1)).toLocaleDateString('en-AU', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** The months on a chart's axis: "Oct", or "Oct 25" when the months span more than one year. */
export function monthAxisLabels(months: readonly string[]): string[] {
  const years = new Set(months.map((month) => month.slice(0, 4)));
  return months.map((month) => {
    const name = SHORT_MONTHS[Number(month.slice(5, 7)) - 1] ?? month;
    return years.size > 1 ? `${name} ${month.slice(2, 4)}` : name;
  });
}

function periodOf(months: string[], today: DateOnly, fy: number | null, label: string): InsightsPeriod {
  const first = months[0] ?? today.slice(0, 7);
  const last = months.at(-1) ?? first;
  const start = dateOnly(`${first}-01`);
  const lastDay = lastDayOf(last);
  const toDate = start <= today && lastDay >= today;
  return { months, start, end: toDate ? today : lastDay, toDate, fy, label: toDate ? `${label} to date` : label };
}

const rangeLabel = (months: readonly string[]) =>
  months.length === 1
    ? monthLabel(months[0] ?? '', 'long')
    : `${monthLabel(months[0] ?? '')} – ${monthLabel(months.at(-1) ?? '')}`;

/**
 * The months a selection covers on `today`: this or last month, this FY to date or the last whole
 * FY (from the org's FY start month), or a chosen run of months (never past this month, at most
 * {@link INSIGHTS_MAX_MONTHS}). An unusable chosen range falls back to this month.
 */
export function insightsPeriod(selection: InsightsSelection, today: DateOnly, fyStartMonth = 7): InsightsPeriod {
  const thisMonth = today.slice(0, 7);
  const fyStart = (year: number) => `${year}-${String(fyStartMonth).padStart(2, '0')}`;
  switch (selection.range) {
    case 'last_month': {
      const month = shiftMonth(thisMonth, -1);
      return periodOf([month], today, null, monthLabel(month, 'long'));
    }
    case 'this_fy': {
      const year = fyStartYear(today, fyStartMonth);
      return periodOf(monthsFrom(fyStart(year), thisMonth), today, year, fyLabel(year, fyStartMonth));
    }
    case 'last_fy': {
      const year = fyStartYear(today, fyStartMonth) - 1;
      return periodOf(
        monthsFrom(fyStart(year), shiftMonth(fyStart(year), 11)),
        today,
        year,
        fyLabel(year, fyStartMonth),
      );
    }
    case 'custom': {
      const to = isMonthId(selection.to) && selection.to < thisMonth ? selection.to : thisMonth;
      const months = monthsFrom(isMonthId(selection.from) ? selection.from : to, to);
      if (months.length) return periodOf(months, today, null, rangeLabel(months));
      break;
    }
    case 'this_month':
      break;
  }
  return periodOf([thisMonth], today, null, monthLabel(thisMonth, 'long'));
}

/**
 * What a period is compared with: the same months a year earlier, or the period before it (the
 * month before, the FY before, or as many months before a chosen range). A financial year, even
 * to date, is compared month for month with the year before. Null for no comparison.
 */
export function comparisonPeriod(
  period: InsightsPeriod,
  mode: InsightsComparison,
  today: DateOnly,
): InsightsPeriod | null {
  if (mode === 'none' || !period.months.length) return null;
  const shift = mode === 'last_year' || period.fy !== null ? -12 : -period.months.length;
  const months = period.months.map((month) => shiftMonth(month, shift));
  return periodOf(months, today, null, rangeLabel(months));
}

/** What a selection's period is compared with, as words: "Compared with Jul 2025 – Oct 2025". */
export const comparisonText = (comparison: InsightsPeriod | null): string =>
  comparison ? `Compared with ${comparison.label}` : '';

// ---------- figures ----------

/** Several documents' figures added up (months into a period, or a period and its shards). */
export function sumMetricValues(list: readonly (MetricValues | undefined | null)[]): MetricValues {
  const total: MetricValues = {};
  for (const values of list)
    for (const [key, value] of Object.entries(values ?? {}))
      if (typeof value === 'number' && Number.isFinite(value)) total[key] = (total[key] ?? 0) + value;
  return total;
}

/**
 * The figures one level under a prefix, largest first: `matters.opened.type.` gives
 * `[{key: 'probate', value: 4}, …]`. Deeper keys (`….probate.x`) and zeros are left out.
 */
export function metricsByKey(values: MetricValues, prefix: string): { key: string; value: number }[] {
  const rows: { key: string; value: number }[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (!key.startsWith(prefix) || !value) continue;
    const rest = key.slice(prefix.length);
    if (rest && !rest.includes('.')) rows.push({ key: rest, value });
  }
  return rows.sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
}

const get = (values: MetricValues | undefined, key: string) => values?.[key] ?? 0;

/** Billable time's target for some months: their working days to `today`, at the daily target. */
export function monthsTargetMinutes(months: readonly string[], dailyTargetMinutes: number, today: DateOnly): number {
  return months.reduce(
    (sum, month) => sum + periodTargetMinutes(`month-${month}`, dailyTargetMinutes, { upTo: today }),
    0,
  );
}

/** Deadlines met on time as a share of those resolved (met on time, met late or missed), or null. */
export function deadlinesMetPct(values: MetricValues): number | null {
  const onTime = get(values, 'deadlines.metOnTime');
  const resolved = onTime + get(values, 'deadlines.metLate') + get(values, 'deadlines.missed');
  return resolved ? Math.round((onTime * 100) / resolved) : null;
}

/** Unbilled time and disbursements in a snapshot, or null when the snapshot has none. */
export function wipCentsOf(values: MetricValues | undefined): number | null {
  if (!values || (!('wip.timeCents' in values) && !('wip.disbursementsCents' in values))) return null;
  return get(values, 'wip.timeCents') + get(values, 'wip.disbursementsCents');
}

/** The overview Stats for a period. */
export interface InsightsSummary {
  /** Invoiced, excluding GST, with the legacy system's billing imported by the migration. */
  billedCents: number;
  /** Of that, billed in the legacy system (`legacy.billedCents`, by its billing date; MIG-09), as it recorded the totals. */
  legacyBilledCents: number;
  /** Payments received, net of refunds. */
  collectedCents: number;
  /** WIP at the end of the period's last month (the nightly snapshot), or null when not recorded. */
  wipCents: number | null;
  mattersOpened: number;
  mattersClosed: number;
  deadlinesDue: number;
  deadlinesMetPct: number | null;
  billableMinutes: number;
  /** Billable target for the period: working days at the daily target, for each fee earner. */
  targetMinutes: number;
  utilisationPct: number | null;
}

export function insightsSummary(input: {
  /** The period's months' figures, added up. */
  values: MetricValues;
  /** The last month's own figures, for its snapshot (WIP). */
  latest?: MetricValues | undefined;
  months: readonly string[];
  dailyTargetMinutes: number;
  /** Members whose time counts towards utilisation. */
  feeEarners: number;
  today: DateOnly;
}): InsightsSummary {
  const { values } = input;
  const billableMinutes = get(values, 'time.billable.minutes');
  const targetMinutes =
    monthsTargetMinutes(input.months, input.dailyTargetMinutes, input.today) * Math.max(0, input.feeEarners);
  const legacyBilledCents = get(values, 'legacy.billedCents');
  return {
    billedCents: get(values, 'billing.invoicedCents') + legacyBilledCents,
    legacyBilledCents,
    collectedCents: get(values, 'billing.collectedCents'),
    wipCents: wipCentsOf(input.latest),
    mattersOpened: get(values, 'matters.opened'),
    mattersClosed: get(values, 'matters.closed'),
    deadlinesDue: get(values, 'deadlines.due'),
    deadlinesMetPct: deadlinesMetPct(values),
    billableMinutes,
    targetMinutes,
    utilisationPct: utilisationPct(billableMinutes, targetMinutes),
  };
}

/** Whether a period has any figures worth charting (a new org has none). */
export const hasFigures = (values: MetricValues): boolean => Object.values(values).some((value) => value !== 0);

/** A change from the comparison: `+12` or `−3` as a number, or null when there is nothing to compare. */
export function insightsDelta(current: number | null, previous: number | null | undefined): number | null {
  if (current === null || previous === null || previous === undefined) return null;
  return current - previous;
}

// ---------- deadlines ----------

export const DEADLINE_RESULTS = ['metOnTime', 'metLate', 'missed', 'waived'] as const;
export type DeadlineResult = (typeof DEADLINE_RESULTS)[number];

export const DEADLINE_RESULT_LABELS: Readonly<Record<DeadlineResult, string>> = {
  metOnTime: 'Met on time',
  metLate: 'Met late',
  missed: 'Missed',
  waived: 'Waived',
};

/** Deadlines due in the period by how they ended, in a fixed order. */
export function deadlineResults(values: MetricValues): { key: DeadlineResult; label: string; value: number }[] {
  return DEADLINE_RESULTS.map((key) => ({
    key,
    label: DEADLINE_RESULT_LABELS[key],
    value: get(values, `deadlines.${key}`),
  }));
}

// ---------- referrals ----------

export interface ReferrerFigures {
  /** The referrer contact's id, as the metric keys carry it. */
  id: string;
  mattersOpened: number;
  /** Billed on their referred matters, net of credit notes. */
  billedCents: number;
}

/** Referrers by fees billed on the matters they sent, then by matters opened; the top `limit`. */
export function referrerFigures(values: MetricValues, limit = 10): ReferrerFigures[] {
  const byId = new Map<string, ReferrerFigures>();
  const row = (id: string): ReferrerFigures => {
    const found = byId.get(id);
    if (found) return found;
    const created = { id, mattersOpened: 0, billedCents: 0 };
    byId.set(id, created);
    return created;
  };
  for (const { key, value } of metricsByKey(values, 'matters.opened.referrer.')) row(key).mattersOpened += value;
  for (const [key, value] of Object.entries(values)) {
    const match = /^referrals\.referrer\.([A-Za-z0-9_-]+)\.(billedCents|creditedCents)$/.exec(key);
    if (match?.[1]) row(match[1]).billedCents += match[2] === 'billedCents' ? value : -value;
  }
  return [...byId.values()]
    .filter((r) => r.billedCents > 0 || r.mattersOpened > 0)
    .sort((a, b) => b.billedCents - a.billedCents || b.mattersOpened - a.mattersOpened || a.id.localeCompare(b.id))
    .slice(0, limit);
}

// ---------- cycle times ----------

/** Median days from instructions to grant for a matter type, by month of grant (null with none granted). */
export function medianDaysByMonth(
  months: readonly { month: string; values: MetricValues | undefined }[],
  type = 'probate',
): { month: string; days: number | null }[] {
  return months.map(({ month, values }) => ({
    month,
    days: values ? medianDays(values, `cycle.${type}.instructionsToGrant`) : null,
  }));
}

// ---------- members ----------

export interface MemberInsights {
  uid: string;
  minutes: number;
  billableMinutes: number;
  recordedCents: number;
  billedCents: number;
  utilisationPct: number | null;
}

/** A member's figures for a period, with utilisation against `targetMinutes` (their share of the target). */
export function memberInsights(uid: string, values: MetricValues | undefined, targetMinutes: number): MemberInsights {
  const billableMinutes = get(values, 'time.billable.minutes');
  return {
    uid,
    minutes: get(values, 'time.minutes'),
    billableMinutes,
    recordedCents: get(values, 'time.recordedCents'),
    billedCents: get(values, 'time.billedCents'),
    utilisationPct: utilisationPct(billableMinutes, targetMinutes),
  };
}

/** How far through a financial year `today` is, as a whole percentage (100 once it has ended). */
export function fyElapsedPct(fy: number, today: DateOnly, fyStartMonth = 7): number {
  const start = dateOnly(`${fy}-${String(fyStartMonth).padStart(2, '0')}-01`);
  const end = addDays(addMonths(start, 12), -1);
  if (today >= end) return 100;
  if (today < start) return 0;
  const day = (value: DateOnly) => Date.parse(`${value}T00:00:00Z`) / 86_400_000;
  return Math.round(((day(today) - day(start) + 1) * 100) / (day(end) - day(start) + 1));
}

// ---------- formats and CSV ----------

/** Minutes as hours for a chart: 90 → "1.5 h". */
export function hoursText(minutes: number): string {
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `${hours.toLocaleString('en-AU', { maximumFractionDigits: 1 })} h`;
}

/** An amount in cents as dollars for a spreadsheet: −1250 → `-12.50`. */
export const csvMoney = (value: number): string => centsToDecimal(value);

const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * One chart's data as CSV (CRLF lines, a header row). Text is quoted and kept from starting a
 * formula; plain numbers (a negative amount included) are written as they are.
 */
export function insightsCsv(
  headers: readonly string[],
  rows: readonly (readonly (string | number | null)[])[],
): string {
  const cell = (value: string | number | null) =>
    typeof value === 'number' ? String(value) : value && PLAIN_NUMBER.test(value) ? value : csvCell(value ?? '');
  const line = (cells: readonly (string | number | null)[]) => cells.map(cell).join(',');
  return [line(headers), ...rows.map(line)].join('\r\n') + '\r\n';
}
