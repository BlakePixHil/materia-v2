import type { Firestore } from 'firebase-admin/firestore';

import { createContextBuilder, type ContextBuilder } from './build-context';
import { firestoreContextSource } from './firestore-source';
import { charEstimateCounter, noChunkSearch, noDocumentText } from './ports';

/**
 * `buildContext` as callables use it. Chunk search and document text are stubs until AI-04 merges
 * (swap `noChunkSearch` for `chunkSearch({ db, embedding: ports.embedding })` from
 * `documents/ingest/search.ts`, and `noDocumentText` for its page reader). Tokens are a character
 * estimate until the provider adapter exposes the token-counting endpoint.
 */
export function clerkContext(deps: { db: Firestore }): ContextBuilder {
  return createContextBuilder({
    source: firestoreContextSource(deps.db),
    chunks: noChunkSearch,
    documentText: noDocumentText,
    tokens: charEstimateCounter,
  });
}
