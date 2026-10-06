# ADR-043: Clerk citations are verified against the chunks and opened in a side-panel viewer

- **Status:** Accepted
- **Date:** 2026-10-05
- **Ticket:** [AI-05](https://linear.app/materia-web/issue/MAT-63)
- **Refines:** [ADR-034: Clerk context assembly](034-clerk-context-assembly.md), [ADR-038: Clerk document ingestion](038-clerk-document-ingestion.md)

## Context

Clerk answers carry the Messages API's citations (page, character, content-block and search-result locations). Before AI-05 the gateway kept a loose `{documentId, version?, page?, quote}` and showed it as given. A model can still cite a page that doesn't hold the quote, or paraphrase it. A lawyer has to see the passage in the document, at the version Clerk read, before relying on it. Stored citations already exist on suggestions (AI-07) and in seed data, so the shape has to change without breaking them.

## Decision

- **One `Citation` shape, read leniently.** `CitationSchema` (libs/domain) is `{kind: 'document' | 'record', documentId?, docVersion?, page?, pageEnd?, quote, charStart?, charEnd?, recordRef?: {collection, id}, verified?}`.
  - `kind` defaults to `document`.
  - A document citation needs `documentId`; a record citation needs `recordRef`.
  - The old `version` is accepted on read and becomes `docVersion`, so no migration runs.
  - `charStart` and `charEnd` count from the start of the cited page; with no page, they count from the start of the document.
- **The gateway maps every API location** (`libs/clerk` `mapCitation`):
  - a `page_location` gives `page`, plus `pageEnd` when it spans pages (the API's end is exclusive);
  - a `char_location` gives page-relative character offsets, computed from the document's page texts;
  - `content_block_location` and `search_result_location` give the chunk's document, version and page.
  - The raw content blocks keep each claim's citations. The gateway therefore writes `[n]` markers into the message text, where `n` is the citation's position plus 1.
- **Verification is a pure function, run on matter-scoped replies.** The core is `verifyQuote`, `matchQuote` and `checkCitations` in libs/domain, so the AI-12 evals and the web viewer use the same matcher.
  - **Normalisation:** NFKC, lower case, invisible characters removed, quote marks and dashes unified, whitespace collapsed.
  - **Matching:** a quote matches when its normalised text occurs in the page text, or reaches at least 0.9 on an approximate substring match (one minus edit distance divided by quote length).
  - An ellipsis splits a quote into pieces, matched in order. Quotes under 12 characters must match exactly.
  - **Where it looks:** the cited page range, then that range plus the next page.
  - **Where it runs:** the functions' `verifyCitations` loads page text from the chunks (`chunkDocumentText`), once per document and version.
  - **Failures:** a failed citation is stored with `verified: false`, so the `[n]` numbering stays stable. It is counted in the monthly metrics doc (`citation_verified`, `citation_unverified`, plus per-feature counts).
  - **Display:** containers drop it (`shownCitations`). A claim left with no shown sources reads "unverified".
  - Replies without matter context (evals, metrics questions) are not gated.
- **The viewer is a lazy side panel.** `mt-citation-viewer` opens at the cited version. A citation of an older version shows "A newer version exists".
  - **PDFs** open in the CORE-12 viewer. The quote is located in PDF.js's text content (the cited page and the next) and drawn as boxes over the canvas.
  - **Scanned pages** have no text layer, so the OCR text from the chunks shows with the highlight.
  - **Other files** (DOCX, email, text) show their extracted text through `documents-citationText`. Chunks are server-only, so that callable needs `matter.view`, plus `privileged.view` for privileged documents, and returns up to 50 pages per call.
  - Esc, `[` and `]` are registered with ShortcutService while the panel is open.
- **Chip state comes from a read by id.** Each cited document is read once with `get`:
  - a refused read is "Restricted source" for roles without `privileged.view`;
  - a missing or deleted document is "Removed document", and its quote stays visible.
  - Neither opens.

## Consequences

- AI-06 (the Clerk panel) renders stored messages with `mt-clerk-message`, provides `CitationSources` and hosts `mt-citation-viewer` the way the Overview's suggestions do.
- AI-12 evals call `verifyQuote` directly. `quoteOnPage` is now fuzzy and accepts a quote that runs onto the next page.
- Suggestions (`proposeSuggestions`) are not verified yet: their citations show as given. Applying `verifyCitations` there is a follow-up.
- Verification needs chunks. A document not yet ingested fails verification, so a reply about a document still processing shows its claims as "unverified" rather than as sourced.

## Alternatives considered

- **Verify in the browser.** Chunks are server-only, and the metrics must be counted where the reply is written, so this lost.
- **Drop unverified citations from storage.** This loses the audit trail and renumbers the markers.
- **Use PDF.js's own text layer and find controller.** This pulls the viewer components and their CSS into the lazy chunk. Boxes from `getTextContent` are smaller and keep one matcher for both verification and highlighting.
- **Rename `version` with a backfill.** No reader needs it gone, and reading both names costs one transform.
