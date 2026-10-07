import { TestBed } from '@angular/core/testing';
import { PDFDocument } from 'pdf-lib';

import { MEDIA_DEVICES } from './scan-camera';
import type { QueuedScan } from './scan-db';
import { indexedDbScanStore } from './scan-db';
import { rotateQuad, WHOLE_PHOTO } from './scan-image';
import { defaultScanName, SCAN_MAX_PAGES, scanFileName } from './scan-page';
import { SCAN_PROCESSOR } from './scan-processor';
import { SCAN_STORE, ScanQueue } from './scan-queue';
import { fakeIndexedDb, fakeProcessor, memoryScanStore, pageOrder, readBytes, stubObjectUrls } from './testing';
import { AccountActions } from '../../core/account/account-actions';
import { DOCUMENT_CATEGORIES } from '../documents/documents-view';
import { FakeUploadPort } from '../documents/testing';
import { UPLOAD_PORT } from '../documents/upload-port';
import { cleanUpOverlays, MATTER, matterDoc, ME, meta, openMatter, ORG, READONLY } from '../matter-detail/testing';

/** Scan a document (MOB-05) against the in-memory Firestore. Every matter and document is fictional. */

type Page = Awaited<ReturnType<typeof openMatter>>;

let urls: ReturnType<typeof stubObjectUrls>;
let onLine: ReturnType<typeof vi.spyOn> | null = null;
/** This device's IndexedDB, where waiting scans are kept. */
let idb: ReturnType<typeof fakeIndexedDb>;

beforeEach(() => {
  urls = stubObjectUrls();
  idb = fakeIndexedDb();
  Object.defineProperty(globalThis, 'indexedDB', { value: idb, configurable: true });
});

afterEach(() => {
  delete (globalThis as { indexedDB?: unknown }).indexedDB;
  urls.restore();
  onLine?.mockRestore();
  onLine = null;
  cleanUpOverlays();
});

function offline(): void {
  onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
}

async function backOnline(page: Page): Promise<void> {
  onLine?.mockReturnValue(true);
  window.dispatchEvent(new Event('online'));
  await page.stable(20);
}

async function openScan(
  url = '/record/scan?matter=m-whitfield',
  options: Parameters<typeof openMatter>[1] & { media?: unknown; refuseStore?: boolean; scans?: QueuedScan[] } = {},
) {
  const processor = fakeProcessor();
  const store = options.refuseStore ? memoryScanStore({ refuse: true }) : indexedDbScanStore(idb);
  for (const scan of options.scans ?? []) await store.put(scan);
  const uploads = new FakeUploadPort();
  const page = await openMatter(url, {
    ...options,
    providers: [
      { provide: SCAN_PROCESSOR, useValue: processor },
      { provide: SCAN_STORE, useValue: store },
      { provide: UPLOAD_PORT, useValue: uploads },
      { provide: MEDIA_DEVICES, useValue: options.media ?? null },
      ...(options.providers ?? []),
    ],
  });
  await page.stable(20);
  const scan = () => page.body.querySelector('mt-scan-page') as HTMLElement;
  /** Chooses photos (the "Choose photos" picker). */
  const choose = async (...names: string[]) => {
    const input = scan().querySelector('[data-testid="scan-files"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      value: names.map((name) => new File([new Uint8Array([1, 2, 3])], name, { type: 'image/jpeg' })),
      configurable: true,
    });
    input.dispatchEvent(new Event('change'));
    await page.stable(20);
    await page.stable(20);
  };
  const rows = () => [...scan().querySelectorAll<HTMLElement>('[data-page-row]')];
  const row = (index: number) => rows()[index] as HTMLElement;
  /** Each row's photo, by the name its thumbnail was made from. */
  const order = () =>
    rows().map((row) => {
      const src = row.querySelector('img')?.getAttribute('src') ?? '';
      return (urls.blobs.get(src) as Blob & { scanName?: string })?.scanName;
    });
  const menu = async (row: number, item: string) => {
    await page.click(`Page ${row} actions`, scan());
    await page.stable(20);
    const found = [...page.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (node) => page.text(node) === item,
    );
    if (!found) throw new Error(`No menu item "${item}"`);
    found.click();
    await page.stable(20);
    await page.stable(20);
  };
  const save = async () => {
    await page.submit(scan());
    await page.stable(20);
    await page.stable(20);
  };
  /** How many scans wait on this device. */
  const waitingCount = async () => (await store.list()).length;
  return { ...page, processor, store, uploads, scan, choose, rows, row, order, menu, save, waitingCount };
}

