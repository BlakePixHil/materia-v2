import type { Firestore } from 'firebase-admin/firestore';

import { createContextBuilder, type ContextBuilder } from './build-context';
import { firestoreContextSource } from './firestore-source';
import { charEstimateCounter } from './ports';
import { chunkSearch } from '../../documents/ingest/search';
import { chunkDocumentText } from '../../documents/ingest/text';
import type { EmbeddingPort } from '../../ports';

/**
 * `buildContext` as callables use it: chunk search and document text from AI-04's chunks
 * (`documents/ingest`). Tokens are a character estimate until the provider adapter exposes the
 * token-counting endpoint.
 */
export function clerkContext(deps: { db: Firestore; embedding: EmbeddingPort }): ContextBuilder {
  return createContextBuilder({
    source: firestoreContextSource(deps.db),
    chunks: chunkSearch({ db: deps.db, embedding: deps.embedding }),
    documentText: chunkDocumentText(deps.db),
    tokens: charEstimateCounter,
  });
}
