import type { InMemoryFirestore } from '@materia/data-access/repository';

import {
  citationText,
  citationVms,
  highlightPages,
  sourceView,
  viewerCitations,
  type CitedDocState,
} from './citation-view';
import { highlightBoxes, type PdfPageText } from '../documents/pdf-highlight';
import { PDFJS_LOADER } from '../documents/pdf-viewer';
import { fakePdfJs, InViewObserver, storedDocument, storedVersion } from '../documents/testing';
import {
  cleanUpOverlays,
  MATTER,
  meta,
  openMatter,
  ORG,
  PARALEGAL,
  type FakeCallable,
  type OpenOptions,
} from '../matter-detail/testing';

/** Citations and the citation viewer (AI-05). Every document, quote and person is fictional. */

type Seed = Record<string, unknown>;
const DOCS = `${MATTER}/documents`;

const realObserver = globalThis.IntersectionObserver;
beforeEach(() => {
  globalThis.IntersectionObserver = InViewObserver as unknown as typeof IntersectionObserver;
});
afterEach(() => {
  cleanUpOverlays();
  globalThis.IntersectionObserver = realObserver;
});

describe('citation helpers', () => {
  const found = (doc: Seed): CitedDocState => ({ status: 'found', doc: { id: 'd', ...doc } as never });

  it('labels chips by the reader’s view of the source', () => {
    const citations = [
      { kind: 'document' as const, documentId: 'd-will', docVersion: 2, page: 2, quote: 'my house' },
      { kind: 'document' as const, documentId: 'd-gone', page: 1, quote: 'a removed passage' },
      { kind: 'document' as const, documentId: 'd-priv', quote: 'advice' },
      { kind: 'document' as const, documentId: 'd-denied', quote: 'advice' },
      { kind: 'record' as const, recordRef: { collection: 'deadlines' as const, id: 'dl-1' }, quote: 'Due 1 Nov' },
      { documentId: 'd-will', version: 1, page: 1, quote: 'old shape', verified: false },
    ];
    const docs = new Map<string, CitedDocState>([
      ['d-will', found({ name: 'Will of Fictional Vale.pdf' })],
      ['d-gone', found({ name: 'Old note.pdf', deletedAt: new Date() })],
      ['d-priv', found({ name: 'Advice.pdf', privileged: true })],
      ['d-denied', { status: 'denied' }],
    ]);
    const paralegal = citationVms(citations, docs, false);
    expect(paralegal.map((vm) => [vm.n, vm.label, vm.state ?? 'available'])).toEqual([
      [1, 'Will of Fictional Vale.pdf', 'available'],
      [2, 'Removed document', 'removed'],
      [3, 'Source', 'restricted'],
      [4, 'Source', 'restricted'],
      [5, 'Deadline', 'available'],
      [6, 'Will of Fictional Vale.pdf', 'available'],
    ]);
    expect(paralegal[0]).toMatchObject({ version: 2, page: 2 });
    expect(paralegal[5]).toMatchObject({ version: 1, verified: false });
    expect(paralegal[4]).toMatchObject({ kind: 'record', documentId: 'dl-1' });
    const lawyer = citationVms(citations, docs, true);
    expect(lawyer.map((vm) => vm.state ?? 'available').slice(2, 4)).toEqual(['available', 'removed']);
    expect(lawyer[2]?.label).toBe('Advice.pdf');

    // The viewer steps through the available, verified document citations only.
    expect(viewerCitations(lawyer, citations).map((c) => c.n)).toEqual([1, 3]);
  });

  it('opens PDFs in the PDF viewer and everything else as extracted text', () => {
    const doc = {
      id: 'd',
      versions: [storedVersion('d', 1, 'Letter.docx') as never, storedVersion('d', 2, 'Letter.pdf') as never],
      version: 2,
    };
    expect(sourceView(doc)).toBe('pdf');
    expect(sourceView(doc, 2)).toBe('pdf');
    expect(sourceView(doc, 1)).toBe('text');
  });

  it('formats Copy citation as the name and page', () => {
    expect(citationText('Will of Fictional Vale.pdf', 3)).toBe('Will of Fictional Vale.pdf, p 3');
    expect(citationText('Will of Fictional Vale.pdf', 3, 4)).toBe('Will of Fictional Vale.pdf, pp 3–4');
    expect(citationText('Email to the executor')).toBe('Email to the executor');
  });

  it('highlights a quote in extracted text, across a page break and despite curly quotes', () => {
    const { pages, found } = highlightPages(
      [
        { page: 1, text: 'Clause 4. I give my house at 14 Fictional St' },
        { page: 2, text: 'to my daughter Avery. Clause 5.', ocr: true },
      ],
      '“my house at 14 Fictional St to my daughter Avery”',
    );
    expect(found).toBe(true);
    expect(pages.map((page) => page.segments.filter((s) => s.mark).map((s) => s.text))).toEqual([
      ['my house at 14 Fictional St'],
      ['to my daughter Avery'],
    ]);
    expect(pages[1]?.ocr).toBe(true);
    expect(highlightPages([{ page: 1, text: 'Nothing to see here at all.' }], 'a fabricated passage').found).toBe(
      false,
    );
  });

  it('places PDF highlight boxes from the text layer, and finds none on a scan', () => {
    const page = (n: number, lines: string[]): PdfPageText => ({
      page: n,
      viewport: { width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] },
      items: lines.map((str, line) => ({
        str,
        transform: [12, 0, 0, 12, 72, 700 - line * 16],
        width: str.length * 6,
        height: 12,
      })),
    });
    const boxes =
      highlightBoxes(
        [page(2, ['I give my house', 'to my daughter.']), page(3, ['Clause 6.'])],
        'my house to my daughter',
      ) ?? [];
    expect(boxes.map((box) => box.page)).toEqual([2, 2]);
    expect(boxes[0]?.left).toBeCloseTo(((72 + 7 * 6) / 600) * 100);
    expect(boxes[0]?.top).toBeCloseTo(((100 - 12) / 800) * 100);
    expect(highlightBoxes([page(2, [])], 'my house')).toBeNull();
    expect(highlightBoxes([page(2, ['I give my house'])], 'my car and boat')).toBeNull();
  });
});

