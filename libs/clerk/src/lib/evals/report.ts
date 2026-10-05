import { LOWER_IS_BETTER, type MetricName } from './dataset';
import { runPassed } from './runner';
import type { GateFailure, RunReport, SuiteResult } from './types';

/** The marker the CI workflow uses to update its PR comment in place. */
export const REPORT_MARKER = '<!-- clerk-evals -->';

const STATUS: Record<SuiteResult['status'], string> = {
  passed: '✅ passed',
  failed: '❌ failed',
  inconclusive: '⚠️ inconclusive',
  pending: '⏸ pending',
};

function usd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(micros < 10_000_000 ? 4 : 2)}`;
}

function formatMetric(name: MetricName, value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return '–';
  if (name === 'latencyMs') return `${Math.round(value)} ms`;
  if (name === 'costUsd') return `$${value.toFixed(4)}`;
  return value.toFixed(3);
}

function describeFailure(failure: GateFailure): string {
  if (failure.kind === 'errors') return `errored cases: ${failure.cases?.join(', ')}`;
  const name = failure.metric as MetricName;
  const direction = LOWER_IS_BETTER.has(name) ? 'above' : 'below';
  const limit = formatMetric(name, failure.limit);
  return failure.kind === 'threshold'
    ? `${name} ${formatMetric(name, failure.mean)} is ${direction} the threshold ${limit}`
    : `${name} ${formatMetric(name, failure.mean)} regressed from the baseline ${formatMetric(name, failure.baseline)} (limit ${limit})`;
}

function tokens(n: number): string {
  return n.toLocaleString('en-AU');
}

/**
 * The Markdown summary written next to the JSON report and posted on the PR: verdict per suite,
 * metric means with spread and the baseline, the gate's failures, and the cost report. Ids and
 * numbers only; no prompt or output text.
 */
export function renderMarkdown(report: RunReport): string {
  const lines: string[] = [REPORT_MARKER, ''];
  const passed = runPassed(report);
  lines.push(
    `## Clerk evals: ${passed ? 'passed' : 'failed'}`,
    '',
    `${report.mode === 'subset' ? 'Subset' : 'Full'} run on \`${report.model}\` (${report.provider}), ${report.startedAt.slice(0, 16).replace('T', ' ')} UTC.`,
  );
  if (report.aborted)
    lines.push(
      '',
      `**Aborted:** the spend cap of $${report.budgetUsd.toFixed(2)} was reached, so some cases were skipped.`,
    );
  lines.push('', '| Suite | Prompt | Verdict | Scored runs | Cost |', '| --- | --- | --- | --- | --- |');
  for (const suite of report.suites) {
    const scored = suite.cases.filter((result) => result.status === 'scored').length;
    lines.push(
      `| ${suite.title} | \`${suite.promptKey || '–'}\` | ${STATUS[suite.status]} | ${suite.status === 'pending' ? '–' : `${scored}/${suite.cases.length}`} | ${usd(suite.costMicros)} |`,
    );
  }

  for (const suite of report.suites) {
    if (suite.status === 'pending') continue;
    lines.push('', `### ${suite.title}`, '');
    if (suite.reason) lines.push(`_${suite.reason}_`, '');
    const baselineNote = suite.baseline
      ? `Baseline: \`${suite.baseline.key}\` on \`${suite.baseline.model}\`, accepted ${suite.baseline.acceptedAt}.`
      : 'No baseline accepted yet: thresholds only.';
    lines.push(
      baselineNote,
      '',
      '| Metric | Mean | SD | Run-to-run SD | n | Baseline |',
      '| --- | --- | --- | --- | --- | --- |',
    );
    for (const [name, summary] of Object.entries(suite.metrics) as [
      MetricName,
      NonNullable<SuiteResult['metrics'][MetricName]>,
    ][]) {
      lines.push(
        `| ${name} | ${formatMetric(name, summary.mean)} | ${formatMetric(name === 'latencyMs' || name === 'costUsd' ? name : 'fieldAccuracy', Math.sqrt(summary.variance))} | ${summary.runVariance ? Math.sqrt(summary.runVariance).toFixed(3) : '–'} | ${summary.n} | ${formatMetric(name, suite.baseline?.metrics[name])} |`,
      );
    }
    if (suite.failures.length) {
      lines.push('', '**Gate failures:**', '');
      for (const failure of suite.failures) lines.push(`- ${describeFailure(failure)}`);
    }
    const low = suite.cases
      .filter((result) => result.status === 'scored')
      .flatMap((result) =>
        (['privilegeLeak', 'injectionResistance', 'outcomePredictionRefusal', 'schemaValid'] as const)
          .filter((name) => result.scores[name] === 0)
          .map((name) => `${result.caseId}#${result.run} ${name}`),
      );
    if (low.length) lines.push('', `Failing safety checks: ${low.join(', ')}`);
    const other = suite.cases.filter((result) => result.status !== 'scored');
    if (other.length)
      lines.push(
        '',
        `Not scored: ${other.map((result) => `${result.caseId}#${result.run} ${result.status} (${result.reason})`).join(', ')}`,
      );
  }

  const total = report.suites.reduce(
    (sum, suite) => ({
      input: sum.input + suite.usage.inputTokens,
      output: sum.output + suite.usage.outputTokens,
      cacheRead: sum.cacheRead + suite.usage.cacheReadTokens,
      cacheWrite: sum.cacheWrite + suite.usage.cacheWriteTokens,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
  lines.push(
    '',
    '### Cost',
    '',
    '| Suite | Input | Output | Cache read | Cache write | Cost |',
    '| --- | --- | --- | --- | --- | --- |',
    ...report.suites
      .filter((suite) => suite.status !== 'pending')
      .map(
        (suite) =>
          `| ${suite.suite} | ${tokens(suite.usage.inputTokens)} | ${tokens(suite.usage.outputTokens)} | ${tokens(suite.usage.cacheReadTokens)} | ${tokens(suite.usage.cacheWriteTokens)} | ${usd(suite.costMicros)} |`,
      ),
    `| **Total** | ${tokens(total.input)} | ${tokens(total.output)} | ${tokens(total.cacheRead)} | ${tokens(total.cacheWrite)} | **$${report.spentUsd.toFixed(4)}** of $${report.budgetUsd.toFixed(2)} |`,
    '',
    'Costs use the list prices in `libs/clerk/src/lib/prices.ts` (output includes thinking tokens).',
  );
  return `${lines.join('\n')}\n`;
}
