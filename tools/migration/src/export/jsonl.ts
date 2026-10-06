import { createHash } from 'node:crypto';

import { isPlainObject, type LegacyData } from '../legacy/snapshot.ts';

/**
 * The export's file format (MIG-02): one JSON object per line, `{path, id, data, readTime}`, lines
 * sorted by path and `data` with its keys sorted, so the same snapshot always gives the same
 * bytes and the same sha256. Values JSON can't hold stay tagged as the reader decodes them
 * (`{ "$timestamp": "…" }`, see snapshot.ts `TaggedValue`).
 */

/** One exported record: a document by path, or a Storage object by name. `data` is null for a missing profile. */
export interface ExportRecord {
  path: string;
  data: LegacyData | null;
}

/** JSON with every object's keys sorted, so equal values serialise to equal strings. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(byCodeUnit)
      .map((key) => [key, sortKeys(value[key])]),
  );
}

/** Plain string order (UTF-16 code units), the same on every machine, unlike `localeCompare`. */
export function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Records sorted by path, the last one kept when a path repeats (a workflow found by both queries). */
export function sortRecords<T extends ExportRecord>(records: readonly T[]): T[] {
  return [...new Map(records.map((record) => [record.path, record])).values()].sort((a, b) =>
    byCodeUnit(a.path, b.path),
  );
}

/** One line of a `raw/*.jsonl` file, newline included. */
export function exportLine(record: ExportRecord, readTime: string): string {
  const id = record.path.slice(record.path.lastIndexOf('/') + 1);
  return `{"path":${JSON.stringify(record.path)},"id":${JSON.stringify(id)},"data":${canonicalJson(record.data)},"readTime":${JSON.stringify(readTime)}}\n`;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// ---------- download tokens ----------

/**
 * Firebase download URLs (`https://firebasestorage.googleapis.com/…?alt=media&token=…`) carry a
 * token that lets anyone holding the link read the file. Attachments store one in `downloadUrl`
 * and descriptions can embed them, but nothing downstream needs them (MIG-05 copies objects by
 * name), so the export drops the token and keeps the rest of the URL (D-17).
 */
const DOWNLOAD_URL = /https?:\/\/firebasestorage\.googleapis\.com\/[^\s"'<>]*/g;
// `token=` after `?` keeps the `?` for the parameters after it; after `&` (or `&amp;` in HTML) it goes with its separator.
const TOKEN_FIRST = /\?token=[^&#\s"'<>]*(?:&amp;|&)?/g;
const TOKEN_LATER = /(?:&amp;|&)token=[^&#\s"'<>]*/g;

/** `text` with the download tokens taken out of any Firebase download URL, and how many there were. */
export function stripDownloadTokens(text: string): { text: string; stripped: number } {
  let stripped = 0;
  const out = text.replace(DOWNLOAD_URL, (url) =>
    url
      .replace(TOKEN_FIRST, () => {
        stripped++;
        return '?';
      })
      .replace(TOKEN_LATER, () => {
        stripped++;
        return '';
      }),
  );
  return { text: out, stripped };
}

/** Every string in `value`, at any depth, without download tokens; counts what it took out. */
export function withoutDownloadTokens<T>(value: T, counter: { stripped: number }): T {
  if (typeof value === 'string') {
    if (!value.includes('token=')) return value;
    const { text, stripped } = stripDownloadTokens(value);
    counter.stripped += stripped;
    return text as T;
  }
  if (Array.isArray(value)) return value.map((item: unknown) => withoutDownloadTokens(item, counter)) as T;
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, withoutDownloadTokens(item, counter)]),
    ) as T;
  }
  return value;
}
