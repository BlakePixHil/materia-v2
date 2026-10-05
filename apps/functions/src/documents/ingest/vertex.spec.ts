import { batchTexts, MAX_BATCH_TEXTS, metadataAccessToken, vertexEmbeddings } from './vertex';
import { EmbeddingUnavailableError } from '../../ports';
import { hashedEmbedding } from '../../ports/fakes';

/** The Vertex AI embeddings adapter (AI-04) against a stand-in fetch. Texts are fictional. */

const vector = (seed: number) => Array.from({ length: 768 }, (_, i) => ((seed + i) % 5) / 5);

function fakeFetch(statuses: number[] = []) {
  const calls: { url: string; body: { instances: { content: string; task_type: string }[]; parameters: object } }[] =
    [];
  const queue = [...statuses];
  const doFetch = (async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as (typeof calls)[number]['body'];
    calls.push({ url, body });
    const status = queue.shift() ?? 200;
    if (status !== 200) return new Response('{}', { status });
    return Response.json({ predictions: body.instances.map((_, i) => ({ embeddings: { values: vector(i) } })) });
  }) as unknown as typeof fetch;
  return { calls, doFetch };
}

const adapter = (doFetch: typeof fetch, project = 'materia-v2-dev') =>
  vertexEmbeddings({
    project: () => project,
    accessToken: async () => 'token',
    fetch: doFetch,
    sleep: async () => undefined,
  });

describe('vertexEmbeddings', () => {
  it('calls text-embedding-005 in australia-southeast1 at 768 dimensions, as documents or a query', async () => {
    const { calls, doFetch } = fakeFetch();
    const port = adapter(doFetch);
    const out = await port.embed(['I appoint Sam Sample as executor.', 'The residue to Kit Placeholder.']);
    expect(out).toEqual([vector(0), vector(1)]);
    expect(calls[0]?.url).toBe(
      'https://australia-southeast1-aiplatform.googleapis.com/v1/projects/materia-v2-dev/locations/australia-southeast1/publishers/google/models/text-embedding-005:predict',
    );
    expect(calls[0]?.body.parameters).toEqual({ outputDimensionality: 768, autoTruncate: true });
    expect(calls[0]?.body.instances[0]?.task_type).toBe('RETRIEVAL_DOCUMENT');
    await port.embed(['who is the executor?'], { task: 'query' });
    expect(calls[1]?.body.instances[0]?.task_type).toBe('RETRIEVAL_QUERY');
  });

  it('batches by count (250) and by estimated tokens, keeping order', async () => {
    const { calls, doFetch } = fakeFetch();
    const texts = Array.from({ length: 600 }, (_, i) => `Fictional clause ${i}.`);
    const out = await adapter(doFetch).embed(texts);
    expect(out).toHaveLength(600);
    expect(calls.map((c) => c.body.instances.length)).toEqual([250, 250, 100]);
    expect(batchTexts(Array.from({ length: 30 }, () => 'x'.repeat(3200))).map((b) => b.length)).toEqual([18, 12]);
    expect(MAX_BATCH_TEXTS).toBe(250);
  });

  it('retries 429 and 5xx, then succeeds', async () => {
    const { calls, doFetch } = fakeFetch([429, 503]);
    await expect(adapter(doFetch).embed(['a'])).resolves.toHaveLength(1);
    expect(calls).toHaveLength(3);
  });

  it('gives up after its retries, and at once on a rejected request', async () => {
    const down = fakeFetch([500, 500, 500, 500]);
    await expect(adapter(down.doFetch).embed(['a'])).rejects.toMatchObject({ reason: 'unavailable', status: 500 });
    const bad = fakeFetch([400]);
    await expect(adapter(bad.doFetch).embed(['a'])).rejects.toMatchObject({ reason: 'rejected', status: 400 });
    expect(bad.calls).toHaveLength(1);
    await expect(adapter(bad.doFetch, '').embed(['a'])).rejects.toBeInstanceOf(EmbeddingUnavailableError);
  });

  it('rejects a reply with the wrong number or size of vectors', async () => {
    const doFetch = (async () =>
      Response.json({ predictions: [{ embeddings: { values: [1, 2] } }] })) as unknown as typeof fetch;
    await expect(adapter(doFetch).embed(['a'])).rejects.toMatchObject({ reason: 'rejected' });
  });

  it('retries a network failure', async () => {
    let first = true;
    const doFetch = (async (_url: string, init: { body: string }) => {
      if (first) {
        first = false;
        throw new TypeError('fetch failed');
      }
      const body = JSON.parse(init.body) as { instances: unknown[] };
      return Response.json({ predictions: body.instances.map(() => ({ embeddings: { values: vector(0) } })) });
    }) as unknown as typeof fetch;
    await expect(adapter(doFetch).embed(['a'])).resolves.toHaveLength(1);
  });
});

/** A stand-in for the metadata server's token (not a real credential). */
const TOKEN = ['fake', 'metadata', 'token'].join('-');

describe('metadataAccessToken', () => {
  it('reads the runtime account token from the metadata server and reuses it', async () => {
    let calls = 0;
    const doFetch = (async (_url: string, init: { headers: Record<string, string> }) => {
      calls++;
      expect(init.headers['Metadata-Flavor']).toBe('Google');
      return Response.json({ access_token: TOKEN, expires_in: 3599 });
    }) as unknown as typeof fetch;
    let now = 0;
    const token = metadataAccessToken(doFetch, () => now);
    expect(await token()).toBe(TOKEN);
    await token();
    expect(calls).toBe(1);
    now = 3_600_000;
    await token();
    expect(calls).toBe(2);
  });

  it('fails as not configured off Google Cloud', async () => {
    const doFetch = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    await expect(metadataAccessToken(doFetch)()).rejects.toMatchObject({ reason: 'not_configured' });
  });
});

describe('hashedEmbedding (the fake)', () => {
  it('is unit-length and puts texts that share words close together', () => {
    const a = hashedEmbedding('executors of the will');
    const b = hashedEmbedding('the executor named in the will');
    const c = hashedEmbedding('funeral invoice paid');
    const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * (y[i] ?? 0), 0);
    expect(Math.hypot(...a)).toBeCloseTo(1);
    expect(dot(a, b)).toBeGreaterThan(dot(a, c));
    expect(Math.hypot(...hashedEmbedding(''))).toBeCloseTo(1);
  });
});
