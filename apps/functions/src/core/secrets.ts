import { defineSecret } from 'firebase-functions/params';

/**
 * Every secret the functions use, declared once (FND-15). Values live in Secret Manager; pass the
 * ones a function needs in `defineCallable({ secrets: [...] })` and read them with `.value()` inside
 * the handler. Never read secrets from `process.env`.
 */
export const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY'); // AI-01b (MAT-120)
