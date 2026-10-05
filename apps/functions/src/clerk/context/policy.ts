import type { ClerkFeature } from '../features';

/** A context scope: one matter, or the practice's aggregated metrics (no client data). */
export type ContextScopeKind = 'matter' | 'metrics';

export interface ContextPolicy {
  /**
   * Tokens the whole context may take: the base system prompt, the matter facts, documents,
   * excerpts and the query. Material is dropped, lowest-ranked first, to fit (ADR-034).
   */
  budgetTokens: number;
  /** The scopes the feature may ask for. Only an explicit feature reaches across matters (metrics). */
  scopes: readonly ContextScopeKind[];
}

/**
 * Per-feature context budgets and scopes (AI-03). Budgets follow ADR-011a's planning volumes (chat
 * about 30k input tokens a call) with headroom; will extraction reads a whole will. No feature reads
 * metrics yet: the Insights narrative (INS-04) adds one with `scopes: ['metrics']`.
 */
export const CONTEXT_POLICIES = {
  hello: { budgetTokens: 8_000, scopes: ['matter'] },
  chat: { budgetTokens: 40_000, scopes: ['matter'] },
  suggestions: { budgetTokens: 24_000, scopes: ['matter'] },
  classification: { budgetTokens: 16_000, scopes: ['matter'] },
  brief: { budgetTokens: 24_000, scopes: ['matter'] },
  willExtraction: { budgetTokens: 120_000, scopes: ['matter'] },
  drafting: { budgetTokens: 40_000, scopes: ['matter'] },
  timeAssist: { budgetTokens: 12_000, scopes: ['matter'] },
  /** The eval harness's citation judge (AI-12): sent only test items, never a matter's context. */
  evalJudge: { budgetTokens: 16_000, scopes: ['matter'] },
} as const satisfies Record<ClerkFeature, ContextPolicy>;

/** Limits on the matter facts block (compact JSON). */
export const FACT_LIMITS = {
  /** Open tasks, soonest due first. */
  tasks: 30,
  /** Upcoming and blocked deadlines, soonest first. */
  deadlines: 20,
  /** Events (key dates), newest first. */
  events: 40,
  parties: 60,
  /** Recent notes, newest first. */
  notes: 10,
  /** A longer note is cut here, with a marker. */
  noteChars: 2_000,
  /** Practice rollups in the metrics scope. */
  metrics: 24,
} as const;

/** Retrieval: the excerpts kept after de-duplication by (document, page). */
export const RETRIEVAL_TOP_K = 12;
/** Asked of the chunk search, so about RETRIEVAL_TOP_K remain after de-duplication (AI-04 clamps to 50). */
export const RETRIEVAL_FETCH_K = 24;
/** Attachments per request: more is a dump, not a question. */
export const MAX_ATTACHMENTS = 10;
