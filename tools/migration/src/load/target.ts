import type { Data } from './values.ts';

/** A document of the v2 database, by its full path. */
export interface Doc {
  path: string;
  data: Data;
}

/** One write: `set` replaces the document, `update` replaces the fields it names, `delete` removes it. */
export type WriteOp =
  { op: 'set'; path: string; data: Data } | { op: 'update'; path: string; data: Data } | { op: 'delete'; path: string };

export interface WriteFailure {
  path: string;
  message: string;
}

/**
 * The v2 Firestore as the load, verify, delta and rollback see it (the Admin SDK in
 * `admin.ts`, a map in the tests). Instants come back as `Date`s.
 */
export interface TargetDb {
  /** The documents that exist among `paths`. */
  getAll(paths: readonly string[]): Promise<Map<string, Data>>;
  /** Applies the writes (a BulkWriter, with its retries) and returns the ones that still failed. */
  apply(ops: readonly WriteOp[]): Promise<WriteFailure[]>;
  /** Every document of a collection group (or top-level collection) that a run loaded. */
  loadedBy(group: string, runId: string): Promise<Doc[]>;
  /** Every document under a document, at any depth (not the document itself). */
  descendants(path: string): Promise<Doc[]>;
  /** The documents of one collection. */
  collection(path: string): Promise<Doc[]>;
}

/** The v2 Auth, for custom claims. */
export interface AuthPort {
  /** The account's custom claims, or null when there is no such account. */
  claimsOf(uid: string): Promise<Record<string, unknown> | null>;
  setClaims(uid: string, claims: Record<string, unknown>): Promise<void>;
}
