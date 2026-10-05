import * as z from 'zod';

import { CHUNK_EMBEDDING_DIMENSIONS } from '@materia/domain';

import { REGION } from '../../config';
import { EmbeddingUnavailableError, type EmbeddingPort } from '../../ports';

/**
 * Vertex AI text embeddings (ADR-012, AI-04): `text-embedding-005` in `australia-southeast1` at 768
 * dimensions, called over REST with the runtime account's access token (`roles/aiplatform.user`,
 * already in Terraform). No SDK: one small POST per batch keeps the functions bundle light.
 *
 *   POST https://{region}-aiplatform.googleapis.com/v1/projects/{project}/locations/{region}/
 *        publishers/google/models/{model}:predict
 *   {"instances": [{"content": "...", "task_type": "RETRIEVAL_DOCUMENT"}], "parameters": {...}}
 *
 * Batches hold at most 250 texts and about 15,000 tokens (the model takes 250 instances and
 * 20,000 tokens a request). 429, 5xx and network failures retry with backoff; anything else, or
 * running out of retries, throws `EmbeddingUnavailableError` (the ingest task then retries).
 */
export const EMBEDDING_MODEL = 'text-embedding-005';
export const MAX_BATCH_TEXTS = 250;
export const MAX_BATCH_TOKENS = 15_000;
const MAX_ATTEMPTS = 4;

export interface VertexEmbeddingOptions {
  project: () => string;
  model?: string;
  location?: string;
  accessToken?: () => Promise<string>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const PredictResponse = z.object({
  predictions: z.array(z.object({ embeddings: z.object({ values: z.array(z.number()) }) })),
});

const METADATA_TOKEN = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

/** The runtime account's OAuth access token from the metadata server, reused until shortly before it expires. */
export function metadataAccessToken(doFetch: typeof fetch = fetch, now: () => number = Date.now) {
  let cached: { token: string; expiresAt: number } | undefined;
  return async (): Promise<string> => {
    if (cached && now() < cached.expiresAt) return cached.token;
    const response = await doFetch(METADATA_TOKEN, { headers: { 'Metadata-Flavor': 'Google' } });
    if (!response.ok) throw new EmbeddingUnavailableError('not_configured', response.status);
    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new EmbeddingUnavailableError('not_configured');
    cached = { token: body.access_token, expiresAt: now() + Math.max(0, (body.expires_in ?? 300) - 120) * 1000 };
    return cached.token;
  };
}

/** Splits texts into batches the model accepts (count and estimated tokens), keeping order. */
export function batchTexts(texts: readonly string[], maxTexts = MAX_BATCH_TEXTS, maxTokens = MAX_BATCH_TOKENS) {
  const batches: string[][] = [];
  let current: string[] = [];
  let tokens = 0;
  for (const text of texts) {
    const estimate = Math.ceil(text.length / 4);
    if (current.length && (current.length >= maxTexts || tokens + estimate > maxTokens)) {
      batches.push(current);
      current = [];
      tokens = 0;
    }
    current.push(text);
    tokens += estimate;
  }
  if (current.length) batches.push(current);
  return batches;
}

const retryable = (status: number) => status === 429 || status >= 500;

export function vertexEmbeddings(options: VertexEmbeddingOptions): EmbeddingPort {
  const doFetch = options.fetch ?? fetch;
  const accessToken = options.accessToken ?? metadataAccessToken(doFetch);
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const location = options.location ?? REGION;
  const model = options.model ?? EMBEDDING_MODEL;

  async function predict(texts: string[], taskType: string): Promise<number[][]> {
    const project = options.project();
    if (!project) throw new EmbeddingUnavailableError('not_configured');
    const url =
      `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}` +
      `/publishers/google/models/${model}:predict`;
    const body = JSON.stringify({
      instances: texts.map((content) => ({ content, task_type: taskType })),
      parameters: { outputDimensionality: CHUNK_EMBEDDING_DIMENSIONS, autoTruncate: true },
    });
    let lastStatus: number | undefined;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt) await sleep(500 * 2 ** attempt);
      let response: Response;
      try {
        response = await doFetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
          body,
        });
      } catch (error) {
        if (error instanceof EmbeddingUnavailableError) throw error;
        lastStatus = undefined;
        continue;
      }
      if (response.ok) {
        const parsed = PredictResponse.safeParse(await response.json());
        const vectors = parsed.success ? parsed.data.predictions.map((p) => p.embeddings.values) : [];
        if (vectors.length !== texts.length || vectors.some((v) => v.length !== CHUNK_EMBEDDING_DIMENSIONS)) {
          throw new EmbeddingUnavailableError('rejected', response.status);
        }
        return vectors;
      }
      lastStatus = response.status;
      if (!retryable(response.status)) throw new EmbeddingUnavailableError('rejected', response.status);
    }
    throw new EmbeddingUnavailableError('unavailable', lastStatus);
  }

  return {
    async embed(texts, embedOptions = {}) {
      const taskType = embedOptions.task === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT';
      const out: number[][] = [];
      for (const batch of batchTexts(texts)) out.push(...(await predict(batch, taskType)));
      return out;
    },
  };
}
