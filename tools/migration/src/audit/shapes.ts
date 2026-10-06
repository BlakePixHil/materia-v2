import { isPlainObject, taggedKind, type LegacyData } from '../legacy/snapshot.ts';

/**
 * Value shapes for the audit's field histograms: what kind of value a field holds (`''`, `null`,
 * the user's uid, another uid, an ISO date…), never the value itself.
 */

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUTO_ID = /^[A-Za-z0-9]{20}$/;
const UID_LIKE = /^[A-Za-z0-9]{28}$/;

export interface ShapeContext {
  /** The designated user. */
  uid: string;
  /** Other users the data references. */
  others: ReadonlySet<string>;
}

export function shapeOf(value: unknown, ctx: ShapeContext): string {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.length ? 'array' : 'array:empty';
  if (typeof value === 'string') return stringShape(value, ctx);
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'decimal';
  if (typeof value === 'boolean') return String(value);
  const tag = taggedKind(value);
  if (tag) return tag;
  if (isPlainObject(value)) return Object.keys(value).length ? 'map' : 'map:empty';
  return typeof value;
}

function stringShape(value: string, ctx: ShapeContext): string {
  if (value === '') return 'empty-string';
  if (value === ctx.uid) return 'uid:self';
  if (ctx.others.has(value)) return 'uid:other';
  if (!value.trim()) return 'whitespace';
  if (ISO_DATETIME.test(value)) return 'iso-datetime';
  if (DATE_ONLY.test(value)) return 'date-only';
  if (UUID.test(value)) return 'uuid';
  if (AUTO_ID.test(value)) return 'auto-id';
  if (UID_LIKE.test(value)) return 'uid:unknown';
  if (/<[a-z][^>]*>/i.test(value)) return 'html';
  return 'text';
}

/** Map keys that are ids (uids in `users`, `calendarSyncByUser`) collapse to `{id}`. */
function fieldKey(key: string): string {
  return UUID.test(key) || AUTO_ID.test(key) || UID_LIKE.test(key) ? '{id}' : key;
}

/** Per field path: how many parent objects could hold it (`of`) and the shapes it held, `missing` included. */
export type FieldHistogram = Record<string, { of: number; shapes: Record<string, number> }>;

/**
 * Histograms every field of `docs`, nested maps and arrays of maps included
 * (`checklists[].items[].dueDate`). Arrays of scalars count each element (`uids[]`).
 */
export function fieldHistogram(docs: readonly LegacyData[], ctx: ShapeContext): FieldHistogram {
  const parents = new Map<string, number>();
  const shapes = new Map<string, Map<string, number>>();
  const children = new Map<string, Set<string>>();
  const record = (path: string, shape: string) => {
    const counts = shapes.get(path) ?? new Map<string, number>();
    counts.set(shape, (counts.get(shape) ?? 0) + 1);
    shapes.set(path, counts);
  };
  const visit = (value: LegacyData, prefix: string) => {
    parents.set(prefix, (parents.get(prefix) ?? 0) + 1);
    for (const [rawKey, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${fieldKey(rawKey)}` : fieldKey(rawKey);
      const known = children.get(prefix) ?? new Set<string>();
      known.add(path);
      children.set(prefix, known);
      record(path, shapeOf(child, ctx));
      if (isPlainObject(child) && !taggedKind(child)) visit(child, path);
      if (Array.isArray(child)) {
        for (const element of child) {
          if (isPlainObject(element) && !taggedKind(element)) visit(element, `${path}[]`);
          else record(`${path}[]`, shapeOf(element, ctx));
        }
      }
    }
  };
  for (const doc of docs) visit(doc, '');

  const out: FieldHistogram = {};
  for (const [parent, paths] of children) {
    const of = parents.get(parent) ?? 0;
    for (const path of paths) {
      const counts = Object.fromEntries(shapes.get(path) ?? []);
      const present = Object.values(counts).reduce((a, b) => a + b, 0);
      // Id-keyed maps can hold several `{id}` entries per parent, so missing never goes negative.
      if (present < of) counts['missing'] = of - present;
      out[path] = { of, shapes: sortRecord(counts) };
    }
  }
  for (const [path, counts] of shapes) {
    if (!path.endsWith('[]') || out[path]) continue;
    const values = Object.fromEntries(counts);
    out[path] = { of: Object.values(values).reduce((a, b) => a + b, 0), shapes: sortRecord(values) };
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

export function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

// ---------- dates ----------

export type DateShape =
  | 'missing'
  | 'null'
  | 'empty-string'
  | 'iso-utc'
  | 'iso-offset'
  | 'date-only'
  | 'timestamp'
  | 'number'
  | 'other-parseable'
  | 'invalid';

/** Whether `YYYY-MM-DD` names a real day (V8 reads 2025-02-30 as 2 March). */
function isRealDay(day: string): boolean {
  const [y = 0, m = 0, d = 0] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function dateShape(value: unknown): DateShape {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (typeof value === 'number') return 'number';
  if (taggedKind(value) === 'timestamp') return 'timestamp';
  if (typeof value !== 'string') return 'invalid';
  if (value === '') return 'empty-string';
  if (DATE_ONLY.test(value)) return isRealDay(value) ? 'date-only' : 'invalid';
  if (ISO_DATETIME.test(value)) {
    if (!isRealDay(value.slice(0, 10)) || Number.isNaN(Date.parse(value))) return 'invalid';
    return value.endsWith('Z') ? 'iso-utc' : 'iso-offset';
  }
  return Number.isNaN(Date.parse(value)) ? 'invalid' : 'other-parseable';
}

const MELBOURNE_PARTS = new Intl.DateTimeFormat('en-AU', {
  timeZone: 'Australia/Melbourne',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function melbourne(instant: Date): { date: string; time: string } {
  const parts = Object.fromEntries(MELBOURNE_PARTS.formatToParts(instant).map((p) => [p.type, p.value]));
  return {
    date: `${parts['year']}-${parts['month']}-${parts['day']}`,
    time: `${parts['hour']}:${parts['minute']}:${parts['second']}`,
  };
}

/**
 * How a due date stored as an ISO instant converts to a `DateOnly` (Legacy migration plan:
 * convert in Australia/Melbourne). `melbourne-midnight` is the expected case (local midnight saved
 * as UTC); `differsFromUtc` counts values whose Melbourne day is not their UTC day, which a naive
 * `slice(0, 10)` would get wrong.
 */
export interface DueDateStats {
  melbourneMidnight: number;
  utcMidnight: number;
  otherTime: number;
  differsFromUtc: number;
}

export function addDueDate(stats: DueDateStats, value: unknown): void {
  const shape = dateShape(value);
  if (shape !== 'iso-utc' && shape !== 'iso-offset') return;
  const instant = new Date(value as string);
  const local = melbourne(instant);
  if (local.time === '00:00:00') stats.melbourneMidnight++;
  else if (instant.toISOString().slice(11, 19) === '00:00:00') stats.utcMidnight++;
  else stats.otherTime++;
  if (local.date !== instant.toISOString().slice(0, 10)) stats.differsFromUtc++;
}
