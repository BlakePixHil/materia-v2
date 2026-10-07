import * as z from 'zod';

import {
  deadlinesMetPct,
  INSIGHTS_COMPARISONS,
  INSIGHTS_RANGES,
  isMonthId,
  sumMetricValues,
  wipCentsOf,
  type InsightsPeriod,
} from './insights';
import { medianDays, type MetricValues } from './metrics';
import { MatterTypeSchema, type MatterType } from './schemas/enums';

/**
 * Clerk's Insights narratives (INS-04, ADR-054): the figures Clerk may describe for a period and
 * what it is compared with, how each figure is written, and the check that every number in a
 * narrative is one of the figures its paragraph cites. Only org totals from the INS-01 rollups:
 * no member's figures, no referrer, no matter and no client. Pure, so the context builder, the
 * callable, the evals and the Insights screen agree on every figure.
 */

export const INSIGHTS_NARRATIVE_CALLABLES = { explain: 'clerk-explainInsights' } as const;

/** The prompt that writes them (`libs/clerk/prompts`). */
export const INSIGHTS_NARRATIVE_PROMPT = 'insights-narrative@1.0.0';
/** How long an explanation is kept and shown again for the same period and comparison. */
export const INSIGHTS_NARRATIVE_TTL_HOURS = 24;
/** The soonest a fresh explanation of the same period and comparison can be asked for. */
export const INSIGHTS_NARRATIVE_REFRESH_MINUTES = 10;
/** Paragraphs Clerk is asked for and shown; any more are left out. */
export const INSIGHTS_NARRATIVE_MAX_PARAGRAPHS = 4;

export const NARRATIVE_PERIODS = ['current', 'comparison'] as const;
export type NarrativePeriod = (typeof NARRATIVE_PERIODS)[number];

export type NarrativeUnit = 'money' | 'count' | 'hours' | 'days' | 'percent';

/** One figure for both periods: null where the period has none (no snapshot, nothing to divide by). */
export interface NarrativeFigure {
  /** The metric key, or a figure worked out from them (`wip`, `deadlines.metOnTimePct`, …). */
  metric: string;
  /** The part of a broken-down metric (`probate` of `matters.opened.type`). */
  dimension?: string;
  label: string;
  unit: NarrativeUnit;
  current: number | null;
  comparison: number | null;
}

/** A cited figure: which one, and for which period. */
export interface NarrativeCitation {
  metric: string;
  period: NarrativePeriod;
  dimension?: string | undefined;
}

// ---------- the figures ----------

/** Matter types as the design system names them (MATTER_TYPE_LABELS in @materia/ui). */
export const MATTER_TYPE_NAMES: Readonly<Record<MatterType, string>> = {
  will: 'Will',
  poa: 'Power of attorney',
  probate: 'Probate',
  loa: 'Letters of admin',
  admin: 'Estate admin',
  fp: 'Family provision',
  contest: 'Will dispute',
  trust: 'Testamentary trust',
};

/** A period's figures: its months added up, and its last month's own (for the snapshots). */
interface PeriodValues {
  total: MetricValues;
  latest: MetricValues | undefined;
}

interface FigureDefinition {
  metric: string;
  label: string;
  unit: NarrativeUnit;
  of: (period: PeriodValues) => number | null;
}

const flow =
  (key: string) =>
  ({ total }: PeriodValues): number =>
    total[key] ?? 0;
/** A snapshot figure (ADR-048) is the period's last month's, never a sum; null when not recorded. */
const snapshot =
  (key: string) =>
  ({ latest }: PeriodValues): number | null =>
    latest && typeof latest[key] === 'number' ? latest[key] : null;

/**
 * Every figure a narrative may use, in the order Clerk sees them: what the Insights screen shows,
 * plus a few that explain it (write-offs, aged debtors, overdue deadlines). Utilisation is left
 * out: its target depends on the members, which this scope doesn't read.
 */
