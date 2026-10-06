import {
  comparisonPeriod,
  dateOnly,
  insightsPeriod,
  narrativeFigures,
  type InsightsPeriod,
  type MetricValues,
  type NarrativeFigure,
} from '@materia/domain';

import type { EvalCase } from './dataset';

/** An Insights narrative case (INS-04): its periods and the figures Clerk is given for them. */
export interface InsightsCase {
  current: InsightsPeriod;
  comparison: InsightsPeriod | null;
  /** Each month's org figures, by `2026-05`. */
  values: Map<string, MetricValues>;
  figures: NarrativeFigure[];
  /** The periods' names, whose numbers ("FY2026–27") a narrative may write. */
  labels: string[];
}

/**
 * The periods an Insights case selects on its `today`, and the figures production's metrics scope
 * gives Clerk for them (`narrativeFigures`, the same function `buildContext` uses), so the runner
 * grades against exactly what the model saw. Null for a case without an Insights selection.
 */
export function insightsCase(evalCase: EvalCase): InsightsCase | null {
  const selection = evalCase.insights;
  if (!selection) return null;
  const today = dateOnly(evalCase.today);
  const current = insightsPeriod(selection, today, selection.fyStartMonth);
  const comparison = comparisonPeriod(current, selection.compare, today);
  const values = new Map(Object.entries(evalCase.metrics));
  const figures = narrativeFigures({ current: current.months, comparison: comparison?.months ?? null, values });
  return { current, comparison, values, figures, labels: [current.label, ...(comparison ? [comparison.label] : [])] };
}
