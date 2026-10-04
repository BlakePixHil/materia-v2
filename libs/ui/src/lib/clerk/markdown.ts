/**
 * A small, safe Markdown subset for Clerk's answers, parsed to a tree that Angular templates render.
 * Nothing is ever passed to `innerHTML`: raw HTML in the model's output stays literal text.
 *
 * Supported: paragraphs, headings (shown as bold lines), `-`/`*`/`1.` lists, `>` quotes, fenced code,
 * `**bold**`, `*italic*`, `` `code` ``, `[links](https://…)` (http, https and mailto only) and citation
 * markers `[1]` / `[1, 2]`. Images are never rendered (only their alt text), so remote content can't
 * load. While `streaming`, half-finished syntax at the end (an open `**`, a `[1` marker, an unclosed
 * fence) renders tolerantly instead of flashing raw markers.
 */

export type MdInline =
  | { type: 'text'; text: string }
  | { type: 'strong'; children: MdInline[] }
  | { type: 'em'; children: MdInline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; children: MdInline[] }
  | { type: 'cite'; refs: number[] };

export type MdBlock =
  | { type: 'paragraph'; children: MdInline[] }
  | { type: 'heading'; children: MdInline[] }
  | { type: 'list'; ordered: boolean; items: MdInline[][] }
  | { type: 'quote'; children: MdInline[] }
  | { type: 'code'; text: string };

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

/** True for URLs a Clerk answer may link to: http(s) and mailto only. */
export function isSafeUrl(url: string): boolean {
  return SAFE_URL.test(url.trim());
}

const CITE = /^\[(\d+(?:\s*,\s*\d+)*)\]/;
const LINK = /^\[([^\]\n]+)\]\(([^)\s]*)\)/;
const IMAGE = /^!\[([^\]\n]*)\]\(([^)\s]*)\)/;
/** Something that could still become a citation or link once more text streams in. */
const PARTIAL_BRACKET = /^!?\[[^\]\n]*(\]\([^)\s]*)?$/;

function pushText(out: MdInline[], text: string): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last?.type === 'text') last.text += text;
  else out.push({ type: 'text', text });
}

function isWordChar(char: string | undefined): boolean {
  return !!char && /[\p{L}\p{N}]/u.test(char);
}

/** Parses inline Markdown. */
export function parseInline(src: string, streaming = false): MdInline[] {
  const out: MdInline[] = [];
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    const char = src[i] as string;

    if (char === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i) {
        out.push({ type: 'code', text: src.slice(i + 1, end) });
        i = end + 1;
      } else if (streaming) {
        if (i + 1 < src.length) out.push({ type: 'code', text: src.slice(i + 1) });
        i = src.length;
      } else {
        pushText(out, char);
        i += 1;
      }
      continue;
    }

    if (rest.startsWith('**') || rest.startsWith('__')) {
      const delim = rest.slice(0, 2);
      const end = src.indexOf(delim, i + 2);
      if (end > i + 2) {
        out.push({ type: 'strong', children: parseInline(src.slice(i + 2, end), streaming) });
        i = end + 2;
      } else if (streaming && end === -1) {
        const inner = src.slice(i + 2);
        if (inner) out.push({ type: 'strong', children: parseInline(inner, streaming) });
        i = src.length;
      } else {
        pushText(out, delim);
        i += 2;
      }
      continue;
    }

    if ((char === '*' || char === '_') && !(char === '_' && isWordChar(src[i - 1]))) {
      let end = -1;
      for (let j = i + 1; j < src.length; j++) {
        if (src[j] === char && src[j + 1] !== char && !(char === '_' && isWordChar(src[j + 1]))) {
          end = j;
          break;
        }
      }
      if (end > i + 1) {
        out.push({ type: 'em', children: parseInline(src.slice(i + 1, end), streaming) });
        i = end + 1;
      } else if (streaming && end === -1 && i + 1 < src.length && src[i + 1] !== ' ') {
        out.push({ type: 'em', children: parseInline(src.slice(i + 1), streaming) });
        i = src.length;
      } else if (streaming && i === src.length - 1) {
        i += 1; // a lone trailing marker: wait for more text
      } else {
        pushText(out, char);
        i += 1;
      }
      continue;
    }

    if (char === '!' && src[i + 1] === '[') {
      const image = IMAGE.exec(rest);
      if (image) {
        // Never render images (they could load remote content); keep the alt text.
        pushText(out, image[1] ?? '');
        i += image[0].length;
        continue;
      }
      if (streaming && PARTIAL_BRACKET.test(rest)) {
        i = src.length;
        continue;
      }
    }

    if (char === '[') {
      const cite = CITE.exec(rest);
      if (cite) {
        const refs = (cite[1] ?? '').split(',').map((n) => Number(n.trim()));
        out.push({ type: 'cite', refs });
        i += cite[0].length;
        continue;
      }
      const link = LINK.exec(rest);
      if (link) {
        const children = parseInline(link[1] ?? '', streaming);
        const href = link[2] ?? '';
        if (isSafeUrl(href)) out.push({ type: 'link', href: href.trim(), children });
        else out.push(...children);
        i += link[0].length;
        continue;
      }
      if (streaming && PARTIAL_BRACKET.test(rest)) {
        // `[1` or `[the will](htt` at the end of a chunk: show the link text, hide the markers.
        const text = /^\[([^\]\n]*)\]\(/.exec(rest)?.[1];
        if (text) out.push(...parseInline(text, streaming));
        i = src.length;
        continue;
      }
    }

    pushText(out, char);
    i += 1;
  }
  return out;
}

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;

