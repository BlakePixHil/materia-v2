import * as z from 'zod';

import { LEGAL_DOCUMENT_LIST } from './legal-documents.generated';

/**
 * Materia's published legal documents (SEC-01): the privacy policy, collection notice, terms of
 * service, data processing addendum, sub-processor list and retention policy. Their text is
 * Markdown in `docs/compliance/*.md`, with the metadata below in each file's front-matter;
 * `pnpm materia-scripts legal-docs` compiles them into this registry and the web app's content
 * module, so the docs and the in-app pages at `/legal/*` are one source. A new page (the
 * accessibility statement, SEC-06) is one more Markdown file.
 *
 * The terms of service and the DPA are one agreement with one version, `TERMS_VERSION` (terms.ts).
 * An org's owner accepts it before using the app; a new version is accepted again.
 */

/** `draft` documents are placeholders awaiting a lawyer's or privacy professional's sign-off. */
export type LegalDocumentStatus = 'draft' | 'final';

/** A legal document's registry entry. */
export interface LegalDocumentMeta {
  /** Its path under `/legal/` and its key in the web app's content module. */
  key: string;
  title: string;
  /** One sentence for the `/legal` index. */
  summary: string;
  /** `major.minor`. The terms' version is the one owners accept. */
  version: string;
  /** When this version takes effect (`YYYY-MM-DD`). */
  effectiveDate: string;
  status: LegalDocumentStatus;
  /** The Markdown source, from the repository root. */
  source: string;
}

/** The published documents, in the order the `/legal` index lists them. */
export const LEGAL_DOCUMENTS: readonly LegalDocumentMeta[] = LEGAL_DOCUMENT_LIST;

export type LegalDocumentKey = (typeof LEGAL_DOCUMENT_LIST)[number]['key'];

/** The document published at `/legal/{key}`, or undefined. */
export function legalDocument(key: string): LegalDocumentMeta | undefined {
  return LEGAL_DOCUMENTS.find((doc) => doc.key === key);
}

/**
 * `orgs-acceptTerms`: the org's owner accepts the terms of service and DPA on its behalf. The
 * version must be the current one, the one the page showed.
 */
export const AcceptTermsInput = z.object({
  requestId: z.uuid(),
  version: z.string().trim().min(1).max(20),
});
export type AcceptTermsInput = z.input<typeof AcceptTermsInput>;

export interface AcceptTermsResult {
  version: string;
  /** False when the org had already accepted this version, so nothing was written. */
  recorded: boolean;
}
