/** The Claude model behind ClerkGateway (ADR-011, ADR-011a). Functions only. */
export const CLERK_MODEL = 'claude-opus-5-5';

/**
 * Availability fallbacks, in order (ADR-011a "Fallback strategy"): after the SDK's retries on an
 * overloaded or failing primary, the gateway tries these. Each hop starts a fresh conversation
 * branch, because thinking blocks are bound to the model that produced them.
 */
export const CLERK_FALLBACK_MODELS = ['claude-opus-5', 'claude-sonnet-5-5'] as const;
