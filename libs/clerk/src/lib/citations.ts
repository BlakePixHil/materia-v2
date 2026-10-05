import { CITATION_QUOTE_MAX, type DocumentCitation } from '@materia/domain';

/**
 * Maps the API's citation locations back to Materia citations (AI-02, Clerk rule 2). Documents go
 * in as `document` content blocks and retrieved chunks as `search_result` blocks; the API numbers
 * each kind separately, in request order, so the gateway keeps the two lists in that order.
 */

/** The citation shapes Claude returns (a structural subset of the SDK types; no SDK import here). */
export type ModelCitation =
  | {
      type: 'char_location';
      document_index: number;
      cited_text: string;
      start_char_index: number;
      end_char_index: number;
    }
  | {
      type: 'page_location';
      document_index: number;
      cited_text: string;
      start_page_number: number;
      end_page_number: number;
    }
  | {
      type: 'content_block_location';
      document_index: number;
      cited_text: string;
      start_block_index: number;
      end_block_index: number;
    }
  | { type: 'search_result_location'; search_result_index: number; cited_text: string; start_block_index?: number }
  | { type: string; cited_text?: string };

/** A document sent as a `document` block. */
export interface CitedDocument {
  documentId: string;
  version: number;
  /** Text documents: the character offset where each page starts (page 1 at index 0). */
  pageOffsets?: number[];
  /** Custom-content documents: the page each content block came from. */
  blockPages?: number[];
}

/** A retrieved chunk sent as a `search_result` block. */
export interface CitedChunk {
  documentId: string;
  version: number;
  page?: number;
}

/**
 * A Materia citation of a document (`Citation` in libs/domain, ADR-043): the API's location
 * converted to the document, version and page, plus character offsets for text documents.
 */
export type ClerkCitation = DocumentCitation & { docVersion: number };

export const MAX_QUOTE_LENGTH = CITATION_QUOTE_MAX;

/** The 1-based page a character offset falls on, from each page's start offset. */
function pageForOffset(offsets: readonly number[] | undefined, charIndex: number): number | undefined {
  if (!offsets?.length) return undefined;
  let page: number | undefined;
  offsets.forEach((start, index) => {
    if (start <= charIndex) page = index + 1;
  });
  return page;
}

type Sources = { documents: readonly CitedDocument[]; searchResults: readonly CitedChunk[] };

/**
 * One API citation as a Materia citation, or undefined when it points at a source the request
 * didn't send (or has no quote):
 * - `page_location` (PDFs): the start page, and `pageEnd` when the range covers more pages (the
 *   API's end page is exclusive);
 * - `char_location` (text documents): the page from the document's page offsets, and `charStart`/
 *   `charEnd` relative to that page (to the whole text when the document has no pages);
 * - `content_block_location`: the page the block came from;
 * - `search_result_location` (retrieved chunks, AI-03): the chunk's document, version and page.
 */
export function mapCitation(citation: ModelCitation, sources: Sources): ClerkCitation | undefined {
  const quote = (citation.cited_text ?? '').trim().slice(0, MAX_QUOTE_LENGTH);
  if (!quote) return undefined;
  const base = (documentId: string, docVersion: number): ClerkCitation => ({
    kind: 'document',
    documentId,
    docVersion,
    quote,
  });
  if ('document_index' in citation && typeof citation.document_index === 'number') {
    const doc = sources.documents[citation.document_index];
    if (!doc) return undefined;
    const out = base(doc.documentId, doc.version);
    if (citation.type === 'page_location' && 'start_page_number' in citation) {
      out.page = citation.start_page_number;
      const last = citation.end_page_number - 1;
      if (last > citation.start_page_number) out.pageEnd = last;
    }
    if (citation.type === 'char_location' && 'start_char_index' in citation) {
      const page = pageForOffset(doc.pageOffsets, citation.start_char_index);
      const offset = page ? (doc.pageOffsets?.[page - 1] ?? 0) : 0;
      const endPage = pageForOffset(doc.pageOffsets, Math.max(citation.start_char_index, citation.end_char_index - 1));
      if (page) out.page = page;
      if (page && endPage && endPage > page) out.pageEnd = endPage;
      out.charStart = citation.start_char_index - offset;
      if (!endPage || endPage === page) out.charEnd = Math.max(out.charStart, citation.end_char_index - offset);
    }
    if (citation.type === 'content_block_location' && 'start_block_index' in citation) {
      const page = doc.blockPages?.[citation.start_block_index];
      const endPage = doc.blockPages?.[Math.max(citation.start_block_index, citation.end_block_index - 1)];
      if (page) out.page = page;
      if (page && endPage && endPage > page) out.pageEnd = endPage;
    }
    return out;
  }
  if ('search_result_index' in citation && typeof citation.search_result_index === 'number') {
    const chunk = sources.searchResults[citation.search_result_index];
    if (!chunk) return undefined;
    const out = base(chunk.documentId, chunk.version);
    if (chunk.page) out.page = chunk.page;
    return out;
  }
  return undefined;
}

