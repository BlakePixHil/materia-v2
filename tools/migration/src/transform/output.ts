import type { TransformedRecord } from './context.ts';
import { byCodeUnit, canonicalJson } from '../export/jsonl.ts';
import { isPlainObject } from '../legacy/snapshot.ts';

/**
 * The transform's file format (MIG-03): `transformed/{entity}.jsonl`, one record per line as
 * `{path, legacyPath, data, copy}`, lines sorted by path and keys sorted, like the export's, so
 * the same raw run always gives the same bytes. Instants are tagged `{ "$timestamp": ISO }` (the
 * export's convention), which the load (MIG-06) turns back into Firestore Timestamps.
 */

/** `value` with every Date as `{ $timestamp }`, at any depth. */
export function tagDates(value: unknown): unknown {
  if (value instanceof Date) return { $timestamp: value.toISOString() };
  if (Array.isArray(value)) return value.map(tagDates);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, tagDates(item)]));
}

/** The inverse, for readers of the files (MIG-05, MIG-06 and the tests). */
export function untagDates(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(untagDates);
  if (!isPlainObject(value)) return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === '$timestamp' && typeof value['$timestamp'] === 'string') {
    return new Date(value['$timestamp']);
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, untagDates(item)]));
}

/** One line of a `transformed/*.jsonl` file, newline included. */
export function recordLine(record: TransformedRecord): string {
  const { path, legacyPath, data, copy } = record;
  return `${canonicalJson(tagDates({ path, legacyPath, ...(data ? { data } : {}), ...(copy ? { copy } : {}) }))}\n`;
}

export function byPath(a: { path: string }, b: { path: string }): number {
  return byCodeUnit(a.path, b.path);
}

/** One line of `idmap.jsonl`: where a legacy record went. */
export function idmapLine(entry: { legacyPath: string; v2Path: string }): string {
  return `${canonicalJson(entry)}\n`;
}

/** JSON for `report.json`: keys sorted, two-space indents, a final newline. */
export function reportJson(report: unknown): string {
  return `${JSON.stringify(JSON.parse(canonicalJson(tagDates(report))), null, 2)}\n`;
}
