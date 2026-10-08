import { DOWNLOAD_NAVIGATOR, FILE_FETCHER, SHARE_MAX_BYTES, WEB_SHARE, type WebShare } from './document-actions';
import { detailsProblem } from './document-details';
import { PREVIEW_UNAVAILABLE, TEXT_PREVIEW_MAX } from './document-preview';
import { DOCUMENT_CATEGORIES } from './documents-view';
import { PDF_PROBLEM_COPY, PDF_RETRY_MS, PDFJS_LOADER, pdfProblem, SCANNED_PAGE_COPY } from './pdf-viewer';
import { fakePdfJs, FakeUploadPort, InViewObserver, pipelineUpload, storedDocument, storedVersion } from './testing';
import { UPLOAD_PORT } from './upload-port';
import type { AuthSession } from '../../core/auth/auth-port';
import { cleanUpOverlays, MATTER, openMatter, PARALEGAL, READONLY, type FakeCallable } from '../matter-detail/testing';

/** The document viewer and its details panel (CORE-12). Fictional data only. */

const DOCS = `${MATTER}/documents`;
const BASE = '/matters/m-whitfield/documents';
type Page = Awaited<ReturnType<typeof openMatter>>;
type Seed = Record<string, unknown>;

const realFetch = globalThis.fetch;
const realObserver = globalThis.IntersectionObserver;
beforeEach(() => {
  globalThis.IntersectionObserver = InViewObserver as unknown as typeof IntersectionObserver;
});
afterEach(() => {
  cleanUpOverlays();
  globalThis.fetch = realFetch;
  globalThis.IntersectionObserver = realObserver;
});

/** `fetch` answering every signed URL with `body`. */
function serve(body: string | object, status = 200): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url));
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, { status });
  }) as typeof fetch;
  return urls;
}

const signedUrl = (data: Seed) =>
  `https://files.example.test/${String(data['docId'])}/v${String(data['version'] ?? 'current')}/${String(data['rendition'] ?? 'download')}?X-Goog-Expires=300`;

/** The `documents-*` callables as the server runs them. */
function documentCallables(overrides: Record<string, FakeCallable> = {}): Record<string, FakeCallable> {
  const patch = (fs: Page['firestore'], id: string, change: Seed) =>
    fs.set(`${DOCS}/${id}`, { ...(fs.get(`${DOCS}/${id}`) as Seed), ...change });
  return {
    'documents-getDownloadUrl': (data) => ({ url: signedUrl(data), expiresAt: '2026-10-04T00:05:00Z' }),
    'documents-restoreVersion': (data, fs) => {
      const id = String(data['docId']);
      const doc = fs.get(`${DOCS}/${id}`) as Seed & { versions: Seed[]; version: number };
      const from = doc.versions.find((v) => v['version'] === data['version']) as Seed;
      const version = doc.version + 1;
      patch(fs, id, {
        version,
        versionSeq: version,
        versions: [
          ...doc.versions,
          { ...storedVersion(id, version, String(from['fileName'])), restoredFrom: from['version'] },
        ],
      });
      return { docId: id, version, restoredFrom: data['version'] };
    },
    'documents-bulkUpdate': (data, fs) => {
      const change = data['change'] as Seed;
      for (const id of data['docIds'] as string[]) {
        patch(
          fs,
          id,
          change['op'] === 'delete' ? { deletedAt: new Date(), deletedBy: 'user-jordan' } : { deletedAt: null },
        );
      }
      return { updated: (data['docIds'] as string[]).length, skipped: [] };
    },
    'documents-saveAttachment': () => ({ docId: 'd-saved', fileName: 'Schedule.txt' }),
    'documents-resolveDuplicate': (data) => ({ docId: data['docId'], action: data['action'] }),
    ...overrides,
  };
}

interface ViewerOptions {
  session?: AuthSession;
  docs?: Record<string, Seed>;
  callables?: Record<string, FakeCallable>;
  pdf?: ReturnType<typeof fakePdfJs>;
  /** The device's share sheet (none by default, as on most desktops). */
  share?: WebShare | null;
}

/** A file's text (jsdom's `File` has no `text()`). */
function readText(blob: Blob | undefined): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => resolve('');
    if (blob) reader.readAsText(blob);
    else resolve('');
  });
}

/** A share sheet that records what it was given, and fails the way `fail` names. */
function fakeShare(fail?: () => string | undefined) {
  const shared: ShareData[] = [];
  const share: WebShare = {
    canShare: (data) => !!data.files?.length,
    share: async (data) => {
      const name = fail?.();
      if (name) throw Object.assign(new Error(name), { name });
      shared.push(data);
    },
  };
  return { share, shared };
}

