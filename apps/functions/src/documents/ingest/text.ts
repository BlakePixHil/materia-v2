import type { Firestore } from 'firebase-admin/firestore';

import type { DocumentPage, DocumentTextPort } from '../../clerk/context/ports';
import { matterPath } from '../../matters/shared';

/** How far back to look for the overlap between two chunks (the chunker overlaps ~400 chars). */
const MAX_OVERLAP_CHARS = 2000;

/**
 * Appends `next` to `text`, dropping the overlap the chunker repeated at its start: the longest
 * prefix of `next` that `text` already ends with. Without one, the two are joined with a space.
 */
export function joinOverlapping(text: string, next: string): string {
  if (!text) return next;
  for (let k = Math.min(next.length, text.length, MAX_OVERLAP_CHARS); k > 0; k--) {
    if (text.endsWith(next.slice(0, k))) return text + next.slice(k);
  }
  return `${text} ${next}`;
}

/**
 * Rebuilds pages from chunks (sorted by ordinal), merging each page's overlapping windows.
 * The text is the normalised text the chunks were cut from (whitespace collapsed).
 */
export function pagesFromChunks(chunks: readonly { page: number; ordinal: number; text: string }[]): DocumentPage[] {
  const pages = new Map<number, string>();
  for (const chunk of [...chunks].sort((a, b) => a.ordinal - b.ordinal)) {
    pages.set(chunk.page, joinOverlapping(pages.get(chunk.page) ?? '', chunk.text));
  }
  return [...pages.entries()].sort(([a], [b]) => a - b).map(([page, text]) => ({ page, text }));
}

/**
 * Document text for Clerk's context (AI-03), read back from the version's chunks (AI-04 keeps no
 * separate copy of the text). A version not yet ingested, or superseded, has no chunks, so it reads
 * as still processing.
 */
export function chunkDocumentText(db: Firestore): DocumentTextPort {
  return {
    async pages({ orgId, matterId, documentId, version }) {
      const snap = await db
        .collection(`${matterPath(orgId, matterId)}/documents/${documentId}/chunks`)
        .where('docVersion', '==', version)
        .select('page', 'ordinal', 'text')
        .get();
      return pagesFromChunks(snap.docs.map((d) => d.data() as { page: number; ordinal: number; text: string }));
    },
  };
}
