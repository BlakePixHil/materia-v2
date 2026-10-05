# ADR-028: Document uploads go through quarantine, a server pipeline and signed downloads

- **Status:** Accepted
- **Date:** 2026-10-05
- **Ticket:** [CORE-12](https://linear.app/materia-web/issue/MAT-46)

## Context

Matter documents (wills, grants, identity documents, correspondence) are the most sensitive data the product holds. CORE-12 needs uploads from the browser. These have to hold:

- nothing unscanned or infected is ever readable by a client;
- privileged documents stay invisible to readonly users;
- the server can trust what the client says about a file only after checking it;
- the same file uploaded twice is noticed, even when both uploads land at the same moment;
- versions are kept, and a download is short-lived and always an attachment.

Firebase Storage rules can check metadata and size but not content. Malware scanning needs a ClamAV engine with fresh signatures, which a function can't carry. The files bucket (`{project}-files`) is versioned.

## Decision

**Quarantine, then a server pipeline.** Clients upload only to `orgs/{orgId}/matters/{matterId}/pending/{uploadId}` (create only: no read, overwrite or delete). The Storage rules check:

- the role and active membership;
- the size (at most 50 MB) and the upload id;
- an allow-listed extension uploaded with exactly its content type;
- the uploader's own uid, and the client's SHA-256;
- for a new version, a live, clean target document the uploader can see.

The contract (`UPLOAD_TYPES`, `uploadSettings`, `UploadMetadataSchema`) lives in libs/domain, and rules-sync generates the rules' type map from it.

**`documents-onUpload`** (a Storage trigger, `processUpload`) does the rest, idempotently by upload id:

1. It re-checks access, because a member can be suspended between the upload and the trigger.
2. It records the upload on the document. A new document's id is the upload id; a new document starts with `scan.status: 'pending'` and `version: 0`, so the UI can show it while it is checked.
3. It checks the size, the SHA-256 and the type by magic bytes. A damaged file with the right signature is stored as uploaded.
4. It scans through `MalwareScanPort`:
   - **Infected:** the object is deleted by generation (so no noncurrent copy lingers), the document records it, and the uploader and admins are notified.
   - **Timeout or outage:** the object stays quarantined ("Scanning delayed") and Cloud Tasks retries with exponential backoff.
5. A clean file is written to `documents/{docId}/v{n}` (never overwritten) with `Content-Disposition: attachment`. Then one transaction adds the version and, for a first version, reads and writes the matter's `documentHashes/{sha256}` index. A second live copy of the same content becomes `duplicateOf` the first, even when the uploads race.

**Versions are append-only.** Each version is an entry in the document's `versions` array (100 at most), mirrored to the top-level fields of the current one. `versionSeq` reserves numbers inside a transaction, and the reserved number is kept on `upload.version`, so a retry reuses it. Restoring copies an old version to a new number (`restoredFrom`) rather than moving the pointer back, so citations of any version stay valid.

**Downloads are signed URLs through a port.** `documents-getDownloadUrl` checks the role, privileged access and the scan. It then signs a V4 URL for 5 minutes with a response disposition of `attachment` (`SignedUrlPort`). The runtime account signs as itself (`iam.serviceAccountTokenCreator` on itself, already in Terraform). In the emulator, a stand-in returns a token URL with the same query parameters. The Storage rules still allow in-app reads of clean, live, visible versions; renditions and quarantined objects have no read rule.

**The scanner is ClamAV over HTTP, and it fails closed.** The adapter POSTs the bytes to `{CLAMAV_SCAN_URL}/scan` with a Google ID token and expects `{verdict}`. Any other answer, a timeout or an empty URL counts as scanner unavailable. The fake scanner (emulator, `MATERIA_FAKES=1`) flags the EICAR test string and times out on a marker string, for tests.

**Email is parsed in the function.** An .eml (mailparser) or .msg (@kenjiuno/msgreader) version gets a JSON rendition: headers, plain-text body (never HTML) and attachments. `documents-saveAttachment` writes one attachment back to the pending area as an upload by the caller, so it gets the same checks, scan and dedupe as any upload.

**Pending cleanup is a sweep, not a lifecycle rule.** GCS lifecycle conditions match prefixes, and `orgs/*/matters/*/pending/` isn't one. `documents-sweepPending` runs hourly, deletes quarantined objects older than 24 hours by generation, and records them as `expired`. The same sweep queues a rescan for any delayed upload whose retry chain has gone quiet for 75 minutes (the chain used up its attempts, or Cloud Tasks refused the next one), so a quarantined file is retried at least hourly until it is scanned or expires.

**The web viewer renders PDFs with PDF.js, sandboxed and lazy.** `pdfjs-dist` is pinned to an exact version (5.4.624). The app uses its legacy build: the modern build needs very recent engines (`Map#getOrInsertComputed`, `Promise.try`), which current Safari and older Chromium lack.
- The library is its own lazy chunk, loaded the first time a PDF opens. The worker, CMaps, standard fonts and wasm decoders are static assets under `assets/pdfjs/`, so none of it is in the initial bundle.
- PDF.js parses the file in a Web Worker and paints pages to canvas, with no scripting, XFA, links or `eval`. Pages render as they scroll into view.
- The bytes come from the signed URL by `fetch`, so the files bucket has a CORS rule for the app's origins: GET and HEAD, with the range headers exposed.

## Consequences

- No client ever holds a reference to unscanned bytes. The web app shows pipeline state from the document (`upload.status`, `scan.status`, `duplicateOf`).
- Firebase Storage adds a download token to client uploads after the rules run. The pipeline reads only the contract's metadata keys, and it deletes the pending object either way. The uploader could fetch their own quarantined bytes with that token until the trigger runs; those are bytes they already have.
- Until the ClamAV service is deployed and `CLAMAV_SCAN_URL` set, production uploads stay "Scanning delayed" and expire after 24 hours. This is deliberate: fail closed. (Built in CORE-12a, ADR-032.)
- The trigger needs the Cloud Storage service agent to publish to Pub/Sub (Eventarc), which Terraform now grants.
- Follow-ups, not built here:
  - **The ClamAV Cloud Run service** (built in CORE-12a, [ADR-032](032-document-services-on-cloud-run.md); `clamav/clamav` with freshclam, behind `run.invoker` for `fn-runtime`). The jobs image runs as a Cloud Run *job*, not a service. A service needs its own image build and deploy step in the deploy workflow, which this ticket must not edit.
  - **Office → PDF and HEIC → JPEG previews** (`renditions.previewPdf`, `previewImage`; built in CORE-12a, ADR-032). LibreOffice and libheif belong in a container. Running a Cloud Run job execution per upload is too heavy, so it wants a preview service, which needs the same deploy-workflow change. The download callable already accepts these renditions and reports `rendition_unavailable` until they exist.
  - **Zip download of a selection** (built in CORE-12b). `documents-startZip` starts a `documents.zip` job on the jobs image (FND-24), which stores the current versions in `orgs/{orgId}/exports/{jobId}.zip`; `jobs-getExportUrl` serves it through a 5-minute signed URL. Removed, unscanned and hidden privileged documents are left out; a zip is a download, not an export of the matter, so it doesn't need `export.includePrivileged`.

## Alternatives considered

- **Client uploads straight to `documents/`, scanned afterwards.** Rejected: the bytes would be readable before the scan, and every read rule would have to know about scan state per object.
- **Firebase Extensions or a third-party scanning API.** Rejected: files would leave the project, or a per-file cost would come with them, and the result would still need our own pipeline for magic bytes, dedupe and versions.
- **A version subcollection instead of the `versions` array.** Rejected for now: a document has few versions (100 at most), and the array keeps the document, its current version and its history in one read and one transaction.
- **Dedupe by a query on `sha256`.** Rejected: one index document gives concurrent uploads of the same file the same document to contend on, so Firestore serialises their transactions; a query would need another index and leave the race to query locking.