// The viewer on the matter Overview, opened from a Clerk suggestion's citation chips.

const WILL_PAGE_2 = 'Clause 4. I give my house at\n14 Fictional St to my daughter\nAvery Whitfield absolutely.';

function suggestion(citations: Seed[]): Seed {
  return {
    kind: 'task',
    payload: { title: 'Request the date-of-death valuation', priority: 'medium' },
    rationale: 'The will leaves the house to Avery.',
    citations,
    status: 'proposed',
    promptId: 'suggest',
    promptVersion: '1.0.0',
    model: 'test-model',
    privileged: false,
    basis: 'b-1',
    basisParts: {},
    dedupeKey: 'task:valuation',
    expiresAt: new Date('2099-01-01T00:00:00Z'),
    orgId: ORG,
    matterId: 'm-whitfield',
    ...meta,
    createdBy: 'clerk',
  };
}

const CITED = [
  {
    kind: 'document',
    documentId: 'doc-will',
    docVersion: 2,
    page: 2,
    quote: 'my house at 14 Fictional St to my daughter',
  },
  { kind: 'document', documentId: 'doc-letter', docVersion: 1, page: 1, quote: 'the estate account holds $12,000' },
  { kind: 'document', documentId: 'doc-will', docVersion: 2, page: 1, quote: 'A fabricated line.', verified: false },
];

function will(): Seed {
  return storedDocument('doc-will', 'Will of Fictional Whitfield.pdf', {
    version: 2,
    versionSeq: 2,
    versions: [
      storedVersion('doc-will', 1, 'Will draft.pdf'),
      storedVersion('doc-will', 2, 'Will of Fictional Whitfield.pdf'),
    ],
  });
}

