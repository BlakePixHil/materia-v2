import { existsSync } from 'node:fs';
import path from 'node:path';

import { ZERO_USAGE, type ClerkUsage } from '../prices';
import {
  readTextFixture,
  type Baselines,
  type EvalCase,
  type EvalsConfig,
  type Gold,
  type MetricName,
  type Suite,
  type SuiteConfig,
} from './dataset';
import { baselineFor, gateFailures, summarise, verdict } from './gate';
import {
  citationCoverage,
  citationPrecision,
  draftAccuracy,
  draftHonesty,
  draftHonestyMisses,
  fieldAccuracy,
  injectionFlagged,
  injectionResistance,
  inventionsFound,
  noInventions,
  numberAccuracy,
  outcomePredictionRefusal,
  outputText,
  placeholderHonesty,
  privilegeLeak,
  quoteOnPage,
  refusalMisses,
  schemaValid,
  type CitedQuote,
  type SourcePages,
} from './graders';
import { insightsCase } from './insights';
import { EvalOutageError, type CaseOutcome, type CaseResult, type RunReport, type SuiteResult } from './types';

/** One case to execute: the executor turns it into a gateway call (or a fake one). */
export interface CaseRequest {
  suite: SuiteConfig;
  evalCase: EvalCase;
  promptRef: string;
  feature: SuiteConfig['feature'];
  run: number;
}

export type CaseExecutor = (request: CaseRequest) => Promise<CaseOutcome>;

export interface RunOptions {
  suites: Suite[];
  mode: 'subset' | 'full';
  /** Overrides the suites' runs per case. */
  runs?: number;
  config: EvalsConfig;
  baselines: Baselines;
  execute: CaseExecutor;
  /** Whether a prompt version is in the registry; suites whose prompts aren't are reported pending. */
  isRegistered: (promptRef: string) => boolean;
  provider: string;
  model: string;
  root: string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Progress, one line per case (ids and statuses only). */
  onProgress?: (line: string) => void;
}

/** A fixture's text by page. A PDF's pages come from the `.txt` it was generated from (make-fixtures). */
export function fixturePages(root: string, fixture: string): string[] {
  const source = fixture.endsWith('.pdf') ? fixture.replace(/(\.typed|\.scanned)?\.pdf$/, '.txt') : fixture;
  if (!existsSync(path.join(root, 'fixtures', source))) return [];
  return readTextFixture(root, source).pages;
}

export function sourcePages(root: string, evalCase: EvalCase): SourcePages {
  return new Map(evalCase.documents.map((doc) => [doc.id, fixturePages(root, doc.fixture)]));
}

/**
 * Quotes in structured output: every object with a string `quote` (and optionally `page` and
 * `documentId`), at any depth. Without a `documentId`, the case's only document is assumed.
 */
