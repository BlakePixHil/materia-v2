/**
 * Citation quotes (AI-05, ADR-043): what "the quote appears on the page" means, shared by the
 * server's verification (`verifyCitations` in functions), the citation viewer's highlight (web) and
 * the Clerk evals (AI-12, `quoteOnPage`). Pure: no I/O, no Angular, no Firebase.
 *
 * Two texts match when, after normalising both (Unicode NFKC, lower case, curly quotes and dashes
 * unified, punctuation dropped, whitespace collapsed), the quote appears in the page, or a stretch of
 * the page is at least `QUOTE_MATCH_THRESHOLD` similar to it (1 − edit distance ÷ quote length). An
 * ellipsis in a quote (`…` or `...`) splits it into pieces that must each match.
 */

/** The similarity a fuzzy match needs (OCR slips, ligatures, a dropped word). */
export const QUOTE_MATCH_THRESHOLD = 0.9;

/** Normalised quotes shorter than this must match exactly: a fuzzy match of a few letters means little. */
const FUZZY_MIN_CHARS = 12;

/**
 * Fuzzy matching is O(quote × page); above this many cells only exact matches count (a whole long
 * document searched without a page). A cited page is far below it.
 */
const FUZZY_MAX_CELLS = 25_000_000;

const SINGLE_QUOTES = /[‘’‚‛′`´]/g;
const DOUBLE_QUOTES = /[“”„‟″«»]/g;
const DASHES = /[‐‑‒–—―−]/g;
const INVISIBLE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;
const WORD_CHAR = /[\p{L}\p{N}']/u;
const ELLIPSIS = /\.{3,}|…/;

/**
 * A quote as people read it: Unicode NFKC, lower case, curly quotes and dashes made straight,
 * invisible characters dropped, whitespace collapsed and trimmed. Punctuation stays.
 */
export function normaliseQuote(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(INVISIBLE, '')
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(DASHES, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A text reduced to its words, with each key character's span in the original. */
interface Keyed {
  key: string;
  /** `starts[i]`/`ends[i]`: the original code point `key[i]` came from (end exclusive). */
  starts: number[];
  ends: number[];
}

/** Words only (letters, digits, apostrophes), single-spaced, mapped back to the original offsets. */
function keyed(text: string): Keyed {
  let key = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  for (const char of text) {
    const normal = /\s/.test(char) ? ' ' : normaliseQuote(char);
    for (const c of normal) {
      const word = WORD_CHAR.test(c);
      if (!word && (!key.length || key.endsWith(' '))) continue;
      key += word ? c : ' ';
      starts.push(offset);
      ends.push(offset + char.length);
    }
    offset += char.length;
  }
  if (key.endsWith(' ')) {
    key = key.slice(0, -1);
    starts.pop();
    ends.pop();
  }
  return { key, starts, ends };
}

/** The pieces of a quote an ellipsis separates (the API shortens long quotes this way). */
function pieces(quote: string): string[] {
  return quote
    .split(ELLIPSIS)
    .map((piece) => keyed(piece).key)
    .filter((piece) => piece.length > 0);
}

/** One match of a quote in a text: where (original offsets, end exclusive) and how close. */
export interface QuoteMatch {
  /** 1 for an exact match (after normalising); down to the threshold for a fuzzy one. */
  score: number;
  /** One range per piece of the quote, in order. */
  ranges: { start: number; end: number }[];
}

/**
 * The best place `needle` (a key) occurs in `hay` (a key), allowing edits: Sellers' approximate
 * substring match, keeping where each candidate started. Returns key offsets and the distance.
 */
function closest(needle: string, hay: string): { start: number; end: number; distance: number } | null {
  const m = needle.length;
  const n = hay.length;
  if (!m || !n) return null;
  // cost[i]: edits to match needle[0..i) ending at the current hay position; from[i]: where it began.
  let cost = new Uint32Array(m + 1);
  let from = new Uint32Array(m + 1);
  let nextCost = new Uint32Array(m + 1);
  let nextFrom = new Uint32Array(m + 1);
  for (let i = 0; i <= m; i++) cost[i] = i;
  let best = { start: 0, end: 0, distance: cost[m] as number };
  for (let j = 1; j <= n; j++) {
    nextCost[0] = 0;
    nextFrom[0] = j;
    const h = hay.charCodeAt(j - 1);
    for (let i = 1; i <= m; i++) {
      const substitute = (cost[i - 1] as number) + (needle.charCodeAt(i - 1) === h ? 0 : 1);
      const skipHay = (cost[i] as number) + 1;
      const skipNeedle = (nextCost[i - 1] as number) + 1;
      if (substitute <= skipHay && substitute <= skipNeedle) {
        nextCost[i] = substitute;
        nextFrom[i] = i === 1 ? j - 1 : (from[i - 1] as number);
      } else if (skipHay <= skipNeedle) {
        nextCost[i] = skipHay;
        nextFrom[i] = from[i] as number;
      } else {
        nextCost[i] = skipNeedle;
        nextFrom[i] = nextFrom[i - 1] as number;
      }
    }
    if ((nextCost[m] as number) < best.distance) {
      best = { start: nextFrom[m] as number, end: j, distance: nextCost[m] as number };
      if (best.distance === 0) break;
    }
    [cost, nextCost] = [nextCost, cost];
    [from, nextFrom] = [nextFrom, from];
  }
  return best;
}

/**
 * Finds a quote in a text: the best match at or above `threshold`, or null. Offsets are into the
 * original `text`, so a viewer can highlight them.
 */
export function matchQuote(quote: string, text: string, threshold = QUOTE_MATCH_THRESHOLD): QuoteMatch | null {
  const hay = keyed(text);
  const parts = pieces(quote);
  if (!parts.length || !hay.key.length) return null;
  const ranges: QuoteMatch['ranges'] = [];
  let score = 1;
  let from = 0;
  for (const part of parts) {
    let found: { start: number; end: number; similarity: number } | null = null;
    const exact = hay.key.indexOf(part, from);
    if (exact >= 0) found = { start: exact, end: exact + part.length, similarity: 1 };
    else if (part.length >= FUZZY_MIN_CHARS && part.length * (hay.key.length - from) <= FUZZY_MAX_CELLS) {
      const near = closest(part, hay.key.slice(from));
      if (near) {
        const similarity = Math.max(0, 1 - near.distance / part.length);
        if (similarity >= threshold) found = { start: from + near.start, end: from + near.end, similarity };
      }
    }
    if (!found) return null;
    score = Math.min(score, found.similarity);
    ranges.push({ start: hay.starts[found.start] as number, end: hay.ends[found.end - 1] as number });
    from = found.end;
  }
  return { score, ranges };
}

/** How well a quote matches a text: its score, or 0 below the threshold. */
export function quoteScore(quote: string, text: string): number {
  return matchQuote(quote, text)?.score ?? 0;
}

/** What a quote check needs from a citation. */
export interface QuoteLocation {
  quote: string;
  page?: number | undefined;
  /** The last page of a quote that runs over a page break. */
  pageEnd?: number | undefined;
}

/** The outcome of checking one citation's quote. */
export interface QuoteCheck {
  verified: boolean;
  score: number;
}

/**
 * Is the quote on the cited page? `pages[i]` is page `i + 1`'s text. A quote may run over the page
 * break (onto `pageEnd`, or the next page). With no page, anywhere in the document counts.
 */
export function verifyQuote(citation: QuoteLocation, pages: readonly string[]): QuoteCheck {
  const candidates: string[] = [];
  if (citation.page === undefined) candidates.push(pages.join('\n'));
  else {
    const first = citation.page - 1;
    const last = Math.max(first, (citation.pageEnd ?? citation.page) - 1);
    candidates.push(pages.slice(first, last + 1).join('\n'));
    if (last + 1 < pages.length) candidates.push(pages.slice(first, last + 2).join('\n'));
  }
  let score = 0;
  for (const text of candidates) {
    if (!text) continue;
    score = Math.max(score, quoteScore(citation.quote, text));
    if (score === 1) break;
  }
  return { verified: score >= QUOTE_MATCH_THRESHOLD, score };
}

/**
 * Checks each citation against its source's pages (`pagesOf`; undefined when the source has no
 * text, which fails the check: a quote that can't be found is not shown). Pure: the caller loads
 * the text (the functions' `verifyCitations` reads it from the document's chunks).
 */
export function checkCitations<T extends QuoteLocation>(
  citations: readonly T[],
  pagesOf: (citation: T) => readonly string[] | undefined,
): (QuoteCheck & { citation: T })[] {
  return citations.map((citation) => {
    const pages = pagesOf(citation);
    return { citation, ...(pages?.length ? verifyQuote(citation, pages) : { verified: false, score: 0 }) };
  });
}

/** A quote cut for a chip or a preview, at a word boundary, with an ellipsis. */
export function truncateQuote(quote: string, max = 160): string {
  const text = quote.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}
