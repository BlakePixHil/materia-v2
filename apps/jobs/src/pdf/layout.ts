import type { PdfPosition } from '@materia/domain';

/** Distance from the page edge to a stamp or page number, in points (about 10 mm). */
export const MARGIN = 28;

export interface Box {
  width: number;
  height: number;
}

/**
 * Where to draw text of `textWidth` so it sits at `position` on a page, in PDF user space (origin
 * bottom left). Text never starts left of the margin, even when it is wider than the page.
 */
export function placeText(
  position: PdfPosition,
  page: Box,
  textWidth: number,
  fontSize: number,
): { x: number; y: number } {
  const [vertical, horizontal] = position.split('-') as ['top' | 'bottom', 'left' | 'center' | 'right'];
  const y = vertical === 'top' ? page.height - MARGIN - fontSize : MARGIN;
  const x =
    horizontal === 'left'
      ? MARGIN
      : horizontal === 'center'
        ? (page.width - textWidth) / 2
        : page.width - MARGIN - textWidth;
  return { x: Math.max(MARGIN, x), y };
}

/** `Page {n} of {total}` → `Page 3 of 12`. Numbering starts at `start` on the first page. */
export function pageLabel(format: string, index: number, pageCount: number, start: number): string {
  const n = start + index;
  const total = start + pageCount - 1;
  return format.replaceAll('{n}', String(n)).replaceAll('{total}', String(total));
}

/** A page range resolved against a document: 1-based, inclusive spans. */
export type PageSpan = [first: number, last: number];

/**
 * Parses `1-3,7` against a document of `pageCount` pages. Throws a RangeError for pages outside the
 * document or reversed spans, so the caller can report the input. No range means every page.
 */
export function parsePageRange(range: string | undefined, pageCount: number): PageSpan[] {
  if (range === undefined) return pageCount > 0 ? [[1, pageCount]] : [];
  return range.split(',').map((part) => {
    const [a, b = a] = part.split('-');
    const first = Number(a);
    const last = Number(b);
    if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first || last > pageCount) {
      throw new RangeError(`Page range ${part} is outside 1-${pageCount}`);
    }
    return [first, last] as PageSpan;
  });
}

export function spanPages(spans: PageSpan[]): number {
  return spans.reduce((sum, [first, last]) => sum + last - first + 1, 0);
}

/** qpdf `--pages` syntax for the spans (`1-3,7`). */
export function qpdfRange(spans: PageSpan[]): string {
  return spans.map(([first, last]) => (first === last ? `${first}` : `${first}-${last}`)).join(',');
}

/** The displayed size of a page: its crop box, turned by `/Rotate`. */
export function displayedBox(box: [number, number, number, number], rotate: number): Box {
  const width = Math.abs(box[2] - box[0]);
  const height = Math.abs(box[3] - box[1]);
  const quarterTurns = ((Math.round(rotate / 90) % 4) + 4) % 4;
  return quarterTurns % 2 === 1 ? { width: height, height: width } : { width, height };
}
