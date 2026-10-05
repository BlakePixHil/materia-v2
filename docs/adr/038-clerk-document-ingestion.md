# ADR-038: Clerk document ingestion runs as a checkpointed Cloud Tasks pipeline

- **Status:** Accepted
- **Date:** 2026-10-05
- **Ticket:** [AI-04](https://linear.app/materia-web/issue/MAT-61)
- **Refines:** [ADR-012: Retrieval](012-retrieval.md), [ADR-014: Heavy work](014-heavy-work-goes-to-cloud-run-jobs-or-cloud-tasks.md)

## Context

AI-04 makes every clean document searchable by Clerk: text per page (OCR for scans), page-aware chunks, Vertex embeddings and a Firestore vector index, plus a classification suggestion. It must be resumable, idempotent and cost-bounded, on a single-user app where idle cost and GitHub Actions minutes matter more than throughput. The ticket left open how heavy files run ("Cloud Tasks; heavy files go to an FND-24 job") and how OCR sees a page.

## Decision

- **One Cloud Tasks function, checkpointed.** `documents-onIngestChange` (a Firestore trigger on documents) queues `documents-ingest` once per transition into "needs ingesting" (a clean version arrives, a restore, a backfill). The task reads pages in batches of 50 and records `ingest.checkpoint {nextPage, nextOrdinal}` after each. Before its 540-second timeout it hands over to a continuation task at the checkpoint. A retry resumes the same way. There is no Cloud Run job: ADR-014 allows "a Cloud Tasks-driven function with checkpointing", and a job image would add a build and deploy step for no gain at this volume.
- **Idempotent by `(docId, version)`.** A version already `done` or `skipped` is left alone, a newer version makes a task stale, and chunk ids are `{version}-{ordinal}`, so a retried batch overwrites itself. A fresh run deletes the document's chunks first; the finished run deletes any other version's.
- **OCR is Claude vision on a one-page PDF.** A PDF page with fewer than 20 characters of text is cut out with pdf-lib and sent as a `document` block through the gateway (`ocr@1`, low effort, structured output `{text, lowConfidence, language}`). Claude reads PDF pages as images, so the functions don't rasterise anything (no canvas or native modules). PNG and JPEG photos are wrapped in a one-page PDF the same way; HEIC uses its JPEG preview when it exists. Document AI wasn't chosen in AI-01, so it isn't built.
- **The OCR budget is a daily page count per org.** Pages are reserved in a transaction on `orgs/{orgId}/counters/ocr-pages-{YYYY-MM-DD}` (Melbourne days) before the calls and refunded when unused. The limit is `settings.clerk.ocrDailyPages` (default 200). Past it, the document is `queued` ("Queued" in the Documents tab) and a task is scheduled just after the next Melbourne midnight to resume at the checkpoint.
- **Clerk off means no OCR, not no ingestion.** If the gateway says Clerk is off for the org (any `CLERK_*` error other than busy or unavailable, including no BYOK key or a rejected one, AI-02a), text pages are still chunked and embedded. Pages that needed OCR are counted in `ingest.ocrUnavailablePages`, and a fully scanned document is `skipped` (`ocr_unavailable`). The backfill re-queues it later.
- **Background Clerk features skip the per-user window.** OCR and classification run as `uid: 'system'` with no person waiting. The daily page budget and the monthly token budget still apply.
- **Citations are off with structured output.** The API rejects the two together, and OCR and classification send a document and want JSON. Chat and other cited answers don't use structured output, so nothing loses citations.
- **Embeddings are a REST call.** `text-embedding-005` in `australia-southeast1` at 768 dimensions, with the runtime account's metadata-server token (`roles/aiplatform.user` is already granted). Batches hold at most 250 texts and about 15,000 tokens. Chunks use `RETRIEVAL_DOCUMENT` and searches `RETRIEVAL_QUERY`.
- **Search is a port.** `chunkSearch({db, embedding}).searchChunks({orgId, matterId, query, k, allowPrivileged})` runs `findNearest` (cosine) on the `chunks` collection group, pre-filtered by `orgId`, `matterId` and, unless privileged material is allowed, `privileged == false`. AI-03 consumes it, and `FakeChunkSearch` stands in for tests.

## Consequences

- A 1,000-page PDF takes several chained tasks, and a large scanned one takes days at the default budget. Raising `ocrDailyPages` is the knob.
- Ingestion is invisible to the audit log (`ingest` is a noise field) and writes no `updatedAt`, so it doesn't bump the document in lists.
- The OCR prompt asks Claude to transcribe, not interpret. Handwriting comes back with `lowConfidence`, stored as `ingest.lowConfidencePages`.
- One live check is still needed on dev after deploy: upload a fictional PDF and confirm the chunks and their embeddings (no staging in the MVP).

## Alternatives considered

- **A Cloud Run job for heavy files (FND-24).** Rejected for now: a new image and deploy step, and a job execution per large file, to save a few chained task dispatches.
- **Rasterising pages for OCR (pdfjs + canvas).** Rejected: a native module in the functions bundle, larger images per call, and no quality gain, because Claude already reads the PDF page visually.
- **The Vertex AI SDK.** Rejected: a large dependency in a bundle every function shares, for one POST.
- **Skipping the whole document when Clerk is off.** Rejected: most documents have a text layer and are searchable without any Claude call.
