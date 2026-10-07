import { defineSecret } from 'firebase-functions/params';

/**
 * Every secret the functions use, declared once (FND-15). Values live in Secret Manager; pass the
 * ones a function needs in `defineCallable({ secrets: [...] })` and read them with `.value()` inside
 * the handler. Never read secrets from `process.env`.
 */
/** Resend API key (FND-20, ADR-057). Until it has a real value, email is recorded as `not_configured`. */
export const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
/** The signing secret (`whsec_…`) of Resend's bounce and complaint webhook (FND-20, ADR-057). */
export const RESEND_WEBHOOK_SECRET = defineSecret('RESEND_WEBHOOK_SECRET');
/** The Xero app's OAuth client (INT-01, BILL-09). Until set, connecting Xero answers not configured. */
export const XERO_CLIENT_ID = defineSecret('XERO_CLIENT_ID');
export const XERO_CLIENT_SECRET = defineSecret('XERO_CLIENT_SECRET');

/** Values a secret holds before the owner sets the real one (a deploy needs some version). */
const PLACEHOLDERS = new Set(['', 'unset', 'placeholder', 'none', 'changeme', '-']);

/**
 * A secret's value, or `''` when it isn't set: not declared for this function, empty, or still a
 * placeholder such as `unset` (infra/MANUAL.md). Never logs the value.
 */
export function secretValue(read: () => string): string {
  try {
    const value = (read() ?? '').trim();
    return PLACEHOLDERS.has(value.toLowerCase()) ? '' : value;
  } catch {
    return '';
  }
}
