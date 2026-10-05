import type { FlagKey } from '@materia/domain';

/**
 * Every Clerk feature that calls the gateway, with its kill switch and timeout (AI-02). The
 * global `clerk.enabled` flag and the org's own setting apply to all of them as well.
 */
export const CLERK_FEATURES = {
  /** The connectivity check behind `clerk-hello` (the live smoke test, AI-01b). */
  hello: { flag: null, timeoutMs: 30_000 },
  chat: { flag: 'clerk.features.chat', timeoutMs: 120_000 },
  suggestions: { flag: 'clerk.features.suggestions', timeoutMs: 90_000 },
  classification: { flag: 'clerk.features.classification', timeoutMs: 60_000 },
  brief: { flag: 'clerk.features.brief', timeoutMs: 90_000 },
  willExtraction: { flag: 'clerk.features.willExtraction', timeoutMs: 300_000 },
  drafting: { flag: 'clerk.features.drafting', timeoutMs: 180_000 },
  timeAssist: { flag: 'clerk.features.timeAssist', timeoutMs: 60_000 },
  /** The citation judge in the eval harness (AI-12): never called by the app. */
  evalJudge: { flag: null, timeoutMs: 60_000 },
} as const satisfies Record<string, { flag: FlagKey | null; timeoutMs: number }>;

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

/** How often streamed text is written to the message document. */
export const STREAM_FLUSH_MS = 250;

/** Budgets and metering run by calendar month in the default org timezone. */
export const METERING_TIMEZONE = 'Australia/Melbourne';

/** `clerk-YYYY-MM` for an instant, in the metering timezone. */
export function meteringPeriod(at: Date, timeZone: string = METERING_TIMEZONE): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(at);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  return `clerk-${year}-${month}`;
}
