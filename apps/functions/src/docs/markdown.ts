/**
 * Markdown to WordprocessingML (INT-06): the `{@body}` block a letterhead takes from Clerk drafting
 * (AI-10) or a person. Covers paragraphs, line breaks, headings (`#` to `###`), bold, italics,
 * bullet and numbered lists (two levels by indent) and quotes. Lists are drawn with their own
 * bullet or number and a hanging indent rather than Word numbering, so they look the same in any
 * template without adding a numbering part. Placeholders such as `[[TO CONFIRM: grant date]]` are
 * highlighted so they can't go out unnoticed. Links keep their text only.
 */

const escapeXml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// eslint-disable-next-line no-control-regex
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

export interface MarkdownOptions {
  /** Paragraph style ids the template defines (`Heading1`…); headings fall back to bold text. */
  styles?: ReadonlySet<string>;
}

interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
  highlight: boolean;
  /** A line break before the text. */
  br?: boolean;
  /** Font size in half-points (a heading without a heading style). */
  size?: number;
}

type Block =
  | { kind: 'paragraph'; lines: string[] }
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'item'; ordered: boolean; level: number; number: number; text: string }
  | { kind: 'quote'; lines: string[] };

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,4})[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

/** Splits Markdown into blocks. A blank line ends a paragraph; consecutive list items form a list. */
export function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const counters: number[] = [];
  let paragraph: string[] | null = null;
  let quote: string[] | null = null;
  const flush = () => {
    if (paragraph) blocks.push({ kind: 'paragraph', lines: paragraph });
    if (quote) blocks.push({ kind: 'quote', lines: quote });
    paragraph = null;
    quote = null;
  };
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (line.trim() === '') {
      flush();
      counters.length = 0;
      continue;
    }
    if (RULE.test(line)) {
      flush();
      continue;
    }
    const heading = HEADING.exec(line);
    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    const quoted = QUOTE.exec(line);
    if (heading) {
      flush();
      counters.length = 0;
      const level = Math.min(heading[1]?.length ?? 1, 3) as 1 | 2 | 3;
      blocks.push({ kind: 'heading', level, text: heading[2] ?? '' });
    } else if (bullet || ordered) {
      flush();
      const indent = (bullet?.[1] ?? ordered?.[1] ?? '').replace(/\t/g, '    ').length;
      const level = indent >= 2 ? 1 : 0;
      counters.length = level + 1;
      const next = ordered ? (counters[level] ?? Number(ordered[2]) - 1) + 1 : 0;
      counters[level] = next;
      blocks.push({
        kind: 'item',
        ordered: !!ordered,
        level,
        number: next,
        text: (bullet ? bullet[2] : ordered?.[3]) ?? '',
      });
    } else if (quoted) {
      if (paragraph) flush();
      quote = [...(quote ?? []), quoted[1] ?? ''];
    } else {
      if (quote) flush();
      paragraph = [...(paragraph ?? []), line.trim()];
    }
  }
  flush();
  return blocks;
}

/**
 * Inline Markdown to runs: `**bold**`, `__bold__`, `*italic*`, `_italic_` (not inside a word),
 * `***both***`, `\*` escapes, `[text](url)` (text only) and `[[placeholders]]` (highlighted).
 */