/** A page row's drag handle. */
const grip = (page: Awaited<ReturnType<typeof openScan>>, index: number) =>
  page.row(index).querySelector('.grip') as HTMLElement;

describe('Scan a document (MOB-05)', () => {
  it('names a scan for today and its file once', () => {
    // The middle of the day in Melbourne, the same day wherever the tests run.
    expect(defaultScanName(new Date('2026-10-07T01:00:00Z'))).toBe('Scan 7 Oct 2026');
    expect(scanFileName('  Death certificate – O’Brien ')).toBe('Death certificate – O’Brien.pdf');
    expect(scanFileName('Grant.PDF')).toBe('Grant.pdf');
  });

  it('starts by asking for photos, with the matter it came from', async () => {
    const page = await openScan();
    expect(page.text(page.scan().querySelector('mt-empty-state'))).toContain('Photograph each page');
    expect(page.buttons('Take photos', page.scan())).toHaveLength(1);
    expect(page.buttons('Choose photos', page.scan())).toHaveLength(1);
    expect(page.scan().querySelector('[data-testid="scan-capture"]')?.getAttribute('capture')).toBe('environment');
    expect(page.body.querySelector('[data-back]')?.getAttribute('aria-label') ?? 'Back to Record').toBe(
      'Back to Record',
    );
  });

  it('makes three photos one PDF in the chosen order and uploads it to the matter as a camera scan', async () => {
    const page = await openScan();
    await page.choose('grant-1.jpg', 'grant-2.jpg', 'plain-3.jpg');
    expect(
      page.rows().map((row) => [page.text(row.querySelector('.tt')), page.text(row.querySelector('.ts'))]),
    ).toEqual([
      ['Page 1', 'Straightened'],
      ['Page 2', 'Straightened'],
      ['Page 3', 'Edges not found. Adjust the corners if it needs cropping.'],
    ]);
    // One page at a time, in the order chosen.
    expect(page.processor.calls.map((call) => call.name)).toEqual(['grant-1.jpg', 'grant-2.jpg', 'plain-3.jpg']);

    // The last page goes first: its handle and the up arrow.
    await page.press('ArrowUp', {}, grip(page, 2));
    await page.press('ArrowUp', {}, grip(page, 1));
    expect(page.order()).toEqual(['plain-3.jpg', 'grant-1.jpg', 'grant-2.jpg']);
    expect(page.text(page.scan().querySelector('[role="status"].mt-sr'))).toBe('Page moved to position 1.');

    await page.click('Black and white', page.scan());
    expect(page.scan().querySelector('.list')?.getAttribute('data-mode')).toBe('grey');
    await page.fill('Name', 'Grant of probate – Whitfield', page.scan());
    await page.fill('Category', String(DOCUMENT_CATEGORIES.indexOf('grant')), page.scan());
    const matter = page.scan().querySelector('[data-testid="scan-matter"]');
    expect([page.text(matter?.querySelector('.num')), page.text(matter?.querySelector('.mt-ell'))]).toEqual([
      'M-2026-0142',
      'Estate of Margaret Whitfield',
    ]);
    await page.save();

    expect(page.processor.greyed).toBe(3);
    const transfer = await vi.waitFor(() => page.uploads.of('Grant of probate – Whitfield.pdf'));
    expect(transfer.path).toMatch(new RegExp(`^orgs/${ORG}/matters/m-whitfield/pending/`));
    expect(transfer.settings.contentType).toBe('application/pdf');
    expect(transfer.settings.customMetadata).toMatchObject({ source: 'camera', category: 'grant' });
    expect(transfer.settings.customMetadata['privileged']).toBeUndefined();
    const bytes = await readBytes(transfer.file);
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(3);
    expect(pdf.getTitle()).toBe('Grant of probate – Whitfield');
    expect(pageOrder(bytes)).toEqual(['plain-3.jpg', 'grant-1.jpg', 'grant-2.jpg']);
    expect(page.router.url).toBe('/matters/m-whitfield/documents');

    // The scan waits on the phone until its bytes are stored, then leaves it.
    expect(await page.waitingCount()).toBe(1);
    transfer.finish();
    await page.stable(20);
    await page.stable(20);
    expect(await page.waitingCount()).toBe(0);
  });

  it('turns a page, and straightens it again from corners dragged by hand', async () => {
    const page = await openScan();
    await page.choose('plain-1.jpg');
    await page.menu(1, 'Turn right');
    expect(page.processor.calls.at(-1)).toEqual({
      name: 'plain-1.jpg',
      quad: rotateQuad([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ]),
    });
    expect(page.text(page.row(0).querySelector('.ts'))).toBe('Straightened');

    await page.menu(1, 'Adjust corners');
    const dialog = await vi.waitFor(() => page.dialog() ?? Promise.reject(new Error('No dialog yet')));
    await page.stable(20);
    expect(page.text(dialog.querySelector('h2'))).toBe('Adjust the corners of page 1');
    const handles = [...dialog.querySelectorAll<HTMLElement>('.handle')];
    expect(handles.map((handle) => handle.getAttribute('aria-label'))).toEqual([
      'Top-left corner, 0% across, 100% down',
      'Top-right corner, 0% across, 0% down',
      'Bottom-right corner, 100% across, 0% down',
      'Bottom-left corner, 100% across, 100% down',
    ]);
    await page.press('ArrowRight', { shiftKey: true }, handles[0] as HTMLElement);
    await page.press('ArrowUp', {}, handles[0] as HTMLElement);
    expect((handles[0] as HTMLElement).getAttribute('aria-label')).toBe('Top-left corner, 5% across, 99% down');
    await page.click('Apply', dialog);
    await page.stable(20);
    expect(page.processor.calls.at(-1)?.quad?.[0]).toEqual({ x: 0.05, y: 0.99 });
  });

  it('won’t take corners that don’t frame a page', async () => {
    const page = await openScan();
    await page.choose('grant-1.jpg');
    await page.menu(1, 'Adjust corners');
    const dialog = await vi.waitFor(() => page.dialog() ?? Promise.reject(new Error('No dialog yet')));
    await page.stable(20);
    const handles = [...dialog.querySelectorAll<HTMLElement>('.handle')];
    // The bottom-right corner dragged over to the top-left: a bow tie.
    for (let i = 0; i < 18; i++) await page.press('ArrowLeft', { shiftKey: true }, handles[2] as HTMLElement);
    for (let i = 0; i < 18; i++) await page.press('ArrowUp', { shiftKey: true }, handles[2] as HTMLElement);
    expect(page.text(dialog.querySelector('[role="alert"]'))).toContain('These corners don’t frame a page.');
    expect(page.buttons('Apply', dialog)[0]?.hasAttribute('disabled')).toBe(true);
    await page.click('Use the whole photo', dialog);
    expect(dialog.querySelector('[role="alert"]')).toBeNull();
    await page.click('Apply', dialog);
    await page.stable(20);
    expect(page.processor.calls.at(-1)?.quad).toEqual(WHOLE_PHOTO);
  });

  it('removes a page that couldn’t be read before saving', async () => {
    const page = await openScan();
    page.processor.unreadable.add('blurry.heic');
    await page.choose('grant-1.jpg', 'blurry.heic');
    expect(page.text(page.row(1).querySelector('.ts'))).toContain('This photo can’t be read here.');
    await page.save();
    expect(page.text(page.scan().querySelector('[data-testid="scan-problem"]'))).toBe(
      'Remove the photos that couldn’t be made into pages.',
    );
    expect(page.uploads.transfers).toHaveLength(0);
    await page.menu(2, 'Remove page');
    expect(page.rows()).toHaveLength(1);
    await page.save();
    expect(await vi.waitFor(() => page.uploads.of(`${defaultScanName(new Date())}.pdf`))).toBeTruthy();
  });

  it('holds a scan to 30 pages', async () => {
    const page = await openScan();
    await page.choose(...Array.from({ length: SCAN_MAX_PAGES + 2 }, (_, i) => `page-${i + 1}.jpg`));
    expect(page.rows()).toHaveLength(SCAN_MAX_PAGES);
    expect(page.text(page.scan().querySelector('[data-testid="scan-notice"]'))).toContain(
      'A scan holds up to 30 pages.',
    );
    expect(page.buttons('Take photos', page.scan())[0]?.hasAttribute('disabled')).toBe(true);
  });

  it('asks for the matter when it came without one', async () => {
    const page = await openScan('/record/scan');
    await page.choose('grant-1.jpg');
    await page.save();
    expect(page.text(page.scan().querySelector('[data-testid="scan-problem"]'))).toBe(
      'Choose the matter the document is for.',
    );
    await page.click('Choose a matter', page.scan());
    const dialog = await vi.waitFor(() => page.dialog() ?? Promise.reject(new Error('No dialog yet')));
    await page.stable(20);
    expect(page.text(dialog.querySelector('h2'))).toBe('Choose the matter');
  });

  it('won’t add to an archived matter', async () => {
    const page = await openScan('/record/scan?matter=m-whitfield', {
      configure: (fs) => fs.set(MATTER, { ...matterDoc(), status: 'archived' }),
    });
    await page.choose('grant-1.jpg');
    expect(page.text(page.scan().querySelector('.matter [role="alert"]'))).toContain('This matter is archived');
    await page.save();
    expect(page.text(page.scan().querySelector('[data-testid="scan-problem"]'))).toBe(
      'Choose a matter that isn’t archived.',
    );
    expect(page.uploads.transfers).toHaveLength(0);
  });

  it('marks a privileged scan only for roles that see privileged documents', async () => {
    const page = await openScan();
    await page.choose('advice-1.jpg');
    const toggle = page.scan().querySelector('mt-switch button, mt-switch [role="switch"]') as HTMLElement;
    toggle.click();
    await page.stable(20);
    await page.save();
    const transfer = await vi.waitFor(() => page.uploads.of(`${defaultScanName(new Date())}.pdf`));
    expect(transfer.settings.customMetadata['privileged']).toBe('true');
  });

  it('asks before leaving photos unsaved', async () => {
    const page = await openScan();
    await page.choose('grant-1.jpg');
    // The navigation waits on the question, so the page isn't stable until it's answered.
    const leaving = page.router.navigateByUrl('/today');
    const dialog = await vi.waitFor(() => {
      const found = page.dialog();
      return found && page.text(found.querySelector('h2')) ? found : Promise.reject(new Error('No dialog yet'));
    });
    expect(page.text(dialog.querySelector('h2'))).toBe('Discard your changes?');
    page.buttons('Keep editing', dialog)[0]?.click();
    expect(await leaving).toBe(false);
    expect(page.router.url).toBe('/record/scan?matter=m-whitfield');
  });

  it('keeps a scan saved offline on the phone, lists it on Record, and uploads it when the connection is back', async () => {
    offline();
    const page = await openScan();
    await page.choose('will-1.jpg', 'will-2.jpg');
    await page.fill('Name', 'Will – Whitfield', page.scan());
    await page.save();
    expect(page.router.url).toBe('/record');
    expect(page.text(page.body.querySelector('.mt-toaster'))).toContain('Scan saved on this phone');
    expect(await page.waitingCount()).toBe(1);
    expect(page.uploads.transfers).toHaveLength(0);
    const waiting = await vi.waitFor(
      () =>
        page.body.querySelector<HTMLElement>('[data-testid="scans-waiting"]') ??
        Promise.reject(new Error('Not listed yet')),
    );
    expect(page.text(waiting.querySelector('.scan'))).toBe(
      'Will – Whitfield.pdf M-2026-0142 Estate of Margaret Whitfield · Waiting for a connection',
    );

    await backOnline(page);
    const transfer = await vi.waitFor(() => page.uploads.of('Will – Whitfield.pdf'));
    expect(transfer.settings.customMetadata['source']).toBe('camera');
    expect(page.text(waiting.querySelector('.scan .ts'))).toContain('Uploading…');
    transfer.finish();
    await page.stable(20);
    await page.stable(20);
    expect(await page.waitingCount()).toBe(0);
    expect(page.body.querySelector('[data-testid="scans-waiting"]')).toBeNull();
    expect(page.text(page.body.querySelector('.mt-toaster'))).toContain('Scan uploaded');
  });

  it('tries a stopped upload again, or deletes the scan from the phone', async () => {
    const page = await openScan();
    await page.choose('will-1.jpg');
    await page.save();
    (await vi.waitFor(() => page.uploads.of(`${defaultScanName(new Date())}.pdf`))).fail(new Error('Network lost'));
    await page.router.navigateByUrl('/record');
    await page.stable(20);
    await page.stable(20);
    const waiting = await vi.waitFor(
      () =>
        page.body.querySelector<HTMLElement>('[data-testid="scans-waiting"]') ??
        Promise.reject(new Error('Not listed yet')),
    );
    expect(waiting.querySelector('.ts[data-failed]')).not.toBeNull();
    await page.click('Try again', waiting);
    // The retry hashes the file again before it transfers.
    await vi.waitFor(() => expect(page.uploads.transfers).toHaveLength(2));

    page.uploads.transfers[1]?.fail(new Error('Network lost'));
    await page.stable(20);
    await page.click(`Delete ${defaultScanName(new Date())}.pdf`, waiting);
    const dialog = await vi.waitFor(() => page.dialog() ?? Promise.reject(new Error('No dialog yet')));
    await page.click('Delete scan', dialog);
    await page.stable(20);
    expect(await page.waitingCount()).toBe(0);
    expect(page.body.querySelector('[data-testid="scans-waiting"]')).toBeNull();
  });

  it('uploads straight away when this browser can’t keep scans', async () => {
    const page = await openScan(undefined, { refuseStore: true });
    await page.choose('will-1.jpg');
    await page.save();
    await vi.waitFor(() => expect(page.uploads.transfers).toHaveLength(1));
    expect(page.router.url).toBe('/matters/m-whitfield/documents');
  });

  it('offline in a browser that can’t keep scans, says to save it with a connection', async () => {
    offline();
    const page = await openScan(undefined, { refuseStore: true });
    await page.choose('will-1.jpg');
    await page.save();
    expect(page.text(page.scan().querySelector('[data-testid="scan-problem"]'))).toBe(
      'This browser can’t keep a scan until you’re back online. Save it when you have a connection.',
    );
    expect(page.router.url).toBe('/record/scan?matter=m-whitfield');
  });

  it('only uploads my scans, in the org I saved them in', async () => {
    const scan = (id: string, uid: string, orgId: string): QueuedScan => ({
      id,
      orgId,
      uid,
      matterId: 'm-whitfield',
      matterLabel: 'M-2026-0142',
      fileName: `${id}.pdf`,
      pages: 1,
      pdf: new Blob(['%PDF-1.4'], { type: 'application/pdf' }),
      savedAt: 1,
    });
    const page = await openScan('/today', {
      scans: [scan('Theirs', 'user-someone-else', ORG), scan('Other org', ME, 'org-x'), scan('Mine', ME, ORG)],
    });
    const queue = TestBed.inject(ScanQueue);
    await page.stable(20);
    await page.stable(20);
    expect(queue.waiting().map((waiting) => waiting.id)).toEqual(['Mine']);
    await vi.waitFor(() =>
      expect(page.uploads.transfers.map((transfer) => (transfer.file as File).name)).toEqual(['Mine.pdf']),
    );
  });
});