/** Opens a document in the viewer with the fakes wired in. */
async function view(url: string, options: ViewerOptions = {}) {
  const pdf = options.pdf ?? fakePdfJs({ pages: 3 });
  const downloads: string[] = [];
  const uploads = new FakeUploadPort();
  const page = await openMatter(url, {
    ...(options.session ? { session: options.session } : {}),
    configure: (fs) => {
      for (const [id, doc] of Object.entries(options.docs ?? { 'd-will': will() })) fs.set(`${DOCS}/${id}`, doc);
    },
    callables: documentCallables(options.callables),
    providers: [
      { provide: PDFJS_LOADER, useValue: pdf.load },
      { provide: PDF_RETRY_MS, useValue: 0 },
      { provide: DOWNLOAD_NAVIGATOR, useValue: (href: string) => downloads.push(href) },
      { provide: UPLOAD_PORT, useValue: uploads },
      { provide: WEB_SHARE, useValue: options.share ?? null },
      { provide: FILE_FETCHER, useValue: (url: string) => Promise.resolve(new Blob([`bytes of ${url}`])) },
    ],
  });
  await settle(page);
  return { ...page, pdf, downloads, uploads };
}

const settle = async (page: Page) => {
  for (let i = 0; i < 5; i++) await page.stable(5);
};

/** The will, with two stored versions. */
function will(extra: Seed = {}): Seed {
  return storedDocument('d-will', 'Will of Margaret Whitfield.pdf', {
    version: 2,
    versionSeq: 2,
    versions: [
      storedVersion('d-will', 1, 'Will draft.pdf', { pageCount: 3 }),
      storedVersion('d-will', 2, 'Will of Margaret Whitfield.pdf', { pageCount: 3 }),
    ],
    tags: ['original'],
    ...extra,
  });
}

const preview = (page: Page) => page.body.querySelector<HTMLElement>('mt-document-preview') as HTMLElement;
const details = (page: Page) => page.body.querySelector<HTMLElement>('mt-document-details') as HTMLElement;
const getUrlCalls = (page: Page) => page.calls('documents-getDownloadUrl');

