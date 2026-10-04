import { CLERK_MODEL } from './model';

/** Token counts for one call (the API's `usage`; output includes thinking tokens). */
export interface ClerkUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** US dollars per million tokens, as integer micro-dollars (1 USD = 1,000,000). */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * List prices (Clerk doc; ADR-011a cost model). Only models with a confirmed price are listed: a
 * call on any other model (a fallback hop) is costed at the primary model's price and flagged
 * `estimated`, so spend reports never present a guess as exact. Add a row when a price is confirmed.
 */
export const CLERK_PRICES: Record<string, ModelPrice> = {
  // $4 input, $20 output, $0.20 cache read; cache writes (5-minute TTL) at 1.25x input.
  [CLERK_MODEL]: { input: 4_000_000, output: 20_000_000, cacheRead: 200_000, cacheWrite: 5_000_000 },
};

export const ZERO_USAGE: ClerkUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** The cost of a call in micro-dollars, rounded to a whole micro-dollar. */
export function costMicros(model: string, usage: ClerkUsage): { micros: number; estimated: boolean } {
  const known = CLERK_PRICES[model];
  const price = known ?? (CLERK_PRICES[CLERK_MODEL] as ModelPrice);
  const total =
    usage.inputTokens * price.input +
    usage.outputTokens * price.output +
    usage.cacheReadTokens * price.cacheRead +
    usage.cacheWriteTokens * price.cacheWrite;
  return { micros: Math.round(total / 1_000_000), estimated: !known };
}

/** All tokens a call consumed (what the monthly budget counts). */
export function totalTokens(usage: ClerkUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}
