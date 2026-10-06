import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

/**
 * Legacy rich text (ngx-quill HTML in card descriptions and comments) to the Markdown v2 notes
 * render (libs/ui `parseMarkdown`: paragraphs, headings, lists, quotes, code, bold, italic, links
 * and `@[uid]` mentions; no HTML, no images). Sanitising comes first and is an allow-list: the
 * HTML is parsed the way a browser parses it (jsdom, no scripts run and nothing loads), then
 * walked, and only the allowed elements turn into Markdown. Everything else is unwrapped to its
 * text, or dropped with its content when it is a script, style, frame or similar. Attributes never
 * survive, apart from a link's address when it is http, https or mailto.
 */

/** The DOM surface the walk reads (jsdom's nodes; the tool builds without the DOM lib). */
interface HtmlNode {
  nodeType: number;
  nodeName: string;
  nodeValue: string | null;
  textContent: string | null;
  childNodes: ArrayLike<HtmlNode>;
  getAttribute?(name: string): string | null;
}

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom') as { JSDOM: { fragment(html: string): HtmlNode } };

const ELEMENT = 1;
const TEXT = 3;

/** Dropped with everything inside them. */
const DROP = new Set([
  'SCRIPT',
  'STYLE',
  'IFRAME',
  'FRAME',
  'FRAMESET',
  'OBJECT',
  'EMBED',
  'NOSCRIPT',
  'TEMPLATE',
  'SVG',
  'MATH',
  'HEAD',
  'TITLE',
  'META',
  'LINK',
  'BASE',
  'FORM',
  'INPUT',
  'BUTTON',
  'TEXTAREA',
  'SELECT',
  'OPTION',
  'CANVAS',
  'VIDEO',
  'AUDIO',
  'SOURCE',
  'TRACK',
  'PICTURE',
]);
/** Counted as unsafe when dropped (the others are just noise). */
const UNSAFE = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'EMBED', 'FORM', 'SVG', 'MATH']);
const BLOCKS = new Set([
  'P',
  'DIV',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'UL',
  'OL',
  'LI',
  'BLOCKQUOTE',
  'PRE',
  'HR',
  'TABLE',
  'TR',
]);

const SAFE_URL = /^(https?:\/\/|mailto:)\S+$/i;
const DATA_IMAGE = /^data:(image\/(png|jpeg|jpg|gif|webp|bmp));base64,([A-Za-z0-9+/=\s]+)$/i;

/** An image embedded in the HTML as base64, which the transform turns into a document. */
export interface InlineImage {
  mime: string;
  extension: string;
  base64: string;
  sizeBytes: number;
  sha256: string;
  /** Base64 MD5, as Storage reports it, so the copy (MIG-05) can check what it stored. */
  md5Hash: string;
}

export interface HtmlOptions {
  /** The text for a quill mention of `uid` (shown as `name`): `@[uid]` for members, plain text otherwise. */
  mention(uid: string, name: string): string;
  /** The text that replaces the `index`th inline image (0-based). */
  imageText(index: number, image: InlineImage): string;
}

export interface MarkdownResult {
  markdown: string;
  images: InlineImage[];
  /** Scripts, styles, frames, event handlers and `javascript:` links removed. */
  unsafeRemoved: number;
  /** Images that loaded from the web (tracking pixels), dropped. */
  remoteImages: number;
}