/** Parses Markdown into blocks. */
export function parseMarkdown(src: string, streaming = false): MdBlock[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', children: parseInline(paragraph.join(' '), streaming) });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    // While streaming, only the last line can be incomplete.
    const tail = streaming && i === lines.length - 1;

    if (FENCE.test(line)) {
      flush();
      const fence = (FENCE.exec(line)?.[1] ?? '```') as string;
      const code: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] as string).trim().startsWith(fence)) code.push(lines[i++] as string);
      blocks.push({ type: 'code', text: code.join('\n') });
      continue;
    }

    if (!line.trim()) {
      flush();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: 'heading', children: parseInline(heading[1] ?? '', tail) });
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
        items.push(parseInline(match[1] ?? '', streaming && j === lines.length - 1));
        j++;
      }
      blocks.push({ type: 'list', ordered, items });
      i = j - 1;
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      flush();
      const parts: string[] = [];
      let j = i;
      while (j < lines.length) {
        const match = QUOTE.exec(lines[j] as string);
        if (!match) break;
        parts.push(match[1] ?? '');
        j++;
      }
      blocks.push({ type: 'quote', children: parseInline(parts.join(' '), streaming && j === lines.length) });
      i = j - 1;
      continue;
    }

    // A lone `#`, `-` or `>` at the very end of a stream could become a heading, list or quote.
    if (tail && /^\s*([#>]+|[-*+]|\d+[.)]?)\s*$/.test(line)) continue;
    paragraph.push(line.trim());
  }
  if (paragraph.length) {
    blocks.push({ type: 'paragraph', children: parseInline(paragraph.join(' '), streaming) });
  }
  return blocks;
}

/** Plain text of inline nodes (for labels and tests). */
export function inlineText(nodes: readonly MdInline[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case 'text':
        case 'code':
          return node.text;
        case 'cite':
          return '';
        default:
          return inlineText(node.children);
      }
    })
    .join('');
}

/** Every citation number referenced in the blocks, in order of first use. */
export function citedRefs(blocks: readonly MdBlock[]): number[] {
  const seen = new Set<number>();
  const visit = (nodes: readonly MdInline[]) => {
    for (const node of nodes) {
      if (node.type === 'cite') node.refs.forEach((n) => seen.add(n));
      else if (node.type !== 'text' && node.type !== 'code') visit(node.children);
    }
  };
  for (const block of blocks) {
    if (block.type === 'list') block.items.forEach(visit);
    else if (block.type !== 'code') visit(block.children);
  }
  return [...seen];
}
