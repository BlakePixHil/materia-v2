import { readFile } from 'node:fs/promises';

import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb } from 'pdf-lib';

import type { PdfPosition } from '@materia/domain';

import { FIXED_DATE } from './determinism';
import { pageLabel, placeText, type Box } from './layout';

/** DejaVu Sans covers Latin extended and Vietnamese diacritics ("Nguyễn"), so stamps never lose glyphs. */
export const STAMP_FONT = process.env['STAMP_FONT_PATH'] ?? '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
export const STAMP_FONT_SIZE = 9;

export interface OverlayOptions {
  stamp?: { text: string; position: PdfPosition } | undefined;
  pageNumbers?: { format: string; start: number; position: PdfPosition } | undefined;
}

/**
 * One overlay page per output page, each the displayed size of its page, carrying the stamp and the
 * page number. qpdf lays it over the merged file, so pdf-lib never loads the (possibly huge) merge.
 */
export async function buildOverlay(boxes: Box[], options: OverlayOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  // A fixed name: pdf-lib otherwise adds a random suffix, which would break determinism.
  const font = await doc.embedFont(await readFile(STAMP_FONT), { subset: true, customName: 'MateriaStamp-DejaVuSans' });
  const colour = rgb(0.2, 0.2, 0.2);

  boxes.forEach((box, index) => {
    const page = doc.addPage([box.width, box.height]);
    const draw = (text: string, position: PdfPosition) => {
      const at = placeText(position, box, font.widthOfTextAtSize(text, STAMP_FONT_SIZE), STAMP_FONT_SIZE);
      page.drawText(text, { ...at, size: STAMP_FONT_SIZE, font, color: colour });
    };
    if (options.stamp) draw(options.stamp.text, options.stamp.position);
    if (options.pageNumbers) {
      const { format, start, position } = options.pageNumbers;
      draw(pageLabel(format, index, boxes.length, start), position);
    }
  });

  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  return doc.save({ useObjectStreams: false });
}
