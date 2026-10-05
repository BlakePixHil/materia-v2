import * as z from 'zod';

/**
 * Clerk bring-your-own-key (AI-02a, ADR-011b): the models an org can choose, the shape of an
 * Anthropic API key, and the callable inputs shared by functions and the web app. The key itself
 * never reaches a client after it is saved.
 */

/** The models an org can run Clerk on. Sonnet 5.5 is the default; Opus 5.5 is an opt-in. */
export const CLERK_MODEL_CHOICES = ['claude-sonnet-5-5', 'claude-opus-5-5'] as const;
export const ClerkModelChoiceSchema = z.enum(CLERK_MODEL_CHOICES);
export type ClerkModelChoice = z.infer<typeof ClerkModelChoiceSchema>;
export const DEFAULT_CLERK_MODEL: ClerkModelChoice = 'claude-sonnet-5-5';

/** An Anthropic API key: `sk-ant-` then letters, digits, `-` and `_`. */
export const ANTHROPIC_KEY_PATTERN = /^sk-ant-[A-Za-z0-9_-]{20,250}$/;

/** A pasted key without spaces or line breaks (copying from a console often adds them). */
export function normaliseAnthropicKey(raw: string): string {
  return raw.replace(/\s+/g, '');
}

/** Whether a (normalised) value looks like an Anthropic API key, before any API call. */
export function looksLikeAnthropicKey(value: string): boolean {
  return ANTHROPIC_KEY_PATTERN.test(value);
}

/** The last four characters, the only part of a key that is ever stored in clear or shown. */
export function keyLast4(key: string): string {
  return key.slice(-4);
}

export const SetClerkApiKeyInput = z.object({
  requestId: z.uuid(),
  apiKey: z
    .string()
    .max(400)
    .transform(normaliseAnthropicKey)
    .refine(looksLikeAnthropicKey, 'This doesn’t look like an Anthropic API key (it starts with sk-ant-)'),
});

export const RemoveClerkApiKeyInput = z.object({ requestId: z.uuid() });

export const SetClerkModelInput = z.object({ requestId: z.uuid(), model: ClerkModelChoiceSchema });

/** The state of the org's key, as owners and admins see it (`clerk-getApiKeyStatus`). */
export interface ClerkKeyStatus {
  set: boolean;
  /** `valid` until Anthropic rejects the stored key; then an admin must replace it. */
  status?: 'valid' | 'invalid';
  last4?: string;
  /** ISO instants. */
  setAt?: string;
  validatedAt?: string;
  /** Whether the key could see Opus 5.5 when it was saved. */
  opusAvailable?: boolean;
  model: ClerkModelChoice;
}

/** What `clerk-setApiKey` returns: never the key or its ciphertext. */
export interface SetClerkApiKeyResult {
  last4: string;
  validatedAt: string;
  opusAvailable: boolean;
  /** Set when the key can't use Opus 5.5 and the org was moved back to Sonnet 5.5. */
  modelReset?: boolean;
}
