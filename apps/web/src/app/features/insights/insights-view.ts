import {
  canSeeMemberMetrics,
  csvMoney,
  deadlineResults,
  fyElapsedPct,
  fyLabel,
  fyStartYear,
  hasFigures,
  insightsCsv,
  insightsSummary,
  medianDaysByMonth,
  memberInsights,
  metricsByKey,
  monthAxisLabels,
  monthLabel,
  monthsTargetMinutes,
  MatterTypeSchema,
  referrerFigures,
  shiftMonth,
  sumMetricValues,
  type DateOnly,
  type DeadlineResult,
  type InsightsPeriod,
  type InsightsSummary,
  type MemberMetricsVisibility,
  type MetricValues,
  type Role,
} from '@materia/domain';
import { formatAud, MATTER_TYPE_LABELS } from '@materia/ui';
import type { ChartDatum } from '@materia/ui/charts';

/**
 * The Insights screen's figures (INS-02), built from the metrics documents the page read: the
 * overview Stats, each chart's data and its CSV. Pure, so the specs check the numbers without
 * Firestore.
 */

/** Roles whose time counts towards the practice's utilisation target (admins and read-only don't). */
export const FEE_EARNER_ROLES: readonly Role[] = ['owner', 'lawyer', 'paralegal'];

/** A member as the screen needs one. */
export interface InsightsMember {
  uid: string;
  name: string;
  role: Role;
  status: 'active' | 'suspended' | 'removed';
  /** FY budgets in cents, by the FY's start year (`2026`). */
  budgets: Readonly<Record<string, number>>;
}

/** Everything the page read for a period and its comparison. */
export interface InsightsInput {
  period: InsightsPeriod;
  comparison: InsightsPeriod | null;
  /** The months the trend charts show (12 to the period's end, or the period when longer). */
  trendMonths: readonly string[];
  /** Every month read, by `2026-10`; a month without a document is absent. */
  months: ReadonlyMap<string, MetricValues>;
  members: readonly InsightsMember[];
  /** Each member's figures for the period (only the members `me` may see). */
  memberValues: ReadonlyMap<string, MetricValues>;
  /** Each member's figures for the budget's FY. */
  fyMemberValues: ReadonlyMap<string, MetricValues>;
  referrerNames: ReadonlyMap<string, string>;
  me: { uid: string; role: Role };
  visibility: MemberMetricsVisibility | undefined;
  dailyTargetMinutes: number;
  fyStartMonth: number;
  today: DateOnly;
}

/** A Stat's change against the comparison. */
export interface InsightsDeltaView {
  text: string;
  direction: 'up' | 'down';
  good: boolean;
}

export interface MemberBudgetView {
  uid: string;
  name: string;
  recordedCents: number;
  budgetCents: number;
  /** Where the member should be today (the share of the year gone). */
  expectedCents: number;
  pct: number;
  behind: boolean;
}

export interface InsightsView {
  hasFigures: boolean;
  summary: InsightsSummary;
  previous: InsightsSummary | null;
  deltas: Record<'billed' | 'collected' | 'wip' | 'utilisation' | 'opened' | 'deadlines', InsightsDeltaView | null>;
  /** The FY the hero and the budget list are for. */
  fy: number;
  fyLabel: string;
  fyElapsedPct: number;
  /** The practice's budget for the FY (every member's, added up), when the period is that FY. */
  heroBudget: { budgetCents: number; pct: number } | null;
  trendLabel: string;
  billedByMonth: ChartDatum[];
  collectedByMonth: ChartDatum[];
  grantDays: ChartDatum[];
  grantDaysComparison: ChartDatum[] | null;
  mattersByType: ChartDatum[];
  /** Each bar's matter type, for drill-down. */
  matterTypes: string[];
  deadlines: ChartDatum[];
  /** Each bar's result, for drill-down (see `DEADLINE_DRILL`). */
  deadlineKeys: DeadlineResult[];
  referrers: ChartDatum[];
  /** Each bar's referrer contact id, for drill-down, and the matters each sent. */
  referrerIds: string[];
  referrerMatters: number[];
  utilisation: ChartDatum[];
  /** Only my own figures: the org shows everyone's to other roles. */
  ownFiguresOnly: boolean;
  budgets: MemberBudgetView[];
}

