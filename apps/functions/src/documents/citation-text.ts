import type { Firestore } from 'firebase-admin/firestore';

import {
  CITATION_TEXT_MAX_PAGES,
  CitationTextInput,
  DOCUMENT_CALLABLES,
  DomainError,
  findVersion,
  PERMISSIONS,
  type CitationTextPage,
  type CitationTextResult,
} from '@materia/domain';

import { pagesFromChunks } from './ingest/text';
import { documentPath, isClean, loadDocument, versionsOf } from './shared';
import { defineCallable, type CallableDefinition } from '../core/callable';

interface ChunkText {
  page: number;
  ordinal: number;
  text: string;
  ocr?: boolean;
}

/** A version's pages from its chunks (all of them, or `pages`), with whether each was OCR'd. */
export async function chunkPages(
  db: Firestore,
  path: string,
  version: number,
  pages?: readonly number[],
): Promise<CitationTextPage[]> {
  let query = db.collection(`${path}/chunks`).where('docVersion', '==', version);
  if (pages?.length) query = query.where('page', 'in', [...new Set(pages)]);
  const snap = await query.select('page', 'ordinal', 'text', 'ocr').get();
  const chunks = snap.docs.map((doc) => doc.data() as ChunkText);
  const ocr = new Set(chunks.filter((chunk) => chunk.ocr === true).map((chunk) => chunk.page));
  return pagesFromChunks(chunks).map((page) => ({ ...page, ocr: ocr.has(page.page) }));
}

/**
 * `documents-citationText` (AI-05; `matter.view`): the extracted text of a cited version's pages,
 * read back from its chunks (AI-04 keeps no other copy), for the citation viewer: DOCX and email
 * sources show it with the quote highlighted, and so do OCR'd PDF pages, which have no text layer.
 * The same checks as a download: privileged documents need `privileged.view` and removed ones are
 * NOT_FOUND (`loadDocument`); the file must be scanned clean. A version without chunks (not ingested
 * yet, or superseded: AI-04 keeps only the current version's) returns no pages. Logs ids only.
 */
export const citationTextDefinition = {
  name: DOCUMENT_CALLABLES.citationText,
  input: CitationTextInput,
  roles: PERMISSIONS['matter.view'],
  handler: async ({ input, orgId, role, db, log }): Promise<CitationTextResult> => {
    const { doc } = await loadDocument(db, orgId, role, input.matterId, input.docId);
    if (!isClean(doc)) {
      throw new DomainError('FAILED_PRECONDITION', 'The document hasn’t passed the malware scan', {
        reason: 'not_scanned',
      });
    }
    const version = findVersion({ version: doc['version'], versions: versionsOf(doc) }, input.version);
    if (!version) throw new DomainError('NOT_FOUND', 'Version not found', { version: input.version ?? null });
    const all = await chunkPages(db, documentPath(orgId, input.matterId, input.docId), version.version, input.pages);
    const pages = all.slice(0, CITATION_TEXT_MAX_PAGES);
    log.info('citation text', {
      matterId: input.matterId,
      docId: input.docId,
      version: version.version,
      pages: pages.length,
    });
    return { version: version.version, pages, truncated: all.length > pages.length };
  },
} satisfies CallableDefinition<typeof CitationTextInput, CitationTextResult>;

export const citationText = defineCallable(citationTextDefinition);
