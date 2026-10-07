import { FieldPath, type Firestore } from 'firebase-admin/firestore';

import { collectionOfPath, excludedCollection } from './org-format';

/**
 * Where the full export (SEC-05) reads the practice's records: one collection group at a time,
 * in document-path order, only documents under `orgs/{orgId}/`. Firestore in production; an
 * in-memory map in unit tests.
 */

type Data = Record<string, unknown>;

export interface SourceDoc {
  path: string;
  data: Data;
}

export interface SourcePage {
  /** The page's documents under the practice (another org whose id starts the same is skipped). */
  docs: SourceDoc[];
  /** The last path read (in or out of the practice), to continue after; null when nothing was read. */
  last: string | null;
  /** Whether there may be more. */
  more: boolean;
}

export interface OrgSource {
  readonly orgId: string;
  /** The org document's fields, or undefined once it is gone. */
  org(): Promise<Data | undefined>;
  /**
   * Documents of collection group `group` under the practice, in path order: from the start, after
   * `after` (a full path), or from `after` itself with `inclusive`.
   */
  page(group: string, after: string | null, limit: number, inclusive?: boolean): Promise<SourcePage>;
}

/**
 * Firestore: a collection-group query ordered by document name from `orgs/{orgId}` to
 * `orgs/{orgId}\uf8ff` (names compare segment by segment, so that covers everything under the
 * practice, and orgs whose id starts with this one, which are filtered out).
 */
export function firestoreSource(db: Firestore, orgId: string): OrgSource {
  const inOrg = `orgs/${orgId}/`;
  return {
    orgId,
    org: async () => (await db.doc(`orgs/${orgId}`).get()).data(),
    async page(group, after, limit, inclusive = false) {
      let query = db.collectionGroup(group).orderBy(FieldPath.documentId()).endAt(`orgs/${orgId}\uf8ff`).limit(limit);
      query = after ? (inclusive ? query.startAt(after) : query.startAfter(after)) : query.startAt(`orgs/${orgId}`);
      const snap = await query.get();
      return {
        docs: snap.docs
          .filter((doc) => doc.ref.path.startsWith(inOrg))
          .map((doc) => ({ path: doc.ref.path, data: doc.data() })),
        last: snap.docs.at(-1)?.ref.path ?? null,
        more: snap.size === limit,
      };
    },
  };
}

/** The in-memory map of `memoryFirestore()`, for unit tests: the same order and filtering. */
export function memorySource(docs: Map<string, Data>, orgId: string): OrgSource {
  const inOrg = `orgs/${orgId}/`;
  return {
    orgId,
    org: async () => docs.get(`orgs/${orgId}`),
    async page(group, after, limit, inclusive = false) {
      const paths = [...docs.keys()]
        .filter((path) => path.split('/').at(-2) === group && path.startsWith(`orgs/${orgId}`))
        .sort()
        .filter((path) => after === null || (inclusive ? path >= after : path > after));
      const read = paths.slice(0, limit);
      return {
        docs: read.filter((path) => path.startsWith(inOrg)).map((path) => ({ path, data: { ...docs.get(path) } })),
        last: read.at(-1) ?? null,
        more: read.length === limit,
      };
    },
  };
}

/** A document with its export collection. */
export interface WalkedDoc extends SourceDoc {
  collection: string;
}

/**
 * One collection group's documents, read a page at a time, with a look at the next one (so a JSONL
 * file can stop where the collection changes). Documents in excluded collections are skipped.
 */
export class GroupWalk {
  private buffer: WalkedDoc[] = [];
  private cursor: string | null;
  private more = true;
  private first: boolean;

  constructor(
    private readonly source: OrgSource,
    private readonly group: string,
    after: string | null,
    private readonly pageSize: number,
    options: { inclusive?: boolean } = {},
  ) {
    this.cursor = after;
    this.first = options.inclusive === true && after !== null;
  }

  async peek(): Promise<WalkedDoc | undefined> {
    while (!this.buffer.length && this.more) {
      const page = await this.source.page(this.group, this.cursor, this.pageSize, this.first);
      this.first = false;
      this.cursor = page.last ?? this.cursor;
      this.more = page.more && page.last !== null;
      for (const doc of page.docs) {
        const collection = collectionOfPath(this.source.orgId, doc.path);
        if (collection && !excludedCollection(collection)) this.buffer.push({ ...doc, collection });
      }
    }
    return this.buffer[0];
  }

  async take(): Promise<WalkedDoc | undefined> {
    const next = await this.peek();
    this.buffer.shift();
    return next;
  }
}