const get = (values: MetricValues | undefined, key: string) => values?.[key] ?? 0;
/** A percentage for a Stat, or a dash when there is nothing to divide by. */
export const pctText = (value: number | null) => (value === null ? '—' : `${value}%`);

function valuesOf(input: InsightsInput, months: readonly string[]): MetricValues {
  return sumMetricValues(months.map((month) => input.months.get(month)));
}

function summaryOf(input: InsightsInput, period: InsightsPeriod): InsightsSummary {
  const feeEarners = input.members.filter(
    (member) => member.status === 'active' && FEE_EARNER_ROLES.includes(member.role),
  ).length;
  return insightsSummary({
    values: valuesOf(input, period.months),
    latest: input.months.get(period.months.at(-1) ?? ''),
    months: period.months,
    dailyTargetMinutes: input.dailyTargetMinutes,
    feeEarners: Math.max(1, feeEarners),
    today: input.today,
  });
}

/** A change for a Stat: money, a count or percentage points, up being good unless `upIsGood` is false. */
export function deltaView(
  current: number | null,
  previous: number | null | undefined,
  format: (value: number) => string,
  upIsGood = true,
): InsightsDeltaView | null {
  if (current === null || previous === null || previous === undefined) return null;
  const change = current - previous;
  const direction = change < 0 ? 'down' : 'up';
  const sign = change > 0 ? '+' : change < 0 ? '−' : '±';
  return { text: `${sign}${format(Math.abs(change))}`, direction, good: change >= 0 === upIsGood };
}

/** Members' display names, "Former member" for those who left (numbered when there are several). */
export function memberNames(members: readonly InsightsMember[]): Map<string, string> {
  const names = new Map<string, string>();
  const former = members.filter((member) => member.status === 'removed');
  for (const member of members) {
    if (member.status !== 'removed') names.set(member.uid, member.name);
  }
  former.forEach((member, i) => names.set(member.uid, former.length > 1 ? `Former member ${i + 1}` : 'Former member'));
  return names;
}

/** The members whose own figures `me` may read, under the org's visibility setting. */
export function visibleMembers(
  members: readonly InsightsMember[],
  me: { uid: string; role: Role },
  visibility: MemberMetricsVisibility | undefined,
): InsightsMember[] {
  const everyone = canSeeMemberMetrics(me.role, visibility);
  return members.filter((member) => everyone || member.uid === me.uid);
}

/** The months the trend charts show: the period when it has 12 or more, else the 12 to its last month. */
export function trendMonthsOf(period: InsightsPeriod): string[] {
  if (period.months.length >= 12) return [...period.months];
  const last = period.months.at(-1) ?? period.start.slice(0, 7);
  return Array.from({ length: 12 }, (_, i) => shiftMonth(last, i - 11));
}

const hasDeadlines = (values: MetricValues) =>
  ['metOnTime', 'metLate', 'missed', 'waived'].some((key) => get(values, `deadlines.${key}`) !== 0);

/** Which deadlines a result's bar lists: done ones (met on time or late), missed or waived. */
export const DEADLINE_DRILL: Readonly<Record<DeadlineResult, 'done' | 'missed' | 'waived'>> = {
  metOnTime: 'done',
  metLate: 'done',
  missed: 'missed',
  waived: 'waived',
};

