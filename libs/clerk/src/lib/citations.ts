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

export interface ClerkCitation {
  documentId: string;
  version: number;
  page?: number;
  quote: string;
}

export const MAX_QUOTE_LENGTH = 2000;

function pageForOffset(offsets: number[] | undefined, charIndex: number): number | undefined {
  if (!offsets?.length) return undefined;
  let page: number | undefined;
  offsets.forEach((start, index) => {
    if (start <= charIndex) page = index + 1;
  });
  return page;
}

/**
 * Maps citations to `{documentId, version, page, quote}`, de-duplicated. Citations pointing at
 * an unknown source are dropped and counted, so the gateway can log (ids only) and evals can catch
 * invented sources.
 */
export function mapCitations(
  citations: readonly ModelCitation[],
  sources: { documents: readonly CitedDocument[]; searchResults: readonly CitedChunk[] },
): { citations: ClerkCitation[]; unmapped: number } {
  const out: ClerkCitation[] = [];
  const seen = new Set<string>();
  let unmapped = 0;
  for (const citation of citations) {
    let mapped: ClerkCitation | undefined;
    const quote = (citation.cited_text ?? '').trim().slice(0, MAX_QUOTE_LENGTH);
    if ('document_index' in citation && typeof citation.document_index === 'number') {
      const doc = sources.documents[citation.document_index];
      if (doc) {
        let page: number | undefined;
        if (citation.type === 'page_location' && 'start_page_number' in citation) page = citation.start_page_number;
        if (citation.type === 'char_location' && 'start_char_index' in citation)
          page = pageForOffset(doc.pageOffsets, citation.start_char_index);
        if (citation.type === 'content_block_location' && 'start_block_index' in citation)
          page = doc.blockPages?.[citation.start_block_index];
        mapped = { documentId: doc.documentId, version: doc.version, quote, ...(page ? { page } : {}) };
      }
    } else if ('search_result_index' in citation && typeof citation.search_result_index === 'number') {
      const chunk = sources.searchResults[citation.search_result_index];
      if (chunk)
        mapped = {
          documentId: chunk.documentId,
          version: chunk.version,
          quote,
          ...(chunk.page ? { page: chunk.page } : {}),
        };
    }
    if (!mapped || !quote) {
      unmapped++;
      continue;
    }
    const key = `${mapped.documentId}|${mapped.version}|${mapped.page ?? ''}|${mapped.quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(mapped);
  }
  return { citations: out, unmapped };
}
