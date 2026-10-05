import type { ClerkCitation } from '@materia/clerk';
import { checkCitations } from '@materia/domain';

import type { DocumentTextPort } from './context/ports';

/** Where cited documents live: the matter the reply was about (chunks are per matter). */
export interface CitationScope {
  orgId: string;
  matterId: string;
}

export interface VerifiedCitations {
  /** Every citation, in order; those whose quote wasn't found carry `verified: false`. */
  citations: ClerkCitation[];
  verified: number;
  unverified: number;
}

/**
 * Citation verification (AI-05, ADR-043): loads the cited version's page text from its chunks
 * (AI-04, through `DocumentTextPort`, each version once) and checks the quote is on the cited page
 * (`checkCitations` in libs/domain: normalised, exact or ≥ 0.9 fuzzy). A citation that fails, or
 * whose version has no text (not ingested, or superseded since), is kept with `verified: false`:
 * the UI never shows it, and the gateway counts it as `citation_unverified`.
 */
export async function verifyCitations(
  citations: readonly ClerkCitation[],
  scope: CitationScope,
  text: DocumentTextPort,
): Promise<VerifiedCitations> {
  const pages = new Map<string, string[]>();
  const versionKey = (citation: ClerkCitation) => `${citation.documentId}@${citation.docVersion}`;
  for (const citation of citations) {
    const key = versionKey(citation);
    if (pages.has(key)) continue;
    let byPage: string[] = [];
    try {
      const read = await text.pages({ ...scope, documentId: citation.documentId, version: citation.docVersion });
      for (const { page, text: pageText } of read) byPage[page - 1] = pageText;
      byPage = Array.from(byPage, (pageText) => pageText ?? '');
    } catch {
      byPage = [];
    }
    pages.set(key, byPage);
  }
  const checks = checkCitations(citations, (citation) => pages.get(versionKey(citation)));
  const out = checks.map(({ citation, verified }) => {
    const rest: ClerkCitation = { ...citation };
    delete rest.verified;
    return verified ? rest : { ...rest, verified: false };
  });
  const verified = checks.filter((check) => check.verified).length;
  return { citations: out, verified, unverified: checks.length - verified };
}
