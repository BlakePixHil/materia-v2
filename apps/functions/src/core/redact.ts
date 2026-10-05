/**
 * Removes personal information before anything is logged (ADR-018, Security doc: logging). Keys
 * that can hold names, contact details or free text are replaced; ids and enums stay.
 */
export const REDACTED_KEYS = [
  'name',
  'firstname',
  'lastname',
  'givennames',
  'familyname',
  'preferredname',
  'displayname',
  'email',
  'emails',
  'phone',
  'phones',
  'address',
  'addresses',
  'text',
  'content',
  'body',
  'bodymd',
  'narrative',
  'notes',
  'note',
  'quote',
  'title',
  'description',
  'descriptionmd',
  'message',
  'prompt',
  'summary',
  'dateofbirth',
  'password',
  'token',
  'secret',
  // Clerk BYOK (AI-02a): the org's Anthropic key and its ciphertext.
  'apikey',
  'encryptedapikey',
] as const;

const REDACTED = new Set<string>(REDACTED_KEYS);
const MAX_DEPTH = 6;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[depth]';
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, v]) => [
        key,
        REDACTED.has(key.toLowerCase()) ? '[redacted]' : redact(v, depth + 1),
      ]),
    );
  }
  return value;
}
