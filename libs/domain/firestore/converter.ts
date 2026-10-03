import type { z } from 'zod';

/**
 * Firestore converters for the domain schemas (FND-13). They import nothing from Firebase: both the
 * web SDK and the Admin SDK accept JS Dates on write, and on read anything with `toDate()`
 * (a Timestamp) becomes a Date and anything with `toArray()` (a VectorValue) becomes a number[].
 */

/** The subset of a DocumentSnapshot both SDKs provide. */
export interface SnapshotLike {
  id: string;
  data(options?: unknown): Record<string, unknown> | undefined;
}

export type Upgrade = (data: Record<string, unknown>) => Record<string, unknown>;

export interface ConverterOptions {
  /**
   * `strict` (dev, test): an invalid document throws. `lenient` (prod): it is returned with an
   * `_invalid` marker and reported through `onInvalid`. Defaults to strict.
   */
  mode?: 'strict' | 'lenient';
  /** Lazy upgrades: `upgrades[n]` turns a version-n document into version n+1. */
  upgrades?: Record<number, Upgrade>;
  /** Called in lenient mode. Receives ids and issue paths only, never field values (no PII). */
  onInvalid?: (report: { id: string; issues: string[] }) => void;
}

export interface EntityLike<T> {
  schema: z.ZodType<T>;
  version: number;
}

export class SchemaVersionError extends Error {
  constructor(
    readonly docId: string,
    readonly found: number,
    readonly current: number,
  ) {
    super(
      `Document ${docId} has schemaVersion ${found}, newer than this app understands (${current}). Reload to update the app.`,
    );
    this.name = 'SchemaVersionError';
  }
}

export class InvalidDocumentError extends Error {
  constructor(
    readonly docId: string,
    readonly issues: string[],
  ) {
    super(`Document ${docId} failed validation: ${issues.join('; ')}`);
    this.name = 'InvalidDocumentError';
  }
}

export type Invalid<T> = T & { _invalid: string[] };

function isTimestampLike(value: unknown): value is { toDate(): Date } {
  return typeof value === 'object' && value !== null && typeof (value as { toDate?: unknown }).toDate === 'function';
}

function isVectorLike(value: unknown): value is { toArray(): number[] } {
  return typeof value === 'object' && value !== null && typeof (value as { toArray?: unknown }).toArray === 'function';
}

/** Firestore → domain: Timestamps to Dates, vectors to arrays, recursively. */
export function fromFirestoreValue(value: unknown): unknown {
  if (isTimestampLike(value)) return value.toDate();
  if (isVectorLike(value)) return value.toArray();
  if (Array.isArray(value)) return value.map(fromFirestoreValue);
  if (value instanceof Date) return value;
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fromFirestoreValue(v)]));
  }
  return value;
}

/** Domain → Firestore: drop `undefined` (Firestore rejects it), keep Dates (stored as Timestamps). */
export function toFirestoreValue(value: unknown): unknown {
  if (value instanceof Date || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(toFirestoreValue);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, toFirestoreValue(v)]),
  );
}

function issuePaths(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.code}`);
}

/** Applies registered upgrades until the document reaches the current schema version. */
export function upgrade(
  id: string,
  data: Record<string, unknown>,
  current: number,
  upgrades: Record<number, Upgrade> = {},
): Record<string, unknown> {
  let version = typeof data['schemaVersion'] === 'number' ? data['schemaVersion'] : 1;
  if (version > current) throw new SchemaVersionError(id, version, current);
  let result = data;
  while (version < current) {
    const step = upgrades[version];
    if (!step) throw new Error(`No upgrade registered from schemaVersion ${version} for document ${id}`);
    result = { ...step(result), schemaVersion: version + 1 };
    version += 1;
  }
  return result;
}

export interface DomainConverter<T> {
  toFirestore(model: T): Record<string, unknown>;
  fromFirestore(snapshot: SnapshotLike, options?: unknown): T;
}

/** Converter for `firebase/firestore` (`withConverter(firestoreConverter(Matter))`). */
export function firestoreConverter<T>(entity: EntityLike<T>, options: ConverterOptions = {}): DomainConverter<T> {
  const mode = options.mode ?? 'strict';
  return {
    toFirestore(model: T): Record<string, unknown> {
      // Writes are always validated: an invalid write is a bug in the caller.
      const parsed = entity.schema.parse(model);
      return toFirestoreValue(parsed) as Record<string, unknown>;
    },
    fromFirestore(snapshot: SnapshotLike, snapshotOptions?: unknown): T {
      const raw = fromFirestoreValue(snapshot.data(snapshotOptions) ?? {}) as Record<string, unknown>;
      const upgraded = upgrade(snapshot.id, raw, entity.version, options.upgrades);
      const result = entity.schema.safeParse(upgraded);
      if (result.success) return result.data;
      const issues = issuePaths(result.error);
      if (mode === 'strict') throw new InvalidDocumentError(snapshot.id, issues);
      options.onInvalid?.({ id: snapshot.id, issues });
      return { ...upgraded, _invalid: issues } as Invalid<T>;
    },
  };
}

/** Converter for `firebase-admin/firestore`. Same behaviour; Admin snapshots take no options. */
export function adminConverter<T>(entity: EntityLike<T>, options: ConverterOptions = {}): DomainConverter<T> {
  const converter = firestoreConverter(entity, options);
  return {
    toFirestore: converter.toFirestore,
    fromFirestore: (snapshot: SnapshotLike) => converter.fromFirestore(snapshot),
  };
}
