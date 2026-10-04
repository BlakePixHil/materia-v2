import { inject, InjectionToken } from '@angular/core';
import type { DocumentSnapshot, Query, QueryConstraint, QuerySnapshot } from 'firebase/firestore';

import type { CollectionDriver, DriverFactory, DriverOptions, PageRequest, QuerySpec, RawDoc, RawPage } from '../query';
import { FirestoreClient, type FirestoreHandle, type FirestoreSource } from './firestore-client';

function toRaw(doc: DocumentSnapshot): RawDoc {
  return { id: doc.id, snapshot: doc, cursor: doc };
}

function toPage(snap: QuerySnapshot): RawPage {
  return { docs: snap.docs.map(toRaw), fromCache: snap.metadata.fromCache };
}

function buildQuery(
  { sdk, db }: FirestoreHandle,
  path: string,
  spec: QuerySpec,
  request?: PageRequest,
  group = false,
): Query {
  const constraints: QueryConstraint[] = [];
  for (const [field, op, value] of spec.where ?? []) constraints.push(sdk.where(field, op, value));
  for (const [field, direction] of spec.orderBy ?? []) constraints.push(sdk.orderBy(field, direction ?? 'asc'));
  if (request?.after) constraints.push(sdk.startAfter(request.after as DocumentSnapshot));
  if (request?.end) constraints.push(sdk.endAt(request.end as DocumentSnapshot));
  if (request?.limit) constraints.push(sdk.limit(request.limit));
  return sdk.query(group ? sdk.collectionGroup(db, path) : sdk.collection(db, path), ...constraints);
}

/**
 * Attaches a listener once the SDK has loaded. The returned function cancels a listener that
 * hasn't attached yet, or unsubscribes one that has.
 */
function attach(
  source: FirestoreSource,
  subscribe: (handle: FirestoreHandle) => () => void,
  error: (e: unknown) => void,
) {
  let stopped = false;
  let unsubscribe: (() => void) | undefined;
  source.get().then(
    (handle) => {
      if (!stopped) unsubscribe = subscribe(handle);
    },
    (e: unknown) => {
      if (!stopped) error(e);
    },
  );
  return () => {
    stopped = true;
    unsubscribe?.();
  };
}

/**
 * The full-SDK implementation of `CollectionDriver` (FND-19). Listeners include metadata changes,
 * so a page that came from the cache reports again when the server confirms it (offline → ready).
 * Writes stamp the meta fields the rules check: `updatedBy`, `updatedAt: serverTimestamp()`.
 */
export function firestoreDriver(source: FirestoreSource, path: string, options: DriverOptions = {}): CollectionDriver {
  const group = !!options.group;
  const ref = async (id: string) => {
    if (group) throw new Error(`Collection group "${path}" is read-only`);
    const handle = await source.get();
    return { handle, ref: handle.sdk.doc(handle.db, path, id) };
  };
  return {
    listen(request, next, error) {
      return attach(
        source,
        (handle) =>
          handle.sdk.onSnapshot(
            buildQuery(handle, path, request.spec, request, group),
            { includeMetadataChanges: true },
            (snap) => next(toPage(snap)),
            error,
          ),
        error,
      );
    },
    async fetch(request) {
      const handle = await source.get();
      return toPage(await handle.sdk.getDocs(buildQuery(handle, path, request.spec, request, group)));
    },
    watchDoc(id, next, error) {
      if (group) throw new Error(`Collection group "${path}" can't watch one document`);
      return attach(
        source,
        (handle) =>
          handle.sdk.onSnapshot(
            handle.sdk.doc(handle.db, path, id),
            { includeMetadataChanges: true },
            (snap) => next(snap.exists() ? toRaw(snap) : null, snap.metadata.fromCache),
            error,
          ),
        error,
      );
    },
    async getDoc(id) {
      const { handle, ref: docRef } = await ref(id);
      const snap = await handle.sdk.getDoc(docRef);
      return snap.exists() ? toRaw(snap) : null;
    },
    async count(spec) {
      const handle = await source.get();
      const result = await handle.sdk.getCountFromServer(buildQuery(handle, path, spec, undefined, group));
      return result.data().count;
    },
    async create(data, meta) {
      if (group) throw new Error(`Collection group "${path}" is read-only`);
      const handle = await source.get();
      const docRef = handle.sdk.doc(handle.sdk.collection(handle.db, path));
      const now = handle.sdk.serverTimestamp();
      await handle.sdk.setDoc(docRef, {
        ...data,
        createdAt: now,
        createdBy: meta.uid,
        updatedAt: now,
        updatedBy: meta.uid,
        schemaVersion: meta.schemaVersion,
      });
      return docRef.id;
    },
    async update(id, patch, meta, remove = []) {
      const { handle, ref: docRef } = await ref(id);
      const removed = Object.fromEntries(remove.map((field) => [field, handle.sdk.deleteField()]));
      await handle.sdk.updateDoc(docRef, {
        ...patch,
        ...removed,
        updatedAt: handle.sdk.serverTimestamp(),
        updatedBy: meta.uid,
      });
    },
    async softDelete(id, meta) {
      const { handle, ref: docRef } = await ref(id);
      const now = handle.sdk.serverTimestamp();
      await handle.sdk.updateDoc(docRef, { deletedAt: now, deletedBy: meta.uid, updatedAt: now, updatedBy: meta.uid });
    },
  };
}

/** Opens `firestoreDriver`s on one Firestore source. */
export function firestoreDriverFactory(source: FirestoreSource): DriverFactory {
  return (path, options) => firestoreDriver(source, path, options);
}

/** Opens collection drivers; the full-SDK Firestore by default, `provideInMemoryFirestore()` in tests. */
export const FIRESTORE_DRIVER = new InjectionToken<DriverFactory>('FIRESTORE_DRIVER', {
  providedIn: 'root',
  factory: () => firestoreDriverFactory(inject(FirestoreClient)),
});
