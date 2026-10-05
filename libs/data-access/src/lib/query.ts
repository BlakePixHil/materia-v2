import type { SnapshotLike } from '@materia/domain/firestore';

/** Firestore's filter operators. */
export type WhereOp = '<' | '<=' | '==' | '!=' | '>=' | '>' | 'array-contains' | 'array-contains-any' | 'in' | 'not-in';

/** A field of `T`, or a dotted path into it (`billing.unitMinutes`). */
export type FieldPath<T> = (keyof T & string) | `${keyof T & string}.${string}`;

/**
 * A query in domain terms, so feature code never handles Firestore types. Every filter needs a
 * matching index in `firebase/firestore.indexes.json` once it combines with an `orderBy`.
 */
export interface QuerySpec<T = Record<string, unknown>> {
  where?: readonly (readonly [field: FieldPath<T>, op: WhereOp, value: unknown])[];
  orderBy?: readonly (readonly [field: FieldPath<T>, direction?: 'asc' | 'desc'])[];
  /** Rows per page (default 25). */
  pageSize?: number;
  /** Soft-deleted documents are hidden unless this is true. */
  includeDeleted?: boolean;
}

export const DEFAULT_PAGE_SIZE = 25;

/** One page to read: after the previous page's last row, up to (and including) `end`, at most `limit` rows. */
export interface PageRequest {
  spec: QuerySpec;
  /** Opaque cursor: start after this row. */
  after: unknown;
  /** Opaque cursor: end at this row (a sealed page, see `PagedQuery`). */
  end: unknown;
  limit: number | null;
}

/** A document as the driver returns it: the snapshot for the converter, plus an opaque cursor. */
export interface RawDoc {
  id: string;
  snapshot: SnapshotLike;
  cursor: unknown;
}

export interface RawPage {
  docs: RawDoc[];
  /** Served from the local cache (offline, or before the server answered). */
  fromCache: boolean;
}

/** Server-set meta fields the driver fills in (`updatedAt: serverTimestamp()` and so on). */
export interface WriteMeta {
  uid: string;
  schemaVersion: number;
}

/**
 * The narrow seam between repositories and Firestore. `firestoreDriver` implements it with the
 * full SDK; `InMemoryFirestore` implements it for unit tests of features.
 */
export interface CollectionDriver {
  listen(request: PageRequest, next: (page: RawPage) => void, error: (error: unknown) => void): () => void;
  fetch(request: PageRequest): Promise<RawPage>;
  /**
   * The same page from this device's cache only (never the server), for showing cached rows while
   * a one-shot read waits for the server. Optional: drivers without a cache leave it out.
   */
  fetchCached?(request: PageRequest): Promise<RawPage>;
  watchDoc(
    id: string,
    next: (doc: RawDoc | null, fromCache: boolean) => void,
    error: (error: unknown) => void,
  ): () => void;
  getDoc(id: string): Promise<RawDoc | null>;
  count(spec: QuerySpec): Promise<number>;
  /** Creates a document with a new id, or with `id` when given (a client-made id, such as a draft's). */
  create(data: Record<string, unknown>, meta: WriteMeta, id?: string): Promise<string>;
  /**
   * Merges `patch`; `remove` lists fields to delete (`deleteField()`), for clearing optional values;
   * `stamp` lists fields set to the server's time (`serverTimestamp()`).
   */
  update(
    id: string,
    patch: Record<string, unknown>,
    meta: WriteMeta,
    remove?: readonly string[],
    stamp?: readonly string[],
  ): Promise<void>;
  softDelete(id: string, meta: WriteMeta): Promise<void>;
  /** Removes the document. Only where the rules allow one (a person's own saved views). */
  hardDelete(id: string): Promise<void>;
}

export interface DriverOptions {
  /**
   * A collection-group query: `path` is a collection id (`parties`) and reads span every collection
   * with that id. Read-only: writes and `watchDoc` reject. Rows sort by full document path on ties.
   */
  group?: boolean;
}

/** Opens a driver for a collection path (`orgs/org-1/members`), or a collection group (`parties`). */
export type DriverFactory = (path: string, options?: DriverOptions) => CollectionDriver;
