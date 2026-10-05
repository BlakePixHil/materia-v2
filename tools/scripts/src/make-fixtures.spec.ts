import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PDFDocument } from 'pdf-lib';

import {
  EVAL_FIXTURES_DIR,
  encodePng,
  main,
  rasterisePage,
  scannedPdf,
  sourcePages,
  typedPdf,
} from './make-fixtures.ts';

const PAGES = ['SAMPLE WILL\nI appoint Alex Example as executor.', 'Signed by the will-maker.'];
// Rasterising a full A4 page takes about a second locally and several on CI runners under coverage.
const RENDER_TIMEOUT_MS = 30_000;

function scratch(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'make-fixtures-'));
  const dir = path.join(root, EVAL_FIXTURES_DIR);
  mkdirSync(path.join(dir, 'wills'), { recursive: true });
  writeFileSync(path.join(dir, 'wills/a.txt'), PAGES.join('\f'));
  writeFileSync(path.join(dir, 'pdfs.json'), JSON.stringify({ 'wills/a.txt': ['typed', 'scanned'] }));
  return root;
}

describe('make-fixtures', () => {
  it('splits pages on form feeds', () => {
    expect(sourcePages(PAGES.join('\f'))).toHaveLength(2);
  });

  it('renders a typed PDF with one page per source page, the same bytes every time', async () => {
    const bytes = await typedPdf('a', PAGES);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(2);
    expect(Buffer.compare(Buffer.from(bytes), Buffer.from(await typedPdf('a', PAGES)))).toBe(0);
  });

  it(
    'renders a scanned PDF as images, deterministically',
    async () => {
      const bytes = await scannedPdf('a', PAGES);
      expect((await PDFDocument.load(bytes)).getPageCount()).toBe(2);
      // No text layer: the page text never appears in the file.
      expect(Buffer.from(bytes).toString('latin1')).not.toContain('appoint');
      expect(Buffer.compare(rasterisePage(PAGES[0] as string, 1), rasterisePage(PAGES[0] as string, 1))).toBe(0);
    },
    RENDER_TIMEOUT_MS,
  );

  it('encodes a valid PNG', () => {
    const png = encodePng(Buffer.alloc(4 * 3, 255), 4, 3);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.readUInt32BE(16)).toBe(4);
    expect(png.readUInt32BE(20)).toBe(3);
  });

  it(
    'writes the PDFs, then --check passes, and fails once a source changes',
    async () => {
      const root = scratch();
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      await main([], root);
      const dir = path.join(root, EVAL_FIXTURES_DIR);
      expect(readFileSync(path.join(dir, 'wills/a.typed.pdf')).length).toBeGreaterThan(0);
      await expect(main(['--check'], root)).resolves.toBeUndefined();
      writeFileSync(path.join(dir, 'wills/a.txt'), 'SAMPLE edited');
      await expect(main(['--check'], root)).rejects.toThrow(/Stale eval fixtures/);
      log.mockRestore();
    },
    RENDER_TIMEOUT_MS,
  );
});
