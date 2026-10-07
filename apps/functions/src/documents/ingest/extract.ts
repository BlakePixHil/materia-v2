import { normaliseText, pseudoPages, type PageText } from '@materia/clerk';
import { uploadExtension, type IngestSkipReason, type MessageAddress } from '@materia/domain';

import { parseMessage } from '../email';

/**
 * Text extraction for Clerk ingestion (AI-04). Every source becomes numbered pages:
 *
 * - PDF: each page's text layer (pdfjs-dist). A page with fewer than `OCR_MIN_CHARS` characters is
 *   treated as scanned and read by OCR, through a one-page PDF of it.
 * - DOCX: mammoth's raw text, packed into ~3,000-character pseudo-pages by paragraph.
 * - Email (.eml, .msg): headers and plain-text body as pseudo-pages. Attachments are separate
 *   documents ("Save to matter"), ingested on their own.
 * - Plain text and CSV: pseudo-pages.
 * - PNG and JPEG photos: one page, read by OCR.
 * - Anything else (spreadsheets, slides, archives, legacy .doc, HEIC, WebP): skipped as unsupported.
 *
 * Heavy parsers are loaded on first use (every function shares one bundle).
 */

/** Fewer non-space characters than this and a PDF page counts as scanned (OCR'd). */
export const OCR_MIN_CHARS = 20;

/** A page source the pipeline reads in batches: PDFs page by page, everything else at once. */
export interface PageSource {
  kind: 'pdf' | 'docx' | 'email' | 'text' | 'image';
  pageCount: number;
  /** The text of pages `from`..`to` (1-based, inclusive). `needsOcr` pages have no usable text. */
  pages(from: number, to: number): Promise<{ page: number; text: string; needsOcr: boolean }[]>;
  /** A one-page PDF (or the image itself) for OCR. */
  ocrInput(page: number): Promise<{ kind: 'pdf'; base64: string }>;
  close(): Promise<void>;
}

export type OpenResult = { ok: true; source: PageSource } | { ok: false; reason: IngestSkipReason };

const significant = (text: string) => text.replace(/\s+/g, '').length;

/** Builds a source over pages that are all known up front. */
function staticSource(kind: PageSource['kind'], pages: PageText[]): PageSource {
  return {
    kind,
    pageCount: pages.length,
    async pages(from, to) {
      return pages.filter((p) => p.page >= from && p.page <= to).map((p) => ({ ...p, needsOcr: false }));
    },
    async ocrInput() {
      throw new Error('Nothing to OCR');
    },
    async close() {
      // Nothing to release.
    },
  };
}

/** pdfjs-dist's legacy build runs in Node; pdf-lib cuts single pages out for OCR. */
async function openPdf(data: Buffer): Promise<OpenResult> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  let doc: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(data),
      disableFontFace: true,
      useSystemFonts: false,
      stopAtErrors: false,
      verbosity: 0,
    }).promise;
  } catch (error) {
    return { ok: false, reason: (error as { name?: string }).name === 'PasswordException' ? 'encrypted' : 'damaged' };
  }
  let source: import('pdf-lib').PDFDocument | undefined;
  return {
    ok: true,
    source: {
      kind: 'pdf',
      pageCount: doc.numPages,
      async pages(from, to) {
        const out = [];
        for (let n = from; n <= Math.min(to, doc.numPages); n++) {
          let text = '';
          try {
            const page = await doc.getPage(n);
            const content = await page.getTextContent();
            text = content.items.map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '')).join('');
            page.cleanup();
          } catch {
            text = '';
          }
          text = normaliseText(text);
          out.push({ page: n, text, needsOcr: significant(text) < OCR_MIN_CHARS });
        }
        return out;
      },
      async ocrInput(page) {
        const { PDFDocument } = await import('pdf-lib');
        source ??= await PDFDocument.load(data, { ignoreEncryption: true, updateMetadata: false });
        const single = await PDFDocument.create();
        const [copied] = await single.copyPages(source, [page - 1]);
        if (copied) single.addPage(copied);
        return { kind: 'pdf', base64: Buffer.from(await single.save()).toString('base64') };
      },
      async close() {
        await doc.loadingTask.destroy();
      },
    },
  };
}

/** A PNG or JPEG photo as a one-page PDF (the gateway sends PDFs; Claude reads the page image). */
async function openImage(data: Buffer, ext: 'png' | 'jpg' | 'jpeg'): Promise<OpenResult> {
  const { PDFDocument } = await import('pdf-lib');
  let base64: string;
  try {
    const pdf = await PDFDocument.create();
    const image = ext === 'png' ? await pdf.embedPng(data) : await pdf.embedJpg(data);
    const page = pdf.addPage([image.width, image.height]);
    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
    base64 = Buffer.from(await pdf.save()).toString('base64');
  } catch {
    return { ok: false, reason: 'damaged' };
  }
  return {
    ok: true,
    source: {
      kind: 'image',
      pageCount: 1,
      async pages() {
        return [{ page: 1, text: '', needsOcr: true }];
      },
      async ocrInput() {
        return { kind: 'pdf', base64 };
      },
      async close() {
        // Nothing to release.
      },
    },
  };
}

const address = (a: MessageAddress | null) => (a ? (a.name ? `${a.name} <${a.address}>` : a.address) : '');

/** Opens a stored version for reading. `fileName` decides the parser (it was checked by magic bytes on upload). */
export async function openSource(fileName: string, data: Buffer): Promise<OpenResult> {
  const ext = uploadExtension(fileName);
  switch (ext) {
    case 'pdf':
      return openPdf(data);
    case 'docx': {
      try {
        const mammoth = await import('mammoth');
        const extractRawText =
          mammoth.extractRawText ?? (mammoth as unknown as { default: typeof mammoth }).default.extractRawText;
        const { value } = await extractRawText({ buffer: data });
        return { ok: true, source: staticSource('docx', pseudoPages(value)) };
      } catch {
        return { ok: false, reason: 'damaged' };
      }
    }
    case 'eml':
    case 'msg': {
      try {
        const { rendition: m } = await parseMessage(fileName, data);
        const headers = [
          `Subject: ${m.subject}`,
          `From: ${address(m.from)}`,
          m.to.length ? `To: ${m.to.map(address).join(', ')}` : '',
          m.cc.length ? `Cc: ${m.cc.map(address).join(', ')}` : '',
          m.date ? `Date: ${m.date}` : '',
          m.attachments.length ? `Attachments: ${m.attachments.map((a) => a.fileName).join(', ')}` : '',
        ].filter(Boolean);
        return { ok: true, source: staticSource('email', pseudoPages(`${headers.join('\n')}\n\n${m.text}`)) };
      } catch {
        return { ok: false, reason: 'damaged' };
      }
    }
    case 'txt':
    case 'csv':
      return { ok: true, source: staticSource('text', pseudoPages(data.toString('utf8'))) };
    case 'png':
    case 'jpg':
    case 'jpeg':
      return openImage(data, ext);
    default:
      return { ok: false, reason: 'unsupported' };
  }
}
