# Document services (`apps/doc-services`)

Two small, private Cloud Run services the documents pipeline calls (CORE-12a, [ADR-028](../../docs/adr/028-document-upload-pipeline.md), [ADR-032](../../docs/adr/032-document-services-on-cloud-run.md)). Both are dependency-free Node HTTP servers bundled by `pnpm nx build doc-services` into `dist/apps/doc-services/{scanner,preview}.js`, with their Dockerfiles in `docker/`.

| Service   | Image                       | Contract                                                                                                        | Called by                                                                                    |
| --------- | --------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `clamav`  | `docker/scanner.Dockerfile` | `POST /scan` bytes → `{verdict: 'clean'}` or `{verdict: 'infected', signature}`; anything else is "unavailable" | `MalwareScanPort` (`apps/functions/src/documents/clamav.ts`)                                 |
| `preview` | `docker/preview.Dockerfile` | `POST /convert?from=<docx\|doc\|xlsx\|xls\|pptx\|heic>&to=<pdf\|jpeg>` bytes → bytes; 415/422 final, 503 retry  | `PreviewPort` (`apps/functions/src/documents/preview.ts`), from the `documents-render` queue |

Both answer `GET /healthz`. Authentication is Cloud Run IAM (ID tokens from `fn-runtime`); the services hold no credentials and no project roles. Logs carry sizes, timings, verdicts and signature names, never file names or content.

## Scanner

The image is ClamAV's official Debian image with Node copied in. Its build runs `freshclam`, so the signatures are that day's. At start, `scanner.js` runs `clamd` (local socket only), waits until it answers `PING` (about 20 seconds, which is the cold start), starts `freshclam` as a daemon (hourly checks, tells clamd to reload) and listens on `$PORT`. If clamd dies the process exits and Cloud Run replaces the instance. `scanner-signatures.yml` rebuilds and redeploys it daily.

## Preview

LibreOffice headless (Writer, Calc, Impress, no GUI) converts Office files to PDF, each conversion in its own temporary folder and LibreOffice profile; `heif-convert` turns HEIC photos into JPEG (the first image of a multi-image file). Metric-compatible fonts (Carlito, Caladea, Liberation) keep Word layouts. One conversion per instance at a time; two minutes at most.

## Running it

- Unit tests: `pnpm nx test doc-services` (a stand-in clamd on a Unix socket, shell-script stand-ins for the converters).
- Container tests: build the images, then `SCANNER_IMAGE=… PREVIEW_IMAGE=… pnpm nx run doc-services:test-container` (EICAR, a fictional .docx and HEIC in `tests/fixtures`). CI's `doc-services container` job does this.
- Deploys: `.github/scripts/deploy-doc-services.sh`, run by `deploy.yml` on every release. Never deploy from a session.
