import { matchQuote } from '@materia/domain';

/**
 * Where a quote sits on rendered PDF pages (AI-05): PDF.js's text content for the cited page (and
 * the next, for a quote that runs over the page break) is searched with the citations' quote match
 * (`matchQuote`, libs/domain), and each matched run of text becomes a box over the canvas, in
 * percent of the page so it scales with the page's CSS width.
 */

/** The parts of a PDF.js text item the highlight uses. */
export interface PdfTextItem {
  str: string;
  /** The item's text matrix in PDF user space. */
  transform: readonly number[];
  /** In user space units. */
  width: number;
  height: number;
  hasEOL?: boolean;
}

/** One page's text items and its viewport at scale 1. */
export interface PdfPageText {
  page: number;
  items: readonly PdfTextItem[];
  viewport: { width: number; height: number; transform?: readonly number[] | undefined };
}

/** A highlight box, in percent of its page. */
export interface HighlightBox {
  page: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** PDF.js's `Util.transform`: the product of two affine matrices. */
function multiply(m1: readonly number[], m2: readonly number[]): number[] {
  const [a1 = 1, b1 = 0, c1 = 0, d1 = 1, e1 = 0, f1 = 0] = m1;
  const [a2 = 1, b2 = 0, c2 = 0, d2 = 1, e2 = 0, f2 = 0] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

interface Span {
  page: PdfPageText;
  item: PdfTextItem;
  start: number;
  end: number;
}

/** The pages' text as one string (items spaced, pages on new lines), with each item's span. */
export function pagesText(pages: readonly PdfPageText[]): { text: string; spans: Span[] } {
  let text = '';
  const spans: Span[] = [];
  for (const page of pages) {
    if (text) text += '\n';
    for (const item of page.items) {
      if (!item.str) {
        if (item.hasEOL) text += ' ';
        continue;
      }
      if (text && !/\s$/.test(text)) text += ' ';
      spans.push({ page, item, start: text.length, end: text.length + item.str.length });
      text += item.str;
    }
  }
  return { text, spans };
}

/** A part of a text item as a box on its page (horizontal text; rotated items get their bounding run). */
function box(span: Span, from: number, to: number): HighlightBox | null {
  const { item, page } = span;
  const { width: pageWidth, height: pageHeight } = page.viewport;
  if (!pageWidth || !pageHeight || !item.str.length) return null;
  const view = page.viewport.transform ?? [1, 0, 0, -1, 0, pageHeight];
  const m = multiply(view, item.transform);
  const scale = Math.hypot(view[0] ?? 1, view[1] ?? 0);
  const height = Math.hypot(m[2] ?? 0, m[3] ?? 0) || item.height * scale;
  const width = item.width * scale;
  const startFraction = from / item.str.length;
  const endFraction = to / item.str.length;
  const left = (m[4] ?? 0) + width * startFraction;
  const top = (m[5] ?? 0) - height;
  return {
    page: page.page,
    left: (left / pageWidth) * 100,
    top: (top / pageHeight) * 100,
    width: (width * (endFraction - startFraction) * 100) / pageWidth,
    height: (height * 1.15 * 100) / pageHeight,
  };
}

/**
 * The boxes to draw for a quote over these pages, or null when it isn't there (or the pages have no
 * text layer at all: a scanned page, whose text only the OCR'd chunks have).
 */
export function highlightBoxes(pages: readonly PdfPageText[], quote: string): HighlightBox[] | null {
  const { text, spans } = pagesText(pages);
  if (!text.trim()) return null;
  const match = matchQuote(quote, text);
  if (!match) return null;
  const boxes: HighlightBox[] = [];
  for (const range of match.ranges) {
    for (const span of spans) {
      if (span.end <= range.start || span.start >= range.end) continue;
      const found = box(
        span,
        Math.max(range.start, span.start) - span.start,
        Math.min(range.end, span.end) - span.start,
      );
      if (found && found.width > 0) boxes.push(found);
    }
  }
  return boxes.length ? boxes : null;
}

/** Whether any of the pages has a text layer. */
export const hasTextLayer = (pages: readonly PdfPageText[]) =>
  pages.some((page) => page.items.some((item) => item.str.trim().length > 0));
