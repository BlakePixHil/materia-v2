/**
 * Legacy rich text (ngx-quill HTML in card descriptions and comments, `<strong>` in history): the
 * features the audit counts and the mention targets. Counting only, with no HTML parser: the
 * transform (MIG-03) sanitises before it converts, so nothing here has to be safe to render.
 */

const TAG = /<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTR = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function attributes(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const match of raw.matchAll(ATTR)) {
    attrs.set((match[1] ?? '').toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

/** The uids a quill mention names: `<span class="mention" data-id="{uid}" …>`. */
export function mentionUids(html: string): string[] {
  const uids: string[] = [];
  for (const match of html.matchAll(TAG)) {
    if (match[1] || (match[2] ?? '').toLowerCase() !== 'span') continue;
    const attrs = attributes(match[3] ?? '');
    const classes = (attrs.get('class') ?? '').split(/\s+/);
    const id = attrs.get('data-id');
    if (classes.includes('mention') && id) uids.push(id);
  }
  return uids;
}

/** Quill's empty editor (`<p><br></p>`), an empty paragraph, or nothing. */
export function isEmptyHtml(html: string): boolean {
  return /^\s*(<p>\s*(<br\s*\/?>)?\s*<\/p>\s*)*$/i.test(html);
}

export interface HtmlStats {
  /** Values seen (strings only). */
  values: number;
  empty: number;
  /** Values with at least one tag. */
  html: number;
  /** Non-empty values with no tags. */
  plain: number;
  maxLength: number;
  tags: Record<string, number>;
  /** `ql-*` and `mention` classes. */
  classes: Record<string, number>;
  mentions: number;
  images: { inlineBase64: number; inlineBase64Bytes: number; remote: number; other: number };
  links: number;
  /** What sanitising must strip. */
  unsafe: {
    script: number;
    style: number;
    iframe: number;
    eventHandlers: number;
    inlineStyles: number;
    javascriptUrls: number;
  };
}

export function emptyHtmlStats(): HtmlStats {
  return {
    values: 0,
    empty: 0,
    html: 0,
    plain: 0,
    maxLength: 0,
    tags: {},
    classes: {},
    mentions: 0,
    images: { inlineBase64: 0, inlineBase64Bytes: 0, remote: 0, other: 0 },
    links: 0,
    unsafe: { script: 0, style: 0, iframe: 0, eventHandlers: 0, inlineStyles: 0, javascriptUrls: 0 },
  };
}

function bump(record: Record<string, number>, key: string, by = 1) {
  record[key] = (record[key] ?? 0) + by;
}

/** Adds one value's features to `stats` (shapes and counts only, never text). */
export function addHtml(stats: HtmlStats, value: unknown): void {
  if (typeof value !== 'string') return;
  stats.values++;
  stats.maxLength = Math.max(stats.maxLength, value.length);
  if (isEmptyHtml(value)) {
    stats.empty++;
    return;
  }
  let tagged = false;
  for (const match of value.matchAll(TAG)) {
    tagged = true;
    if (match[1]) continue;
    const tag = (match[2] ?? '').toLowerCase();
    bump(stats.tags, tag);
    const attrs = attributes(match[3] ?? '');
    for (const cls of (attrs.get('class') ?? '').split(/\s+/)) {
      if (cls.startsWith('ql-') || cls === 'mention') bump(stats.classes, cls);
    }
    if (tag === 'span' && (attrs.get('class') ?? '').split(/\s+/).includes('mention')) stats.mentions++;
    if (tag === 'img') {
      const src = attrs.get('src') ?? '';
      const inline = /^data:[^;,]*;base64,(.*)$/is.exec(src);
      if (inline) {
        stats.images.inlineBase64++;
        stats.images.inlineBase64Bytes += Math.floor(((inline[1] ?? '').replace(/\s/g, '').length * 3) / 4);
      } else if (/^https?:/i.test(src)) stats.images.remote++;
      else stats.images.other++;
    }
    if (tag === 'a') stats.links++;
    if (tag === 'script') stats.unsafe.script++;
    if (tag === 'style') stats.unsafe.style++;
    if (tag === 'iframe') stats.unsafe.iframe++;
    for (const [name, attrValue] of attrs) {
      if (name.startsWith('on')) stats.unsafe.eventHandlers++;
      if (name === 'style') stats.unsafe.inlineStyles++;
      if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(attrValue)) stats.unsafe.javascriptUrls++;
    }
  }
  if (tagged) stats.html++;
  else stats.plain++;
}
