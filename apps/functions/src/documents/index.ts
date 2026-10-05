// Documents (CORE-12, ADR-028). Deployed as documents-onUpload (Storage trigger on the files
// bucket's pending/ uploads), documents-rescan (Cloud Tasks retries of delayed scans), documents-render
// (Office and HEIC previews through the preview service, CORE-12a),
// documents-sweepPending (hourly expiry of quarantined uploads) and the callables
// documents-getDownloadUrl, documents-restoreVersion, documents-resolveDuplicate,
// documents-bulkUpdate and documents-saveAttachment. Clients edit document metadata directly (the rules check it).
// Clerk ingestion (AI-04): documents-onIngestChange (queues ingestion, keeps chunks' privileged flag,
// deletes chunks with the document), documents-ingest (Cloud Tasks) and documents-backfillIngest.
// documents-onWrite keeps each document's ⌘K `search` tokens from its name (CORE-15).
export { bulkUpdate, getDownloadUrl, resolveDuplicate, restoreVersion, saveAttachment } from './callables';
export { onUpload, render, rescan, sweepPending } from './on-upload';
export { onWrite } from './on-write';
export { backfillIngestCallable as backfillIngest, ingest, onIngestChange } from './ingest/index';
