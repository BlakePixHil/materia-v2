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
  watchDoc(
    id: string,
    next: (doc: RawDoc | null, fromCache: boolean) => void,
    error: (error: unknown) => void,
  ): () => void;
  getDoc(id: string): Promise<RawDoc | null>;
  count(spec: QuerySpec): Promise<number>;
  create(data: Record<string, unknown>, meta: WriteMeta): Promise<string>;
  update(id: string, patch: Record<string, unknown>, meta: WriteMeta): Promise<void>;
  softDelete(id: string, meta: WriteMeta): Promise<void>;
}

/** Opens a driver for a collection path (`orgs/org-1/members`). */
export type DriverFactory = (path: string) => CollectionDriver;