const FIGURES: readonly FigureDefinition[] = [
  { metric: 'billing.invoicedCents', label: 'Billed, excluding GST', unit: 'money', of: flow('billing.invoicedCents') },
  {
    metric: 'billing.collectedCents',
    label: 'Collected (payments received, net of refunds)',
    unit: 'money',
    of: flow('billing.collectedCents'),
  },
  {
    metric: 'wip',
    label: 'Work in progress at the end of the period (unbilled time and disbursements)',
    unit: 'money',
    of: ({ latest }) => wipCentsOf(latest),
  },
  {
    metric: 'time.recordedCents',
    label: 'Billable time recorded, at its value',
    unit: 'money',
    of: flow('time.recordedCents'),
  },
  {
    metric: 'time.billable.minutes',
    label: 'Billable hours recorded',
    unit: 'hours',
    of: flow('time.billable.minutes'),
  },
  {
    metric: 'time.nonBillable.minutes',
    label: 'Non-billable hours recorded',
    unit: 'hours',
    of: flow('time.nonBillable.minutes'),
  },
  {
    metric: 'billing.writtenOff.timeCents',
    label: 'Time written off',
    unit: 'money',
    of: flow('billing.writtenOff.timeCents'),
  },
  {
    metric: 'billing.writtenDown.timeCents',
    label: 'Time written down',
    unit: 'money',
    of: flow('billing.writtenDown.timeCents'),
  },
  {
    metric: 'disbursements.exGstCents',
    label: 'Disbursements recorded, excluding GST',
    unit: 'money',
    of: flow('disbursements.exGstCents'),
  },
  { metric: 'matters.opened', label: 'Matters opened', unit: 'count', of: flow('matters.opened') },
  { metric: 'matters.closed', label: 'Matters closed', unit: 'count', of: flow('matters.closed') },
  {
    metric: 'matters.opened.referred',
    label: 'Matters opened from a referral',
    unit: 'count',
    of: flow('matters.opened.referred'),
  },
  {
    metric: 'referrals.netBilledCents',
    label: 'Fees billed on referred matters, net of credit notes',
    unit: 'money',
    of: ({ total }) => (total['referrals.billedCents'] ?? 0) - (total['referrals.creditedCents'] ?? 0),
  },
  {
    metric: 'active.matters',
    label: 'Open matters at the end of the period',
    unit: 'count',
    of: snapshot('active.matters'),
  },
  { metric: 'deadlines.due', label: 'Deadlines due', unit: 'count', of: flow('deadlines.due') },
  { metric: 'deadlines.metOnTime', label: 'Deadlines met on time', unit: 'count', of: flow('deadlines.metOnTime') },
  { metric: 'deadlines.metLate', label: 'Deadlines met late', unit: 'count', of: flow('deadlines.metLate') },
  { metric: 'deadlines.missed', label: 'Deadlines missed', unit: 'count', of: flow('deadlines.missed') },
  { metric: 'deadlines.waived', label: 'Deadlines waived', unit: 'count', of: flow('deadlines.waived') },
  {
    metric: 'deadlines.critical.due',
    label: 'Critical deadlines due',
    unit: 'count',
    of: flow('deadlines.critical.due'),
  },
  {
    metric: 'deadlines.critical.missed',
    label: 'Critical deadlines missed',
    unit: 'count',
    of: flow('deadlines.critical.missed'),
  },
  {
    metric: 'deadlines.metOnTimePct',
    label: 'Deadlines met on time, as a share of those met or missed',
    unit: 'percent',
    of: ({ total }) => deadlinesMetPct(total),
  },
  {
    metric: 'overdue.deadlines',
    label: 'Deadlines overdue at the end of the period',
    unit: 'count',
    of: snapshot('overdue.deadlines'),
  },
  {
    metric: 'cycle.probate.instructionsToGrant',
    label: 'Median days from instructions to grant, for probate matters granted in the period',
    unit: 'days',
    of: ({ total }) => medianDays(total, 'cycle.probate.instructionsToGrant'),
  },
  {
    metric: 'debtors.total',
    label: 'Owed on unpaid invoices at the end of the period',
    unit: 'money',
    of: snapshot('debtors.total'),
  },
  {
    metric: 'debtors.invoices',
    label: 'Unpaid invoices at the end of the period',
    unit: 'count',
    of: snapshot('debtors.invoices'),
  },
  {
    metric: 'debtors.current',
    label: 'Owed and not yet due at the end of the period',
    unit: 'money',
    of: snapshot('debtors.current'),
  },
  {
    metric: 'debtors.d1_30',
    label: 'Owed 1 to 30 days past due at the end of the period',
    unit: 'money',
    of: snapshot('debtors.d1_30'),
  },
  {
    metric: 'debtors.d31_60',
    label: 'Owed 31 to 60 days past due at the end of the period',
    unit: 'money',
    of: snapshot('debtors.d31_60'),
  },
  {
    metric: 'debtors.d61_90',
    label: 'Owed 61 to 90 days past due at the end of the period',
    unit: 'money',
    of: snapshot('debtors.d61_90'),
  },
  {
    metric: 'debtors.d90_plus',
    label: 'Owed more than 90 days past due at the end of the period',
    unit: 'money',
    of: snapshot('debtors.d90_plus'),
  },
];

