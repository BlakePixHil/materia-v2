/**
 * `materia-scripts make-fixtures [--check]` (AI-12): renders the Clerk eval fixture PDFs from their
 * fictional source text. `libs/clerk/evals/fixtures/pdfs.json` lists which `.txt` files become PDFs
 * and in which forms:
 *
 * - `typed`: a normal PDF with a text layer (Courier, A4), one page per form-feed-separated page;
 * - `scanned`: each page rasterised to a greyscale image with a built-in bitmap typewriter face,
 *   a slight skew and speckle, and no text layer, so it looks and reads like a photocopied scan.
 *
 * Output is deterministic (fixed metadata, seeded noise), so re-running only changes files when the
 * source text or this script changes; `--check` fails if a committed PDF is stale. The `.txt` stays
 * the source of truth for gold answers and citation checks. Every fixture is invented. Never real
 * client data.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { deflateSync } from 'node:zlib';

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export const EVAL_FIXTURES_DIR = 'libs/clerk/evals/fixtures';

type Form = 'typed' | 'scanned';

const FIXED_DATE = new Date('2026-01-01T00:00:00Z');
const A4: [number, number] = [595.28, 841.89];

/** Source pages: form-feed separated, leading blank lines dropped (as the eval runner reads them). */
export function sourcePages(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split('\f')
    .map((page) => page.replace(/^\n+/, '').replace(/\s+$/, ''));
}

function metadata(doc: PDFDocument, title: string): void {
  doc.setTitle(title);
  doc.setAuthor('Materia eval fixtures (fictional)');
  doc.setProducer('materia-scripts make-fixtures');
  doc.setCreator('materia-scripts make-fixtures');
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
}

function wrapChars(line: string, width: number): string[] {
  if (line.length <= width) return [line];
  const out: string[] = [];
  let current = '';
  for (const word of line.split(' ')) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > width && current) {
      out.push(current);
      current = word;
    } else current = next;
  }
  if (current) out.push(current);
  return out;
}

/** A typed PDF: real text, so the model's PDF text extraction and page citations work. */
export async function typedPdf(title: string, pages: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  metadata(doc, title);
  const font = await doc.embedFont(StandardFonts.Courier);
  const size = 10;
  for (const text of pages) {
    const page = doc.addPage(A4);
    let y = A4[1] - 64;
    for (const line of text.split('\n').flatMap((raw) => wrapChars(raw, 76))) {
      page.drawText(line, { x: 56, y, size, font, color: rgb(0.08, 0.08, 0.1) });
      y -= size * 1.45;
    }
  }
  return doc.save({ useObjectStreams: false });
}

// A 5x7 bitmap typewriter face (capitals only, like an old office typewriter), for scanned pages.
const GLYPHS: Record<string, string> = {
  A: '.###.#...##...#######...##...##...#',
  B: '####.#...##...#####.#...##...#####.',
  C: '.###.#...##....#....#....#...#.###.',
  D: '####.#...##...##...##...##...#####.',
  E: '######....#....####.#....#....#####',
  F: '######....#....####.#....#....#....',
  G: '.###.#...##....#.####...##...#.####',
  H: '#...##...##...#######...##...##...#',
  I: '.###...#....#....#....#....#...###.',
  J: '..###...#....#....#....#.#..#..##..',
  K: '#...##..#.#.#..##...#.#..#..#.#...#',
  L: '#....#....#....#....#....#....#####',
  M: '#...###.###.#.##...##...##...##...#',
  N: '#...###..##.#.##..###...##...##...#',
  O: '.###.#...##...##...##...##...#.###.',
  P: '####.#...##...#####.#....#....#....',
  Q: '.###.#...##...##...##.#.##..#..##.#',
  R: '####.#...##...#####.#.#..#..#.#...#',
  S: '.#####....#.....###.....#....#####.',
  T: '#####..#....#....#....#....#....#..',
  U: '#...##...##...##...##...##...#.###.',
  V: '#...##...##...##...##...#.#.#...#..',
  W: '#...##...##...##.#.##.#.###.###...#',
  X: '#...##...#.#.#...#...#.#.#...##...#',
  Y: '#...##...#.#.#...#....#....#....#..',
  Z: '#####....#...#...#...#...#....#####',
  '0': '.###.#...##..###.#.###..##...#.###.',
  '1': '..#...##....#....#....#....#...###.',
  '2': '.###.#...#....#...#...#...#...#####',
  '3': '#####...#...#.....#.....##...#.###.',
  '4': '...#...##..#.#.#..#.#####...#....#.',
  '5': '#####.....####.....#....##...#.###.',
  '6': '..##..#...#....####.#...##...#.###.',
  '7': '#####....#...#...#...#....#....#...',
  '8': '.###.#...##...#.###.#...##...#.###.',
  '9': '.###.#...##...#.####....#...#..##..',
  '.': '..........................##...##..',
  ',': '.....................##....#...#...',
  ':': '.....##...##.........##...##.......',
  ';': '.....##...##.........##....#...#...',
  "'": '..#....#...#.......................',
  '"': '.#.#..#.#..#.#.....................',
  '-': '...............' + '.###.' + '...............',
  '(': '...#...#...#....#....#.....#.....#.',
  ')': '.#.....#.....#....#....#...#...#...',
  '/': '.........#...#...#...#...#.........',
  '&': '.##..#..#.#.#...#...#.#.##..#..##.#',
  $: '..#...####.#....###....#.####...#..',
  '%': '##...##..#...#...#...#...#..##...##',
  '?': '.###.#...#....#...#...#.........#..',
  '!': '..#....#....#....#....#.........#..',
  '#': '.#.#..#.#.#####.#.#.#####.#.#..#.#.',
  '[': '.###..#....#....#....#....#....###.',
  ']': '.###....#....#....#....#....#..###.',
  _: '.'.repeat(30) + '#####',
  '@': '.###.#...##.####.#.##.####....####.',
  '*': '......#..#.#.#.###.#.#.#..#........',
  '+': '.......#....#..#####..#....#.......',
  '=': '..........#####.....#####..........',
  ' ': '...................................',
};

