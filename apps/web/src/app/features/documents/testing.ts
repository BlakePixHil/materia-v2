import type { DocumentRow } from './documents-view';
import type { UploadHandle, UploadPort, UploadProgress } from './upload-port';
import { UploadCancelled } from './upload-port';

/**
 * Fakes and fixtures for the Documents specs (CORE-12): stored documents as the pipeline writes
 * them, an upload port the test drives, and a PDF.js stand-in. Fictional data only.
 */

type Seed = Record<string, unknown>;

export const DOC_SHA = 'ab'.repeat(32);
const DAY = (day: number) => new Date(`2026-10-0${day}T00:00:00Z`);

/** One clean stored version. */
export function storedVersion(docId: string, version: number, fileName: string, extra: Seed = {}): Seed {
  return {
    version,
    storagePath: `orgs/org-harbour-vine/matters/m-whitfield/documents/${docId}/v${version}`,
    fileName,
    mime: 'application/pdf',
    sizeBytes: 1200,
    sha256: DOC_SHA,
    uploadedAt: DAY(1),
    uploadedBy: 'user-jordan',
    ...extra,
  };
}

/** A stored document (Firestore data) with one clean version named `name`. */
export function storedDocument(docId: string, name: string, extra: Seed = {}): Seed {
  return {
    orgId: 'org-harbour-vine',
    matterId: 'm-whitfield',
    name,
    category: 'will',
    privileged: false,
    tags: [],
    version: 1,
    versionSeq: 1,
    versions: [storedVersion(docId, 1, name)],
    storagePath: `orgs/org-harbour-vine/matters/m-whitfield/documents/${docId}/v1`,
    mime: 'application/pdf',
    sizeBytes: 1200,
    sha256: DOC_SHA,
    scan: { status: 'clean', at: DAY(1) },
    ingest: { status: 'pending' },
    source: 'upload',
    encrypted: false,
    accessRestricted: false,
    deletedAt: null,
    createdAt: DAY(1),
    createdBy: 'user-jordan',
    updatedAt: DAY(1),
    updatedBy: 'user-jordan',
    schemaVersion: 1,
    ...extra,
  };
}

/** The same document as the tab reads it. */
export function docRow(docId: string, name: string, extra: Seed = {}): DocumentRow {
  return { id: docId, ...storedDocument(docId, name, extra) } as unknown as DocumentRow;
}

/** An upload in the pipeline (the document's `upload` field). */
export function pipelineUpload(status: string, extra: Seed = {}): Seed {
  return {
    uploadId: 'up-1',
    fileName: 'Statement.pdf',
    sizeBytes: 10,
    uploadedBy: 'user-jordan',
    at: DAY(2),
    status,
    attempts: 1,
    ...extra,
  };
}

/** One upload the fake port received; the test finishes, fails or reports progress on it. */
export interface FakeTransfer {
  path: string;
  file: Blob;
  settings: { contentType: string; customMetadata: Record<string, string> };
  cancelled: boolean;
  progress(sent: number): void;
  finish(): void;
  fail(error: unknown): void;
}

/** An upload port that keeps every transfer open until the test settles it. */
export class FakeUploadPort implements UploadPort {
  readonly transfers: FakeTransfer[] = [];

  upload(
    path: string,
    file: Blob,
    settings: FakeTransfer['settings'],
    progress: (progress: UploadProgress) => void,
  ): UploadHandle {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const done = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const transfer: FakeTransfer = {
      path,
      file,
      settings,
      cancelled: false,
      progress: (sent) => progress({ sent, total: file.size }),
      finish: () => resolve(),
      fail: (error) => reject(error),
    };
    this.transfers.push(transfer);
    return {
      done,
      cancel: () => {
        transfer.cancelled = true;
        reject(new UploadCancelled());
      },
    };
  }

  /** The transfer for a file name. */
  of(fileName: string): FakeTransfer {
    const found = this.transfers.filter((t) => (t.file as File).name === fileName).at(-1);
    if (!found) throw new Error(`No upload of ${fileName}`);
    return found;
  }
}

/**
 * A PDF.js stand-in: `pages` pages whose text is "Fictional page N" (or `texts[N]`, one text item
 * per line at 12pt; `null` is a scanned page with no text layer), or a load failure.
 */
export function fakePdfJs(
  options: { pages?: number; error?: { name: string }; texts?: Record<number, string | null> } = {},
) {
  const opened: string[] = [];
  const rendered: number[] = [];
  const items = (number: number) => {
    const text = options.texts && number in options.texts ? options.texts[number] : `Fictional page ${number}`;
    return (text ?? '')
      .split('\n')
      .filter(Boolean)
      .map((str, line) => ({
        str,
        transform: [12, 0, 0, 12, 72, 700 - line * 16],
        width: str.length * 6,
        height: 12,
        hasEOL: true,
      }));
  };
  const page = (number: number) => ({
    getViewport: ({ scale }: { scale: number }) => ({
      width: 600 * scale,
      height: 800 * scale,
      transform: [scale, 0, 0, -scale, 0, 800 * scale],
    }),
    render: () => {
      rendered.push(number);
      return { promise: Promise.resolve() };
    },
    getTextContent: () => Promise.resolve({ items: items(number) }),
  });
  const lib = {
    getDocument: (params: { url: string }) => {
      opened.push(params.url);
      const pdf = {
        numPages: options.pages ?? 2,
        getPage: (n: number) => Promise.resolve(page(n)),
        loadingTask: { destroy: () => Promise.resolve() },
      };
      return {
        promise: options.error ? Promise.reject(options.error) : Promise.resolve(pdf),
        destroy: () => Promise.resolve(),
      };
    },
  };
  return { lib, opened, rendered, load: () => Promise.resolve(lib as never) };
}

/** IntersectionObserver for the DOM tests: everything observed is in view at once. */
export class InViewObserver {
  constructor(private readonly callback: (entries: { isIntersecting: boolean; target: Element }[]) => void) {}
  observe(target: Element): void {
    queueMicrotask(() => this.callback([{ isIntersecting: true, target }]));
  }
  disconnect(): void {
    // Nothing to release.
  }
}
