# ADR-032: The ClamAV scanner and the preview converter are private Cloud Run services

- **Status:** Accepted
- **Date:** 2026-10-05
- **Ticket:** [CORE-12a](https://linear.app/materia-web/issue/MAT-137)

## Context

ADR-028 left two follow-ups: the ClamAV service behind `MalwareScanPort` (until it exists, deployed uploads stay "Scanning delayed" and expire) and Office/HEIC previews (`renditions.previewPdf`, `previewImage`). Both need native tools a function can't carry (clamd with about 1 GB of signatures, LibreOffice, libheif), both are called per upload, and this is a single-user app, so cost while idle matters more than latency.

## Decision

- **One Nx project, two images.** `apps/doc-services` holds two dependency-free Node HTTP servers, bundled with esbuild: `scanner.js` (the ADR-028 scan contract over clamd's `INSTREAM`) and `preview.js` (`POST /convert?from=&to=`: LibreOffice headless to PDF, `heif-convert` to JPEG, one temporary folder and LibreOffice profile per conversion). Their images are `docker/scanner.Dockerfile` (on `clamav/clamav-debian:stable`, with Node copied in) and `docker/preview.Dockerfile` (on `node:22-bookworm-slim`).
- **Private Cloud Run services, scaled to zero.** `clamav` and `preview` in `australia-southeast1`, without unauthenticated access, running as `clamav-runtime` and `preview-runtime`, which hold no project roles. The functions runtime calls them with Google ID tokens (`fn-runtime` already has `roles/run.invoker`). The preview service gets bytes and returns bytes: it has no storage access, so a converter compromised by a hostile document reaches nothing.
- **Deployed by `deploy.yml`, not Terraform.** Terraform owns the runtime accounts, the deployer's `actAs` on them and the `services` Artifact Registry repository (with a cleanup policy). The deploy workflow builds both images from the release's bundle and runs `gcloud run deploy`, like the jobs image (ADR-014). It then reads each service's URL and appends `CLAMAV_SCAN_URL` and `PREVIEW_SERVICE_URL` to the functions' `.env`, so no repository variable has to be kept in step with a deployed service, and an environment without the services fails closed.
- **Signatures are at most a day old.** The scanner image runs `freshclam` at build time, `scanner-signatures.yml` rebuilds and redeploys it daily (dev; prod joins at launch), every release rebuilds it, and `freshclam` also runs inside the container (hourly checks, `NotifyClamd`). A mirror outage never blocks a scan: the image's signatures still work.
- **Previews are a Cloud Tasks queue.** After a version is stored, `startRenditions` enqueues `documents-render` for Office and HEIC files. The task reads the stored version, calls the preview service, checks the output's magic bytes, writes `renditions/v{n}/preview.pdf` or `preview.jpg` and records it with `recordRendition`. A file that can't be converted (415/422) ends without a preview; a timeout or outage retries with backoff. The web viewer already asks for these renditions.

## Consequences

- A cold scanner takes about 20 seconds to load its signatures. The first scan after a quiet spell can exceed the 60-second scan timeout and show "Scanning delayed" briefly; `documents-rescan` retries a minute later against the warm instance.
- Prod needs the Terraform applied (`clamav-runtime`, `preview-runtime`, the `services` repository) before the first prod release, and a `production` job in `scanner-signatures.yml` at launch.
- A new runtime config value needs a line in deploy.yml's "Point the functions at the document services" step.

## Alternatives considered

- **Cloud Run services in Terraform with the image ignored.** Rejected: the deploy workflow already builds and deploys Cloud Run images, and splitting a service between Terraform (config) and the workflow (image) makes every setting change a two-place edit.
- **A Cloud Run job execution per upload for previews.** Rejected in ADR-028: too slow to start and too heavy per file.
- **freshclam only at container start.** Rejected: Cloud Run instances can live for hours, the ClamAV mirror rate-limits shared cloud IPs, and a cold start shouldn't wait on a download.
- **The functions convert in-process.** Not possible: no LibreOffice or libheif in the functions runtime, and a hostile document would run its converter beside the Firestore credentials.