const COLS = 5;
const ROWS = 7;
const SCALE = 3;
const CELL_W = (COLS + 1) * SCALE;
const LINE_H = (ROWS + 4) * SCALE;
const PAGE_W = 1240; // A4 at 150 dpi
const PAGE_H = 1754;
const LEFT = 96;
const TOP = 110;

/** A small seeded PRNG (mulberry32), so the scan noise is the same on every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFor(text: string): number {
  return createHash('sha256').update(text).digest().readUInt32BE(0);
}

/** Rasterises one page of text into an 8-bit greyscale buffer, with skew, uneven ink and speckle. */
export function rasterisePage(text: string, seed: number): Buffer {
  const random = prng(seed);
  const pixels = Buffer.alloc(PAGE_W * PAGE_H, 0xf4); // off-white paper
  const skew = (random() - 0.5) * 0.012; // about ±0.35°
  const lines = text
    .toUpperCase()
    .split('\n')
    .flatMap((raw) => wrapChars(raw, Math.floor((PAGE_W - 2 * LEFT) / CELL_W)));
  lines.forEach((line, row) => {
    [...line].forEach((char, col) => {
      const glyph = GLYPHS[char] ?? (GLYPHS['?'] as string);
      const ink = 0x18 + Math.floor(random() * 0x30); // uneven typewriter ink
      const x0 = LEFT + col * CELL_W;
      const y0 = TOP + row * LINE_H + Math.round(x0 * skew);
      for (let gy = 0; gy < ROWS; gy++)
        for (let gx = 0; gx < COLS; gx++) {
          if (glyph[gy * COLS + gx] !== '#') continue;
          for (let dy = 0; dy < SCALE; dy++)
            for (let dx = 0; dx < SCALE; dx++) {
              const x = x0 + gx * SCALE + dx;
              const y = y0 + gy * SCALE + dy;
              if (x < 0 || y < 0 || x >= PAGE_W || y >= PAGE_H) continue;
              if (random() < 0.04) continue; // dropout where the ribbon was dry
              pixels[y * PAGE_W + x] = ink;
            }
        }
    });
  });
  for (let i = 0; i < PAGE_W * PAGE_H * 0.0015; i++) {
    const at = Math.floor(random() * PAGE_W * PAGE_H);
    pixels[at] = 0x40 + Math.floor(random() * 0x60); // photocopier speckle
  }
  return pixels;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Encodes a greyscale buffer as a PNG (no dependencies; zlib from Node). */
export function encodePng(pixels: Buffer, width = PAGE_W, height = PAGE_H): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) pixels.copy(raw, y * (width + 1) + 1, y * width, (y + 1) * width);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A scanned-looking PDF: one image per page and no text layer. */
export async function scannedPdf(title: string, pages: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  metadata(doc, title);
  for (const [index, text] of pages.entries()) {
    const png = await doc.embedPng(encodePng(rasterisePage(text, seedFor(`${title}#${index}`))));
    const page = doc.addPage(A4);
    page.drawImage(png, { x: 0, y: 0, width: A4[0], height: A4[1] });
  }
  return doc.save({ useObjectStreams: false });
}

/** The PDFs `pdfs.json` asks for, as [output path, bytes]. */
export async function renderAll(root: string): Promise<[string, Uint8Array][]> {
  const dir = path.join(root, EVAL_FIXTURES_DIR);
  const manifest = JSON.parse(readFileSync(path.join(dir, 'pdfs.json'), 'utf8')) as Record<string, Form[]>;
  const out: [string, Uint8Array][] = [];
  for (const [source, forms] of Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b))) {
    const pages = sourcePages(readFileSync(path.join(dir, source), 'utf8'));
    const title = `${path.basename(source, '.txt')} (fictional eval fixture)`;
    for (const form of forms) {
      const bytes = form === 'typed' ? await typedPdf(title, pages) : await scannedPdf(title, pages);
      out.push([path.join(dir, source.replace(/\.txt$/, `.${form}.pdf`)), bytes]);
    }
  }
  return out;
}

export async function main(argv: string[], root = process.cwd()): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { check: { type: 'boolean', default: false } } });
  const stale: string[] = [];
  for (const [file, bytes] of await renderAll(root)) {
    const current = existsSync(file) ? readFileSync(file) : undefined;
    if (current && Buffer.compare(current, Buffer.from(bytes)) === 0) continue;
    if (values.check) stale.push(path.relative(root, file));
    else {
      writeFileSync(file, bytes);
      console.log(`Wrote ${path.relative(root, file)} (${bytes.length} bytes)`);
    }
  }
  if (stale.length)
    throw new Error(`Stale eval fixtures (run \`pnpm materia-scripts make-fixtures\`): ${stale.join(', ')}`);
  if (values.check) console.log('Eval fixture PDFs are up to date.');
}