/** Plain text never becomes syntax by accident: a literal `@[x]` or `#[x]` would read as a mention. */
export function escapeText(text: string): string {
  return text.replace(/([@#])\[/g, '$1\u200B[');
}

function attr(node: HtmlNode, name: string): string {
  return node.getAttribute?.(name) ?? '';
}

function classes(node: HtmlNode): string[] {
  return attr(node, 'class').split(/\s+/).filter(Boolean);
}

/** Counts the event handler and `javascript:` attributes on an element (they never survive anyway). */
function unsafeAttributes(node: HtmlNode): number {
  const attributes = (node as unknown as { attributes?: ArrayLike<{ name: string; value: string }> }).attributes;
  if (!attributes) return 0;
  let count = 0;
  for (const { name, value } of Array.from(attributes)) {
    if (
      /^on/i.test(name) ||
      (/^(href|src|action|formaction|xlink:href)$/i.test(name) && /^\s*javascript:/i.test(value))
    )
      count++;
  }
  return count;
}

interface Walk {
  options: HtmlOptions;
  images: InlineImage[];
  unsafeRemoved: number;
  remoteImages: number;
}

/** Inline Markdown of a node's children: text, emphasis, code, links, mentions, line breaks. */
function inline(walk: Walk, node: HtmlNode, pre = false): string {
  let out = '';
  for (const child of Array.from(node.childNodes)) out += inlineNode(walk, child, pre);
  return out;
}

function wrap(marker: string, text: string): string {
  // Markers hug the text: `** bold **` wouldn't read as bold, so spaces move outside them.
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  const [, before = '', body = '', after = ''] = match ?? [];
  return body ? `${before}${marker}${body}${marker}${after}` : text;
}

function inlineNode(walk: Walk, node: HtmlNode, pre: boolean): string {
  if (node.nodeType === TEXT) {
    const text = (node.nodeValue ?? '').replace(/\uFEFF/g, '').replace(/\u00A0/g, ' ');
    return pre ? text : escapeText(text.replace(/[\t\n\r ]+/g, ' '));
  }
  if (node.nodeType !== ELEMENT) return '';
  const name = node.nodeName.toUpperCase();
  walk.unsafeRemoved += unsafeAttributes(node);
  if (DROP.has(name)) {
    if (UNSAFE.has(name)) walk.unsafeRemoved++;
    return '';
  }
  switch (name) {
    case 'BR':
      return '\n';
    case 'IMG':
      return image(walk, node);
    case 'STRONG':
    case 'B':
      return pre ? inline(walk, node, pre) : wrap('**', inline(walk, node));
    case 'EM':
    case 'I':
      return pre ? inline(walk, node, pre) : wrap('*', inline(walk, node));
    case 'CODE': {
      const text = (node.textContent ?? '').replace(/\uFEFF/g, '');
      return pre || text.includes('`') || !text.trim() ? text : `\`${text}\``;
    }
    case 'A':
      return link(walk, node, pre);
    case 'SPAN':
      if (classes(node).includes('mention') && attr(node, 'data-id')) {
        const label = attr(node, 'data-value') || (node.textContent ?? '').replace(/^\s*@/, '').trim();
        return walk.options.mention(attr(node, 'data-id'), label.replace(/\uFEFF/g, '').trim());
      }
      return inline(walk, node, pre);
    case 'TD':
    case 'TH':
      return `${inline(walk, node, pre)} `;
    default:
      // Blocks met inside inline content (a list in a span, say) read as their own lines.
      if (BLOCKS.has(name)) return `\n${blocks(walk, node).join('\n')}\n`;
      return inline(walk, node, pre);
  }
}

function link(walk: Walk, node: HtmlNode, pre: boolean): string {
  const text = inline(walk, node, pre).trim();
  const href = attr(node, 'href').trim();
  if (pre || !SAFE_URL.test(href)) return text;
  if (!text || text === href) return `[${href}](${href})`;
  // A `]` in the text would end the link early: keep the address after the text instead.
  return /[\]\n]/.test(text) || /[()\s]/.test(href) ? `${text} (${href})` : `[${text}](${href})`;
}

function image(walk: Walk, node: HtmlNode): string {
  const src = attr(node, 'src').trim();
  const alt = attr(node, 'alt').trim();
  const data = DATA_IMAGE.exec(src);
  if (data) {
    const base64 = (data[3] ?? '').replace(/\s/g, '');
    const bytes = Buffer.from(base64, 'base64');
    const mime = (data[1] ?? '').toLowerCase().replace('image/jpg', 'image/jpeg');
    const found: InlineImage = {
      mime,
      extension: mime === 'image/jpeg' ? 'jpg' : mime === 'image/svg+xml' ? 'svg' : mime.slice('image/'.length),
      base64: bytes.toString('base64'),
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      md5Hash: createHash('md5').update(bytes).digest('base64'),
    };
    walk.images.push(found);
    return walk.options.imageText(walk.images.length - 1, found);
  }
  if (/^https?:/i.test(src) || src.startsWith('//')) walk.remoteImages++;
  // `javascript:`, and data images that aren't plain bitmaps (an SVG can carry script).
  else if (/^\s*(javascript|data):/i.test(src)) walk.unsafeRemoved++;
  return alt ? escapeText(alt) : '';
}

/** The lines of some inline Markdown, each with its spaces collapsed and trimmed. */
function lines(text: string): string[] {
  return text.split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trim());
}

/**
 * Block Markdown of a node's children. Quill writes one `<p>` per line, so consecutive paragraphs
 * stay consecutive lines (notes keep single line breaks) and an empty `<p>` is a paragraph break.
 */
function blocks(walk: Walk, node: HtmlNode): string[] {
  const out: string[] = [];
  let paragraph = '';
  const flushInline = () => {
    if (paragraph.trim()) out.push(...lines(paragraph).filter(Boolean));
    paragraph = '';
  };
  const breakParagraph = () => {
    flushInline();
    if (out.length && out[out.length - 1] !== '') out.push('');
  };
  let listIndex = 0;
  for (const child of Array.from(node.childNodes)) {
    const name = child.nodeType === ELEMENT ? child.nodeName.toUpperCase() : '';
    if (child.nodeType === ELEMENT && DROP.has(name)) {
      walk.unsafeRemoved += unsafeAttributes(child);
      if (UNSAFE.has(name)) walk.unsafeRemoved++;
      continue;
    }
    if (child.nodeType !== ELEMENT || !BLOCKS.has(name)) {
      paragraph += inlineNode(walk, child, false);
      continue;
    }
    flushInline();
    walk.unsafeRemoved += unsafeAttributes(child);
    switch (name) {
      case 'P':
      case 'DIV':
      case 'TR': {
        const text = lines(inline(walk, child)).filter(Boolean);
        if (text.length) out.push(...text);
        else breakParagraph();
        break;
      }
      case 'H1':
      case 'H2':
      case 'H3':
      case 'H4':
      case 'H5':
      case 'H6': {
        const text = lines(inline(walk, child)).filter(Boolean).join(' ');
        if (text) {
          breakParagraph();
          out.push(`${'#'.repeat(Math.min(Number(name.slice(1)), 3))} ${text}`, '');
        }
        break;
      }
      case 'UL':
      case 'OL': {
        breakParagraph();
        listIndex = 0;
        for (const item of Array.from(child.childNodes)) {
          if (item.nodeType !== ELEMENT || item.nodeName.toUpperCase() !== 'LI') continue;
          // Quill 2 writes every list as `<ol>` and says which kind on each item.
          const kind = attr(item, 'data-list');
          const ordered = kind ? kind === 'ordered' : name === 'OL';
          const text = lines(inline(walk, item)).filter(Boolean).join(' ');
          if (!text) continue;
          out.push(ordered ? `${++listIndex}. ${text}` : `- ${text}`);
        }
        out.push('');
        break;
      }
      case 'LI': {
        const text = lines(inline(walk, child)).filter(Boolean).join(' ');
        if (text) out.push(`- ${text}`);
        break;
      }
      case 'BLOCKQUOTE': {
        breakParagraph();
        const quoted = blocks(walk, child).filter(Boolean);
        out.push(...quoted.map((line) => `> ${line}`), '');
        break;
      }
      case 'PRE': {
        breakParagraph();
        const code = inline(walk, child, true)
          .replace(/\uFEFF/g, '')
          .replace(/\n+$/, '');
        if (code.trim())
          out.push('```', ...code.split('\n').map((line) => line.replace(/^(```|~~~)/, ' $1')), '```', '');
        break;
      }
      case 'HR':
        breakParagraph();
        break;
      case 'TABLE':
        breakParagraph();
        out.push(...blocks(walk, child), '');
        break;
    }
  }
  flushInline();
  return out;
}

/** Sanitised Markdown of legacy HTML (or plain text). Empty input, and Quill's empty editor, give ''. */
export function htmlToMarkdown(html: string, options: HtmlOptions): MarkdownResult {
  const walk: Walk = { options, images: [], unsafeRemoved: 0, remoteImages: 0 };
  const fragment = JSDOM.fragment(html);
  const markdown = blocks(walk, fragment)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { markdown, images: walk.images, unsafeRemoved: walk.unsafeRemoved, remoteImages: walk.remoteImages };
}

function plainText(node: HtmlNode): string {
  if (node.nodeType === TEXT) return node.nodeValue ?? '';
  const name = node.nodeName.toUpperCase();
  if (DROP.has(name)) return '';
  const inner = Array.from(node.childNodes).map(plainText).join('');
  return name === 'BR' || BLOCKS.has(name) ? ` ${inner} ` : inner;
}

/**
 * The text of legacy HTML with every tag gone, and scripts and the like with their content
 * (history lines: `<strong>Name</strong> moved card` → `Name moved card`).
 */
export function htmlToText(html: string): string {
  return plainText(JSDOM.fragment(html))
    .replace(/\uFEFF/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
