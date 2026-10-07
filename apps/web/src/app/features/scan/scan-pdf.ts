/**
 * A scan's PDF (MOB-05): one JPEG per page, each drawn to fill its page. PDF readers decode JPEG
 * themselves (`/DCTDecode`), so the photos go in byte for byte and the writer is a page of code;
 * pdf-lib would add over 100 kB to the Scan screen for the same file.
 */

/** A JPEG's size and colour channels, from its start-of-frame header. */
export interface JpegInfo {
  width: number;
  height: number;
  /** 1 for greyscale, 3 for colour. */
  components: number;
}

/** Reads a JPEG's start-of-frame. Throws when the bytes aren't a JPEG this writer can use. */
export function jpegInfo(bytes: Uint8Array): JpegInfo {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('Not a JPEG');
  const byte = (index: number) => bytes[index] ?? 0;
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) throw new Error('Damaged JPEG');
    const marker = byte(at + 1);
    // Fill bytes, then standalone markers, which have no length.
    if (marker === 0xff) {
      at++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    const length = (byte(at + 2) << 8) | byte(at + 3);
    // Start of frame: every SOFn except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (byte(at + 5) << 8) | byte(at + 6);
      const width = (byte(at + 7) << 8) | byte(at + 8);
      const components = byte(at + 9);
      if (!width || !height || (components !== 1 && components !== 3)) throw new Error('Unsupported JPEG');
      return { width, height, components };
    }
    at += 2 + length;
  }
  throw new Error('Damaged JPEG');
}

/** A page's size in points: the longer side is A4's (842pt), the shorter in the photo's proportion. */
export function pageBox(width: number, height: number): { width: number; height: number } {
  const scale = 842 / Math.max(width, height);
  return { width: round2(width * scale), height: round2(height * scale) };
}

export interface ScanPdfOptions {
  /** The document's title (the PDF's Info). */
  title?: string;
  created?: Date;
}

/** The PDF of these JPEG pages, in order. */
export function scanPdf(pages: readonly Uint8Array[], options: ScanPdfOptions = {}): Uint8Array {
  if (!pages.length) throw new Error('A scan needs at least one page');
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const encoder = new TextEncoder();
  const write = (part: string | Uint8Array) => {
    const bytes = typeof part === 'string' ? encoder.encode(part) : part;
    chunks.push(bytes);
    length += bytes.length;
  };
  const object = (id: number, body: string | (() => void)) => {
    offsets[id] = length;
    write(`${id} 0 obj\n`);
    if (typeof body === 'string') write(body);
    else body();
    write('\nendobj\n');
  };

  // Objects: 1 catalog, 2 page tree, 3 info, then a page, its content and its image for each page.
  const pageId = (i: number) => 4 + i * 3;
  // A binary comment after the header tells transfer tools the file is binary.
  write('%PDF-1.4\n');
  write(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageId(i)} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  const info = [`/Producer ${pdfText('Materia')}`, `/CreationDate (${pdfDate(options.created ?? new Date())})`];
  if (options.title) info.unshift(`/Title ${pdfText(options.title)}`);
  object(3, `<< ${info.join(' ')} >>`);
  pages.forEach((jpeg, i) => {
    const { width, height, components } = jpegInfo(jpeg);
    const box = pageBox(width, height);
    const id = pageId(i);
    object(
      id,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${box.width} ${box.height}] ` +
        `/Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`,
    );
    const draw = `q ${box.width} 0 0 ${box.height} 0 0 cm /Im0 Do Q`;
    object(id + 1, `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
    object(id + 2, () => {
      write(
        `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
          `/ColorSpace /${components === 1 ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8 ` +
          `/Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
      );
      write(jpeg);
      write('\nendstream');
    });
  });

  const count = 4 + pages.length * 3;
  const xref = length;
  write(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let id = 1; id < count; id++) write(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  write(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** A PDF text string as UTF-16BE hex, so any name (accents, apostrophes, brackets) survives. */
export function pdfText(text: string): string {
  let hex = 'FEFF';
  for (let i = 0; i < text.length; i++) hex += text.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
  return `<${hex}>`;
}

/** `D:YYYYMMDDHHmmSSZ`, in UTC. */
function pdfDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
