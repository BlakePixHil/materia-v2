/**
 * Search tokens for Firestore `array-contains` search (CORE-01, shared with CORE-15): lower-case,
 * diacritics stripped, apostrophes dropped ("O'Brien" → "obrien"), then every prefix of length
 * 2–10 of each word. At most 50 tokens, earlier text first.
 */
export const SEARCH_TOKEN_MIN = 2;
export const SEARCH_TOKEN_MAX = 10;
export const SEARCH_TOKENS_LIMIT = 50;

/** Lower-case, diacritics stripped, apostrophes dropped, everything else not a letter or digit a space. */
export function normaliseText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The words of a text, normalised. */
export function searchWords(text: string | null | undefined): string[] {
  if (!text) return [];
  const normalised = normaliseText(text);
  return normalised ? normalised.split(' ') : [];
}

export function searchTokens(...texts: (string | null | undefined)[]): string[] {
  const tokens = new Set<string>();
  for (const text of texts) {
    for (const word of searchWords(text)) {
      for (let length = SEARCH_TOKEN_MIN; length <= Math.min(word.length, SEARCH_TOKEN_MAX); length++) {
        tokens.add(word.slice(0, length));
        if (tokens.size >= SEARCH_TOKENS_LIMIT) return [...tokens];
      }
    }
  }
  return [...tokens];
}

/** The token to query for what someone typed: the first word's prefix, capped at the token length. */
export function searchQueryToken(query: string): string | null {
  const [first] = searchWords(query);
  if (!first || first.length < SEARCH_TOKEN_MIN) return null;
  return first.slice(0, SEARCH_TOKEN_MAX);
}
