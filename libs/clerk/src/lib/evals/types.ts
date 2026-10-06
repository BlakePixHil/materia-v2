import type { ClerkUsage } from '../prices';
import type { MetricName } from './dataset';
import type { CitedQuote, TextSpan } from './graders';

/** What one case produced, as the executor (the gateway in Functions, or a fake) reports it. */
export interface CaseOutcome {
  /** The gateway status: done, refused, truncated, invalid_output, … */
  status: string;
  stopReason: string;
  model: string;
  text: string;
  parsed?: unknown;
  /** Quotes the output relies on (API citations, or `quote` fields of structured output). */
  citations: CitedQuote[];
  /** The answer split into cited and uncited runs (free-text answers with API citations). */
  spans: TextSpan[];
  usage: ClerkUsage;
  costMicros: number;
  latencyMs: number;
  /** citationSupport from the LLM judge, when it ran: supported citations / judged citations. */
  judge?: { supported: number; judged: number; costMicros: number };
}

/**
 * A provider failure that survived the gateway's own retries (overloaded, unavailable, busy,
 * timed out). The runner retries the case, then marks it inconclusive: an outage is not a regression.
 */
export class EvalOutageError extends Error {
  constructor(readonly code: string) {
    super(`Provider outage (${code})`);
    this.name = 'EvalOutageError';
  }
}

export type CaseStatus = 'scored' | 'errored' | 'inconclusive' | 'skipped';

export interface CaseResult {
  caseId: string;
  run: number;
  promptRef: string;
  status: CaseStatus;
  /** Why a case is errored, inconclusive or skipped: a code, never content. */
  reason?: string;
  outputStatus?: string;
  stopReason?: string;
  model?: string;
  scores: Partial<Record<MetricName, number>>;
  fields?: Record<string, number>;
  /** Top-level output keys where an injection's forbidden marker appeared: keys, never content. */
  leaks?: string[];
  usage?: ClerkUsage;
  costMicros: number;
  latencyMs?: number;
}

export interface MetricSummary {
  mean: number;
  /** Population variance across all scored runs of all cases. */
  variance: number;
  /** Mean of the per-case variance between repeat runs (0 with one run): the non-determinism. */
  runVariance: number;
  n: number;
}

export interface GateFailure {
  metric: MetricName | 'errors';
  kind: 'threshold' | 'regression' | 'errors';
  mean?: number;
  limit?: number;
  baseline?: number;
  /** errored case ids, for kind "errors". */
  cases?: string[];
}

export type SuiteStatus = 'passed' | 'failed' | 'inconclusive' | 'pending';

export interface SuiteResult {
  suite: string;
  title: string;
  ticket: string;
  /** The prompt refs under test, sorted and joined with "+" (the baseline key). */
  promptKey: string;
  status: SuiteStatus;
  reason?: string;
  metrics: Partial<Record<MetricName, MetricSummary>>;
  baseline?: { key: string; model: string; acceptedAt: string; metrics: Partial<Record<MetricName, number>> };
  failures: GateFailure[];
  cases: CaseResult[];
  usage: ClerkUsage;
  costMicros: number;
}

export interface RunReport {
  runId: string;
  startedAt: string;
  finishedAt: string;
  mode: 'subset' | 'full';
  provider: string;
  model: string;
  budgetUsd: number;
  spentUsd: number;
  /** The budget ran out and cases were skipped: the run as a whole fails. */
  aborted: boolean;
  suites: SuiteResult[];
}
