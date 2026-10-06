import { gcsStore, StorageError } from './gcs.ts';

const STORAGE = 'https://storage.googleapis.com/storage/v1';
const OBJECT = {
  bucket: 'b',
  name: 'n',
  size: '3',
  generation: '7',
  md5Hash: 'bWQ1',
  crc32c: 'Y3Jj',
  metadata: { k: 'v' },
};

/** A fetch that answers each call in turn and records it. */
function scripted(...answers: (Response | Error)[]) {
  const calls: { method: string; url: string; body?: string; auth: string | null }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({
      method: init.method ?? 'GET',
      url,
      ...(typeof init.body === 'string' ? { body: init.body } : {}),
      auth: new Headers(init.headers).get('authorization'),
    });
    const next = answers.shift();
    if (!next) throw new Error(`unexpected ${init.method} ${url}`);
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return {
    calls,
    store: gcsStore({ fetch: impl, token: async () => 't0k' }, { storage: STORAGE, sleep: async () => undefined }),
  };
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

describe('gcsStore', () => {
  it('reads metadata, or null for a missing object, with the token', async () => {
    const { store, calls } = scripted(json(OBJECT), new Response('', { status: 404 }));
    expect(await store.stat('b', 'a/b c')).toEqual({
      bucket: 'b',
      name: 'n',
      size: 3,
      generation: '7',
      md5Hash: 'bWQ1',
      crc32c: 'Y3Jj',
      metadata: { k: 'v' },
    });
    expect(await store.stat('b', 'gone')).toBeNull();
    expect(calls[0]).toMatchObject({ method: 'GET', url: `${STORAGE}/b/b/o/a%2Fb%20c`, auth: 'Bearer t0k' });
  });

  it('lists objects under a prefix, page by page', async () => {
    const { store, calls } = scripted(
      json({ items: [OBJECT], nextPageToken: 'p2' }),
      json({ items: [{ ...OBJECT, name: 'n2' }] }),
      json({}),
      new Response('no', { status: 403 }),
    );
    expect((await store.list('b', 'orgs/o/')).map((object) => object.name)).toEqual(['n', 'n2']);
    expect(calls.map((call) => call.url)).toEqual([
      `${STORAGE}/b/b/o?prefix=orgs%2Fo%2F`,
      `${STORAGE}/b/b/o?prefix=orgs%2Fo%2F&pageToken=p2`,
    ]);
    expect(await store.list('b', 'empty/')).toEqual([]);
    await expect(store.list('b', 'refused/')).rejects.toThrow(/Listing gs:\/\/b\/refused\//);
  });

  it('rewrites on the server until done, pinned to the source generation, with the new metadata', async () => {
    const { store, calls } = scripted(
      json({ done: false, rewriteToken: 'tok-1' }),
      new Response('busy', { status: 503 }),
      json({ done: true, resource: OBJECT }),
    );
    const out = await store.rewrite(
      { bucket: 'legacy', name: 'workflows/w/a.pdf', generation: '42' },
      { bucket: 'files', name: 'q/x' },
      { contentType: 'application/pdf', metadata: { legacyPath: 'w' } },
    );
    expect(out?.generation).toBe('7');
    expect(calls.map((call) => call.url)).toEqual([
      `${STORAGE}/b/legacy/o/workflows%2Fw%2Fa.pdf/rewriteTo/b/files/o/q%2Fx?sourceGeneration=42`,
      `${STORAGE}/b/legacy/o/workflows%2Fw%2Fa.pdf/rewriteTo/b/files/o/q%2Fx?sourceGeneration=42&rewriteToken=tok-1`,
      `${STORAGE}/b/legacy/o/workflows%2Fw%2Fa.pdf/rewriteTo/b/files/o/q%2Fx?sourceGeneration=42&rewriteToken=tok-1`,
    ]);
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual({ contentType: 'application/pdf', metadata: { legacyPath: 'w' } });
  });

  it('answers null when the source generation is gone, and throws on a refusal', async () => {
    const { store } = scripted(new Response('', { status: 404 }), new Response('no', { status: 403 }));
    const args = [
      { bucket: 'l', name: 'a' },
      { bucket: 'f', name: 'b' },
      { contentType: 'x/y', metadata: {} },
    ] as const;
    expect(await store.rewrite(...args)).toBeNull();
    await expect(store.rewrite(...args)).rejects.toThrow('Copying to gs://f/b: 403 no');
  });

  it('reads bytes up to a limit, retrying dropped connections', async () => {
    const { store } = scripted(new Error('socket hang up'), new Response('abc'), new Response('abcdef'));
    expect((await store.read('b', 'n', 5)).toString()).toBe('abc');
    await expect(store.read('b', 'n', 5)).rejects.toThrow(StorageError);
  });

  it('gives up after four retries', async () => {
    const busy = () => new Response('', { status: 500 });
    const { store, calls } = scripted(busy(), busy(), busy(), busy(), busy());
    await expect(store.stat('b', 'n')).rejects.toThrow('Storage returned 500');
    expect(calls).toHaveLength(5);
  });

  it('patches metadata and deletes by generation, a missing object being fine', async () => {
    const { store, calls } = scripted(
      json(OBJECT),
      new Response(null, { status: 204 }),
      new Response('', { status: 404 }),
    );
    await store.patchMetadata('b', 'n', { scan: 'clean' });
    await store.remove('b', 'q/n', '7');
    await store.remove('b', 'q/n');
    expect(calls.map(({ method, url, body }) => [method, url, body])).toEqual([
      ['PATCH', `${STORAGE}/b/b/o/n`, '{"metadata":{"scan":"clean"}}'],
      ['DELETE', `${STORAGE}/b/b/o/q%2Fn?ifGenerationMatch=7`, undefined],
      ['DELETE', `${STORAGE}/b/b/o/q%2Fn`, undefined],
    ]);
  });
});