/** Matters opened by type: one figure per matter type (the screen's "Matters opened by type"). */
const BY_TYPE_METRIC = 'matters.opened.type';

function periodValues(
  months: readonly string[] | null,
  values: ReadonlyMap<string, MetricValues>,
): PeriodValues | null {
  if (!months?.length) return null;
  return {
    total: sumMetricValues(months.map((month) => values.get(month))),
    latest: values.get(months.at(-1) ?? ''),
  };
}

const worthShowing = (figure: NarrativeFigure) =>
  (figure.current !== null && figure.current !== 0) || (figure.comparison !== null && figure.comparison !== 0);

/**
 * The figures for a period's months and, when there is one, the comparison's: org totals from the
 * month documents (`values` by month, shards already added). Figures that are zero or missing in
 * both periods are left out, so an empty list means there is nothing to explain.
 */
export function narrativeFigures(input: {
  current: readonly string[];
  comparison: readonly string[] | null;
  /** Each month's org figures by `2026-10`; a month without a document is absent. */
  values: ReadonlyMap<string, MetricValues>;
}): NarrativeFigure[] {
  const current = periodValues(input.current, input.values);
  const comparison = periodValues(input.comparison, input.values);
  const figures: NarrativeFigure[] = FIGURES.map((definition) => ({
    metric: definition.metric,
    label: definition.label,
    unit: definition.unit,
    current: current ? definition.of(current) : null,
    comparison: comparison ? definition.of(comparison) : null,
  }));
  for (const type of MatterTypeSchema.options) {
    const key = `${BY_TYPE_METRIC}.${type}`;
    figures.push({
      metric: BY_TYPE_METRIC,
      dimension: type,
      label: `Matters opened: ${MATTER_TYPE_NAMES[type]}`,
      unit: 'count',
      current: current ? (current.total[key] ?? 0) : null,
      comparison: comparison ? (comparison.total[key] ?? 0) : null,
    });
  }
  return figures.filter(worthShowing);
}

/** The figure a citation names, if it is one of `figures`. */
export function citedFigure(
  figures: readonly NarrativeFigure[],
  citation: Pick<NarrativeCitation, 'metric' | 'dimension'>,
): NarrativeFigure | undefined {
  return figures.find(
    (figure) => figure.metric === citation.metric && (figure.dimension ?? '') === (citation.dimension ?? ''),
  );
}

// ---------- how figures are written ----------

