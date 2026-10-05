import { FieldValue, type Firestore } from 'firebase-admin/firestore';

import type { EmbeddingPort } from '../../ports';

/**
 * Vector search over ingested chunks (AI-04, ADR-012), for Clerk's context assembly (AI-03).
 * Firestore `findNearest` on the `chunks` collection group, pre-filtered by `orgId`, `matterId`
 * and, unless the caller may see privileged material, `privileged == false` (flat 768-d indexes in
 * firestore.indexes.json). The query is embedded with the retrieval-query task type.
 *
 * Only chunks of live, clean, ingested documents exist (removal and new versions delete them), so
 * no document read is needed here. The caller has already checked the org claim and membership;
 * names and role checks on the documents are AI-03's.
 */
export interface ChunkSearchInput {
  orgId: string;
  matterId: string;
  query: string;
  /** How many chunks (default 8, at most 50, so callers can over-fetch before de-duplicating). */
  k?: number;
  /** False for roles without `privileged.view`: privileged chunks are filtered out in the query. */
  allowPrivileged: boolean;
}

export interface ChunkHit {
  documentId: string;
  /** The document version the chunk was built from (citations pin it). */
  version: number;
  /** 1-based page (DOCX and email pseudo-pages included). */
  page: number;
  /** The chunk's position in that version. */
  ordinal: number;
  text: string;
  privileged: boolean;
  /** Cosine distance, ascending: 0 is identical. */
  distance: number;
}

export interface ChunkSearchPort {
  searchChunks(input: ChunkSearchInput): Promise<ChunkHit[]>;
}

export const DEFAULT_K = 8;
export const MAX_K = 50;

export const clampK = (k: number | undefined) => Math.min(MAX_K, Math.max(1, Math.floor(k ?? DEFAULT_K)));

export function chunkSearch(deps: { db: Firestore; embedding: EmbeddingPort }): ChunkSearchPort {
  return {
    async searchChunks(input) {
      const query = input.query.trim();
      if (!query) return [];
      const [vector] = await deps.embedding.embed([query], { task: 'query' });
      if (!vector) return [];
      let base = deps.db
        .collectionGroup('chunks')
        .where('orgId', '==', input.orgId)
        .where('matterId', '==', input.matterId);
      if (!input.allowPrivileged) base = base.where('privileged', '==', false);
      const snapshot = await base
        .findNearest({
          vectorField: 'embedding',
          queryVector: FieldValue.vector(vector),
          limit: clampK(input.k),
          distanceMeasure: 'COSINE',
          distanceResultField: 'distance',
        })
        .get();
      return snapshot.docs
        .map((snap) => {
          const data = snap.data();
          return {
            documentId: snap.ref.parent.parent?.id ?? '',
            version: Number(data['docVersion']),
            page: Number(data['page']),
            ordinal: Number(data['ordinal']),
            text: String(data['text'] ?? ''),
            privileged: data['privileged'] === true,
            distance: Number(data['distance']),
          };
        })
        .filter((hit) => hit.documentId && (input.allowPrivileged || !hit.privileged))
        .sort((a, b) => a.distance - b.distance);
    },
  };
}

/**
 * An in-memory `ChunkSearchPort` for tests (AI-03 and AI-04): ranks the chunks it was given by
 * word overlap with the query, with the same filters and limits as the real one.
 */
export class FakeChunkSearch implements ChunkSearchPort {
  readonly queries: ChunkSearchInput[] = [];
  constructor(readonly chunks: (ChunkHit & { orgId: string; matterId: string })[] = []) {}

  async searchChunks(input: ChunkSearchInput): Promise<ChunkHit[]> {
    this.queries.push(input);
    const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
    const q = words(input.query);
    return this.chunks
      .filter((c) => c.orgId === input.orgId && c.matterId === input.matterId)
      .filter((c) => input.allowPrivileged || !c.privileged)
      .map((c): ChunkHit => {
        const w = words(c.text);
        const shared = [...q].filter((word) => w.has(word)).length;
        const { documentId, version, page, ordinal, text, privileged } = c;
        return { documentId, version, page, ordinal, text, privileged, distance: q.size ? 1 - shared / q.size : 1 };
      })
      .sort((a, b) => a.distance - b.distance)
      .slice(0, clampK(input.k));
  }
}
