import { CLERK_MODEL_CHOICES, DEFAULT_CLERK_MODEL, type ClerkModelChoice } from '@materia/domain';

/**
 * The Claude models behind ClerkGateway (ADR-011b, superseding ADR-011a's single model). Each org
 * picks one of `choices` (`settings.clerk.model`); Sonnet 5.5 is the default. Functions only.
 */
export const CLERK_MODELS = {
  choices: CLERK_MODEL_CHOICES,
  default: DEFAULT_CLERK_MODEL,
} as const;

/**
 * Availability fallbacks per primary, in order: after the retries on an overloaded or failing
 * primary, the gateway tries these. Each hop starts a fresh conversation branch, because thinking
 * blocks are bound to the model that produced them.
 */
export const CLERK_FALLBACKS: Record<ClerkModelChoice, readonly string[]> = {
  'claude-sonnet-5-5': ['claude-sonnet-5'],
  'claude-opus-5-5': ['claude-opus-5', 'claude-sonnet-5-5'],
};

/** The org's stored choice, or the default for anything unset or unknown. */
export function clerkModelFor(stored: unknown): ClerkModelChoice {
  return (CLERK_MODELS.choices as readonly unknown[]).includes(stored)
    ? (stored as ClerkModelChoice)
    : CLERK_MODELS.default;
}
