import { isPlainObject } from '../legacy/snapshot.ts';

/** A Firestore document's fields, with instants as `Date`s. */
export type Data = Record<string, unknown>;

/**
 * The transform's values (MIG-03) back as Firestore values: `{"$timestamp": "<ISO>"}` becomes a
 * `Date`, which the Admin SDK writes as a Timestamp and the domain schemas take as an instant. The
 * transform writes no other tags, so any other `$` tag means its output changed: it throws.
 */
export function decodeTagged(value: unknown, at = ''): unknown {
  if (Array.isArray(value)) return value.map((item, i) => decodeTagged(item, `${at}[${i}]`));
  if (!isPlainObject(value)) return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0]?.startsWith('$')) {
    const iso = value['$timestamp'];
    if (typeof iso !== 'string') throw new Error(`${at || 'value'}: unexpected ${keys[0]} value.`);
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) throw new Error(`${at || 'value'}: "${iso}" is not an instant.`);
    return date;
  }
  return Object.fromEntries(keys.map((key) => [key, decodeTagged(value[key], at ? `${at}.${key}` : key)]));
}

/** Whether two Firestore values are the same: instants by time, maps regardless of key order. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => key in b && sameValue(a[key], b[key]));
  }
  return a === b;
}

/** The top-level fields whose values differ, in order. */
export function changedFields(a: Data, b: Data): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((key) => !sameValue(a[key], b[key])).sort();
}

/** An instant field as milliseconds, or undefined. */
export function millis(value: unknown): number | undefined {
  return value instanceof Date ? value.getTime() : undefined;
}

/** The run that loaded a document, as its `migration` field says. */
export interface Provenance {
  runId: string;
  legacyPath: string;
  loadedAt: Date;
}

export function provenanceOf(data: Data | undefined): Provenance | undefined {
  const migration = data?.['migration'];
  if (!isPlainObject(migration)) return undefined;
  const { runId, legacyPath, loadedAt } = migration;
  if (typeof runId !== 'string' || typeof legacyPath !== 'string' || !(loadedAt instanceof Date)) return undefined;
  return { runId, legacyPath, loadedAt };
}

/**
 * Whether someone changed a loaded document in v2 after the load (the conflict rule): its
 * `updatedAt` is after `migration.loadedAt`. Triggers that stamp `updatedAt` write `updatedBy:
 * 'system'` (a task date filled from key facts, the claims mirror on `users/{uid}`), so those
 * don't count as an edit.
 */
export function editedAfterLoad(data: Data): boolean {
  const loaded = provenanceOf(data)?.loadedAt.getTime();
  const updated = millis(data['updatedAt']);
  if (loaded === undefined || updated === undefined) return false;
  return updated > loaded && data['updatedBy'] !== 'system';
}