export function parseInline(text: string): Run[] {
  const runs: Run[] = [];
  let bold = false;
  let italic = false;
  let buffer = '';
  const push = (highlight = false) => {
    if (buffer) runs.push({ text: buffer, bold, italic, highlight });
    buffer = '';
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const char = text[i] ?? '';
    if (char === '\\' && i + 1 < text.length && /[\\`*_{}[\]()#+\-.!>]/.test(text[i + 1] ?? '')) {
      buffer += text[i + 1];
      i += 2;
      continue;
    }
    const placeholder = /^\[\[[^\]\n]{1,300}\]\]/.exec(rest);
    if (placeholder) {
      push();
      buffer = placeholder[0];
      push(true);
      i += placeholder[0].length;
      continue;
    }
    const link = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(rest);
    if (link) {
      buffer += link[1];
      i += link[0].length;
      continue;
    }
    const marker = /^(\*{1,3}|_{1,3})/.exec(rest)?.[1];
    if (marker) {
      const before = text[i - 1] ?? ' ';
      const after = text[i + marker.length] ?? ' ';
      // Underscores inside a word (snake_case) are text, as in CommonMark.
      const intraword = marker.startsWith('_') && /\w/.test(before) && /\w/.test(after);
      const opens = !/\s/.test(after);
      const closes = !/\s/.test(before);
      const strong = marker.length >= 2;
      const emphasis = marker.length !== 2;
      const toggles = (strong ? bold : false) || (emphasis ? italic : false) ? closes : opens;
      if (!intraword && toggles) {
        push();
        if (strong) bold = !bold;
        if (emphasis) italic = !italic;
        i += marker.length;
        continue;
      }
    }
    buffer += char;
    i += 1;
  }
  push();
  return runs;
}

function runXml(run: Run): string {
  // In the order the schema requires (Word refuses a file with them out of order).
  const props = [
    run.bold ? '<w:b/><w:bCs/>' : '',
    run.italic ? '<w:i/><w:iCs/>' : '',
    run.size ? `<w:sz w:val="${run.size}"/><w:szCs w:val="${run.size}"/>` : '',
    run.highlight ? '<w:highlight w:val="yellow"/>' : '',
  ]
    .filter(Boolean)
    .join('');
  const text = escapeXml(run.text.replace(INVALID_XML_CHARS, ''));
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}${run.br ? '<w:br/>' : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
}

const runsXml = (lines: readonly string[]) =>
  lines
    .flatMap((line, index) => {
      const runs = parseInline(line);
      if (index > 0) {
        // A line break inside a paragraph keeps the line (an address, a list of names).
        if (runs[0]) runs[0] = { ...runs[0], br: true };
        else return ['<w:r><w:br/></w:r>'];
      }
      return runs.map(runXml);
    })
    .join('');

const paragraph = (props: string, body: string) => `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}${body}</w:p>`;

/** Hanging indent per list level, in twentieths of a point (0.63 cm steps, as Word does). */
const LIST_INDENT = [360, 720];
const HEADING_SIZES: Record<1 | 2 | 3, number> = { 1: 32, 2: 28, 3: 24 };

/** WordprocessingML paragraphs for a Markdown body; empty for an empty body. */
export function markdownToWordml(markdown: string, options: MarkdownOptions = {}): string {
  const styles = options.styles ?? new Set<string>();
  return parseBlocks(markdown)
    .map((block) => {
      switch (block.kind) {
        case 'paragraph':
          return paragraph('', runsXml(block.lines));
        case 'quote':
          return paragraph('<w:ind w:left="720"/>', runsXml(block.lines));
        case 'heading': {
          const style = `Heading${block.level}`;
          if (styles.has(style)) return paragraph(`<w:pStyle w:val="${style}"/>`, runsXml([block.text]));
          // No heading style in the template: bold, larger text that keeps with the next paragraph.
          const runs = parseInline(block.text).map((run) =>
            runXml({ ...run, bold: true, size: HEADING_SIZES[block.level] }),
          );
          return paragraph('<w:keepNext/><w:spacing w:before="240"/>', runs.join(''));
        }
        case 'item': {
          const left = (LIST_INDENT[block.level] ?? 720) + 360;
          const label = block.ordered ? `${block.number}.` : block.level === 0 ? '•' : '–';
          return paragraph(
            `<w:ind w:left="${left}" w:hanging="360"/>`,
            `<w:r><w:t xml:space="preserve">${label}</w:t></w:r><w:r><w:tab/></w:r>${runsXml([block.text])}`,
          );
        }
      }
    })
    .join('');
}
