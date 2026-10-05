import { FieldValue, type DocumentReference, type Firestore } from 'firebase-admin/firestore';

import { Chunk } from '@materia/domain';

/** Writes per batch (Firestore allows 500; vectors make each write large, so stay well under). */
const BATCH = 200;

/** `{version}-{ordinal}`, zero-padded so ids sort in reading order. */
export const chunkId = (version: number, ordinal: number) =>
  `${String(version).padStart(3, '0')}-${String(ordinal).padStart(5, '0')}`;

export interface ChunkRecord {
  orgId: string;
  matterId: string;
  text: string;
  page: number;
  docVersion: number;
  ordinal: number;
  privileged: boolean;
  ocr?: boolean;
  embedding: number[];
}

/** Writes chunks under the document (overwriting a retry's earlier write of the same chunk). */
export async function writeChunks(db: Firestore, doc: DocumentReference, chunks: ChunkRecord[], at: Date) {
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = db.batch();
    for (const chunk of chunks.slice(i, i + BATCH)) {
      const record = Chunk.schema.parse({
        ...chunk,
        createdAt: at,
        createdBy: 'system',
        updatedAt: at,
        updatedBy: 'system',
        schemaVersion: Chunk.version,
      });
      batch.set(doc.collection('chunks').doc(chunkId(chunk.docVersion, chunk.ordinal)), {
        ...record,
        embedding: FieldValue.vector(record.embedding),
      });
    }
    await batch.commit();
  }
}

/** Deletes a document's chunks: all of them, or only those not built from `keepVersion`. */
export async function deleteChunks(db: Firestore, doc: DocumentReference, keepVersion?: number): Promise<number> {
  let deleted = 0;
  for (;;) {
    const base = doc.collection('chunks');
    const query = keepVersion === undefined ? base : base.where('docVersion', '!=', keepVersion);
    const page = await query.select().limit(BATCH).get();
    if (page.empty) return deleted;
    const batch = db.batch();
    for (const snap of page.docs) batch.delete(snap.ref);
    await batch.commit();
    deleted += page.size;
  }
}

/** Sets `privileged` on every chunk of a document that differs (the vector index pre-filters on it). */
export async function syncChunksPrivileged(
  db: Firestore,
  doc: DocumentReference,
  privileged: boolean,
): Promise<number> {
  let updated = 0;
  for (;;) {
    const page = await doc.collection('chunks').where('privileged', '==', !privileged).select().limit(BATCH).get();
    if (page.empty) return updated;
    const batch = db.batch();
    for (const snap of page.docs) batch.update(snap.ref, { privileged });
    await batch.commit();
    updated += page.size;
  }
}
