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
  /** What the chat drafting tools (AI-06b) were asked to draft, as text ("title · due · details" for a task). */
  drafts?: DraftedItem[];
  /**
   * The key dates production would offer a person (MIG-09): the model's events after the caller's
   * checks (a quote found in its source that states the date, not already recorded, one per kind).
   */
  proposedEvents?: ProposedEvent[];
  /** citationSupport from the LLM judge, when it ran: supported citations / judged citations. */
  judge?: { supported: number; judged: number; costMicros: number };
}

/** One key date offered as a suggestion (MIG-09). */
export interface ProposedEvent {
  kind: string;
  date: string;
  label?: string;
}

/** One draft a chat answer made (AI-06b). */
export interface DraftedItem {
  kind: 'note' | 'task';
  text: string;
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
  /** Why a citation or refusal score fell short: `citation:<documentId>:p<page>`, `refusal:no-decline|predicts|no-referral`, `invention:<forbidden string>`, `draft:claims-saved|no-confirm`, `event:extra|missing|dropped:<kind>:<date>`. */
  misses?: string[];
  /**
   * The start of a reply that failed the refusal or draft-honesty check, or the text around a
   * forbidden string (cases without privileged canaries only).
   */
  excerpt?: string;
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
