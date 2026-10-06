import { createHash } from 'node:crypto';

import { assertMigrationBucket, gcsSink, memorySink } from './sink.ts';

const STORAGE = 'https://storage.googleapis.com/storage/v1';
const KIB = 1024;

interface Session {
  name: string;
  data: Buffer;
  done: boolean;
}

/**
 * Enough of the GCS JSON API's resumable upload for the sink: sessions, chunks with
 * `Content-Range`, 308s with `Range`, status queries, `ifGenerationMatch=0` and media reads.
 * `failNext` makes the next chunk die after keeping `kept` bytes of it, as a dropped connection would.
 */
function fakeGcs() {
  const objects = new Map<string, Buffer>();
  const sessions = new Map<string, Session>();
  const calls: { method: string; url: string; range?: string }[] = [];
  const state = { failNext: null as null | { kept: number }, md5Wrong: false };
  const fetchImpl = (async (input: string, init: RequestInit) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    const range = headers.get('content-range') ?? undefined;
    calls.push({ method, url: input, ...(range ? { range } : {}) });
    if (method === 'POST' && url.pathname.startsWith('/upload/storage/v1/b/materia-v2-dev-migration/o')) {
      const name = url.searchParams.get('name') ?? '';
      if (url.searchParams.get('ifGenerationMatch') === '0' && objects.has(name))
        return new Response('', { status: 412 });
      const id = `s${sessions.size}`;
      sessions.set(id, { name, data: Buffer.alloc(0), done: false });
      return new Response('', { status: 200, headers: { location: `https://upload.example/${id}` } });
    }
    if (method === 'PUT' && url.host === 'upload.example') {
      const session = sessions.get(url.pathname.slice(1));
      if (!session) return new Response('no session', { status: 404 });
      const held = () =>
        session.data.length ? { range: `bytes=0-${session.data.length - 1}` } : ({} as Record<string, string>);
      if (range === 'bytes */*') {
        return session.done ? new Response('{}', { status: 200 }) : new Response('', { status: 308, headers: held() });
      }
      const match = /^bytes (?:(\d+)-(\d+)|\*)\/(\d+|\*)$/.exec(range ?? '');
      if (!match) return new Response('bad range', { status: 400 });
      const body = Buffer.from(init.body ? new Uint8Array(init.body as Uint8Array) : new Uint8Array());
      const start = match[1] === undefined ? session.data.length : Number(match[1]);
      if (start !== session.data.length) return new Response('wrong offset', { status: 400 });
      if (state.failNext) {
        session.data = Buffer.concat([session.data, body.subarray(0, state.failNext.kept)]);
        state.failNext = null;
        throw new TypeError('fetch failed');
      }
      session.data = Buffer.concat([session.data, body]);
      if (match[3] === '*') return new Response('', { status: 308, headers: held() });
      session.done = true;
      objects.set(session.name, session.data);
      const md5 = createHash('md5')
        .update(state.md5Wrong ? 'x' : session.data)
        .digest('base64');
      return Response.json({ name: session.name, size: String(session.data.length), md5Hash: md5 });
    }
    if (method === 'GET') {
      const name = decodeURIComponent(url.pathname.replace(/^\/storage\/v1\/b\/[^/]+\/o\//, ''));
      const object = objects.get(name);
      if (!object) return new Response('not found', { status: 404 });
      return url.searchParams.get('alt') === 'media'
        ? new Response(object)
        : Response.json({ size: String(object.length), md5Hash: createHash('md5').update(object).digest('base64') });
    }
    return new Response('unexpected', { status: 500 });
  }) as typeof globalThis.fetch;
  return { fetch: fetchImpl, objects, calls, state };
}

const sinkOn = (gcs: ReturnType<typeof fakeGcs>, chunkBytes = 256 * KIB) =>
  gcsSink(
    { fetch: gcs.fetch, token: async () => 'writer-token' },
    { bucket: 'materia-v2-dev-migration', runId: 'r1', storage: STORAGE, chunkBytes, sleep: async () => undefined },
  );

async function upload(sink: ReturnType<typeof sinkOn>, name: string, parts: string[], once = false) {
  const file = await sink.create(name, 'application/x-ndjson', { once });
  for (const part of parts) await file.write(part);
  await file.close();
}

describe('the bucket sink', () => {
  it('writes only to a migration bucket', () => {
    expect(() => assertMigrationBucket('materia-v2-prod-migration')).not.toThrow();
    for (const bucket of [
      'matt-r-1fe15.firebasestorage.app',
      'materia-v2-dev.firebasestorage.app',
      'materia-v2-staging-migration',
    ]) {
      expect(() => assertMigrationBucket(bucket)).toThrow(/writes only to a materia-v2 migration bucket/);
    }
    expect(() =>
      gcsSink(
        { fetch, token: async () => 't' },
        { bucket: 'matt-r-1fe15.firebasestorage.app', runId: 'r', storage: STORAGE },
      ),
    ).toThrow(/Refusing to write/);
  });

  it('uploads a small file in one request under runs/{runId}/', async () => {
    const gcs = fakeGcs();
    const sink = sinkOn(gcs);
    expect(sink.location).toBe('gs://materia-v2-dev-migration/runs/r1/');
    await upload(sink, 'raw/cards.jsonl', ['{"a":1}\n', '{"b":2}\n']);
    expect(gcs.objects.get('runs/r1/raw/cards.jsonl')?.toString()).toBe('{"a":1}\n{"b":2}\n');
    expect(gcs.calls.map((c) => c.range).filter(Boolean)).toEqual(['bytes 0-15/16']);
    expect(await sink.read('raw/cards.jsonl')).toBe('{"a":1}\n{"b":2}\n');
    expect(await sink.read('raw/none.jsonl')).toBeNull();
  });

  it('streams a big file in 256 KiB chunks', async () => {
    const gcs = fakeGcs();
    const line = `${'x'.repeat(KIB - 1)}\n`;
    await upload(sinkOn(gcs), 'raw/cards.jsonl', Array(600).fill(line));
    expect(gcs.objects.get('runs/r1/raw/cards.jsonl')?.length).toBe(600 * KIB);
    expect(gcs.calls.map((c) => c.range).filter(Boolean)).toEqual([
      'bytes 0-262143/*',
      'bytes 262144-524287/*',
      'bytes 524288-614399/614400',
    ]);
  });

  it('finishes an empty file', async () => {
    const gcs = fakeGcs();
    await upload(sinkOn(gcs), 'raw/auth.jsonl', []);
    expect(gcs.objects.get('runs/r1/raw/auth.jsonl')?.length).toBe(0);
    expect(gcs.calls.at(-1)?.range).toBe('bytes */0');
  });

  it('resends only what Storage lost when a chunk fails midway', async () => {
    const gcs = fakeGcs();
    const sink = sinkOn(gcs);
    const file = await sink.create('raw/cards.jsonl', 'application/x-ndjson');
    const content = Buffer.alloc(700 * KIB, 7).toString();
    gcs.state.failNext = { kept: 0 };
    await file.write(content.slice(0, 300 * KIB));
    gcs.state.failNext = { kept: 100 * KIB };
    await file.write(content.slice(300 * KIB));
    await file.close();
    expect(gcs.objects.get('runs/r1/raw/cards.jsonl')?.toString()).toBe(content);
    expect(gcs.calls.filter((c) => c.range === 'bytes */*')).toHaveLength(2);
  });

  it('refuses to overwrite a file written once', async () => {
    const gcs = fakeGcs();
    const sink = sinkOn(gcs);
    await upload(sink, 'manifest.json', ['{}'], true);
    await expect(upload(sink, 'manifest.json', ['{}'], true)).rejects.toThrow(/already exists/);
    await upload(sink, 'checkpoint.json', ['1']);
    await upload(sink, 'checkpoint.json', ['2']);
    expect(gcs.objects.get('runs/r1/checkpoint.json')?.toString()).toBe('2');
  });

  it("fails when Storage's MD5 doesn't match what was sent", async () => {
    const gcs = fakeGcs();
    gcs.state.md5Wrong = true;
    await expect(upload(sinkOn(gcs), 'raw/cards.jsonl', ['not x'])).rejects.toThrow(/MD5/);
  });

  it('takes a chunk size of whole 256 KiB granules only', () => {
    expect(() => sinkOn(fakeGcs(), 100 * KIB)).toThrow(/multiple of 256 KiB/);
  });
});

describe('the memory sink', () => {
  it('keeps files by name', async () => {
    const sink = memorySink('r1');
    const file = await sink.create('raw/a.jsonl', 'application/x-ndjson');
    await file.write('a');
    await file.write('b');
    expect(await sink.read('raw/a.jsonl')).toBeNull();
    await file.close();
    expect(await sink.read('raw/a.jsonl')).toBe('ab');
    await expect(sink.create('raw/a.jsonl', 'x', { once: true })).rejects.toThrow(/already exists/);
  });
});
