import PizZip from 'pizzip';

/**
 * Reading a .docx package (INT-06): the parts docxtemplater fills, the paragraph styles a template
 * defines, and the fonts it uses, checked against those the PDF preview service has.
 */

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** A .docx we can't open: not a zip, or a zip without a Word document in it. */
export class NotDocxError extends Error {
  constructor() {
    super('Not a .docx file');
    this.name = 'NotDocxError';
  }
}

export function openDocx(data: Uint8Array): PizZip {
  let zip: PizZip;
  try {
    zip = new PizZip(data);
  } catch {
    throw new NotDocxError();
  }
  if (!zip.file('word/document.xml')) throw new NotDocxError();
  return zip;
}

const text = (zip: PizZip, name: string) => zip.file(name)?.asText() ?? '';

/** The parts with text a template can carry tags in: the body, headers, footers and notes. */
export const textParts = (zip: PizZip): string[] =>
  Object.keys(zip.files)
    .filter((name) => /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(name))
    .sort();

/** The paragraph style ids the template defines (`Heading1`, `Title`…). */
export function paragraphStyles(zip: PizZip): Set<string> {
  const styles = text(zip, 'word/styles.xml');
  const ids = new Set<string>();
  for (const match of styles.matchAll(/<w:style\b[^>]*w:type="paragraph"[^>]*>/g)) {
    const id = /w:styleId="([^"]+)"/.exec(match[0])?.[1];
    if (id) ids.add(id);
  }
  return ids;
}

const decode = (value: string) =>
  value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");

/**
 * The Latin fonts the text uses: named in run fonts (`w:rFonts w:ascii`) in the body, headers,
 * footers and styles, plus the theme's heading and body fonts where a style points at them.
 */
export function templateFonts(zip: PizZip): string[] {
  const fonts = new Set<string>();
  const theme = text(zip, 'word/theme/theme1.xml');
  const themeFont = (which: 'major' | 'minor') =>
    new RegExp(`<a:${which}Font>[\\s\\S]*?<a:latin typeface="([^"]*)"`).exec(theme)?.[1];
  for (const part of [...textParts(zip), 'word/styles.xml']) {
    for (const match of text(zip, part).matchAll(/<w:rFonts\b[^>]*>/g)) {
      const tag = match[0];
      for (const attr of ['w:ascii', 'w:hAnsi']) {
        const name = new RegExp(`${attr}="([^"]+)"`).exec(tag)?.[1];
        if (name) fonts.add(decode(name));
      }
      for (const attr of ['w:asciiTheme', 'w:hAnsiTheme']) {
        const ref = new RegExp(`${attr}="([^"]+)"`).exec(tag)?.[1];
        const name = ref ? themeFont(ref.startsWith('major') ? 'major' : 'minor') : undefined;
        if (name) fonts.add(decode(name));
      }
    }
  }
  return [...fonts].filter((name) => name.trim() !== '').sort();
}

/**
 * Fonts the preview service renders as themselves or with a metric-compatible stand-in (the
 * Liberation, Carlito, Caladea and DejaVu families in apps/doc-services' preview image), plus
 * symbol fonts LibreOffice maps to OpenSymbol. Lower case.
 */
const SERVER_FONTS = new Set(
  [
    'Arial',
    'Helvetica',
    'Liberation Sans',
    'Times New Roman',
    'Times',
    'Liberation Serif',
    'Courier New',
    'Courier',
    'Liberation Mono',
    'Calibri',
    'Calibri Light',
    'Carlito',
    'Cambria',
    'Caladea',
    'DejaVu Sans',
    'DejaVu Serif',
    'DejaVu Sans Mono',
    'Symbol',
    'Wingdings',
    'OpenSymbol',
  ].map((name) => name.toLowerCase()),
);

/** The template's fonts the PDF preview will substitute (the .docx itself keeps them). */
export const substitutedFonts = (fonts: readonly string[]) =>
  fonts.filter((name) => !SERVER_FONTS.has(name.toLowerCase()));

/** The warning for substituted fonts, or none. */
export function fontWarnings(fonts: readonly string[]): string[] {
  const missing = substitutedFonts(fonts);
  if (missing.length === 0) return [];
  const list = missing.slice(0, 5).join(', ') + (missing.length > 5 ? ` and ${missing.length - 5} more` : '');
  return [`The PDF preview uses a similar font in place of ${list}. The Word document keeps the original.`];
}
