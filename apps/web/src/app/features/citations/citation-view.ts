import {
  documentDisplayName,
  findVersion,
  matchQuote,
  REMOVED_DOCUMENT_LABEL,
  type CITATION_RECORD_COLLECTIONS,
  type CitationInput,
  type DocumentVersion,
} from '@materia/domain';
import type { CitationVm } from '@materia/ui';

import { previewKind } from '../documents/documents-view';

/**
 * How Clerk's citations show (AI-05, ADR-043): chips labelled with the cited document's name, in
 * the state the reader may see it (available, removed, restricted), and the citation viewer's
 * helpers (which view a source opens in, the highlight in extracted text, "Copy citation").
 */

/** What a cited document resolved to for this reader. */
export type CitedDocState =
  | { status: 'loading' }
  | { status: 'found'; doc: CitedDoc }
  /** The read was refused (privileged, for a role without privileged.view) or found nothing. */
  | { status: 'denied' }
  | { status: 'missing' };

/** The fields of a matter document the citations need. */
export interface CitedDoc {
  id: string;
  name?: string | undefined;
  deletedAt?: unknown;
  privileged?: boolean | undefined;
  version?: number | undefined;
  versions?: readonly DocumentVersion[] | undefined;
}

/** A citation the viewer can open: a document the reader may see, with the passage. */
export interface ViewerCitation {
  n?: number | undefined;
  documentId: string;
  version?: number | undefined;
  page?: number | undefined;
  pageEnd?: number | undefined;
  quote: string;
}

type RecordCollection = (typeof CITATION_RECORD_COLLECTIONS)[number];

/** A record citation's chip label. */
export const RECORD_LABELS: Readonly<Record<RecordCollection, string>> = {
  matter: 'Matter details',
  deadlines: 'Deadline',
  events: 'Key date',
  tasks: 'Task',
  timeEntries: 'Time entry',
  notes: 'Note',
  parties: 'Party',
  metrics: 'Practice figures',
};

/** The matter tab a record citation opens. */
export const RECORD_TABS: Readonly<Record<RecordCollection, string>> = {
  matter: 'overview',
  deadlines: 'deadlines',
  events: 'overview',
  tasks: 'tasks',
  timeEntries: 'overview',
  notes: 'notes',
  parties: 'parties',
  metrics: 'overview',
};

/** A citation as stored, old field names included (`version` for `docVersion`). */
type StoredCitation = CitationInput & { docVersion?: number | undefined; version?: number | undefined };

/**
 * The chips for a list of citations, numbered by position (`n` = index + 1, the `[n]` markers of a
 * Clerk message): labelled with the document's name; "Removed document" once deleted; "Restricted
 * source" when the reader can't see it (a refused read without privileged.view; with it, a refused
 * or empty read means the document is gone). Verification failures keep `verified: false`, so the
 * containers drop them.
 */
export function citationVms(
  citations: readonly StoredCitation[],
  docs: ReadonlyMap<string, CitedDocState>,
  privilegedVisible: boolean,
): CitationVm[] {
  return citations.map((citation, i): CitationVm => {
    const n = i + 1;
    const verified = citation.verified === false ? { verified: false } : {};
    if (citation.kind === 'record' && citation.recordRef) {
      return {
        n,
        documentId: citation.recordRef.id,
        label: RECORD_LABELS[citation.recordRef.collection],
        quote: citation.quote,
        kind: 'record',
        ...verified,
      };
    }
    const documentId = citation.documentId ?? '';
    const state = docs.get(documentId) ?? { status: 'loading' };
    const base = {
      n,
      documentId,
      version: citation.docVersion ?? citation.version,
      page: citation.page,
      quote: citation.quote,
      ...verified,
    };
    switch (state.status) {
      case 'found': {
        const doc = state.doc;
        if (doc.deletedAt !== undefined && doc.deletedAt !== null)
          return { ...base, label: REMOVED_DOCUMENT_LABEL, state: 'removed' };
        if (doc.privileged && !privilegedVisible) return { ...base, label: 'Source', state: 'restricted' };
        return { ...base, label: documentDisplayName(doc) };
      }
      case 'denied':
        return { ...base, label: 'Source', state: privilegedVisible ? 'removed' : 'restricted' };
      case 'missing':
        return { ...base, label: REMOVED_DOCUMENT_LABEL, state: 'removed' };
      default:
        return { ...base, label: citation.page ? 'Source' : 'Source document' };
    }
  });
}

/** The citations of a list the viewer can step through: shown, available documents. */
export function viewerCitations(vms: readonly CitationVm[], stored: readonly StoredCitation[]): ViewerCitation[] {
  return vms.flatMap((vm, i) => {
    const citation = stored[i];
    if (!citation || vm.kind === 'record' || vm.verified === false || (vm.state ?? 'available') !== 'available')
      return [];
    return [
      {
        n: vm.n,
        documentId: vm.documentId,
        version: vm.version,
        page: vm.page,
        pageEnd: citation.pageEnd,
        quote: citation.quote,
      },
    ];
  });
}

/** How a cited version is shown in the viewer. */
export type SourceView = 'pdf' | 'text';

/**
 * PDFs open in the PDF viewer at the page; everything else (DOCX and other Office files, emails,
 * plain text, scanned images) shows its extracted text from the chunks, where the quote was found.
 */
export function sourceView(doc: CitedDoc, version?: number): SourceView {
  const entry = findVersion(doc, version) ?? null;
  return entry && previewKind(entry.fileName) === 'pdf' ? 'pdf' : 'text';
}

/** "Copy citation": the document's name and page, as `Will of Margaret Doyle, p 3`. */
export function citationText(name: string, page?: number, pageEnd?: number): string {
  if (!page) return name;
  return pageEnd && pageEnd > page ? `${name}, pp ${page}–${pageEnd}` : `${name}, p ${page}`;
}

/** A run of a page's text, highlighted when it is part of the quote. */
export interface TextSegment {
  text: string;
  mark: boolean;
}

/** Extracted pages with the quote highlighted across them (a quote may run over a page break). */
export interface HighlightedPage {
  page: number;
  ocr: boolean;
  segments: TextSegment[];
}

/**
 * Splits pages of extracted text into plain and highlighted runs for a quote (matched with the
 * citations' normalised, ≥ 0.9 fuzzy match). `found` is false when the quote isn't there.
 */
export function highlightPages(
  pages: readonly { page: number; text: string; ocr?: boolean }[],
  quote: string,
): { pages: HighlightedPage[]; found: boolean } {
  const joined = pages.map((page) => page.text).join('\n');
  const ranges = matchQuote(quote, joined)?.ranges ?? [];
  let offset = 0;
  const out = pages.map((page): HighlightedPage => {
    const start = offset;
    const end = start + page.text.length;
    offset = end + 1;
    const segments: TextSegment[] = [];
    let at = start;
    for (const range of ranges) {
      const from = Math.max(range.start, start);
      const to = Math.min(range.end, end);
      if (to <= from) continue;
      if (from > at) segments.push({ text: joined.slice(at, from), mark: false });
      segments.push({ text: joined.slice(from, to), mark: true });
      at = to;
    }
    if (at < end) segments.push({ text: joined.slice(at, end), mark: false });
    return { page: page.page, ocr: page.ocr === true, segments };
  });
  return { pages: out, found: ranges.length > 0 };
}