const letter = (extra: Seed = {}): Seed =>
  storedDocument('doc-letter', 'Letter to the executor.docx', {
    versions: [
      storedVersion('doc-letter', 1, 'Letter to the executor.docx', {
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    ],
    ...extra,
  });

interface ViewOptions extends OpenOptions {
  citations?: Seed[];
  docs?: Record<string, Seed>;
  pdf?: ReturnType<typeof fakePdfJs>;
  deny?: string[];
}

const citationTextCall: FakeCallable = (data) => {
  if (data['docId'] === 'doc-letter')
    return {
      version: 1,
      pages: [{ page: 1, text: 'Dear Harper, the estate account holds $12,000 (fictional).', ocr: false }],
      truncated: false,
    };
  return {
    version: data['version'] ?? 2,
    pages: [{ page: 2, text: 'Clause 4. I give my house at 14 Fictional St to my daughter Avery.', ocr: true }],
    truncated: false,
  };
};

async function open(options: ViewOptions = {}) {
  const pdf = options.pdf ?? fakePdfJs({ pages: 3, texts: { 2: WILL_PAGE_2 } });
  const page = await openMatter(undefined, {
    ...options,
    flags: { 'clerk.features.suggestions': true },
    configure: (fs: InMemoryFirestore) => {
      for (const [id, doc] of Object.entries(options.docs ?? { 'doc-will': will(), 'doc-letter': letter() }))
        fs.set(`${DOCS}/${id}`, doc);
      for (const id of options.deny ?? []) fs.denyRead(`${DOCS}/${id}`);
      fs.set(`${MATTER}/suggestions/s-cited`, suggestion(options.citations ?? CITED));
    },
    callables: {
      'documents-getDownloadUrl': (data) => ({
        url: `https://files.example.test/${String(data['docId'])}/v${String(data['version'] ?? 'current')}`,
        expiresAt: '2026-10-04T00:05:00Z',
      }),
      'documents-citationText': citationTextCall,
      ...options.callables,
    },
    providers: [{ provide: PDFJS_LOADER, useValue: pdf.load }, ...(options.providers ?? [])],
  });
  await settle(page);
  return { ...page, pdf };
}

type Page = Awaited<ReturnType<typeof open>>;
const settle = async (page: Pick<Page, 'stable'>) => {
  for (let i = 0; i < 6; i++) await page.stable(5);
};
const chips = (page: Page) =>
  [...page.body.querySelectorAll<HTMLElement>('mt-suggestion-card mt-citation')].map((chip) =>
    chip.getAttribute('aria-label'),
  );
const chip = (page: Page, n: number) =>
  page.body.querySelector<HTMLElement>(`mt-suggestion-card mt-citation[aria-label^="Source ${n}:"]`);
const viewer = (page: Page) => page.body.querySelector<HTMLElement>('mt-citation-viewer');
const openChip = async (page: Page, n: number) => {
  chip(page, n)?.click();
  await settle(page);
};

describe('citation viewer', () => {
  it('shows the cited sources, dropping the one verification failed', async () => {
    const page = await open();
    expect(chips(page)).toEqual([
      'Source 1: Will of Fictional Whitfield.pdf p 2',
      'Source 2: Letter to the executor.docx p 1',
    ]);
    expect(viewer(page)).toBeNull();
  });

  it('opens a PDF at the cited page with the quote highlighted, steps with ] and [, and closes with Esc', async () => {
    const page = await open();
    await openChip(page, 1);
    const panel = viewer(page) as HTMLElement;
    expect(panel).not.toBeNull();
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(page.text(panel.querySelector('h2'))).toBe('Will of Fictional Whitfield.pdf, p 2');
    expect(page.text(panel.querySelector('blockquote'))).toBe('my house at 14 Fictional St to my daughter');
    expect(page.calls('documents-getDownloadUrl')).toEqual([
      expect.objectContaining({ docId: 'doc-will', version: 2 }),
    ]);
    expect(page.pdf.opened).toEqual(['https://files.example.test/doc-will/v2']);
    const marks = panel.querySelectorAll('[data-page="2"] mark.mt-pdf-hl[data-highlight]');
    expect(marks.length).toBe(2);
    expect(panel.hasAttribute('data-highlighted')).toBe(true);
    expect(panel.textContent).not.toContain('A newer version exists');
    expect(page.text(panel)).toContain('Source 1 of 2');

    await page.press(']');
    await settle(page);
    expect(page.text(viewer(page)?.querySelector('h2'))).toBe('Letter to the executor.docx, p 1');
    expect(page.calls('documents-citationText')).toEqual([
      expect.objectContaining({ docId: 'doc-letter', version: 1, pages: [1, 2] }),
    ]);
    const mark = viewer(page)?.querySelector('section[data-page="1"] mark[data-highlight]');
    expect(page.text(mark)).toBe('the estate account holds $12,000');

    await page.press('[');
    await settle(page);
    expect(page.text(viewer(page)?.querySelector('h2'))).toBe('Will of Fictional Whitfield.pdf, p 2');

    await page.press('Escape');
    await settle(page);
    expect(viewer(page)).toBeNull();
  });

  it('copies the citation as the document name and page', async () => {
    const writeText = vi.fn(async () => undefined);
    const realClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      const page = await open();
      await openChip(page, 1);
      await page.click('Copy citation', viewer(page) as HTMLElement);
      expect(writeText).toHaveBeenCalledWith('Will of Fictional Whitfield.pdf, p 2');
      expect(page.text()).toContain('Citation copied');
      const link = [...(viewer(page)?.querySelectorAll('a') ?? [])].find((a) =>
        a.textContent?.includes('Open full document'),
      );
      expect(link?.getAttribute('href')).toBe('/matters/m-whitfield/documents/doc-will?page=2');
    } finally {
      if (realClipboard) Object.defineProperty(navigator, 'clipboard', realClipboard);
      else delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });

  it('opens the cited older version under a newer-version banner', async () => {
    const page = await open({
      citations: [
        { kind: 'document', documentId: 'doc-will', docVersion: 1, page: 2, quote: 'my house at 14 Fictional St' },
      ],
    });
    await openChip(page, 1);
    const panel = viewer(page) as HTMLElement;
    expect(page.text(panel)).toContain(
      'A newer version exists. This is version 1, the one Clerk cited; the document is now at version 2.',
    );
    expect(page.calls('documents-getDownloadUrl')).toEqual([expect.objectContaining({ version: 1 })]);
    const link = [...panel.querySelectorAll('a')].find((a) => a.textContent?.includes('Open full document'));
    expect(link?.getAttribute('href')).toBe('/matters/m-whitfield/documents/doc-will?page=2&v=1');
  });

  it('marks the passage in the OCR text when the scanned page has no text layer', async () => {
    const page = await open({ pdf: fakePdfJs({ pages: 3, texts: { 2: null, 3: null } }) });
    await openChip(page, 1);
    const panel = viewer(page) as HTMLElement;
    expect(panel.querySelector('mark.mt-pdf-hl')).toBeNull();
    const ocr = panel.querySelector('section.ocr');
    expect(page.text(ocr)).toContain('This page is a scan');
    expect(page.text(ocr?.querySelector('mark[data-highlight]'))).toBe('my house at 14 Fictional St to my daughter');
    expect(page.calls('documents-citationText')).toEqual([
      expect.objectContaining({ docId: 'doc-will', version: 2, pages: [2, 3] }),
    ]);
    expect(panel.hasAttribute('data-highlighted')).toBe(true);
  });

  it('shows a privileged source as restricted to a paralegal, and never opens it', async () => {
    const page = await open({
      session: PARALEGAL,
      docs: { 'doc-will': will(), 'doc-letter': letter({ privileged: true }) },
      deny: ['doc-letter'],
    });
    expect(chips(page)).toEqual(['Source 1: Will of Fictional Whitfield.pdf p 2', 'Source 2: Restricted source']);
    expect(chip(page, 2)?.getAttribute('aria-disabled')).toBe('true');
    await openChip(page, 2);
    expect(viewer(page)).toBeNull();
    // The viewer opened from the first chip doesn't step to the restricted one.
    await openChip(page, 1);
    expect(page.text(viewer(page))).not.toContain('Source 1 of');
  });

  it('shows a deleted source as removed, keeping its quote, and never opens it', async () => {
    const page = await open({
      docs: { 'doc-will': will(), 'doc-letter': letter({ deletedAt: new Date('2026-10-02T00:00:00Z') }) },
    });
    expect(chips(page)[1]).toBe('Source 2: Removed document: “the estate account holds $12,000”');
    await openChip(page, 2);
    expect(viewer(page)).toBeNull();
  });
});
