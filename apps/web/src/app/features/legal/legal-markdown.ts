import { parseInline, type MdInline } from '@materia/ui/markdown';

/**
 * The block structure of a legal document (SEC-01). Unlike notes and Clerk answers, a document
 * needs real headings (for its outline and screen readers) and tables (the sub-processor list), so
 * blocks are parsed here; inline text goes through the shared safe parser (`parseInline`), with
 * links to the app's own pages kept. Nothing is ever passed to `innerHTML`.
 */
export type LegalBlock =
  | { type: 'heading'; level: 2 | 3; id: string; children: MdInline[] }
  | { type: 'paragraph'; children: MdInline[] }
  | { type: 'list'; ordered: boolean; items: MdInline[][] }
  | { type: 'quote'; paragraphs: MdInline[][] }
  | { type: 'table'; header: MdInline[][]; rows: MdInline[][][]; labelledBy: string | null }
  | { type: 'code'; text: string };

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/;
const FENCE = /^\s*(```|~~~)/;

const inline = (text: string) => parseInline(text.trim(), false, { citations: false, internalLinks: true });

/** `Who we are` → `who-we-are`. */
export function headingId(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s+/g, '-') || 'section'
  );
}

/** The cells of a `| a | b |` row. */
function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/** Plain text of inline nodes (for heading ids). */
function plain(nodes: readonly MdInline[]): string {
  return nodes.map((node) => ('text' in node ? node.text : 'children' in node ? plain(node.children) : '')).join('');
}

/** Parses a legal document's Markdown into blocks. `#` and `##` are level 2, deeper headings level 3. */
export function parseLegalMarkdown(src: string): LegalBlock[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: LegalBlock[] = [];
  const ids = new Map<string, number>();
  let lastHeading: string | null = null;
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', children: inline(paragraph.join(' ')) });
    paragraph = [];
  };
  const uniqueId = (text: string) => {
    const base = headingId(text);
    const seen = ids.get(base) ?? 0;
    ids.set(base, seen + 1);
    return seen ? `${base}-${seen + 1}` : base;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;

    if (!line.trim()) {
      flush();
      continue;
    }

    if (FENCE.test(line)) {
      flush();
      const fence = FENCE.exec(line)?.[1] ?? '```';
      const code: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] as string).trim().startsWith(fence)) code.push(lines[i++] as string);
      blocks.push({ type: 'code', text: code.join('\n') });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const children = inline(heading[2] ?? '');
      const id = uniqueId(plain(children));
      lastHeading = id;
      blocks.push({ type: 'heading', level: (heading[1] ?? '').length <= 2 ? 2 : 3, id, children });
      continue;
    }

    if (TABLE_ROW.test(line) && TABLE_RULE.test(lines[i + 1] ?? '')) {
      flush();
      const header = cells(line).map(inline);
      const rows: MdInline[][][] = [];
      let j = i + 2;
      while (j < lines.length && TABLE_ROW.test(lines[j] as string)) rows.push(cells(lines[j++] as string).map(inline));
      blocks.push({ type: 'table', header, rows, labelledBy: lastHeading });
      i = j - 1;
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      flush();
      const ordered = !bullet;
      const items: MdInline[][] = [];
      let j = i;
      while (j < lines.length) {
        const match = (ordered ? NUMBERED : BULLET).exec(lines[j] as string);
        if (!match) break;
        items.push(inline(match[1] ?? ''));
        j++;
      }
      blocks.push({ type: 'list', ordered, items });
      i = j - 1;
      continue;
    }

    if (QUOTE.test(line)) {
      flush();
      const paragraphs: string[][] = [[]];
      let j = i;
      while (j < lines.length) {
        const match = QUOTE.exec(lines[j] as string);
        if (!match) break;
        const text = match[1] ?? '';
        if (text.trim()) paragraphs[paragraphs.length - 1]?.push(text);
        else paragraphs.push([]);
        j++;
      }
      blocks.push({
        type: 'quote',
        paragraphs: paragraphs.filter((part) => part.length).map((part) => inline(part.join(' '))),
      });
      i = j - 1;
      continue;
    }

    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

/**
 * The blocks of the section under the first heading named `title`, up to the next heading of the
 * same or a higher level (the terms' "Summary", shown where an owner accepts them).
 */
export function sectionBlocks(blocks: readonly LegalBlock[], title: string): LegalBlock[] {
  const start = blocks.findIndex((block) => block.type === 'heading' && plain(block.children) === title);
  if (start < 0) return [];
  const level = (blocks[start] as Extract<LegalBlock, { type: 'heading' }>).level;
  const end = blocks.findIndex((block, i) => i > start && block.type === 'heading' && block.level <= level);
  return blocks.slice(start + 1, end < 0 ? undefined : end);
}
