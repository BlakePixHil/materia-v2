import { FakeUploadPort, pipelineUpload, storedDocument } from './testing';
import { UPLOAD_PORT } from './upload-port';
import { cleanUpOverlays, MATTER, openMatter, PARALEGAL, READONLY, type FakeCallable } from '../matter-detail/testing';

/** The matter's Documents tab (CORE-12). Fictional data only. */

afterEach(() => {
  cleanUpOverlays();
  localStorage.removeItem('materia.documents.layout');
});

const URL = '/matters/m-whitfield/documents';
const DOCS = `${MATTER}/documents`;
type Page = Awaited<ReturnType<typeof openMatter>>;
type Seed = Record<string, unknown>;
const day = (n: number) => new Date(`2026-10-0${n}T00:00:00Z`);

/** A will, a privileged letter of advice, a bank statement, and a removed draft. */
function documents(fs: Page['firestore']): void {
  fs.set(`${DOCS}/d-will`, storedDocument('d-will', 'Will of Margaret Whitfield.pdf', { createdAt: day(1) }));
  fs.set(
    `${DOCS}/d-advice`,
    storedDocument('d-advice', 'Advice on the claim.docx', {
      category: 'correspondence',
      privileged: true,
      createdAt: day(3),
    }),
  );
  fs.set(
    `${DOCS}/d-bank`,
    storedDocument('d-bank', 'Bank statement.xlsx', { category: 'financial', createdAt: day(2), sizeBytes: 64_000 }),
  );
  fs.set(
    `${DOCS}/d-draft`,
    storedDocument('d-draft', 'Draft inventory.pdf', {
      createdAt: day(4),
      deletedAt: day(4),
      deletedBy: 'user-jordan',
    }),
  );
}

/** The `documents-*` callables as the server runs them, against the in-memory Firestore. */
function documentCallables(): Record<string, FakeCallable> {
  const patch = (fs: Page['firestore'], id: string, change: Seed) =>
    fs.set(`${DOCS}/${id}`, { ...(fs.get(`${DOCS}/${id}`) as Seed), ...change });
  return {
    'documents-bulkUpdate': (data, fs) => {
      const change = data['change'] as Seed;
      const ids = data['docIds'] as string[];
      for (const id of ids) {
        if (change['op'] === 'category') patch(fs, id, { category: change['category'] });
        if (change['op'] === 'delete') patch(fs, id, { deletedAt: new Date(), deletedBy: 'user-jordan' });
        if (change['op'] === 'restore') patch(fs, id, { deletedAt: null });
      }
      return { updated: ids.length, skipped: [] };
    },
    'documents-resolveDuplicate': (data, fs) => {
      const id = String(data['docId']);
      if (data['action'] === 'keep') {
        const { duplicateOf: _drop, ...rest } = fs.get(`${DOCS}/${id}`) as Seed;
        void _drop;
        fs.set(`${DOCS}/${id}`, rest);
      } else {
        patch(fs, id, { deletedAt: new Date(), deletedBy: 'user-jordan' });
      }
      return { docId: id, action: data['action'] };
    },
  };
}

async function open(options: Parameters<typeof openMatter>[1] = {}) {
  const port = new FakeUploadPort();
  const page = await openMatter(URL, {
    configure: documents,
    callables: documentCallables(),
    providers: [{ provide: UPLOAD_PORT, useValue: port }],
    ...options,
  });
  return { ...page, uploads: port };
}

const names = (page: Page) =>
  [...page.body.querySelectorAll('mt-matter-documents mt-table tbody .doc-name a')].map((a) => page.text(a));
const tab = (page: Page) => page.body.querySelector<HTMLElement>('mt-matter-documents') as HTMLElement;
const uploadRows = (page: Page) =>
  [...page.body.querySelectorAll('mt-upload-list li')].map((li) => page.text(li).replace(/ \d+ bytes/, ''));

/** Picks files with the hidden file input, as the Upload button does. */
async function pick(page: Page, files: File[], selector = '[data-testid="document-upload-input"]'): Promise<void> {
  const input = page.body.querySelector<HTMLInputElement>(selector);
  if (!input) throw new Error('No upload input');
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new Event('change'));
  await page.stable(10);
}

const menu = (page: Page, label: string) =>
  page.body.querySelector<HTMLElement>(`mt-menu[aria-label="${label}"]`) ?? page.body;

const settle = async (page: Page) => {
  for (let i = 0; i < 4; i++) await page.stable(5);
};

