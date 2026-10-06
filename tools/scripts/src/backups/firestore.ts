import { applicationDefault, deleteApp, initializeApp } from 'firebase-admin/app';
import {
  DocumentReference,
  getFirestore,
  Timestamp,
  type CollectionReference,
  type Firestore,
} from 'firebase-admin/firestore';

import { AdminApi, type ApiDeps } from './admin-api.ts';
import type { RestoreArgs, RestoreTarget } from './restore-matter.ts';
import type { Data, SubtreeReader } from './subtree.ts';

/** The Admin SDK side of the restore tooling (SEC-03): readers, the restore target and counting. */

export function apiDeps(): ApiDeps {
  const credential = applicationDefault();
  return {
    fetch,
    token: async () => (await credential.getAccessToken()).access_token,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
  };
}

/** Reads a database as it is now (the live one, or one restored next to it). */
export function databaseReader(db: Firestore): SubtreeReader {
  return {
    async get(path) {
      const snap = await db.doc(path).get();
      return snap.exists ? (snap.data() as Data) : null;
    },
    async collections(docPath) {
      return (await db.doc(docPath).listCollections()).map((c) => c.id);
    },
    async documents(collectionPath) {
      const refs = await db.collection(collectionPath).listDocuments();
      if (!refs.length) return [];
      const snaps = await db.getAll(...refs);
      return snaps.map((snap) => ({ path: snap.ref.path, data: snap.exists ? (snap.data() as Data) : null }));
    },
  };
}

/**
 * Reads (default) as it was at a PITR read time: documents through read-only transactions at that
 * time, collection ids through the REST API (the Admin SDK can't list them at a read time). Missing
 * documents that only hold subcollections aren't visible this way; Materia doesn't create those
 * under a matter.
 */
export function pitrReader(db: Firestore, api: AdminApi, readTime: string): SubtreeReader {
  const options = { readOnly: true as const, readTime: Timestamp.fromDate(new Date(readTime)) };
  return {
    async get(path) {
      const snap = await db.runTransaction((tx) => tx.get(db.doc(path)), options);
      return snap.exists ? (snap.data() as Data) : null;
    },
    collections: (docPath) => api.listCollectionIds(db.databaseId, docPath, readTime),
    async documents(collectionPath) {
      const snap = await db.runTransaction((tx) => tx.get(db.collection(collectionPath)), options);
      return snap.docs.map((doc) => ({ path: doc.ref.path, data: doc.data() as Data }));
    },
  };
}

/** References read from another database point at it; rewrite them to the same path in `db`. */
function rebase(value: unknown, db: Firestore): unknown {
  if (value instanceof DocumentReference) return db.doc(value.path);
  if (Array.isArray(value)) return value.map((item) => rebase(item, db));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rebase(item, db)]));
  }
  return value;
}

export function adminTarget(db: Firestore): RestoreTarget {
  return {
    ...databaseReader(db),
    async write(docs) {
      const writer = db.bulkWriter();
      for (const { path, data } of docs) void writer.set(db.doc(path), rebase(data, db) as Data);
      await writer.close();
    },
    async delete(paths) {
      const writer = db.bulkWriter();
      for (const path of paths) void writer.delete(db.doc(path));
      await writer.close();
    },
    async runningMigrations(orgId) {
      const snap = await db.collection(`orgs/${orgId}/migrations`).where('status', '==', 'running').get();
      return snap.docs.map((doc) => doc.id);
    },
    async audit(orgId, entry) {
      const ref = db.collection(`orgs/${orgId}/audit`).doc();
      await ref.create(entry);
      return ref.id;
    },
  };
}

export async function openRestore(args: RestoreArgs) {
  const app = initializeApp({ projectId: args.project }, `restore-matter-${Date.now()}`);
  const target = getFirestore(app, args.targetDatabase);
  const source = args.readTime
    ? pitrReader(getFirestore(app, args.targetDatabase), new AdminApi(apiDeps(), args.project), args.readTime)
    : databaseReader(getFirestore(app, args.fromDatabase as string));
  return { source, target: adminTarget(target), close: () => deleteApp(app) };
}

/** The number of documents in a collection group, now or as of a PITR read time. */
export async function countGroup(db: Firestore, group: string, readTime?: string): Promise<number> {
  const query = db.collectionGroup(group).count();
  if (!readTime) return (await query.get()).data().count;
  const snap = await db.runTransaction((tx) => tx.get(query), {
    readOnly: true,
    readTime: Timestamp.fromDate(new Date(readTime)),
  });
  return snap.data().count;
}

/** A collection as the walk sees it: its id and path, and a sample of its documents. */
export interface WalkCollection {
  id: string;
  path: string;
  sample(limit: number): Promise<{ listCollections(): Promise<WalkCollection[]> }[]>;
}

// orgs/a/matters/b/tasks has the shape orgs/{}/matters/{}/tasks: collections that share a shape.
const shape = (path: string) =>
  path
    .split('/')
    .map((part, index) => (index % 2 ? '{}' : part))
    .join('/');

/**
 * Every collection id under `roots`, found by walking: documents are probed for subcollections, up
 * to `perShape` documents across all collections of the same shape (every matter's tasks share
 * one budget), so the walk is bounded by the schema rather than the data. Materia's collections
 * are uniform, so a sample finds them all. Runs `concurrency` probes at a time.
 */
export async function walkCollectionIds(
  roots: WalkCollection[],
  { perShape = 100, perCollection = 20, concurrency = 16 } = {},
): Promise<string[]> {
  const ids = new Set<string>();
  const budget = new Map<string, number>();
  const queue = [...roots];
  let active = 0;
  return new Promise((resolve, reject) => {
    const next = () => {
      if (!queue.length && !active) return resolve([...ids].sort());
      while (active < concurrency && queue.length) {
        const collection = queue.shift() as WalkCollection;
        ids.add(collection.id);
        const key = shape(collection.path);
        const left = budget.get(key) ?? perShape;
        const take = Math.min(left, perCollection);
        if (take <= 0) continue;
        budget.set(key, left - take);
        active++;
        collection
          .sample(take)
          .then((docs) => Promise.all(docs.map((doc) => doc.listCollections())))
          .then((children) => {
            queue.push(...children.flat());
            active--;
            next();
          }, reject);
      }
      if (!queue.length && !active) resolve([...ids].sort());
    };
    next();
  });
}

function walkable(collection: CollectionReference): WalkCollection {
  return {
    id: collection.id,
    path: collection.path,
    async sample(limit) {
      const snap = await collection.select().limit(limit).get();
      return snap.docs.map((doc) => ({
        listCollections: async () => (await doc.ref.listCollections()).map(walkable),
      }));
    },
  };
}

/**
 * Every collection id in a database (see walkCollectionIds). Documents that don't exist but hold
 * subcollections aren't sampled, so a group found only under those isn't compared.
 */
export async function collectionIds(db: Firestore): Promise<string[]> {
  return walkCollectionIds((await db.listCollections()).map(walkable));
}