export function parsedQuotes(parsed: unknown, defaultDocumentId: string | undefined): CitedQuote[] {
  const out: CitedQuote[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (value === null || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const documentId = typeof record['documentId'] === 'string' ? record['documentId'] : defaultDocumentId;
    if (typeof record['quote'] === 'string' && record['quote'].trim() && documentId)
      out.push({
        documentId,
        quote: record['quote'],
        ...(typeof record['page'] === 'number' ? { page: record['page'] } : {}),
      });
    Object.values(record).forEach(visit);
  };
  visit(parsed);
  return out;
}

/** Every applicable grader for one case. Not-applicable graders are left out. */
export function scoreCase(
  suite: SuiteConfig,
  evalCase: EvalCase,
  gold: Gold,
  outcome: CaseOutcome,
  sources: SourcePages,
): {
  scores: Partial<Record<MetricName, number>>;
  fields?: Record<string, number>;
  leaks?: string[];
  misses?: string[];
  excerpt?: string;
} {
  // What the answer drafted (AI-06b) is output too: a draft can leak or obey an injection.
  const drafted = (outcome.drafts ?? []).map((draft) => draft.text).join('\n');
  const output = [outputText(outcome.text, outcome.parsed), drafted].join('\n');
  // An injection the model reported (structured `suspiciousInstructions`) quotes the injected text;
  // only the rest of the output shows whether it obeyed. A structured reply's text is that same JSON,
  // so it is left out too.
  const record =
    outcome.parsed && typeof outcome.parsed === 'object' && !Array.isArray(outcome.parsed)
      ? (outcome.parsed as Record<string, unknown>)
      : undefined;
  const { suspiciousInstructions: flags, ...answer } = record ?? { suspiciousInstructions: undefined };
  const obeyed = [
    outcome.parsed === undefined ? outputText(outcome.text) : outputText(undefined, answer),
    drafted,
  ].join('\n');
  // Only the fields that act (names, shares, dates) can obey an injection; the report fields only describe it.
  const acting = record ? Object.entries(record).filter(([key]) => !suite.reportFields.includes(key)) : undefined;
  const forbidden = gold.injection?.forbidden;
  const leaks = acting?.filter(([, value]) => injectionResistance(outputText(undefined, value), forbidden) === 0);
  const quotes =
    suite.citations === 'parsed'
      ? parsedQuotes(outcome.parsed, evalCase.documents.length === 1 ? evalCase.documents[0]?.id : undefined)
      : suite.citations === 'api'
        ? outcome.citations
        : [];
  const structured = suite.citations === 'parsed' || gold.fields !== undefined;
  const accuracy = fieldAccuracy(outcome.parsed, gold.fields, suite.fields);
  const insights = insightsCase(evalCase);
  const all: Partial<Record<MetricName, number | null>> = {
    schemaValid: structured ? schemaValid(outcome.status, outcome.parsed) : null,
    fieldAccuracy: accuracy.score,
    citationPrecision: citationPrecision(quotes, sources),
    citationSupport: outcome.judge && outcome.judge.judged ? outcome.judge.supported / outcome.judge.judged : null,
    citationCoverage: suite.citations === 'api' ? citationCoverage(outcome.spans, gold.expectCitations) : null,
    privilegeLeak: privilegeLeak(output, gold.canaries),
    injectionResistance: injectionResistance(
      acting ? outputText(undefined, Object.fromEntries(acting)) : obeyed,
      forbidden,
    ),
    injectionFlagged: injectionFlagged(output, gold.injection !== undefined, flags),
    outcomePredictionRefusal: outcomePredictionRefusal(output, outcome.stopReason, gold.expectRefusal, gold.referTo),
    placeholderHonesty: placeholderHonesty(outcome.text, gold.placeholders),
    noInventions: noInventions(obeyed, gold.mustNotContain),
    draftAccuracy: draftAccuracy(outcome.drafts, gold.drafts),
    draftHonesty: draftHonesty(outcome.text, outcome.drafts),
    numberAccuracy: insights ? numberAccuracy(outcome.parsed, insights.figures, insights.labels) : null,
    latencyMs: outcome.latencyMs,
    costUsd: (outcome.costMicros + (outcome.judge?.costMicros ?? 0)) / 1_000_000,
  };
  const scores = Object.fromEntries(
    Object.entries(all).filter((entry): entry is [string, number] => entry[1] !== null),
  ) as Partial<Record<MetricName, number>>;
  const inventions = scores.noInventions === 0 ? inventionsFound(obeyed, gold.mustNotContain) : [];
  // Why a citation, refusal or invention score fell short, so a failing run can be read from the log.
  const misses = [
    ...quotes
      .filter((quote) => !quoteOnPage(quote, sources))
      .map((quote) => `citation:${quote.documentId}:p${quote.page ?? '-'}`),
    ...(scores.outcomePredictionRefusal === 0
      ? refusalMisses(output, gold.referTo).map((code) => `refusal:${code}`)
      : []),
    ...inventions.map(({ item }) => `invention:${item}`),
    ...(scores.draftHonesty === 0 ? draftHonestyMisses(outcome.text).map((code) => `draft:${code}`) : []),
  ];
  return {
    scores,
    ...(Object.keys(accuracy.fields).length ? { fields: accuracy.fields } : {}),
    ...(leaks?.length ? { leaks: leaks.map(([key]) => key) } : {}),
    ...(misses.length ? { misses } : {}),
    // Only for cases with no privileged canaries; fixtures are fictional.
    ...(gold.canaries?.length ? {} : excerptOf(scores, output, outcome.text, inventions)),
  };
}

/**
 * The text behind a failed refusal, invention or draft-honesty check, so a grader miss can be told
 * from a real failure in the log: the start of the reply, or the text around a forbidden string.
 */
function excerptOf(
  scores: Partial<Record<MetricName, number>>,
  output: string,
  text: string,
  inventions: readonly { context: string }[],
): { excerpt?: string } {
  const start = (value: string) => value.replace(/\s+/g, ' ').trim().slice(0, 400);
  if (scores.outcomePredictionRefusal === 0) return { excerpt: start(output) };
  if (inventions[0]) return { excerpt: inventions[0].context };
  if (scores.draftHonesty === 0) return { excerpt: start(text) };
  return {};
}

function addUsage(a: ClerkUsage, b: ClerkUsage | undefined): ClerkUsage {
  if (!b) return a;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

/** Runs `tasks` with at most `limit` in flight. */
async function pool<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await worker(item);
    }
  });
  await Promise.all(lanes);
}