const MONEY = new Intl.NumberFormat('en-AU', {
  style: 'currency',
  currency: 'AUD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});
const DECIMAL = new Intl.NumberFormat('en-AU', { maximumFractionDigits: 1 });
const WHOLE = new Intl.NumberFormat('en-AU', { maximumFractionDigits: 0 });

/** A value as Clerk is given it and must write it: `$12,345`, `12`, `12.5 hours`, `45 days`, `92%`. */
export function narrativeValue(unit: NarrativeUnit, value: number): string {
  switch (unit) {
    case 'money':
      return MONEY.format(Math.round(value / 100));
    case 'hours':
      return `${DECIMAL.format(value / 60)} hours`;
    case 'days':
      return `${DECIMAL.format(value)} days`;
    case 'percent':
      return `${WHOLE.format(value)}%`;
    case 'count':
      return WHOLE.format(value);
  }
}

/** A figure's value in one period as written, or null when the period has none. */
export function figureValue(figure: NarrativeFigure, period: NarrativePeriod): string | null {
  const value = period === 'current' ? figure.current : figure.comparison;
  return value === null ? null : narrativeValue(figure.unit, value);
}

const signed = (text: string, value: number) => (value > 0 ? `+${text}` : value < 0 ? `-${text}` : text);

/**
 * The change from the comparison to the current period, as written: `+$2,345` and `+23%`, or for a
 * percentage figure `+5 percentage points` and no relative change. Null without both values; the
 * relative change is null when the comparison is zero.
 */
export function figureChange(figure: NarrativeFigure): { change: string; changePct: string | null } | null {
  if (figure.current === null || figure.comparison === null) return null;
  const diff = figure.current - figure.comparison;
  if (figure.unit === 'percent') {
    const points = Math.round(diff);
    return { change: signed(`${WHOLE.format(Math.abs(points))} percentage points`, points), changePct: null };
  }
  const change = diff === 0 ? 'no change' : signed(narrativeValue(figure.unit, Math.abs(diff)), diff);
  if (figure.comparison === 0) return { change, changePct: null };
  const pct = Math.round((diff * 100) / Math.abs(figure.comparison));
  return { change, changePct: signed(`${WHOLE.format(Math.abs(pct))}%`, pct) };
}

/** A period as Clerk is told about it. */
export interface NarrativePeriodInfo {
  label: string;
  months: readonly string[];
  /** Still running, so its figures are to date. */
  toDate: boolean;
}

/** The prompt's variables (`insights-narrative@1`) for a period and what it is compared with. */
export function narrativePromptVars(
  current: { label: string },
  comparison: { label: string } | null,
): { periodLabel: string; comparisonText: string } {
  return { periodLabel: current.label, comparisonText: comparison ? ` compared with ${comparison.label}` : '' };
}

export const narrativePeriodInfo = (period: InsightsPeriod): NarrativePeriodInfo => ({
  label: period.label,
  months: period.months,
  toDate: period.toDate,
});

/**
 * What Clerk reads (inside `<org_metrics>`): the two periods and every figure, written as it must
 * be written back, with the change already worked out so the narrative never does arithmetic.
 */
export function narrativeContextJson(input: {
  current: NarrativePeriodInfo;
  comparison: NarrativePeriodInfo | null;
  figures: readonly NarrativeFigure[];
}): Record<string, unknown> {
  const period = (info: NarrativePeriodInfo) => ({
    label: info.label,
    firstMonth: info.months[0] ?? null,
    lastMonth: info.months.at(-1) ?? null,
    toDate: info.toDate,
  });
  return {
    current: period(input.current),
    comparison: input.comparison ? period(input.comparison) : null,
    figures: input.figures.map((figure) => {
      const change = input.comparison ? figureChange(figure) : null;
      return {
        metric: figure.metric,
        ...(figure.dimension ? { dimension: figure.dimension } : {}),
        label: figure.label,
        current: figureValue(figure, 'current'),
        ...(input.comparison ? { comparison: figureValue(figure, 'comparison') } : {}),
        ...(change ? { change: change.change, ...(change.changePct ? { changePct: change.changePct } : {}) } : {}),
      };
    }),
  };
}

// ---------- checking a narrative ----------

const NUMBER = /\d[\d,]*(?:\.\d+)?/g;

/** Every number written in `text` (`$12,345.50` → 12345.5, `-18%` → 18), signs and units dropped. */
export function numbersIn(text: string): number[] {
  return [...text.matchAll(NUMBER)]
    .map((match) => Number(match[0].replace(/,/g, '')))
    .filter((value) => Number.isFinite(value));
}

export interface ParagraphCheck {
  ok: boolean;
  /** Numbers in the text that none of its cited figures (nor the periods' names) contain. */
  unmatched: number[];
  /** Citations of a figure that isn't in the context, or of a period it has no value for. */
  unknownCitations: number;
}

/**
 * Whether every number in a paragraph is one of the figures it cites, written as Clerk was given
 * it: a cited period's value, the figure's own label ("61 to 90 days"), the periods' names
 * ("FY2026–27"), and, when the paragraph cites the figure in both periods, its change. Anything
 * else (a sum, a rounding, a figure it didn't cite, an invented one) fails the paragraph.
 */
export function checkNarrativeParagraph(
  paragraph: { text: string; citations: readonly NarrativeCitation[] },
  figures: readonly NarrativeFigure[],
  periodLabels: readonly string[],
): ParagraphCheck {
  const allowed = new Set<number>(periodLabels.flatMap(numbersIn));
  const periods = new Map<NarrativeFigure, Set<NarrativePeriod>>();
  let unknownCitations = 0;
  for (const citation of paragraph.citations) {
    const figure = citedFigure(figures, citation);
    const value = figure ? figureValue(figure, citation.period) : null;
    if (!figure || value === null) {
      unknownCitations++;
      continue;
    }
    numbersIn(value).forEach((n) => allowed.add(n));
    numbersIn(figure.label).forEach((n) => allowed.add(n));
    const cited = periods.get(figure) ?? new Set<NarrativePeriod>();
    cited.add(citation.period);
    periods.set(figure, cited);
  }
  for (const [figure, cited] of periods) {
    if (cited.size < NARRATIVE_PERIODS.length) continue;
    const change = figureChange(figure);
    if (change) [change.change, change.changePct ?? ''].flatMap(numbersIn).forEach((n) => allowed.add(n));
  }
  const unmatched = numbersIn(paragraph.text).filter((n) => !allowed.has(n));
  return { ok: !unmatched.length && !unknownCitations, unmatched, unknownCitations };
}

/** A cited figure as the screen shows it: its label and the value for the cited period. */
export interface ShownCitation extends NarrativeCitation {
  label: string;
  value: string;
}

export interface ShownParagraph {
  text: string;
  citations: ShownCitation[];
}

/**
 * The paragraphs that pass {@link checkNarrativeParagraph}, with each citation's label and value,
 * and how many were left out. A paragraph that fails is never shown.
 */
export function verifiedNarrative(
  paragraphs: readonly { text: string; citations: readonly NarrativeCitation[] }[],
  figures: readonly NarrativeFigure[],
  periodLabels: readonly string[],
): { paragraphs: ShownParagraph[]; omitted: number } {
  const shown: ShownParagraph[] = [];
  for (const paragraph of paragraphs) {
    if (!paragraph.text.trim() || !checkNarrativeParagraph(paragraph, figures, periodLabels).ok) continue;
    const citations: ShownCitation[] = [];
    for (const citation of paragraph.citations) {
      const figure = citedFigure(figures, citation);
      const value = figure ? figureValue(figure, citation.period) : null;
      if (!figure || value === null) continue;
      if (
        citations.some(
          (c) => c.metric === citation.metric && c.dimension === figure.dimension && c.period === citation.period,
        )
      )
        continue;
      citations.push({
        metric: figure.metric,
        period: citation.period,
        ...(figure.dimension ? { dimension: figure.dimension } : {}),
        label: figure.label,
        value,
      });
    }
    shown.push({ text: paragraph.text.trim(), citations });
  }
  return { paragraphs: shown, omitted: paragraphs.length - shown.length };
}

/**
 * The share of a narrative's paragraphs whose numbers all match their cited figures (1 for a
 * narrative with no paragraphs): the evals' `numberAccuracy`.
 */
export function narrativeNumberAccuracy(
  paragraphs: readonly { text: string; citations: readonly NarrativeCitation[] }[],
  figures: readonly NarrativeFigure[],
  periodLabels: readonly string[],
): number {
  if (!paragraphs.length) return 1;
  const ok = paragraphs.filter((p) => checkNarrativeParagraph(p, figures, periodLabels).ok).length;
  return ok / paragraphs.length;
}

// ---------- the callable ----------

/** Where the explanation of a period and its comparison is kept: `insightsNarratives/{key}`. */
export function narrativeKey(current: { months: readonly string[] }, comparison: { months: readonly string[] } | null) {
  const span = (months: readonly string[]) => `${months[0] ?? ''}_${months.at(-1) ?? ''}`;
  return `${span(current.months)}__${comparison ? span(comparison.months) : 'none'}`;
}

/**
 * `clerk-explainInsights`: the Insights selection (the screen's URL parameters). `cached` returns
 * the kept explanation or none without asking Clerk; `explain` returns the kept one or asks;
 * `refresh` asks again once the kept one is {@link INSIGHTS_NARRATIVE_REFRESH_MINUTES} old.
 */
export const ExplainInsightsInputSchema = z.object({
  requestId: z.uuid().optional(),
  range: z.enum(INSIGHTS_RANGES),
  from: z.string().refine(isMonthId, 'Expected a month (YYYY-MM)').optional(),
  to: z.string().refine(isMonthId, 'Expected a month (YYYY-MM)').optional(),
  compare: z.enum(INSIGHTS_COMPARISONS),
  mode: z.enum(['cached', 'explain', 'refresh']).default('explain'),
});
export type ExplainInsightsInput = z.input<typeof ExplainInsightsInputSchema>;

export interface InsightsNarrativeView {
  periodLabel: string;
  comparisonLabel: string | null;
  paragraphs: ShownParagraph[];
  /** Clerk said the figures aren't enough to say what changed. */
  insufficientData: boolean;
  /** Paragraphs left out because a number in them didn't match the figures they cite. */
  omitted: number;
  /** ISO instants: when it was written, when it can be refreshed, and when it is no longer kept. */
  generatedAt: string;
  refreshAfter: string;
  expiresAt: string;
  /** The figures have changed since it was written. */
  stale: boolean;
  promptRef: string;
}

export interface ExplainInsightsResult {
  narrative: InsightsNarrativeView | null;
  /**
   * Why there is none after asking: Clerk declined or its reply was unusable (`failed`), or no
   * paragraph's numbers matched the figures (`unverified`). Absent when nothing was asked.
   */
  problem?: 'failed' | 'unverified';
}
