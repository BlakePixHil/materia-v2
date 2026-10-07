import type { App } from 'firebase-admin/app';
import type { DocumentReference, Firestore } from 'firebase-admin/firestore';

import type { AuthPort, Doc, TargetDb, WriteFailure } from './target.ts';
import type { Data } from './values.ts';

/** Attempts a BulkWriter makes at one write before it counts as failed. */
const WRITE_ATTEMPTS = 5;

/**
 * The v2 Firestore and Auth through the Admin SDK. Firestore takes Application Default
 * Credentials only (the Admin SDK refuses other credentials for it): your account in Cloud
 * Shell, or `gcloud auth application-default login`. On the emulator, none.
 */
export async function adminTarget(projectId: string, emulator: boolean) {
  const { applicationDefault, deleteApp, initializeApp } = await import('firebase-admin/app');
  const { getFirestore, Timestamp } = await import('firebase-admin/firestore');
  const { getAuth } = await import('firebase-admin/auth');
  // A user account's token bills a quota project; the target's, as Terraform's calls do.
  if (!emulator) process.env['GOOGLE_CLOUD_QUOTA_PROJECT'] ??= projectId;
  const app: App = initializeApp(
    { projectId, ...(emulator ? {} : { credential: applicationDefault() }) },
    `migration-load-${Date.now()}`,
  );
  const firestore = getFirestore(app);
  const auth = getAuth(app);

  /** Firestore values as the load compares them: Timestamps as Dates. */
  const plain = (value: unknown): unknown => {
    if (value instanceof Timestamp) return value.toDate();
    if (Array.isArray(value)) return value.map(plain);
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
    }
    return value;
  };
  const docsOf = async (refs: DocumentReference[]): Promise<Doc[]> => {
    if (!refs.length) return [];
    const snaps = await firestore.getAll(...refs);
    return snaps
      .filter((snap) => snap.exists)
      .map((snap) => ({ path: snap.ref.path, data: plain(snap.data()) as Data }));
  };

  const db: TargetDb = {
    async getAll(paths) {
      const docs = await docsOf(paths.map((path) => firestore.doc(path)));
      return new Map(docs.map((doc) => [doc.path, doc.data]));
    },
    async apply(ops) {
      const failures: WriteFailure[] = [];
      const writer = firestore.bulkWriter();
      writer.onWriteError((error) => error.failedAttempts < WRITE_ATTEMPTS);
      const pending = ops.map((op) => {
        const ref = firestore.doc(op.path);
        const write =
          op.op === 'delete'
            ? writer.delete(ref)
            : op.op === 'set'
              ? writer.set(ref, op.data)
              : writer.update(ref, op.data);
        return write.catch((error: unknown) => {
          failures.push({ path: op.path, message: error instanceof Error ? error.message : String(error) });
        });
      });
      await writer.close();
      await Promise.all(pending);
      return failures;
    },
    async loadedBy(group, runId) {
      const source =
        group === 'orgs' || group === 'users' ? firestore.collection(group) : firestore.collectionGroup(group);
      const snap = await source.where('migration.runId', '==', runId).get();
      return snap.docs.map((doc) => ({ path: doc.ref.path, data: plain(doc.data()) as Data }));
    },
    async descendants(path) {
      const found: Doc[] = [];
      const walk = async (docPath: string): Promise<void> => {
        for (const collection of await firestore.doc(docPath).listCollections()) {
          // listDocuments also finds documents that only hold subcollections.
          const refs = await collection.listDocuments();
          found.push(...(await docsOf(refs)));
          for (const ref of refs) await walk(ref.path);
        }
      };
      await walk(path);
      return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    },
    async collection(path) {
      const snap = await firestore.collection(path).get();
      return snap.docs.map((doc) => ({ path: doc.ref.path, data: plain(doc.data()) as Data }));
    },
  };

  const authPort: AuthPort = {
    async claimsOf(uid) {
      try {
        return { ...((await auth.getUser(uid)).customClaims ?? {}) };
      } catch (error) {
        if ((error as { code?: string }).code === 'auth/user-not-found') return null;
        throw error;
      }
    },
    async setClaims(uid, claims) {
      await auth.setCustomUserClaims(uid, claims);
    },
  };

  return { db, auth: authPort, firestore: firestore as Firestore, close: () => deleteApp(app) };
}
