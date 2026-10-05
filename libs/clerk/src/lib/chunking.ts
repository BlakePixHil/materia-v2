/**
 * Page-aware chunking for retrieval (AI-04). Each chunk is about 800 tokens, consecutive chunks of
 * a long page overlap by about 100 tokens, and no chunk ever crosses a page boundary, so every
 * chunk (and every citation of it) has exactly one page.
 *
 * Tokens are estimated at four characters each: good enough for sizing English legal text, and
 * the embedding model's 2,048-token input limit leaves plenty of room either way.
 */

export const CHARS_PER_TOKEN = 4;
export const CHUNK_TARGET_TOKENS = 800;
export const CHUNK_OVERLAP_TOKENS = 100;

export interface PageText {
  /** 1-based page number (DOCX and text files use pseudo-pages). */
  page: number;
  text: string;
}

export interface TextChunk {
  page: number;
  /** Position in the document, from `startOrdinal`. */
  ordinal: number;
  text: string;
}

export interface ChunkOptions {
  targetTokens?: number;
  overlapTokens?: number;
  /** The first chunk's ordinal (a resumed ingest continues the numbering). */
  startOrdinal?: number;
}

/** A rough token count (four characters a token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Collapses runs of spaces and tabs, trims lines, and keeps at most one blank line between paragraphs. */
export function normaliseText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Where to end a window that starts at `start` and may run to `limit`: the last paragraph break,
 * else sentence end, else space, in the window's last 40%; the hard limit when there is none.
 */
function breakPoint(text: string, start: number, limit: number): number {
  if (limit >= text.length) return text.length;
  const floor = start + Math.floor((limit - start) * 0.6);
  const window = text.slice(floor, limit);
  for (const pattern of [/\n\n/g, /[.!?;:]["')\]]?\s/g, /\s/g]) {
    let last = -1;
    for (const match of window.matchAll(pattern)) last = (match.index ?? 0) + match[0].length;
    if (last > 0) return floor + last;
  }
  return limit;
}

/** Moves `index` forward to the start of the next word, so an overlap doesn't begin mid-word. */
function wordStart(text: string, index: number, max: number): number {
  if (index <= 0 || /\s/.test(text[index - 1] ?? ' ')) return index;
  const next = text.slice(index, max).search(/\s/);
  return next < 0 ? index : index + next + 1;
}

/** Splits one page into overlapping windows of about `targetChars`. */
export function splitPage(text: string, targetChars: number, overlapChars: number): string[] {
  const clean = normaliseText(text);
  if (!clean) return [];
  if (clean.length <= targetChars) return [clean];
  const parts: string[] = [];
  let start = 0;
  while (start < clean.length) {
    const end = breakPoint(clean, start, start + targetChars);
    const part = clean.slice(start, end).trim();
    if (part) parts.push(part);
    if (end >= clean.length) break;
    // Step back by the overlap, but always move forward.
    const back = wordStart(clean, Math.max(end - overlapChars, start + 1), end);
    start = back > start ? back : end;
  }
  return parts;
}

/** Chunks pages in order; empty pages give no chunks. */
export function chunkPages(pages: readonly PageText[], options: ChunkOptions = {}): TextChunk[] {
  const targetChars = (options.targetTokens ?? CHUNK_TARGET_TOKENS) * CHARS_PER_TOKEN;
  const overlapChars = (options.overlapTokens ?? CHUNK_OVERLAP_TOKENS) * CHARS_PER_TOKEN;
  if (overlapChars >= targetChars) throw new Error('The overlap must be smaller than the chunk');
  let ordinal = options.startOrdinal ?? 0;
  const chunks: TextChunk[] = [];
  for (const { page, text } of pages) {
    for (const part of splitPage(text, targetChars, overlapChars))
      chunks.push({ page, ordinal: ordinal++, text: part });
  }
  return chunks;
}

/**
 * Pseudo-pages for text without real pages (DOCX, plain text): paragraphs packed into pages of
 * about `pageChars` characters (3,000 by default). A paragraph longer than a page is split.
 */
export function pseudoPages(text: string, pageChars = 3000): PageText[] {
  const paragraphs = normaliseText(text)
    .split(/\n\n+/)
    .flatMap((paragraph) => (paragraph.length > pageChars ? splitPage(paragraph, pageChars, 0) : [paragraph]))
    .filter(Boolean);
  const pages: PageText[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 2 > pageChars) {
      pages.push({ page: pages.length + 1, text: current });
      current = '';
    }
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  if (current) pages.push({ page: pages.length + 1, text: current });
  return pages;
}
