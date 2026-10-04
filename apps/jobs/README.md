# Cloud Run jobs (`apps/jobs`)

Heavy work runs here, not in functions (ADR-014, FND-24). One image, one entry point: `node main.js <job>` with `pdf` today and `court-book` and `ocr` reserved for later tickets.

## The job contract

1. A callable validates the request, writes `orgs/{orgId}/jobs/{jobId}` as `queued` (the `Job` entity in `@materia/domain`) and starts an execution of the Cloud Run job with `JOB_ORG_ID` and `JOB_ID` as environment overrides (`apps/functions/src/jobs/start-pdf.ts`, `createJob`). Feature callables (invoices, court books, exports) reuse `createJob` after their own checks.
2. The job claims the document in a transaction (`src/core/claim.ts`). A succeeded job, a failed job that isn't retryable, or a running job with a heartbeat in the last 2 minutes is skipped, so a duplicate dispatch does nothing.
3. It writes `progress` (`done`, `total`, `stage`) at most once a second and a heartbeat every 30 seconds. The web app shows it with `<mt-job-progress>` (`apps/web/src/app/core/jobs`).
4. It ends `succeeded` with `output` (path, size, SHA-256, pages), or `failed` with `error` (`code` is an `ErrorCode`, `retryable` says whether running it again can help). Skipped inputs become `warnings`. Messages never carry document text.
5. After 28 minutes it stops with `JOB_TIMEOUT` (retryable). The Cloud Run task timeout is 30 minutes and Cloud Run never retries (`--max-retries 0`); retries are a new dispatch.

Exit codes: `0` done or skipped, `1` setup error (bad environment, unreadable job), `2` the job failed and the document says why.

Outputs: a matter target becomes a new matter document (`orgs/{org}/matters/{m}/documents/job-{jobId}`, `source: generated`, privileged if any input was), an export target goes to `orgs/{org}/exports/{jobId}.pdf` (the 7-day expiry is SEC-05's lifecycle rule, not yet in Terraform).

## PDF

- **`pdf.merge`** concatenates matter document versions (with optional page ranges) with qpdf, which streams pages, so memory stays flat: 500 pages take about 2 seconds and 200 MB. Then it lays a pdf-lib overlay (stamp, page numbers) over every page with `qpdf --overlay`, adds bookmarks with `--update-from-json` and linearises the result. Encrypted inputs fail with `PDF_ENCRYPTED`, unreadable ones with `PDF_INVALID`; `onInputError: 'skip'` turns either into a warning. Damaged files qpdf can repair are used with a warning.
- **`pdf.render`** fills an HTML template from `templates/` with Handlebars (escaped, known helpers only) and prints it with Chromium as a tagged PDF. JavaScript is off and every non-file request is blocked. Geist ships in the bundle, DejaVu Sans covers what it lacks (Vietnamese diacritics included).
- Output is deterministic: the same inputs give the same bytes (fixed dates, producer and font names, `--deterministic-id`).

## Image choices

- **Debian `chromium` and `qpdf`** on `node:22-bookworm-slim`, upgraded at build time. Playwright's own browser download is avoided so the image builds from Debian's mirrors alone.
- **No Chromium sandbox.** Cloud Run's gVisor sandbox and the non-root user are the isolation; templates are ours and the page can't run scripts or fetch anything.
- `/tmp` is in memory on Cloud Run, so the job has 2 GiB: enough for 5,000 inputs at typical sizes. The job deletes its working folder at the end.

## Running it

- Unit tests: `pnpm nx test jobs`.
- Container tests: `pnpm nx run jobs:test-container` runs `tests/integration` against the built bundle with the host's `qpdf` and `CHROMIUM_PATH`. CI (`jobs container`) runs the same tests inside the image with `JOBS_IMAGE` set.
- By hand, without Google Cloud: put `job.json` (a `Job` document plus `orgId` and `id`) and `storage/` in a folder, then `node dist/apps/jobs/main.js pdf --local <folder>` or `docker run --rm -v "$PWD/<folder>:/work" <image> pdf --local /work`. The job writes `firestore/` and `progress.jsonl` next to them.

Deploys: `deploy.yml` builds the image from the release bundle, pushes it to the environment's `jobs` Artifact Registry repository (scanned on push) and deploys the Cloud Run job `pdf` as `jobs-runtime`. Never deploy from a session.

## Adding a job type

Add the type and its input schema to `libs/domain/src/lib/schemas/jobs.ts`, a handler under `src/<area>/`, and register it in `main.ts`. Add container tests with fixture files (fictional data only).
