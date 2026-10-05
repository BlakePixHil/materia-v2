/**
 * Search tokens for Firestore `array-contains` search (ADR-013; CORE-01, CORE-15): lower-cased,
 * NFKD-normalised with diacritics stripped, apostrophes dropped ("O'Brien" → "obrien"), split on
 * anything that isn't a letter or digit, then every prefix of length 2–10 of each word. At most 60
 * tokens, earlier text first. Every `*-onWrite` trigger that keeps a `search` field uses these
 * (matters, contacts, documents by name, tasks by title), and the palette's providers query them.
 */
export const SEARCH_TOKEN_MIN = 2;
export const SEARCH_TOKEN_MAX = 10;
export const SEARCH_TOKENS_LIMIT = 60;
/** Rows each provider reads per collection (ADR-013), before the other words are checked here. */
export const SEARCH_RESULT_LIMIT = 20;

/** Lower-case, NFKD with diacritics stripped, apostrophes dropped, everything else not a letter or digit a space. */
export function normaliseText(text: string): string {
  return text
    .normalize('NFKD')
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

/** A text's letters and digits only, normalised ("M-2026-0142" → "m20260142"). */
export function compactText(text: string | null | undefined): string {
  return searchWords(text).join('');
}

/** Adds each prefix of length 2–10 of a word; false once the set is full. */
function addPrefixes(tokens: Set<string>, word: string): boolean {
  for (let length = SEARCH_TOKEN_MIN; length <= Math.min(word.length, SEARCH_TOKEN_MAX); length++) {
    tokens.add(word.slice(0, length));
    if (tokens.size >= SEARCH_TOKENS_LIMIT) return false;
  }
  return true;
}

export function searchTokens(...texts: (string | null | undefined)[]): string[] {
  const tokens = new Set<string>();
  for (const text of texts) {
    for (const word of searchWords(text)) if (!addPrefixes(tokens, word)) return [...tokens];
  }
  return [...tokens];
}

/**
 * The tokens of a matter number, in the order they're kept: the whole number without separators
 * and its digits only (each in full, even past 10 characters), then their prefixes, then each part's
 * prefixes, with a numeric part's leading zeros dropped too. So "M-2026-0142" is found by "142",
 * "0142", "2026-0142", "20260142" and "M-2026-0142" alike.
 */
export function numberTokens(number: string | null | undefined): string[] {
  const compact = compactText(number);
  if (!compact) return [];
  const digits = compact.replace(/\D/g, '');
  const words = searchWords(number);
  const tokens = new Set<string>([compact]);
  if (digits.length >= SEARCH_TOKEN_MIN) tokens.add(digits);
  addPrefixes(tokens, compact);
  if (digits) addPrefixes(tokens, digits);
  for (const word of words) {
    addPrefixes(tokens, word);
    const stripped = /^\d+$/.test(word) ? word.replace(/^0+/, '') : '';
    if (stripped && stripped !== word) addPrefixes(tokens, stripped);
  }
  return [...tokens].filter((token) => token.length >= SEARCH_TOKEN_MIN);
}

/** Tokens for a number first, then texts, capped at `SEARCH_TOKENS_LIMIT` (the number is never cut). */
export function searchTokensWithNumber(number: string | null | undefined, ...texts: (string | null | undefined)[]) {
  const tokens = new Set(numberTokens(number));
  for (const token of searchTokens(...texts)) {
    if (tokens.size >= SEARCH_TOKENS_LIMIT) break;
    tokens.add(token);
  }
  return [...tokens];
}

/** A task's search tokens: its title (CORE-15). */
export function taskSearchTokens(title: string | null | undefined): string[] {
  return searchTokens(title);
}

/** A document's search tokens: its name (the extension is a word too, so "pdf" finds PDFs; CORE-15). */
export function documentSearchTokens(name: string | null | undefined): string[] {
  return searchTokens(name);
}

/** The token to query for what someone typed: the first word's prefix, capped at the token length. */
export function searchQueryToken(query: string): string | null {
  const [first] = searchWords(query);
  if (!first || first.length < SEARCH_TOKEN_MIN) return null;
  return first.slice(0, SEARCH_TOKEN_MAX);
}

/** What someone typed in the palette, parsed once for every provider (CORE-15). */
export interface SearchQuery {
  /** The words typed, normalised. */
  words: string[];
  /** The normalised text ("estate of nguyen"), for title-prefix ranking. */
  text: string;
  /** Typed as a number ("142", "M-2026-0142", "2026-0142"): its letters and digits, else null. */
  number: string | null;
  /**
   * The `array-contains` token to query with: a number's compact form, else the longest word (the
   * most selective; the first of equal length), capped at 10 characters. Null when nothing typed is
   * two characters or more.
   */
  token: string | null;
}

/** A number: one run of letters, digits and separators, with at least one digit. */
const NUMBER_LIKE = /^[\p{L}\p{N}][\p{L}\p{N}\-/._]*$/u;

export function parseSearchQuery(query: string): SearchQuery {
  const trimmed = query.trim();
  const words = searchWords(trimmed);
  const text = words.join(' ');
  const number = NUMBER_LIKE.test(trimmed) && /\d/.test(trimmed) ? compactText(trimmed) : null;
  const lead = number ?? words.reduce((best, word) => (word.length > best.length ? word : best), '');
  const token = lead.length >= SEARCH_TOKEN_MIN ? lead.slice(0, SEARCH_TOKEN_MAX) : null;
  return { words, text, number, token };
}

/**
 * Whether a document matches every word typed: each word of two or more characters is one of its
 * tokens (or, past 10 characters, its 10-character prefix is and one of `texts` contains the
 * word). A number matches a whole-number token, or a number in `texts` containing it.
 */
export function matchesSearch(tokens: readonly string[], query: SearchQuery, texts: readonly string[] = []): boolean {
  const set = new Set(tokens);
  if (query.number) {
    if (set.has(query.number)) return true;
    const compacts = texts.map(compactText);
    if (compacts.some((text) => text.includes(query.number as string))) return true;
  }
  const words = query.words.filter((word) => word.length >= SEARCH_TOKEN_MIN);
  if (!words.length) return false;
  const haystack = texts.map(normaliseText).join(' ');
  return words.every((word) =>
    word.length <= SEARCH_TOKEN_MAX
      ? set.has(word)
      : set.has(word.slice(0, SEARCH_TOKEN_MAX)) && haystack.includes(word),
  );
}

/** Whether a matter number is exactly what was typed, with or without its prefix or leading zeros. */
export function isExactNumberMatch(number: string | null | undefined, query: SearchQuery): boolean {
  if (!query.number || !number) return false;
  const compact = compactText(number);
  const digits = compact.replace(/\D/g, '');
  const last = searchWords(number).at(-1) ?? '';
  const sequence = /^\d+$/.test(last) ? last.replace(/^0+/, '') : last;
  return [compact, digits, last, sequence].includes(query.number);
}

/** A search result as ranking sees it. */
export interface RankedHit {
  /** The matter number, for an exact-number match. */
  number?: string | null | undefined;
  /** What the row is called: a matter's title, a contact's name, a task's title, a document's name. */
  title: string;
  /** Recency: last activity or update, newest first. */
  at?: Date | null | undefined;
}

/** 0: exact number match, 1: the title starts with what was typed, 2: anything else. */
export function searchRank(hit: RankedHit, query: SearchQuery): 0 | 1 | 2 {
  if (isExactNumberMatch(hit.number, query)) return 0;
  if (query.text && normaliseText(hit.title).startsWith(query.text)) return 1;
  return 2;
}

/** Orders hits: exact number match, then title prefix, then most recent first (CORE-15). */
export function rankSearchHits<T extends RankedHit>(hits: readonly T[], query: SearchQuery): T[] {
  return hits
    .map((hit, index) => ({ hit, index, rank: searchRank(hit, query), at: hit.at?.getTime() ?? 0 }))
    .sort((a, b) => a.rank - b.rank || b.at - a.at || a.index - b.index)
    .map((entry) => entry.hit);
}