describe('The camera (MOB-05)', () => {
  it('falls back to the phone’s camera app when the camera can’t start', async () => {
    const media = {
      getUserMedia: vi.fn(async () => {
        throw Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
      }),
    };
    const page = await openScan(undefined, { media });
    const capture = page.scan().querySelector('[data-testid="scan-capture"]') as HTMLInputElement;
    const opened = vi.spyOn(capture, 'click').mockImplementation(() => undefined);
    await page.click('Take photos', page.scan());
    await page.stable(20);
    expect(media.getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: false }));
    expect(page.body.querySelector('mt-scan-camera')).toBeNull();
    expect(page.text(page.scan().querySelector('[data-testid="scan-notice"]'))).toContain(
      'Materia isn’t allowed to use the camera.',
    );
    await page.click('Use the camera app', page.scan());
    expect(opened).toHaveBeenCalledTimes(1);
    // Next time it goes straight to the camera app.
    await page.click('Take photos', page.scan());
    expect(opened).toHaveBeenCalledTimes(2);
    expect(media.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('shows the back camera full screen and stops it on Done', async () => {
    const stop = vi.fn();
    const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
    const media = { getUserMedia: vi.fn(async () => stream) };
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    try {
      const page = await openScan(undefined, { media });
      await page.click('Take photos', page.scan());
      await page.stable(20);
      const camera = page.body.querySelector('mt-scan-camera') as HTMLElement;
      expect(camera.getAttribute('role')).toBe('dialog');
      expect(media.getUserMedia).toHaveBeenCalledWith(
        expect.objectContaining({ video: expect.objectContaining({ facingMode: { ideal: 'environment' } }) }),
      );
      expect(page.text(camera.querySelector('.count'))).toBe('0 pages');
      expect(page.buttons('Take photo', camera)[0]?.hasAttribute('disabled')).toBe(false);
      await page.click('Done', camera);
      expect(stop).toHaveBeenCalled();
      expect(page.body.querySelector('mt-scan-camera')).toBeNull();
    } finally {
      play.mockRestore();
    }
  });
});

describe('Record’s Photo document (MOB-05)', () => {
  it('opens Scan a document for the chosen matter', async () => {
    const page = await openScan('/record', {
      configure: (fs) =>
        fs.set(`users/${ME}/recent/${ORG}_m-whitfield`, {
          orgId: ORG,
          kind: 'matter',
          matterId: 'm-whitfield',
          expireAt: new Date('2026-12-31T00:00:00Z'),
          ...meta,
          updatedAt: new Date('2026-10-02T00:00:00Z'),
        }),
    });
    const record = page.body.querySelector('mt-record-page') as HTMLElement;
    expect(page.text(record.querySelector('[data-record="scan"] .tt'))).toBe('Photo document');
    await page.click('M-2026-0142', record);
    (record.querySelector('[data-record="scan"]') as HTMLElement).click();
    await page.stable(20);
    await page.stable(20);
    expect(page.router.url).toBe('/record/scan?matter=m-whitfield');
  });

  it('isn’t offered to a read-only role, who can’t open the Scan screen either', async () => {
    const page = await openScan('/record', { session: READONLY });
    expect(page.body.querySelector('[data-record="scan"]')).toBeNull();
    await page.router.navigateByUrl('/record/scan');
    await page.stable(20);
    expect(page.body.querySelector('mt-scan-page')).toBeNull();
  });
});

describe('Signing out with scans waiting (MOB-05)', () => {
  it('warns that waiting scans are deleted', async () => {
    const page = await openScan('/today');
    await indexedDbScanStore(idb).put({
      id: 'waiting',
      orgId: ORG,
      uid: ME,
      matterId: 'm-whitfield',
      matterLabel: 'M-2026-0142',
      fileName: 'Will.pdf',
      pages: 2,
      pdf: new Blob(['%PDF-1.4']),
      savedAt: 1,
    });
    void TestBed.inject(AccountActions).signOut();
    const dialog = await vi.waitFor(() => page.dialog() ?? Promise.reject(new Error('No dialog yet')));
    await page.stable(20);
    expect(page.text(dialog.querySelector('h2'))).toBe('A scan hasn’t uploaded');
    await page.click('Sign out anyway', dialog);
    await page.stable(20);
    await page.stable(20);
    expect(page.router.url).toBe('/auth/sign-in');
    expect(idb.stores.has('materia-scans')).toBe(false);
  });
});