describe('document viewer', () => {
  it('previews a PDF from a signed URL, at the cited page, rendering pages as they come into view', async () => {
    const page = await view(`${BASE}/d-will?page=2`);
    expect(page.text(page.body.querySelector('mt-document-page h2'))).toBe('Will of Margaret Whitfield.pdf');
    expect(getUrlCalls(page)).toEqual([
      expect.objectContaining({ matterId: 'm-whitfield', docId: 'd-will', version: 2, rendition: 'original' }),
    ]);
    expect(page.pdf.opened).toEqual(['https://files.example.test/d-will/v2/original?X-Goog-Expires=300']);
    const viewer = page.body.querySelector<HTMLElement>('mt-pdf-viewer') as HTMLElement;
    expect(page.text(viewer.querySelector('[role="toolbar"]'))).toContain('Page 2 of 3');
    expect(viewer.querySelectorAll('.page')).toHaveLength(3);
    expect(viewer.querySelectorAll('.page[data-rendered] canvas[aria-hidden="true"]')).toHaveLength(3);
    // Each page's text is PDF.js's text layer over the canvas: there for screen readers, find and select.
    expect(page.text(viewer.querySelector('[data-page="1"] .textLayer'))).toBe('Fictional page 1');
    expect(viewer.querySelectorAll('.textLayer')).toHaveLength(3);
    expect(page.calls('documents-citationText')).toEqual([]);

    await page.click('Next page', viewer);
    await settle(page);
    expect(page.router.url).toBe(`${BASE}/d-will?page=3`);
    expect(page.text(viewer.querySelector('[role="toolbar"]'))).toContain('Page 3 of 3');
    await page.click('Previous page', viewer);
    expect(page.router.url).toBe(`${BASE}/d-will?page=2`);
  });

  it('reads out a scanned page’s OCR text, asking for the next pages’ in the same call (SEC-06b)', async () => {
    const page = await view(`${BASE}/d-will`, {
      pdf: fakePdfJs({ pages: 3, texts: { 2: null, 3: ' ' } }),
      callables: {
        'documents-citationText': (data) => ({
          version: data['version'],
          pages: [{ page: 2, text: 'Fictional affidavit of\nexecution', ocr: true }],
          truncated: false,
        }),
      },
    });
    const viewer = page.body.querySelector<HTMLElement>('mt-pdf-viewer') as HTMLElement;
    expect(viewer.querySelectorAll('.textLayer')).toHaveLength(1);
    expect(page.text(viewer.querySelector('[data-page="2"] [data-scan-text].mt-sr'))).toBe(
      `${SCANNED_PAGE_COPY.text} Fictional affidavit of execution`,
    );
    // Nothing stored for page 3 (a blank or unread page).
    expect(page.text(viewer.querySelector('[data-page="3"] [data-scan-text]'))).toBe(SCANNED_PAGE_COPY.none);
    expect(page.calls('documents-citationText')).toEqual([
      expect.objectContaining({ matterId: 'm-whitfield', docId: 'd-will', version: 2, pages: [2, 3] }),
    ]);
  });

  it('says when a scanned page’s text didn’t load', async () => {
    const page = await view(`${BASE}/d-will`, {
      pdf: fakePdfJs({ pages: 2, texts: { 1: null } }),
      callables: {
        'documents-citationText': () => {
          throw { code: 'functions/unavailable', message: 'offline' };
        },
      },
    });
    const viewer = page.body.querySelector<HTMLElement>('mt-pdf-viewer') as HTMLElement;
    expect(page.text(viewer.querySelector('[data-page="1"] [data-scan-text]'))).toBe(SCANNED_PAGE_COPY.failed);
    expect(page.text(viewer.querySelector('[data-page="2"] .textLayer'))).toBe('Fictional page 2');
  });

  it('shows an older version when asked, with a way back', async () => {
    const page = await view(`${BASE}/d-will?v=1`);
    expect(page.text(page.body)).toContain('You’re looking at version 1.');
    expect(getUrlCalls(page).at(-1)).toMatchObject({ version: 1, rendition: 'original' });
    await page.click('Show the current version');
    await settle(page);
    expect(getUrlCalls(page).at(-1)).toMatchObject({ version: 2 });
  });

  it('explains a password-protected or damaged PDF instead of failing', async () => {
    const page = await view(`${BASE}/d-will`, { pdf: fakePdfJs({ error: { name: 'PasswordException' } }) });
    expect(page.text(preview(page))).toContain(PDF_PROBLEM_COPY.encrypted);
    expect(pdfProblem({ name: 'InvalidPDFException' })).toBe('corrupt');
    expect(pdfProblem(new Error('network'))).toBe('failed');
  });

  it('doesn’t try to open a PDF the pipeline found password-protected', async () => {
    const flagged = await view(`${BASE}/d-will`, {
      docs: {
        'd-will': will({
          versions: [storedVersion('d-will', 1, 'a.pdf'), storedVersion('d-will', 2, 'b.pdf', { encrypted: true })],
        }),
      },
    });
    expect(flagged.text(preview(flagged))).toContain('password-protected');
    expect(flagged.pdf.opened).toEqual([]);
    expect(flagged.buttons('Download', preview(flagged)).length).toBe(1);
  });

  it('says a damaged PDF can’t be previewed', async () => {
    const page = await view(`${BASE}/d-will`, { pdf: fakePdfJs({ error: { name: 'InvalidPDFException' } }) });
    expect(page.text(preview(page))).toContain(PDF_PROBLEM_COPY.corrupt);
  });

  it('opens a PDF once more by itself when it doesn’t load the first time', async () => {
    const page = await view(`${BASE}/d-will`, { pdf: fakePdfJs({ pages: 3, failures: 1 }) });
    const viewer = page.body.querySelector<HTMLElement>('mt-pdf-viewer') as HTMLElement;
    expect(page.text(viewer.querySelector('[role="toolbar"]'))).toContain('Page 1 of 3');
    expect(page.pdf.opened).toEqual([
      'https://files.example.test/d-will/v2/original?X-Goog-Expires=300',
      'https://files.example.test/d-will/v2/original?X-Goog-Expires=300',
    ]);
    expect(getUrlCalls(page)).toHaveLength(1);
  });

  it('offers to try again with a new link when a PDF still doesn’t load', async () => {
    const page = await view(`${BASE}/d-will`, { pdf: fakePdfJs({ pages: 3, failures: 2 }) });
    expect(page.text(preview(page))).toContain(PDF_PROBLEM_COPY.failed);
    expect(page.pdf.opened).toHaveLength(2);
    await page.click('Try again', preview(page));
    await settle(page);
    expect(getUrlCalls(page)).toHaveLength(2);
    expect(page.pdf.opened).toHaveLength(3);
    expect(page.text(preview(page).querySelector('[role="toolbar"]'))).toContain('Page 1 of 3');
  });

  it('keeps the preview open while the document changes around the same version', async () => {
    const page = await view(`${BASE}/d-will`);
    expect(getUrlCalls(page)).toHaveLength(1);
    // What ingestion and indexing do after an upload: the document changes, its version doesn't.
    page.firestore.set(`${DOCS}/d-will`, will({ name: 'Signed will.pdf' }));
    await settle(page);
    expect(page.text(page.body.querySelector('mt-document-page h2'))).toBe('Signed will.pdf');
    expect(getUrlCalls(page)).toHaveLength(1);
    expect(page.pdf.opened).toHaveLength(1);

    const versions = will()['versions'] as Seed[];
    page.firestore.set(
      `${DOCS}/d-will`,
      will({ version: 3, versionSeq: 3, versions: [...versions, storedVersion('d-will', 3, 'Will (signed).pdf')] }),
    );
    await settle(page);
    expect(getUrlCalls(page)).toHaveLength(2);
    expect(page.pdf.opened.at(-1)).toBe('https://files.example.test/d-will/v3/original?X-Goog-Expires=300');
  });

  it('shows an Office file’s preview once its PDF rendition lands', async () => {
    const letter = (renditions?: Seed) =>
      storedDocument('d-letter', 'Letter.docx', {
        versions: [storedVersion('d-letter', 1, 'Letter.docx', renditions ? { renditions } : {})],
      });
    const page = await view(`${BASE}/d-letter`, {
      docs: { 'd-letter': letter() },
      callables: {
        'documents-getDownloadUrl': (data, fs) => {
          const [version] = (fs.get(`${DOCS}/d-letter`) as { versions: { renditions?: Seed }[] }).versions;
          if (data['rendition'] === 'previewPdf' && !version?.renditions?.['previewPdf']) {
            throw {
              code: 'functions/failed-precondition',
              details: { code: 'FAILED_PRECONDITION', reason: 'rendition_unavailable' },
            };
          }
          return { url: signedUrl(data), expiresAt: '2026-10-04T00:05:00Z' };
        },
      },
    });
    expect(page.text(preview(page))).toContain(PREVIEW_UNAVAILABLE);
    page.firestore.set(
      `${DOCS}/d-letter`,
      letter({ previewPdf: 'orgs/org-harbour-vine/matters/m-whitfield/documents/d-letter/renditions/v1/preview.pdf' }),
    );
    await settle(page);
    expect(page.pdf.opened).toEqual(['https://files.example.test/d-letter/v1/previewPdf?X-Goog-Expires=300']);
  });

  it('shows images inline, and says when one can’t be shown', async () => {
    const photo = storedDocument('d-photo', 'Garden.png', {
      versions: [storedVersion('d-photo', 1, 'Garden.png', { mime: 'image/png' })],
    });
    const page = await view(`${BASE}/d-photo`, { docs: { 'd-photo': photo } });
    const img = preview(page).querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('https://files.example.test/d-photo/v1/original?X-Goog-Expires=300');
    expect(img.alt).toBe('Garden.png');
    img.dispatchEvent(new Event('error'));
    await page.stable();
    expect(page.text(preview(page))).toContain('This image couldn’t be shown.');
  });

  it('shows plain text, only the start of a long file', async () => {
    const urls = serve('Fictional note. '.repeat(20_000));
    const note = storedDocument('d-note', 'File note.txt', {
      versions: [storedVersion('d-note', 1, 'File note.txt', { mime: 'text/plain' })],
    });
    const page = await view(`${BASE}/d-note`, { docs: { 'd-note': note } });
    expect(urls).toEqual(['https://files.example.test/d-note/v1/original?X-Goog-Expires=300']);
    const pre = preview(page).querySelector('pre') as HTMLElement;
    expect(pre.textContent?.length).toBe(TEXT_PREVIEW_MAX);
    expect(page.text(preview(page))).toContain('Only the start of this file is shown.');
  });

  it('offers to try again when the file can’t be fetched', async () => {
    serve('nope', 500);
    const note = storedDocument('d-note', 'File note.txt', {
      versions: [storedVersion('d-note', 1, 'File note.txt', { mime: 'text/plain' })],
    });
    const page = await view(`${BASE}/d-note`, { docs: { 'd-note': note } });
    expect(page.buttons('Try again', preview(page))).toHaveLength(1);
    serve('Fictional note.');
    await page.click('Try again', preview(page));
    await settle(page);
    expect(page.text(preview(page).querySelector('pre'))).toBe('Fictional note.');
  });

  it('says Office files preview later, and downloads instead', async () => {
    const letter = storedDocument('d-letter', 'Letter.docx', {
      versions: [storedVersion('d-letter', 1, 'Letter.docx')],
    });
    const page = await view(`${BASE}/d-letter`, {
      docs: { 'd-letter': letter },
      callables: {
        'documents-getDownloadUrl': (data) => {
          if (data['rendition'] === 'previewPdf') {
            throw {
              code: 'functions/failed-precondition',
              details: { code: 'FAILED_PRECONDITION', reason: 'rendition_unavailable' },
            };
          }
          return { url: signedUrl(data), expiresAt: '2026-10-04T00:05:00Z' };
        },
      },
    });
    expect(page.text(preview(page))).toContain(PREVIEW_UNAVAILABLE);
    await page.click('Download', preview(page));
    await settle(page);
    expect(page.downloads).toEqual(['https://files.example.test/d-letter/v1/download?X-Goog-Expires=300']);
  });

  it('says a zip has no preview', async () => {
    const zip = storedDocument('d-zip', 'Bundle.zip', { versions: [storedVersion('d-zip', 1, 'Bundle.zip')] });
    const page = await view(`${BASE}/d-zip`, { docs: { 'd-zip': zip } });
    expect(page.text(preview(page))).toContain('Zip files can’t be previewed.');
  });

  it('shows an email as headers, body and attachments, and saves an attachment to the matter', async () => {
    const urls = serve({
      format: 'message.v1',
      subject: 'Fictional schedule of assets',
      from: { name: 'Avery Quill', address: 'avery@example.test' },
      to: [{ name: 'Jordan Price', address: 'jordan@example.test' }],
      cc: [],
      date: '2026-10-01T23:00:00Z',
      text: 'Please find the fictional schedule attached.',
      textTruncated: false,
      attachments: [
        { index: 0, fileName: 'Schedule.txt', mime: 'text/plain', sizeBytes: 60, savable: true },
        { index: 1, fileName: 'tool.exe', mime: 'application/octet-stream', sizeBytes: 60, savable: false },
      ],
      attachmentsTruncated: false,
    });
    const mail = storedDocument('d-mail', 'Schedule letter.eml', {
      versions: [storedVersion('d-mail', 1, 'Schedule letter.eml', { mime: 'message/rfc822' })],
    });
    const page = await view(`${BASE}/d-mail`, { docs: { 'd-mail': mail } });
    expect(urls).toEqual(['https://files.example.test/d-mail/v1/message?X-Goog-Expires=300']);
    const message = page.text(preview(page));
    expect(message).toContain('Fictional schedule of assets');
    expect(message).toContain('Avery Quill');
    expect(message).toContain('Please find the fictional schedule attached.');
    expect(message).toContain('This type can’t be saved');

    await page.click('Save Schedule.txt to the matter', preview(page));
    await settle(page);
    expect(page.calls('documents-saveAttachment')).toEqual([
      expect.objectContaining({ matterId: 'm-whitfield', docId: 'd-mail', version: 1, attachmentIndex: 0 }),
    ]);
    expect(page.text(page.body)).toContain('Schedule.txt saved to the matter');
  });

  it('says when an email rendition can’t be read', async () => {
    serve({ format: 'something else' });
    const mail = storedDocument('d-mail', 'Schedule letter.eml', {
      versions: [storedVersion('d-mail', 1, 'Schedule letter.eml')],
    });
    const page = await view(`${BASE}/d-mail`, { docs: { 'd-mail': mail } });
    expect(page.text(preview(page))).toContain('This email couldn’t be read.');
  });

  it('downloads the current version through a signed URL', async () => {
    const page = await view(`${BASE}/d-will`);
    const head = page.body.querySelector<HTMLElement>('mt-document-page .head') as HTMLElement;
    await page.click('Download', head);
    await settle(page);
    expect(page.downloads).toEqual(['https://files.example.test/d-will/v2/download?X-Goog-Expires=300']);
  });

  it('shares the file itself through the device’s share sheet, never the link (MOB-02)', async () => {
    const device = fakeShare();
    const page = await view(`${BASE}/d-will`, { share: device.share });
    const head = page.body.querySelector<HTMLElement>('mt-document-page .head') as HTMLElement;
    await page.click('Share', head);
    await settle(page);
    expect(getUrlCalls(page).at(-1)).toEqual(
      expect.objectContaining({ docId: 'd-will', version: 2, rendition: 'original' }),
    );
    expect(device.shared).toHaveLength(1);
    const [file] = device.shared[0]?.files ?? [];
    expect(file?.name).toBe('Will of Margaret Whitfield.pdf');
    expect(file?.type).toBe('application/pdf');
    expect(await readText(file)).toBe('bytes of https://files.example.test/d-will/v2/original?X-Goog-Expires=300');
    expect(device.shared[0]?.url).toBeUndefined();
    // Again: the file is already read.
    const reads = getUrlCalls(page).length;
    await page.click('Share', head);
    await settle(page);
    expect(device.shared).toHaveLength(2);
    expect(getUrlCalls(page)).toHaveLength(reads);
  });

  it('asks for one more tap when reading the file took too long to share at once', async () => {
    let failures = ['NotAllowedError'];
    const device = fakeShare(() => failures.shift());
    const page = await view(`${BASE}/d-will`, { share: device.share });
    await page.click('Share', page.body.querySelector('mt-document-page .head') ?? page.body);
    await settle(page);
    const toast = page.body.querySelector<HTMLElement>('.mt-toast') as HTMLElement;
    expect(page.text(toast)).toContain('Ready to share');
    await page.click('Share', toast);
    await settle(page);
    expect(device.shared).toHaveLength(1);

    // Closing the share sheet says nothing.
    failures = ['AbortError'];
    cleanUpOverlays();
    await page.click('Share', page.body.querySelector('mt-document-page .head') ?? page.body);
    await settle(page);
    expect(page.body.querySelector('.mt-toast')).toBeNull();
  });

  it('downloads instead of sharing a file too big for the share sheet', async () => {
    const big = will({
      versions: [storedVersion('d-will', 2, 'Will of Margaret Whitfield.pdf', { sizeBytes: SHARE_MAX_BYTES + 1 })],
    });
    const device = fakeShare();
    const page = await view(`${BASE}/d-will`, { share: device.share, docs: { 'd-will': big } });
    await page.click('Share', page.body.querySelector('mt-document-page .head') ?? page.body);
    await settle(page);
    expect(device.shared).toEqual([]);
    expect(page.downloads).toEqual(['https://files.example.test/d-will/v2/download?X-Goog-Expires=300']);
  });

  it('offers no Share on a device without a share sheet', async () => {
    const page = await view(`${BASE}/d-will`);
    expect(page.body.querySelector('mt-document-page [data-share]')).toBeNull();
    expect(page.buttons('Download', page.body.querySelector('mt-document-page .head') ?? page.body)).toHaveLength(1);
  });

  it('zooms a PDF with the buttons, the keyboard and a pinch, and redraws it sharp (MOB-02)', async () => {
    const page = await view(`${BASE}/d-will`);
    const viewer = page.body.querySelector<HTMLElement>('mt-pdf-viewer') as HTMLElement;
    const pages = viewer.querySelector<HTMLElement>('.pages') as HTMLElement;
    const zoom = () => pages.style.getPropertyValue('--mt-pdf-zoom');
    const fit = () => viewer.querySelector<HTMLButtonElement>('[data-zoom-fit]') as HTMLButtonElement;
    expect(page.text(fit())).toBe('100%');
    expect(fit().disabled).toBe(true);
    expect(viewer.querySelector<HTMLButtonElement>('[data-zoom-out]')?.disabled).toBe(true);
    const drawn = page.pdf.rendered.length;

    await page.click('Zoom in', viewer);
    await page.click('Zoom in', viewer);
    expect(zoom()).toBe('1.5');
    expect(fit().getAttribute('aria-label')).toBe('Zoom 150%. Fit to width');
    await page.stable(300);
    await settle(page);
    // The pages in view redraw at the new size.
    expect(page.pdf.rendered.length).toBe(drawn + 3);
    expect(viewer.querySelectorAll('.page canvas')).toHaveLength(3);

    await page.press('-', {}, pages);
    expect(zoom()).toBe('1.25');
    await page.press('0', {}, pages);
    expect(zoom()).toBe('1');

    // Two fingers spreading to twice as far apart: 200%.
    const fingers = (type: string, apart: number) => {
      const event = new Event(type);
      const touches = [
        { clientX: 100, clientY: 200 },
        { clientX: 100 + apart, clientY: 200 },
      ];
      Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : touches });
      pages.dispatchEvent(event);
    };
    fingers('touchstart', 100);
    fingers('touchmove', 200);
    fingers('touchend', 200);
    await page.stable();
    expect(zoom()).toBe('2');
    fingers('touchstart', 100);
    fingers('touchmove', 1000);
    await page.stable();
    expect(zoom()).toBe('3');
    expect(viewer.querySelector<HTMLButtonElement>('[data-zoom-in]')?.disabled).toBe(true);
  });

  it('says why a download failed', async () => {
    const page = await view(`${BASE}/d-will`, {
      callables: {
        'documents-getDownloadUrl': () => {
          throw {
            code: 'functions/failed-precondition',
            details: { code: 'FAILED_PRECONDITION', reason: 'not_scanned' },
          };
        },
      },
    });
    expect(page.text(preview(page))).toContain('hasn’t passed the malware check');
    await page.click('Download', page.body.querySelector('mt-document-page .head') ?? page.body);
    await settle(page);
    expect(page.text(page.body)).toContain('Couldn’t download the file');
    expect(page.downloads).toEqual([]);
  });

  it('says a document still being checked can’t be opened yet', async () => {
    const scanning = storedDocument('d-new', 'Statement.pdf', {
      version: 0,
      versions: [],
      scan: { status: 'pending' },
      upload: pipelineUpload('delayed', { fileName: 'Statement.pdf' }),
    });
    const page = await view(`${BASE}/d-new`, { docs: { 'd-new': scanning } });
    expect(page.text(page.body)).toContain('Scanning delayed');
    expect(page.text(page.body)).toContain('Not ready to open');
    expect(page.text(details(page))).toContain('No stored version yet.');
    expect(getUrlCalls(page)).toEqual([]);
  });

  it('offers keep or discard for a possible duplicate', async () => {
    const copy = storedDocument('d-copy', 'Will (2).pdf', { duplicateOf: 'd-will' });
    const page = await view(`${BASE}/d-copy`, { docs: { 'd-will': will(), 'd-copy': copy } });
    expect(page.text(page.body)).toContain('Duplicate of Will of Margaret Whitfield.pdf.');
    await page.click('Keep both', page.body.querySelector('mt-document-page') ?? page.body);
    await settle(page);
    expect(page.calls('documents-resolveDuplicate')).toEqual([
      expect.objectContaining({ docId: 'd-copy', action: 'keep' }),
    ]);
  });
});

