/**
 * `materia-scripts fixture-pdfs`: writes the fictional fixture PDFs used by the seed and tests to
 * libs/test-utils/fixtures/pdfs/. Every document is invented and marked as a sample. The output is
 * deterministic (fixed metadata), so re-running only changes the files when this script changes.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from 'pdf-lib';

import type { FixtureInfo, FixtureName } from './dataset.ts';

export const FIXTURE_DIR = path.resolve(import.meta.dirname, '../../../../libs/test-utils/fixtures/pdfs');
export const FIXTURE_NAMES: readonly FixtureName[] = ['will', 'death-certificate', 'court-order'];

const FIXED_DATE = new Date('2026-01-01T00:00:00Z');
const A4: [number, number] = [595.28, 841.89];
const MARGIN = 64;

interface Block {
  text: string;
  size?: number;
  bold?: boolean;
  gap?: number;
}

const WILL: Block[][] = [
  [
    { text: 'SAMPLE — FICTIONAL DOCUMENT FOR TESTING ONLY', size: 9, bold: true, gap: 18 },
    { text: 'LAST WILL AND TESTAMENT', size: 18, bold: true, gap: 10 },
    { text: 'of Margaret Anne Doyle (fictional)', size: 12, gap: 20 },
    { text: '1. I revoke all former wills and testamentary dispositions made by me.' },
    {
      text: '2. I appoint my daughter Catherine Doyle and my friend Peter Hale to be the executors and trustees of this will.',
    },
    { text: '3. I give my residence at 1 Example Street, Geelong to my daughter Catherine Doyle.' },
    { text: '4. I give the residue of my estate to my daughter Catherine Doyle absolutely.' },
    { text: '5. I make no provision for my son Thomas Doyle, for reasons he understands.' },
  ],
  [
    { text: 'SAMPLE — FICTIONAL DOCUMENT FOR TESTING ONLY', size: 9, bold: true, gap: 18 },
    { text: '6. I direct that my executors pay my funeral expenses and debts from my estate.' },
    { text: '7. I declare that this will is governed by the law of Victoria.', gap: 28 },
    { text: 'Signed by the will-maker in our presence on 3 May 2019 (fictional).', gap: 36 },
    { text: '_____________________________          _____________________________' },
    { text: 'Will-maker                                            Witness 1', size: 9, gap: 28 },
    { text: '_____________________________' },
    { text: 'Witness 2', size: 9 },
  ],
];

const DEATH_CERTIFICATE: Block[][] = [
  [
    { text: 'SAMPLE — NOT A REAL CERTIFICATE', size: 16, bold: true, gap: 8 },
    { text: 'Fictional document for software testing. Not issued by any registry.', size: 9, gap: 24 },
    { text: 'DEATH CERTIFICATE (SAMPLE)', size: 18, bold: true, gap: 20 },
    { text: 'Name of deceased: Margaret Anne Doyle (fictional)' },
    { text: 'Place of death: Geelong, Victoria' },
    { text: 'Usual residence: 1 Example Street, Geelong VIC 3220' },
    { text: 'Occupation: Retired teacher' },
    { text: 'Registration number: SAMPLE-0000-0000', gap: 24 },
    { text: 'SAMPLE — NOT A REAL CERTIFICATE', size: 16, bold: true },
  ],
];

const COURT_ORDER: Block[][] = [
  [
    { text: 'SAMPLE — FICTIONAL DOCUMENT FOR TESTING ONLY', size: 9, bold: true, gap: 18 },
    { text: 'IN THE SUPREME COURT OF VICTORIA (FICTIONAL)', size: 12, bold: true, gap: 6 },
    { text: 'Nguyen v Nguyen — Proceeding No. SAMPLE-0001', size: 12, gap: 20 },
    { text: 'ORDERS', size: 18, bold: true, gap: 16 },
    { text: 'THE COURT ORDERS THAT:', bold: true, gap: 12 },
    { text: '1. The plaintiff file and serve any affidavit on which she intends to rely within 21 days.' },
    { text: '2. The defendant file and serve any affidavit in reply within 42 days.' },
    { text: '3. The proceeding be referred to mediation, to be completed within 60 days.' },
    { text: '4. Costs be reserved.' },
  ],
];

const CONTENT: Record<FixtureName, Block[][]> = {
  will: WILL,
  'death-certificate': DEATH_CERTIFICATE,
  'court-order': COURT_ORDER,
};

const TITLES: Record<FixtureName, string> = {
  will: 'Will (fictional sample)',
  'death-certificate': 'Death certificate (SAMPLE)',
  'court-order': 'Orders (fictional sample)',
};

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) > width && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawPage(page: PDFPage, blocks: Block[], regular: PDFFont, bold: PDFFont): void {
  let y = A4[1] - MARGIN;
  for (const block of blocks) {
    const size = block.size ?? 11;
    const font = block.bold ? bold : regular;
    for (const line of wrap(block.text, font, size, A4[0] - MARGIN * 2)) {
      page.drawText(line, { x: MARGIN, y, size, font, color: rgb(0.1, 0.1, 0.12) });
      y -= size * 1.5;
    }
    y -= block.gap ?? 8;
  }
}

/** Renders one fixture PDF. */
export async function renderFixture(name: FixtureName): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(TITLES[name]);
  doc.setAuthor('Materia test fixtures (fictional)');
  doc.setProducer('materia-scripts fixture-pdfs');
  doc.setCreator('materia-scripts fixture-pdfs');
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const blocks of CONTENT[name]) drawPage(doc.addPage(A4), blocks, regular, bold);
  return doc.save({ useObjectStreams: false });
}

/** Size, hash and page count of a committed fixture, for the seeded document records. */
export function fixtureInfo(name: FixtureName, dir = FIXTURE_DIR): FixtureInfo {
  const bytes = readFileSync(path.join(dir, `${name}.pdf`));
  return {
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    pages: CONTENT[name].length,
  };
}

export function readFixture(name: FixtureName, dir = FIXTURE_DIR): Buffer {
  return readFileSync(path.join(dir, `${name}.pdf`));
}

export async function main(): Promise<void> {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  for (const name of FIXTURE_NAMES) {
    const bytes = await renderFixture(name);
    writeFileSync(path.join(FIXTURE_DIR, `${name}.pdf`), bytes);
    console.log(`Wrote ${path.relative(process.cwd(), path.join(FIXTURE_DIR, `${name}.pdf`))} (${bytes.length} bytes)`);
  }
}
