import type { Baselines, MetricName, SuiteConfig } from './dataset';
import { LOWER_IS_BETTER } from './dataset';
import type { CaseResult, GateFailure, MetricSummary, SuiteResult, SuiteStatus } from './types';

/** Mean and variance of a list (population variance; 0 for one value). */
export function meanVariance(values: readonly number[]): { mean: number; variance: number } {
  if (!values.length) return { mean: NaN, variance: 0 };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return { mean, variance };
}

/** Per-metric summaries over the scored runs; `runVariance` is the mean variance between a case's repeat runs. */
export function summarise(cases: readonly CaseResult[]): Partial<Record<MetricName, MetricSummary>> {
  const scored = cases.filter((result) => result.status === 'scored');
  const names = new Set(scored.flatMap((result) => Object.keys(result.scores) as MetricName[]));
  const out: Partial<Record<MetricName, MetricSummary>> = {};
  for (const name of names) {
    const values = scored.flatMap((result) => (result.scores[name] === undefined ? [] : [result.scores[name]]));
    const byCase = new Map<string, number[]>();
    for (const result of scored) {
      const value = result.scores[name];
      if (value === undefined) continue;
      byCase.set(result.caseId, [...(byCase.get(result.caseId) ?? []), value]);
    }
    const repeats = [...byCase.values()].filter((list) => list.length > 1).map((list) => meanVariance(list).variance);
    const { mean, variance } = meanVariance(values);
    out[name] = {
      mean,
      variance,
      runVariance: repeats.length ? meanVariance(repeats).mean : 0,
      n: values.length,
    };
  }
  return out;
}

/**
 * The baseline a run is compared with: the entry for exactly these prompt versions, or else the
 * suite's most recently accepted entry. That second case is the point of the gate: a prompt change
 * bumps the version, and the new version must not regress against the last accepted one.
 */
export function baselineFor(baselines: Baselines, suite: string, promptKey: string): SuiteResult['baseline'] {
  const entries = baselines[suite];
  if (!entries) return undefined;
  const exact = entries[promptKey];
  if (exact) return { key: promptKey, ...exact };
  const latest = Object.entries(entries).sort(([, a], [, b]) => b.acceptedAt.localeCompare(a.acceptedAt))[0];
  return latest ? { key: latest[0], ...latest[1] } : undefined;
}

const EPSILON = 1e-9;

/** Threshold and regression failures for one suite's metrics. */
export function gateFailures(
  config: SuiteConfig,
  metrics: Partial<Record<MetricName, MetricSummary>>,
  baseline: SuiteResult['baseline'],
): GateFailure[] {
  const failures: GateFailure[] = [];
  for (const [name, rule] of Object.entries(config.metrics) as [
    MetricName,
    NonNullable<SuiteConfig['metrics'][MetricName]>,
  ][]) {
    const summary = metrics[name];
    if (!summary || !summary.n || Number.isNaN(summary.mean)) continue;
    const { mean } = summary;
    if (rule.min !== undefined && mean < rule.min - EPSILON)
      failures.push({ metric: name, kind: 'threshold', mean, limit: rule.min });
    if (rule.max !== undefined && mean > rule.max + EPSILON)
      failures.push({ metric: name, kind: 'threshold', mean, limit: rule.max });
    const base = baseline?.metrics[name];
    if (rule.maxRegression === undefined || base === undefined) continue;
    if (LOWER_IS_BETTER.has(name)) {
      const limit = base * (1 + rule.maxRegression);
      if (mean > limit + EPSILON) failures.push({ metric: name, kind: 'regression', mean, limit, baseline: base });
    } else {
      const limit = base - rule.maxRegression;
      if (mean < limit - EPSILON) failures.push({ metric: name, kind: 'regression', mean, limit, baseline: base });
    }
  }
  return failures;
}

/**
 * A suite's verdict. Errored cases (a provider 400, an unexpected exception) fail it. When fewer
 * than half the planned runs were scored (an outage, or the budget ran out), it is inconclusive
 * rather than passed or failed on a sliver of the data.
 */
export function verdict(
  cases: readonly CaseResult[],
  failures: GateFailure[],
): { status: SuiteStatus; failures: GateFailure[]; reason?: string } {
  const errored = cases.filter((result) => result.status === 'errored');
  const all = errored.length
    ? [
        ...failures,
        { metric: 'errors' as const, kind: 'errors' as const, cases: [...new Set(errored.map((r) => r.caseId))] },
      ]
    : failures;
  const scored = cases.filter((result) => result.status === 'scored').length;
  if (all.length) return { status: 'failed', failures: all };
  if (scored * 2 < cases.length)
    return {
      status: 'inconclusive',
      failures: all,
      reason: `${scored} of ${cases.length} runs scored (the rest hit an outage or the budget)`,
    };
  return { status: 'passed', failures: all };
}