describe('matter documents tab', () => {
  it('lists live documents newest first, as a table or a grid', async () => {
    const page = await open();
    expect(page.text(tab(page).querySelector('.head'))).toContain('3 documents');
    expect(names(page)).toEqual(['Advice on the claim.docx', 'Bank statement.xlsx', 'Will of Margaret Whitfield.pdf']);
    expect(tab(page).querySelector('mt-table tbody [aria-label="Privileged"]')).not.toBeNull();
    expect(page.text(tab(page).querySelector('mt-table'))).toContain('64 KB');

    await page.click('Name', tab(page).querySelector('thead') ?? tab(page));
    expect(names(page)[0]).toBe('Advice on the claim.docx');

    const grid = [...tab(page).querySelectorAll<HTMLElement>('mt-segmented-control button, [role="radio"]')].find(
      (b) => page.text(b) === 'Grid',
    );
    grid?.click();
    await page.stable();
    expect(tab(page).querySelectorAll('.grid .card')).toHaveLength(3);
    expect(localStorage.getItem('materia.documents.layout')).toBe('grid');
  });

  it('shows only the name and date columns on a phone', async () => {
    const real = globalThis.matchMedia;
    globalThis.matchMedia = ((query: string) => ({
      matches: query === '(max-width: 767px)',
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof matchMedia;
    try {
      const page = await open();
      const headers = [...tab(page).querySelectorAll('mt-table thead th')].map((th) => page.text(th)).filter(Boolean);
      expect(headers).toEqual(['Name', 'Added']);
    } finally {
      globalThis.matchMedia = real;
    }
  });

  it('filters by category, type, privilege and removal, and sorts', async () => {
    const page = await open();
    await page.click('Category', tab(page));
    await page.click('Financial', menu(page, 'Category'));
    cleanUpOverlays();
    await page.stable();
    expect(names(page)).toEqual(['Bank statement.xlsx']);
    await page.click('Clear filters', tab(page));
    expect(names(page)).toHaveLength(3);

    await page.click('Type', tab(page));
    await page.click('Word', menu(page, 'Type'));
    cleanUpOverlays();
    await page.stable();
    expect(names(page)).toEqual(['Advice on the claim.docx']);
    await page.click('Clear filters', tab(page));

    await page.click('Privileged', tab(page));
    await page.click('Not privileged', menu(page, 'Privileged'));
    expect(names(page)).toEqual(['Bank statement.xlsx', 'Will of Margaret Whitfield.pdf']);
    await page.click('Not privileged', tab(page));
    await page.click('Privileged only', menu(page, 'Privileged'));
    expect(names(page)).toEqual(['Advice on the claim.docx']);
    await page.click('Clear filters', tab(page));

    await page.click('Show removed', tab(page));
    // A removed document reads as "Removed document" everywhere, so citations of it still resolve.
    expect(names(page)[0]).toBe('Removed document');
    // …with its former name beside it, to tell removed documents apart.
    expect(page.text(tab(page).querySelector('mt-table tbody .doc-name'))).toContain('Draft inventory.pdf');
    expect(page.text(tab(page).querySelector('mt-table'))).toContain('Removed');
    await page.click('Show removed', tab(page));

    await page.click('Sort: Date added', tab(page));
    await page.click('Name', menu(page, 'Sort by'));
    expect(names(page)).toEqual(['Advice on the claim.docx', 'Bank statement.xlsx', 'Will of Margaret Whitfield.pdf']);
    await page.click('Sort: Name', tab(page));
    await page.click('Descending', menu(page, 'Sort by'));
    expect(names(page)[0]).toBe('Will of Margaret Whitfield.pdf');

    // Nothing matches: say so, and offer to clear.
    await page.click('Category', tab(page));
    await page.click('Grant', menu(page, 'Category'));
    cleanUpOverlays();
    await page.stable();
    expect(page.text(tab(page))).toContain('No documents match');
  });

  it('never lists privileged documents for a read-only member, and offers no changes', async () => {
    const page = await open({ session: READONLY });
    expect(names(page)).toEqual(['Bank statement.xlsx', 'Will of Margaret Whitfield.pdf']);
    expect(page.text(tab(page))).not.toContain('Advice on the claim');
    expect(page.buttons('Upload', tab(page))).toHaveLength(0);
    expect(page.buttons('Privileged', tab(page))).toHaveLength(0);
    expect(page.buttons('Show removed', tab(page))).toHaveLength(0);
    expect(tab(page).querySelector('[role="checkbox"]')).toBeNull();
  });

  it('lets a paralegal upload but not remove, and hides privileged documents', async () => {
    const page = await open({ session: PARALEGAL });
    expect(names(page)).not.toContain('Advice on the claim.docx');
    expect(page.buttons('Upload', tab(page)).length).toBeGreaterThan(0);
    expect(page.buttons('Show removed', tab(page))).toHaveLength(0);
  });

  it('shows an empty tab with an Upload button', async () => {
    const page = await open({ configure: () => undefined });
    expect(page.text(tab(page))).toContain('No documents yet');
    expect(page.text(tab(page))).toContain('0 documents');
  });

  it('uploads several files and follows each through the pipeline', async () => {
    const page = await open();
    await pick(page, [
      new File(['Fictional codicil'], 'Codicil.pdf', { type: 'application/pdf' }),
      new File(['Fictional note'], 'File note.txt', { type: 'text/plain' }),
      new File(['MZ'], 'tool.exe'),
    ]);
    await settle(page);
    expect(page.uploads.transfers).toHaveLength(2);
    expect(uploadRows(page)[2]).toContain('This type of file can’t be added');

    page.uploads.of('Codicil.pdf').progress(8);
    await page.stable();
    expect(page.body.querySelector('mt-upload-list progress')).not.toBeNull();
    expect(uploadRows(page)[0]).toContain('Uploading 47%');

    // The note is cancelled, then sent again.
    await page.click('Cancel File note.txt', tab(page));
    expect(uploadRows(page)[1]).toContain('Cancelled');
    await page.click('Retry File note.txt', tab(page));
    await settle(page);

    // The server creates each document under its upload id.
    page.uploads.of('Codicil.pdf').finish();
    page.uploads.of('File note.txt').finish();
    await settle(page);
    expect(uploadRows(page)[0]).toContain('Checking the file…');
    const codicilId = page.uploads.of('Codicil.pdf').path.split('/').at(-1) as string;
    const noteId = page.uploads.of('File note.txt').path.split('/').at(-1) as string;
    page.firestore.set(
      `${DOCS}/${codicilId}`,
      storedDocument(codicilId, 'Codicil.pdf', {
        version: 0,
        versions: [],
        scan: { status: 'pending' },
        upload: pipelineUpload('scanning', { uploadId: codicilId, fileName: 'Codicil.pdf' }),
        createdAt: day(5),
      }),
    );
    page.firestore.set(
      `${DOCS}/${noteId}`,
      storedDocument(noteId, 'File note.txt', {
        version: 0,
        versions: [],
        scan: { status: 'infected' },
        upload: pipelineUpload('infected', { uploadId: noteId, fileName: 'File note.txt' }),
        createdAt: day(5),
      }),
    );
    await settle(page);
    expect(uploadRows(page)[0]).toContain('Scanning…');
    expect(uploadRows(page)[1]).toContain('Quarantined');

    page.firestore.set(`${DOCS}/${codicilId}`, storedDocument(codicilId, 'Codicil.pdf', { createdAt: day(5) }));
    await settle(page);
    expect(uploadRows(page)[0]).toContain('Ready');
    expect(names(page)[0]).toBe('Codicil.pdf');
    await page.click('Clear finished', tab(page));
    expect(page.body.querySelector('mt-upload-list')).toBeNull();
  });

  it('asks to keep or discard a possible duplicate', async () => {
    const page = await open();
    await pick(page, [new File(['Fictional will'], 'Will copy.pdf', { type: 'application/pdf' })]);
    await settle(page);
    page.uploads.of('Will copy.pdf').finish();
    await settle(page);
    const id = page.uploads.of('Will copy.pdf').path.split('/').at(-1) as string;
    page.firestore.set(
      `${DOCS}/${id}`,
      storedDocument(id, 'Will copy.pdf', { duplicateOf: 'd-will', createdAt: day(5) }),
    );
    await settle(page);
    expect(uploadRows(page)[0]).toContain('Duplicate of Will of Margaret Whitfield.pdf');
    expect(page.text(tab(page))).toContain('looks like a copy: duplicate of Will of Margaret Whitfield.pdf');

    await page.click('Discard', tab(page).querySelector('mt-upload-list') ?? tab(page));
    await settle(page);
    expect(page.calls('documents-resolveDuplicate')).toEqual([
      expect.objectContaining({ matterId: 'm-whitfield', docId: id, action: 'discard' }),
    ]);
    expect(uploadRows(page)[0]).toContain('Discarded');
    expect(page.text(page.body)).toContain('Copy discarded');
  });

  it('keeps both copies from the note above the list', async () => {
    const page = await open({
      configure: (fs) => {
        documents(fs);
        fs.set(
          `${DOCS}/d-copy`,
          storedDocument('d-copy', 'Will (2).pdf', { duplicateOf: 'd-will', createdAt: day(5) }),
        );
      },
    });
    await page.click('Keep both', tab(page));
    await settle(page);
    expect(page.calls('documents-resolveDuplicate')[0]).toMatchObject({ docId: 'd-copy', action: 'keep' });
    expect(page.text(tab(page))).not.toContain('looks like a copy');
  });

  it('takes at most 20 files at once', async () => {
    const page = await open();
    const files = Array.from({ length: 21 }, (_, i) => new File(['x'], `Note ${i + 1}.txt`, { type: 'text/plain' }));
    await pick(page, files);
    expect(page.body.querySelectorAll('mt-upload-list li')).toHaveLength(20);
    expect(page.text(page.body)).toContain('1 file not added');
  });

  it('adds files dropped on the tab', async () => {
    const page = await open();
    const drag = (type: string, files: File[] = []) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files, dropEffect: 'none' } });
      tab(page).dispatchEvent(event);
      return event;
    };
    expect(drag('dragenter').defaultPrevented).toBe(true);
    drag('dragover');
    await page.stable();
    expect(page.text(tab(page))).toContain('Drop files to add them to this matter');
    drag('dragleave');
    await page.stable();
    expect(page.text(tab(page))).not.toContain('Drop files to add them');
    drag('dragenter');
    drag('drop', [new File(['Fictional'], 'Dropped.pdf', { type: 'application/pdf' })]);
    await settle(page);
    expect(page.text(tab(page))).not.toContain('Drop files to add them');
    expect(page.uploads.transfers.map((t) => (t.file as File).name)).toEqual(['Dropped.pdf']);
  });

  it('moves, removes and restores documents in bulk', async () => {
    const page = await open();
    const check = async (name: string) => {
      const box = tab(page).querySelector<HTMLElement>(`mt-table [role="checkbox"][aria-label="Select ${name}"]`);
      if (!box) throw new Error(`No checkbox for ${name}`);
      box.click();
      await page.stable();
    };
    await check('Bank statement.xlsx');
    await check('Will of Margaret Whitfield.pdf');
    expect(page.text(page.body.querySelector('mt-documents-bulk-bar'))).toContain('2 selected');

    await page.click('Move to category', page.body.querySelector('mt-documents-bulk-bar') ?? page.body);
    await page.click('Grant', menu(page, 'Move to category'));
    await settle(page);
    expect(page.calls('documents-bulkUpdate')[0]).toMatchObject({
      docIds: ['d-bank', 'd-will'],
      change: { op: 'category', category: 'grant' },
    });
    expect(page.text(page.body)).toContain('2 documents moved to Grant');
    expect(page.body.querySelector('mt-documents-bulk-bar')).toBeNull();

    await check('Bank statement.xlsx');
    await page.click('Remove', page.body.querySelector('mt-documents-bulk-bar') ?? page.body);
    expect(page.text(page.dialog())).toContain('Remove this document?');
    await page.click('Remove document', page.dialog() ?? page.body);
    await settle(page);
    expect(page.calls('documents-bulkUpdate')[1]).toMatchObject({ docIds: ['d-bank'], change: { op: 'delete' } });
    expect(names(page)).not.toContain('Bank statement.xlsx');

    await page.click('Show removed', tab(page));
    await check('Removed document (Bank statement.xlsx)');
    await page.click('Restore', page.body.querySelector('mt-documents-bulk-bar') ?? page.body);
    await settle(page);
    expect(page.calls('documents-bulkUpdate')[2]).toMatchObject({ docIds: ['d-bank'], change: { op: 'restore' } });
    expect(page.text(page.body)).toContain('1 document restored');
  });

  it('says when a bulk change fails', async () => {
    const page = await open({
      callables: {
        'documents-bulkUpdate': () => {
          throw { code: 'functions/permission-denied', details: { code: 'PERMISSION_DENIED' } };
        },
      },
    });
    tab(page)
      .querySelector<HTMLElement>('mt-table [role="checkbox"][aria-label="Select Bank statement.xlsx"]')
      ?.click();
    await page.stable();
    await page.click('Move to category', page.body.querySelector('mt-documents-bulk-bar') ?? page.body);
    await page.click('Other', menu(page, 'Move to category'));
    await settle(page);
    expect(page.text(page.body)).toContain('Couldn’t change the documents');
    expect(page.body.querySelector('mt-documents-bulk-bar')).not.toBeNull();
  });
});
