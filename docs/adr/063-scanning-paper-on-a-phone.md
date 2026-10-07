# ADR-063: Scanning paper on a phone, in the browser and without libraries

- **Status:** Accepted
- **Date:** 2026-10-07
- **Ticket:** [MOB-05](https://linear.app/materia-web/issue/MAT-110)
- **Builds on:** [ADR-020](020-offline-and-pwa.md) (offline and PWA), [ADR-056](056-startup-loads-in-parallel.md) (initial budget), [ADR-060](060-installable-app-updates-and-offline-indicators.md) (the installable app)

## Context

MOB-05 turns photos of a paper document into one PDF on the matter, from Record's "Photo document" tile (`/record/scan`). Each photo needs its page found, cut out and straightened in the browser, the pages put in order, and the result uploaded through CORE-12 as a camera scan. A phone that has lost its connection must keep the scan and upload it later.

The obvious libraries are heavy. OpenCV.js (which jscanify wraps) is about 8 MB, and pdf-lib adds over 100 kB gzip. The ticket allows a lazy library under 1 MB, and the largest lazy chunk is held to 150 kB (ADR-056).

## Decision

**Finding and straightening the page.** `scan-image.ts` works on plain RGBA pixels, so it is tested without a canvas:

- Paper is usually the largest bright region in the photo. A 400px copy is turned grey, blurred and split into light and dark with Otsu's threshold. The page's corners are the largest light region's extremes along the two diagonals.
- A region under 15% of the photo, or over 97% (no edge left to find), finds nothing. The whole photo is used, and the page says "Edges not found" with Adjust corners.
- The page is straightened with a homography from the four corners (bilinear sampling) to at most 2000px on the long edge, then saved as JPEG at quality 0.8. Black and white re-encodes each page in grey when the scan is saved.
- Corners set by hand only need to be convex and cover 1% of the photo, so a receipt can be cropped.

**Photos.** `<input type="file" accept="image/*" capture="environment">` is the baseline. Where `getUserMedia` exists, an in-app camera counts the pages as they're taken. A photo the browser can't decode with `createImageBitmap` goes through an `<img>` (HEIC on Safari) and is refused if that fails too. Pages are made one at a time. Each page keeps a 2600px working copy of its photo for re-cropping and turning, and a 320px thumbnail; the original photo is dropped.

**The PDF.** `scan-pdf.ts` writes the PDF itself: one page per JPEG (DCTDecode, with no re-encoding), the longer side A4's 842pt and the shorter in the photo's proportion. A scan has at most 30 pages and 50 MB (`DOCUMENT_MAX_BYTES`).

**Upload.** The PDF goes through `DocumentUploads` with `source: 'camera'`. Storage rules allow `source` only as `camera`, and the pipeline stores it on the document (`'upload'` otherwise).

**Offline.** Every scan is written to IndexedDB (`materia-scans`) before it uploads, and deleted once the upload is sent. A scan saved offline shows under "Waiting to upload" on Record, with Try again and Delete, and uploads on reconnect. The app checks for waiting scans 5 seconds after start and loads the queue only when one exists. Signing out warns when a scan hasn't uploaded and deletes the queue, so the next person on the device never sees it.

**Loading.** The Scan screen is a lazy route (about 11.5 kB gzip, the PDF writer included). The corner dialog (about 3 kB) and the browser's image work (about 1 kB) load when first used. Only the IndexedDB check for waiting scans is in the initial bundle, which stays at about 125 kB gzip.

## Consequences

- No new dependency, and nothing large for a phone to download before the first photo.
- Finding the page relies on contrast. Paper on a white desk, or a page filling the frame, needs its corners dragged. A model-based detector could replace `detectPage` later without changing the rest.
- A scan waiting on a device is readable by anyone using that browser profile until it uploads or someone signs out. An idle sign-out deletes it too, and the scan is lost.
