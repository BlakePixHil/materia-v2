import { applicationDefault, deleteApp, initializeApp } from 'firebase-admin/app';
import { DocumentReference, getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';

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

/**
 * Every collection id in a database, found by walking it: each collection's documents are probed
 * for subcollections, up to `probe` documents per collection (Materia's collections are uniform,
 * so a sample finds them all; chunks and audit entries can run to thousands).
 */
export async function collectionIds(db: Firestore, probe = 200): Promise<string[]> {
  const ids = new Set<string>();
  const visit = async (collections: { id: string; listDocuments(): Promise<DocumentReference[]> }[]) => {
    for (const collection of collections) {
      ids.add(collection.id);
      const refs = (await collection.listDocuments()).slice(0, probe);
      for (const ref of refs) await visit(await ref.listCollections());
    }
  };
  await visit(await db.listCollections());
  return [...ids].sort();
}