/** The identity of a citation, for de-duplication. */
export const citationKey = (c: ClerkCitation) => `${c.documentId}|${c.docVersion}|${c.page ?? ''}|${c.quote}`;

/**
 * Maps citations to Materia citations (`mapCitation`), de-duplicated, in the order they first
 * appear. Citations pointing at an unknown source are dropped and counted, so the gateway can log
 * (ids only) and evals can catch invented sources.
 */
export function mapCitations(
  citations: readonly ModelCitation[],
  sources: Sources,
): { citations: ClerkCitation[]; unmapped: number } {
  const out: ClerkCitation[] = [];
  const seen = new Set<string>();
  let unmapped = 0;
  for (const citation of citations) {
    const mapped = mapCitation(citation, sources);
    if (!mapped) {
      unmapped++;
      continue;
    }
    const key = citationKey(mapped);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(mapped);
  }
  return { citations: out, unmapped };
}

/** A run of the answer and the citations (indices into the mapped list) the API attached to it. */
export interface CitedClaim {
  text: string;
  refs: number[];
}

/**
 * The answer as claims (AI-05): each text block of the assistant turn with the citations the API
 * attached to it, as indices into `mapped` (from `mapCitations` over the same turn). When the turn
 * carries citations but no block does (a provider that only returns them flat), the whole text is
 * one claim citing all of them.
 */
export function citedClaims(
  content: readonly unknown[],
  text: string,
  mapped: readonly ClerkCitation[],
  sources: Sources,
): CitedClaim[] {
  const index = new Map(mapped.map((citation, i) => [citationKey(citation), i]));
  const claims: CitedClaim[] = [];
  let attached = false;
  for (const raw of content) {
    const block = raw as { type?: string; text?: string; citations?: ModelCitation[] | null };
    if (block.type !== 'text' || typeof block.text !== 'string') continue;
    const refs: number[] = [];
    for (const citation of block.citations ?? []) {
      const one = mapCitation(citation, sources);
      const at = one ? index.get(citationKey(one)) : undefined;
      if (at !== undefined && !refs.includes(at)) refs.push(at);
    }
    if (refs.length) attached = true;
    claims.push({ text: block.text, refs });
  }
  if (!attached) return [{ text, refs: mapped.length ? mapped.map((_, i) => i) : [] }];
  return claims;
}

/**
 * The answer as stored on the Clerk message: each cited claim followed by its `[n]` markers
 * (`n` = the citation's index + 1 in the message's `citations`), which the Clerk message renders as
 * superscripts linked to the source chips. A marker goes before the claim's trailing whitespace.
 */
export function markClaims(claims: readonly CitedClaim[]): string {
  return claims
    .map(({ text, refs }) => {
      if (!refs.length) return text;
      const body = text.replace(/\s+$/, '');
      return `${body}[${refs.map((ref) => ref + 1).join(', ')}]${text.slice(body.length)}`;
    })
    .join('');
}