function promptRefFor(suite: SuiteConfig, evalCase: EvalCase): string {
  return evalCase.promptId ?? suite.promptId;
}

/**
 * Runs the suites (AI-12): up to `config.concurrency` cases at once, each case `runs` times,
 * provider outages retried and then marked inconclusive, and a spend cap that stops new cases
 * once reached (the report is then `aborted`). Returns the report; writing it is the caller's job.
 */
export async function runEvals(options: RunOptions): Promise<RunReport> {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const startedAt = now();
  const budgetUsd = options.config.budgetUsd[options.mode];
  const budgetMicros = Math.round(budgetUsd * 1_000_000);
  let spentMicros = 0;
  let aborted = false;

  interface Task {
    suite: Suite;
    evalCase: EvalCase;
    run: number;
    results: CaseResult[];
  }
  const suiteResults: SuiteResult[] = [];
  const tasks: Task[] = [];
  const resultsBySuite = new Map<string, CaseResult[]>();

  for (const suite of options.suites) {
    const { config } = suite;
    const chosen = options.mode === 'subset' ? suite.cases.filter((c) => config.subset.includes(c.id)) : suite.cases;
    const refs = [...new Set(chosen.map((c) => promptRefFor(config, c)))].sort();
    const missing = refs.filter((ref) => !options.isRegistered(ref));
    const promptKey = refs.join('+');
    if (missing.length) {
      suiteResults.push({
        suite: config.suite,
        title: config.title,
        ticket: config.ticket,
        promptKey,
        status: 'pending',
        reason: `prompt not registered yet: ${missing.join(', ')} (${config.ticket} adds it)`,
        metrics: {},
        failures: [],
        cases: [],
        usage: ZERO_USAGE,
        costMicros: 0,
      });
      continue;
    }
    const results: CaseResult[] = [];
    resultsBySuite.set(config.suite, results);
    const runs = options.runs ?? config.runs[options.mode];
    for (const evalCase of chosen) for (let run = 1; run <= runs; run++) tasks.push({ suite, evalCase, run, results });
  }

  await pool(tasks, options.config.concurrency, async ({ suite, evalCase, run, results }) => {
    const { config } = suite;
    const promptRef = promptRefFor(config, evalCase);
    const base = { caseId: evalCase.id, run, promptRef, scores: {}, costMicros: 0 };
    if (spentMicros >= budgetMicros) {
      aborted = true;
      results.push({ ...base, status: 'skipped', reason: 'budget' });
      options.onProgress?.(`${config.suite}/${evalCase.id}#${run} skipped (budget)`);
      return;
    }
    const gold = suite.gold.get(evalCase.id) as Gold;
    for (let attempt = 1; ; attempt++) {
      try {
        const outcome = await options.execute({
          suite: config,
          evalCase,
          promptRef,
          feature: evalCase.feature ?? config.feature,
          run,
        });
        const cost = outcome.costMicros + (outcome.judge?.costMicros ?? 0);
        spentMicros += cost;
        const scored = scoreCase(config, evalCase, gold, outcome, sourcePages(options.root, evalCase));
        results.push({
          ...base,
          status: 'scored',
          outputStatus: outcome.status,
          stopReason: outcome.stopReason,
          model: outcome.model,
          ...scored,
          usage: outcome.usage,
          costMicros: cost,
          latencyMs: outcome.latencyMs,
        });
        options.onProgress?.(`${config.suite}/${evalCase.id}#${run} ${outcome.status}`);
        return;
      } catch (error) {
        if (error instanceof EvalOutageError && attempt < options.config.attempts) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        const outage = error instanceof EvalOutageError;
        const reason = outage
          ? error.code
          : error instanceof Error && 'code' in error && typeof error.code === 'string'
            ? error.code
            : error instanceof Error
              ? error.name
              : 'error';
        results.push({ ...base, status: outage ? 'inconclusive' : 'errored', reason });
        options.onProgress?.(
          `${config.suite}/${evalCase.id}#${run} ${outage ? 'inconclusive' : 'errored'} (${reason})`,
        );
        return;
      }
    }
  });

  for (const suite of options.suites) {
    const results = resultsBySuite.get(suite.config.suite);
    if (!results) continue;
    results.sort((a, b) => a.caseId.localeCompare(b.caseId) || a.run - b.run);
    const promptKey = [...new Set(results.map((result) => result.promptRef))].sort().join('+');
    const metrics = summarise(results);
    const baseline = baselineFor(options.baselines, suite.config.suite, promptKey);
    const judged = verdict(results, gateFailures(suite.config, metrics, baseline));
    suiteResults.push({
      suite: suite.config.suite,
      title: suite.config.title,
      ticket: suite.config.ticket,
      promptKey,
      status: judged.status,
      ...(judged.reason ? { reason: judged.reason } : {}),
      metrics,
      ...(baseline ? { baseline } : {}),
      failures: judged.failures,
      cases: results,
      usage: results.reduce<ClerkUsage>((sum, result) => addUsage(sum, result.usage), ZERO_USAGE),
      costMicros: results.reduce((sum, result) => sum + result.costMicros, 0),
    });
  }
  suiteResults.sort((a, b) => a.suite.localeCompare(b.suite));

  const finishedAt = now();
  return {
    runId: startedAt.toISOString().replace(/[:.]/g, '-'),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    mode: options.mode,
    provider: options.provider,
    model: options.model,
    budgetUsd,
    spentUsd: spentMicros / 1_000_000,
    aborted,
    suites: suiteResults,
  };
}

/** The run passes when no suite failed and the budget held. Pending and inconclusive suites don't fail it. */
export function runPassed(report: RunReport): boolean {
  return !report.aborted && report.suites.every((suite) => suite.status !== 'failed');
}

/**
 * The baselines file after accepting a run: each passed suite's means, keyed by its prompt
 * versions. Only an explicit "accept baseline" commit writes this (`--accept-baseline`).
 */
export function acceptBaselines(baselines: Baselines, report: RunReport, source: string): Baselines {
  const next: Baselines = structuredClone(baselines);
  for (const suite of report.suites) {
    if (suite.status !== 'passed') continue;
    const metrics = Object.fromEntries(
      Object.entries(suite.metrics).map(([name, summary]) => [name, Number(summary.mean.toFixed(4))]),
    );
    next[suite.suite] = {
      ...next[suite.suite],
      [suite.promptKey]: { model: report.model, acceptedAt: report.startedAt.slice(0, 10), source, metrics },
    };
  }
  return next;
}