export function buildInsights(input: InsightsInput): InsightsView {
  const { period, comparison } = input;
  const values = valuesOf(input, period.months);
  const summary = summaryOf(input, period);
  const previous = comparison ? summaryOf(input, comparison) : null;
  const aud = (cents: number) => formatAud(cents);
  const count = (n: number) => n.toLocaleString('en-AU');
  const points = (n: number) => `${n} pts`;

  const fy = period.fy ?? fyStartYear(period.end, input.fyStartMonth);
  const elapsed = fyElapsedPct(fy, input.today, input.fyStartMonth);
  const names = memberNames(input.members);
  const visible = visibleMembers(input.members, input.me, input.visibility);

  // The practice's FY budget: every member's for the year, as BILL-03's budget card reads them.
  const totalBudget = input.members.reduce((sum, member) => sum + (member.budgets[String(fy)] ?? 0), 0);
  const heroBudget =
    period.fy !== null && totalBudget > 0
      ? { budgetCents: totalBudget, pct: Math.round((summary.billedCents * 100) / totalBudget) }
      : null;

  const trend = input.trendMonths;
  const axis = monthAxisLabels(trend);
  const monthBars = (key: string): ChartDatum[] => {
    const rows = trend.map((month, i) => ({
      label: axis[i] ?? month,
      value: get(input.months.get(month), key),
      meta: monthLabel(month, 'long'),
    }));
    return rows.some((row) => row.value !== 0) ? rows : [];
  };

  // Median days to grant by month of grant, for the months with a grant; the comparison is the
  // same months a year earlier, drawn only when every one of them had a grant (the line chart pairs
  // the two series point for point).
  const medians = (months: readonly string[]) =>
    medianDaysByMonth(months.map((month) => ({ month, values: input.months.get(month) })));
  const current = medians(trend);
  const kept = current.flatMap((row, i) => (row.days === null ? [] : [{ i, row }]));
  const grantDays = kept.map(({ i, row }) => ({
    label: axis[i] ?? row.month,
    value: row.days ?? 0,
    meta: monthLabel(row.month, 'long'),
  }));
  const earlier = comparison ? medians(trend.map((month) => shiftMonth(month, -12))) : [];
  const paired = kept.map(({ i }) => earlier[i]);
  const grantComparison =
    comparison && paired.length && paired.every((row) => row?.days !== null && row?.days !== undefined)
      ? paired.map((row, k) => ({
          label: grantDays[k]?.label ?? '',
          value: row?.days ?? 0,
          meta: monthLabel(row?.month ?? '', 'long'),
        }))
      : null;

  const typeRows = metricsByKey(values, 'matters.opened.type.');
  const mattersByType = typeRows.map(({ key, value }) => {
    const known = MatterTypeSchema.safeParse(key);
    return { label: known.success ? MATTER_TYPE_LABELS[known.data] : key, value };
  });

  const deadlineRows = deadlineResults(values).filter(() => hasDeadlines(values));
  const deadlines = deadlineRows.map((row) => ({ label: row.label, value: row.value }));

  const referrerRows = referrerFigures(values);
  const referrers = referrerRows.map((row) => ({
    label: input.referrerNames.get(row.id) ?? 'Referrer',
    value: row.billedCents,
  }));

  const memberTarget = monthsTargetMinutes(period.months, input.dailyTargetMinutes, input.today);
  const utilisation = visible
    .map((member) => {
      const figures = input.memberValues.get(member.uid);
      const counts = member.status === 'active' && FEE_EARNER_ROLES.includes(member.role);
      if (!counts && !hasFigures(figures ?? {})) return null;
      const row = memberInsights(member.uid, figures, memberTarget);
      return { label: names.get(member.uid) ?? 'Former member', value: row.utilisationPct ?? 0 };
    })
    .filter((row): row is ChartDatum => row !== null)
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));

  const budgets = visible
    .map((member): MemberBudgetView | null => {
      const budgetCents = member.budgets[String(fy)] ?? 0;
      if (budgetCents <= 0) return null;
      const recordedCents = get(input.fyMemberValues.get(member.uid), 'time.recordedCents');
      const expectedCents = Math.round((budgetCents * elapsed) / 100);
      return {
        uid: member.uid,
        name: names.get(member.uid) ?? 'Former member',
        recordedCents,
        budgetCents,
        expectedCents,
        pct: Math.round((recordedCents * 100) / budgetCents),
        behind: recordedCents < expectedCents,
      };
    })
    .filter((row): row is MemberBudgetView => row !== null)
    .sort((a, b) => b.pct - a.pct || a.name.localeCompare(b.name));

  return {
    hasFigures: hasFigures(values),
    summary,
    previous,
    deltas: {
      billed: deltaView(summary.billedCents, previous?.billedCents, aud),
      collected: deltaView(summary.collectedCents, previous?.collectedCents, aud),
      wip: deltaView(summary.wipCents, previous?.wipCents, aud, false),
      utilisation: deltaView(summary.utilisationPct, previous?.utilisationPct, points),
      opened: deltaView(summary.mattersOpened, previous?.mattersOpened, count),
      deadlines: deltaView(summary.deadlinesMetPct, previous?.deadlinesMetPct, points),
    },
    fy,
    fyLabel: fyLabel(fy, input.fyStartMonth),
    fyElapsedPct: elapsed,
    heroBudget,
    trendLabel:
      trend.length === period.months.length
        ? period.label
        : `${trend.length} months to ${monthLabel(trend.at(-1) ?? '', 'long')}`,
    billedByMonth: monthBars('billing.invoicedCents'),
    collectedByMonth: monthBars('billing.collectedCents'),
    grantDays,
    grantDaysComparison: grantComparison,
    mattersByType,
    matterTypes: typeRows.map((row) => row.key),
    deadlines,
    deadlineKeys: deadlineRows.map((row) => row.key),
    referrers,
    referrerIds: referrerRows.map((row) => row.id),
    referrerMatters: referrerRows.map((row) => row.mattersOpened),
    utilisation,
    ownFiguresOnly: !canSeeMemberMetrics(input.me.role, input.visibility),
    budgets,
  };
}

