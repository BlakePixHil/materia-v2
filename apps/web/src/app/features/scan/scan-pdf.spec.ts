import { PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';

import { jpegInfo, pageBox, pdfText, scanPdf } from './scan-pdf';
import { TINY_JPEG } from './testing';

/** A greyscale JPEG header: SOI, then a baseline start-of-frame for 300 × 200, one component. */
const GREY_HEADER = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0xc8, 0x01, 0x2c, 0x01, 0x01,
  0x11, 0x00,
]);

describe('scanPdf (MOB-05)', () => {
  it('reads a JPEG’s size and channels from its frame header', () => {
    expect(jpegInfo(TINY_JPEG)).toEqual({ width: 12, height: 16, components: 3 });
    expect(jpegInfo(GREY_HEADER)).toEqual({ width: 300, height: 200, components: 1 });
    expect(() => jpegInfo(new TextEncoder().encode('%PDF-1.7'))).toThrow('Not a JPEG');
    expect(() => jpegInfo(TINY_JPEG.slice(0, 40))).toThrow('Damaged JPEG');
  });

  it('sizes pages to A4’s long side in the photo’s proportion', () => {
    expect(pageBox(1414, 2000)).toEqual({ width: 595.29, height: 842 });
    expect(pageBox(2000, 1500)).toEqual({ width: 842, height: 631.5 });
  });

  it('makes a PDF with one page per photo, in order, that a PDF library reads back', async () => {
    const pdf = scanPdf([TINY_JPEG, TINY_JPEG, TINY_JPEG], {
      title: 'Death certificate – O’Brien',
      created: new Date('2026-10-07T01:02:03Z'),
    });
    expect(new TextDecoder().decode(pdf.slice(0, 8))).toBe('%PDF-1.4');
    const doc = await PDFDocument.load(pdf, { updateMetadata: false });
    expect(doc.getPageCount()).toBe(3);
    for (const page of doc.getPages()) expect(page.getSize()).toEqual({ width: 631.5, height: 842 });
    expect(doc.getTitle()).toBe('Death certificate – O’Brien');
    expect(doc.getProducer()).toBe('Materia');
    expect(doc.getCreationDate()?.toISOString()).toBe('2026-10-07T01:02:03.000Z');
    // Each page draws its JPEG, stored as is.
    const resources = doc.getPages()[1]?.node.Resources();
    const xobjects = resources?.lookup(PDFName.of('XObject'), PDFDict);
    const stream = doc.context.lookup(xobjects?.get(PDFName.of('Im0')));
    if (!(stream instanceof PDFRawStream)) throw new Error('No image');
    expect(stream.dict.get(PDFName.of('Filter'))).toEqual(PDFName.of('DCTDecode'));
    expect(stream.dict.get(PDFName.of('ColorSpace'))).toEqual(PDFName.of('DeviceRGB'));
    expect([...stream.contents]).toEqual([...TINY_JPEG]);
  });

  it('writes a correct cross-reference table', () => {
    const pdf = scanPdf([TINY_JPEG]);
    const text = new TextDecoder('latin1').decode(pdf);
    const start = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)?.[1]);
    expect(text.slice(start, start + 4)).toBe('xref');
    const offsets = [...text.slice(start).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(offsets).toHaveLength(6);
    offsets.forEach((offset, i) => expect(text.startsWith(`${i + 1} 0 obj\n`, offset)).toBe(true));
  });

  it('refuses an empty scan', () => {
    expect(() => scanPdf([])).toThrow('at least one page');
  });

  it('writes text as UTF-16', () => {
    expect(pdfText('A’')).toBe('<FEFF00412019>');
  });
});