describe('document details', () => {
  it('renames, recategorises, tags and notes a document', async () => {
    const page = await view(`${BASE}/d-will`);
    await page.fill('Name', 'Will (fictional).pdf', details(page));
    // The native picker's options are indexed.
    await page.fill('Category', String(DOCUMENT_CATEGORIES.indexOf('grant')), details(page));
    await page.fill('Tags', 'original, signed, original', details(page));
    await page.fill('Notes', 'Kept in the strongroom.', details(page));
    await page.submit(details(page));
    await settle(page);
    expect(page.firestore.get(`${DOCS}/d-will`)).toMatchObject({
      name: 'Will (fictional).pdf',
      category: 'grant',
      tags: ['original', 'signed'],
      notes: 'Kept in the strongroom.',
    });
    expect(page.text(page.body.querySelector('mt-document-page h2'))).toBe('Will (fictional).pdf');
    expect(page.text(page.body)).toContain('Document details saved');
  });

  it('checks the details before saving', async () => {
    const page = await view(`${BASE}/d-will`);
    await page.fill('Name', '   ', details(page));
    expect(page.text(details(page))).toContain(detailsProblem('', [], '') ?? 'missing');
    await page.submit(details(page));
    expect(page.firestore.get(`${DOCS}/d-will`)?.['name']).toBe('Will of Margaret Whitfield.pdf');
    expect(
      detailsProblem(
        'Will.pdf',
        Array.from({ length: 21 }, (_, i) => `t${i}`),
        '',
      ),
    ).toBeTruthy();
    expect(detailsProblem('Will.pdf', ['x'.repeat(41)], '')).toBeTruthy();
    expect(detailsProblem('Will.pdf', [], 'x'.repeat(5001))).toBeTruthy();
    expect(detailsProblem('Will.pdf', ['estate'], 'Fine.')).toBeNull();
  });

  it('marks a document privileged', async () => {
    const page = await view(`${BASE}/d-will`);
    details(page).querySelector<HTMLElement>('mt-switch button')?.click();
    await settle(page);
    expect(page.firestore.get(`${DOCS}/d-will`)?.['privileged']).toBe(true);
    expect(page.text(page.body)).toContain('Marked privileged');
  });

  it('lists versions, restores an earlier one and downloads any', async () => {
    const page = await view(`${BASE}/d-will`);
    const versions = details(page).querySelector('.versions') as HTMLElement;
    expect(page.text(versions)).toContain('Version 2 (current)');
    expect(page.buttons('Restore version 2', versions)).toHaveLength(0);

    await page.click('Download version 1', versions);
    await settle(page);
    expect(page.downloads).toEqual(['https://files.example.test/d-will/v1/download?X-Goog-Expires=300']);

    await page.click('Restore version 1', versions);
    await settle(page);
    expect(page.calls('documents-restoreVersion')).toEqual([
      expect.objectContaining({ matterId: 'm-whitfield', docId: 'd-will', version: 1 }),
    ]);
    expect(page.text(details(page).querySelector('.versions'))).toContain('Version 3 (current)');
    expect(page.text(details(page).querySelector('.versions'))).toContain('restored from version 1');
    expect(page.text(page.body)).toContain('Version 1 restored');
  });

  it('uploads a new version of the document', async () => {
    const page = await view(`${BASE}/d-will`);
    const input = details(page).querySelector<HTMLInputElement>('[data-testid="version-upload-input"]');
    if (!input) throw new Error('No version input');
    Object.defineProperty(input, 'files', {
      value: [new File(['Fictional signed will'], 'Will signed.pdf', { type: 'application/pdf' })],
    });
    input.dispatchEvent(new Event('change'));
    await settle(page);
    expect(page.uploads.of('Will signed.pdf').settings.customMetadata['documentId']).toBe('d-will');
    expect(page.text(page.body)).toContain('Uploading a new version');
    expect(page.text(page.body.querySelector('mt-upload-list'))).toContain('Will signed.pdf');
  });

  it('removes and restores the document', async () => {
    const page = await view(`${BASE}/d-will`);
    await page.click('Remove document', details(page));
    await page.click('Remove document', page.dialog() ?? page.body);
    await settle(page);
    expect(page.calls('documents-bulkUpdate')[0]).toMatchObject({ docIds: ['d-will'], change: { op: 'delete' } });
    expect(page.text(page.body.querySelector('mt-document-page h2'))).toBe('Removed document');
    expect(page.text(page.body)).toContain('This document was removed (Will of Margaret Whitfield.pdf).');

    await page.click('Restore document', details(page));
    await settle(page);
    expect(page.calls('documents-bulkUpdate')[1]).toMatchObject({ change: { op: 'restore' } });
    expect(page.text(page.body.querySelector('mt-document-page h2'))).toBe('Will of Margaret Whitfield.pdf');
  });

  it('is read-only for a read-only member, without the privileged switch', async () => {
    const page = await view(`${BASE}/d-will`, { session: READONLY });
    expect(details(page).querySelector('form')).toBeNull();
    expect(page.text(details(page))).toContain('original');
    expect(details(page).querySelector('mt-switch')).toBeNull();
    expect(page.buttons('Restore version 1', details(page))).toHaveLength(0);
    expect(page.buttons('Remove document', details(page))).toHaveLength(0);
    expect(page.buttons('Download version 1', details(page))).toHaveLength(1);
  });

  it('lets a paralegal edit but not remove', async () => {
    const page = await view(`${BASE}/d-will`, { session: PARALEGAL });
    expect(details(page).querySelector('form')).not.toBeNull();
    expect(details(page).querySelector('mt-switch')).toBeNull();
    expect(page.buttons('Remove document', details(page))).toHaveLength(0);
  });

  it('says only that a document is not available when it can’t be read', async () => {
    const page = await view(`${BASE}/d-missing`, { session: READONLY });
    expect(page.text(page.body)).toContain('Document not available');
  });

  it('says a document the rules refuse is not available, without naming it', async () => {
    const page = await view(`${BASE}`, {
      session: READONLY,
      docs: { 'd-advice': storedDocument('d-advice', 'Advice on the claim.pdf', { privileged: true }) },
    });
    page.firestore.failNext({ code: 'permission-denied' });
    await page.router.navigateByUrl(`${BASE}/d-advice`);
    await settle(page);
    expect(page.text(page.body)).toContain('Document not available');
    expect(page.text(page.body)).not.toContain('Advice on the claim');
  });
});