// ---------- CSV ----------

/** The CSV for one chart: a header row, then its rows as the table view lists them. */
export interface InsightsCsvFile {
  name: string;
  text: string;
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

function file(chart: string, period: string, headers: string[], rows: (string | number | null)[][]): InsightsCsvFile {
  return { name: `insights-${slug(chart)}-${slug(period)}.csv`, text: insightsCsv(headers, rows) };
}

export type InsightsChart =
  'billed' | 'collected' | 'grant' | 'types' | 'utilisation' | 'deadlines' | 'referrers' | 'budgets';

/** One chart's data as a CSV file named for the chart and the period. */
export function chartCsv(chart: InsightsChart, view: InsightsView, periodLabel: string): InsightsCsvFile {
  switch (chart) {
    case 'billed':
      return file('billed by month', view.trendLabel, ['Month', 'Billed (ex GST)'], monthRows(view.billedByMonth));
    case 'collected':
      return file('collected by month', view.trendLabel, ['Month', 'Collected'], monthRows(view.collectedByMonth));
    case 'grant':
      return file(
        'median days to grant',
        view.trendLabel,
        ['Month of grant', 'Median days'],
        view.grantDays.map((d) => [d.meta ?? d.label, d.value]),
      );
    case 'types':
      return file(
        'matters opened by type',
        periodLabel,
        ['Matter type', 'Matters opened'],
        view.mattersByType.map((d) => [d.label, d.value]),
      );
    case 'utilisation':
      return file(
        'utilisation by fee earner',
        periodLabel,
        ['Fee earner', 'Utilisation (%)'],
        view.utilisation.map((d) => [d.label, d.value]),
      );
    case 'deadlines':
      return file(
        'deadline performance',
        periodLabel,
        ['Result', 'Deadlines'],
        view.deadlines.map((d) => [d.label, d.value]),
      );
    case 'referrers':
      return file(
        'referrers by fees',
        periodLabel,
        ['Referrer', 'Matters opened', 'Billed (ex GST)'],
        view.referrers.map((d, i) => [d.label, view.referrerMatters[i] ?? 0, csvMoney(d.value)]),
      );
    case 'budgets':
      return file(
        'fy budget by fee earner',
        view.fyLabel,
        ['Fee earner', 'Recorded', 'Budget', 'Recorded (%)'],
        view.budgets.map((b) => [b.name, csvMoney(b.recordedCents), csvMoney(b.budgetCents), b.pct]),
      );
  }
}

function monthRows(rows: readonly ChartDatum[]): (string | number)[][] {
  return rows.map((d) => [d.meta ?? d.label, csvMoney(d.value)]);
}
