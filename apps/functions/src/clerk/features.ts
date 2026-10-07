import type { FlagKey, OrgClerkFeature } from '@materia/domain';

/**
 * Every Clerk feature that calls the gateway, with its kill switch and timeout (AI-02). The
 * global `clerk.enabled` flag and the org's own setting apply to all of them as well. `orgFeature`
 * is the toggle in Settings → Clerk and AI that turns it off for one org (AI-13). Every feature
 * that sends the firm's data needs the org's acknowledgement of the data-use disclosure; the
 * connectivity check and the eval judge (fixtures only) don't (`noClientData`).
 */
export const CLERK_FEATURES = {
  /** The connectivity check behind `clerk-hello` (the live smoke test, AI-01b). */
  hello: { flag: null, timeoutMs: 30_000, noClientData: true },
  chat: { flag: 'clerk.features.chat', timeoutMs: 120_000, orgFeature: 'chat' },
  // The chat panel's follow-on calls (AI-06): the proposals step after an answer, and the summary
  // that seeds a continued thread. The question that led to them already took a slot in the
  // person's request window, so they don't take another; the monthly budget still applies. The
  // org's one "Ask Clerk" switch covers the whole panel (AI-13).
  chatProposals: { flag: 'clerk.features.suggestions', timeoutMs: 60_000, background: true, orgFeature: 'chat' },
  chatSummary: { flag: 'clerk.features.chat', timeoutMs: 60_000, background: true, orgFeature: 'chat' },
  suggestions: { flag: 'clerk.features.suggestions', timeoutMs: 90_000, orgFeature: 'suggestions' },
  // Background features (AI-04 ingestion) run without a person waiting, so the per-user request
  // window doesn't apply; the org's daily OCR page budget and the monthly token budget do.
  classification: {
    flag: 'clerk.features.classification',
    timeoutMs: 60_000,
    background: true,
    orgFeature: 'classification',
  },
  ocr: { flag: null, timeoutMs: 120_000, background: true },
  brief: { flag: 'clerk.features.brief', timeoutMs: 90_000, orgFeature: 'brief' },
  /**
   * The brief on a matter's Overview (AI-06c): written when the matter is opened and its brief is
   * stale, without the person asking, so it takes no slot in their request window; the org's
   * daily cap on matter briefs and the monthly budget apply.
   */
  matterBrief: {
    flag: 'clerk.features.matterBrief',
    timeoutMs: 60_000,
    background: true,
    orgFeature: 'matterBrief',
  },
  willExtraction: { flag: 'clerk.features.willExtraction', timeoutMs: 300_000, orgFeature: 'willExtract' },
  drafting: { flag: 'clerk.features.drafting', timeoutMs: 180_000, orgFeature: 'drafting' },
  // Rewriting a passage of a draft (AI-10): a person waits on it, so it has a shorter timeout.
  draftingRewrite: { flag: 'clerk.features.drafting', timeoutMs: 90_000, orgFeature: 'drafting' },
  timeAssist: { flag: 'clerk.features.timeAssist', timeoutMs: 60_000, orgFeature: 'timeAssist' },
  /**
   * Key dates from a migrated estate matter's file (MIG-09): `event` suggestions, run in the
   * background after the owner approves the migration's enrichment. The org's Suggestions switch
   * covers it.
   */
  eventsExtraction: {
    flag: 'clerk.features.suggestions',
    timeoutMs: 120_000,
    background: true,
    orgFeature: 'suggestions',
  },
  /** Explain on Insights (INS-04): the practice's figures only, never a matter. */
  insightsNarrative: {
    flag: 'clerk.features.insightsNarrative',
    timeoutMs: 90_000,
    orgFeature: 'insightsNarrative',
  },
  /** The citation judge in the eval harness (AI-12): never called by the app. */
  evalJudge: { flag: null, timeoutMs: 60_000, noClientData: true },
} as const satisfies Record<
  string,
  {
    flag: FlagKey | null;
    timeoutMs: number;
    background?: boolean;
    orgFeature?: OrgClerkFeature;
    noClientData?: boolean;
  }
>;

export type ClerkFeature = keyof typeof CLERK_FEATURES;

/** Per-user request window when the org sets none (Clerk doc: 30 requests per 10 minutes). */
export const DEFAULT_USER_RATE_LIMIT = { requests: 30, windowMinutes: 10 } as const;

/**
 * Monthly token budget (all token kinds) when the org sets none. ADR-011a's planning volumes for a
 * 10-lawyer firm come to roughly 100M tokens a month, most of them cache reads; this is 2x that.
 */
export const DEFAULT_MONTHLY_TOKEN_BUDGET = 200_000_000;

/** Retries of the primary model on 429, 529, 5xx and timeouts, before falling back. */
export const MAX_RETRIES = 2;

/** Tool rounds per answer (AI-06): then the model answers with what it has. */
export const MAX_TOOL_ROUNDS = 6;

/** How often streamed text is written to the message document. */
export const STREAM_FLUSH_MS = 250;

/** Budgets and metering run by calendar month in the default org timezone. */
export const METERING_TIMEZONE = 'Australia/Melbourne';

/** `YYYY-MM-DD` for an instant in the metering timezone: the day a per-user daily limit counts. */
export function meteringDay(at: Date, timeZone: string = METERING_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** `clerk-YYYY-MM` for an instant, in the metering timezone. */
export function meteringPeriod(at: Date, timeZone: string = METERING_TIMEZONE): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(at);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  return `clerk-${year}-${month}`;
}
