import { assertReadOnlyRequest, decodeValue, restIamTester, restReader, type RestDeps } from './rest.ts';

interface Call {
  url: string;
  method: string;
  body?: unknown;
  auth: string | null;
}

function fakeFetch(responses: ((call: Call) => { status?: number; json?: unknown } | undefined)[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string, init: RequestInit) => {
    const call: Call = {
      url: input,
      method: init.method ?? 'GET',
      ...(init.body ? { body: JSON.parse(String(init.body)) } : {}),
      auth: new Headers(init.headers).get('authorization'),
    };
    calls.push(call);
    for (const respond of responses) {
      const res = respond(call);
      if (res) return new Response(JSON.stringify(res.json ?? {}), { status: res.status ?? 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch: fetchImpl, calls };
}

const project = { project: 'legacy-p', bucket: 'legacy-b.firebasestorage.app' };
const DOCS = 'https://firestore.googleapis.com/v1/projects/legacy-p/databases/(default)/documents';

describe('decodeValue', () => {
  it('turns REST values into plain JSON and tags what JSON cannot hold', () => {
    expect(
      decodeValue({
        mapValue: {
          fields: {
            n: { nullValue: null },
            b: { booleanValue: false },
            i: { integerValue: '42' },
            d: { doubleValue: 5500.5 },
            s: { stringValue: '' },
            t: { timestampValue: '2025-01-01T00:00:00Z' },
            y: { bytesValue: 'AAAA' },
            r: { referenceValue: 'projects/p/databases/(default)/documents/workflows/w1' },
            g: { geoPointValue: { latitude: -38.1, longitude: 144.3 } },
            a: { arrayValue: { values: [{ stringValue: 'x' }, { arrayValue: {} }] } },
            m: { mapValue: {} },
          },
        },
      }),
    ).toEqual({
      n: null,
      b: false,
      i: 42,
      d: 5500.5,
      s: '',
      t: { $timestamp: '2025-01-01T00:00:00Z' },
      y: { $bytes: 3 },
      r: { $reference: 'workflows/w1' },
      g: { $geopoint: [-38.1, 144.3] },
      a: ['x', []],
      m: {},
    });
    expect(decodeValue({})).toBeNull();
  });
});

describe('restReader', () => {
  const deps = (fetch: typeof globalThis.fetch): RestDeps => ({ fetch, token: async () => 'short-lived' });

  it('gets a document by path, and null when it is missing', async () => {
    const { fetch, calls } = fakeFetch([
      (c) =>
        c.url === `${DOCS}/profiles/u%201`
          ? {
              json: {
                name: 'projects/legacy-p/databases/(default)/documents/profiles/u 1',
                fields: { a: { stringValue: 'x' } },
              },
            }
          : undefined,
    ]);
    const reader = restReader(deps(fetch), project);
    expect(await reader.get('profiles/u 1')).toEqual({ path: 'profiles/u 1', data: { a: 'x' } });
    expect(await reader.get('profiles/none')).toBeNull();
    expect(calls[0]).toMatchObject({ method: 'GET', auth: 'Bearer short-lived' });
  });

  it('lists a collection across pages', async () => {
    const doc = (id: string) => ({ name: `projects/legacy-p/databases/(default)/documents/workflows/w/cards/${id}` });
    const { fetch, calls } = fakeFetch([
      (c) => (c.url.includes('pageToken=next') ? { json: { documents: [doc('c2')] } } : undefined),
      (c) =>
        c.url.startsWith(`${DOCS}/workflows/w/cards?`)
          ? { json: { documents: [doc('c1')], nextPageToken: 'next' } }
          : undefined,
    ]);
    const docs = await restReader(deps(fetch), project).list('workflows/w/cards');
    expect(docs.map((d) => d.path)).toEqual(['workflows/w/cards/c1', 'workflows/w/cards/c2']);
    expect(calls).toHaveLength(2);
  });

  it('queries a top-level collection with runQuery', async () => {
    const { fetch, calls } = fakeFetch([
      (c) =>
        c.url === `${DOCS}:runQuery`
          ? {
              json: [
                { document: { name: 'projects/legacy-p/databases/(default)/documents/workflows/w1' } },
                { readTime: 'x' },
              ],
            }
          : undefined,
    ]);
    const reader = restReader(deps(fetch), project);
    expect((await reader.query('workflows', 'uids', 'array-contains', 'u1')).map((d) => d.path)).toEqual([
      'workflows/w1',
    ]);
    await reader.query('workflows', 'owner', '==', 'u1');
    expect(calls[0]?.body).toEqual({
      structuredQuery: {
        from: [{ collectionId: 'workflows' }],
        where: { fieldFilter: { field: { fieldPath: 'uids' }, op: 'ARRAY_CONTAINS', value: { stringValue: 'u1' } } },
      },
    });
    expect(calls[1]?.body).toMatchObject({ structuredQuery: { where: { fieldFilter: { op: 'EQUAL' } } } });
  });

  it('lists Storage objects across pages, with numeric sizes', async () => {
    const { fetch, calls } = fakeFetch([
      (c) =>
        c.url.includes('pageToken=p2') ? { json: { items: [{ name: 'workflows/w/b.pdf', size: '20' }] } } : undefined,
      (c) =>
        c.url.startsWith('https://storage.googleapis.com/storage/v1/b/legacy-b.firebasestorage.app/o?')
          ? {
              json: {
                items: [{ name: 'workflows/w/a.pdf', size: '10', contentType: 'application/pdf' }],
                nextPageToken: 'p2',
              },
            }
          : undefined,
    ]);
    expect(await restReader(deps(fetch), project).objects('workflows/w/')).toEqual([
      { name: 'workflows/w/a.pdf', size: 10, contentType: 'application/pdf' },
      { name: 'workflows/w/b.pdf', size: 20 },
    ]);
    expect(new URL(calls[0]?.url ?? '').searchParams.get('prefix')).toBe('workflows/w/');
  });

  it('summarises the Auth user without hashes or emails', async () => {
    const { fetch, calls } = fakeFetch([
      (c) =>
        c.url.endsWith('/projects/legacy-p/accounts:lookup') && (c.body as { localId: string[] }).localId[0] === 'u1'
          ? {
              json: {
                users: [
                  {
                    email: 'someone@example.com',
                    providerUserInfo: [{ providerId: 'google.com' }, { providerId: 'google.com' }],
                    emailVerified: true,
                  },
                ],
              },
            }
          : undefined,
      () => ({ json: {} }),
    ]);
    const reader = restReader(deps(fetch), project);
    const auth = await reader.authUser?.('u1');
    expect(auth).toEqual({
      found: true,
      providers: ['google.com'],
      hasPassword: false,
      mfaEnrolled: false,
      disabled: false,
      emailVerified: true,
    });
    expect(JSON.stringify(auth)).not.toContain('example.com');
    expect(await reader.authUser?.('u2')).toMatchObject({ found: false });
    expect(calls[0]?.method).toBe('POST');
  });

  it('throws on errors other than not found', async () => {
    const { fetch } = fakeFetch([() => ({ status: 403, json: { error: 'denied' } })]);
    await expect(restReader(deps(fetch), project).list('workflows')).rejects.toThrow(/403/);
  });
});

describe('restIamTester', () => {
  it('tests project permissions by POST and bucket permissions by GET', async () => {
    const { fetch, calls } = fakeFetch([
      (c) =>
        c.url.endsWith(':testIamPermissions') ? { json: { permissions: ['datastore.entities.get'] } } : undefined,
      (c) => (c.url.includes('/iam/testPermissions?') ? { json: {} } : undefined),
    ]);
    const iam = restIamTester({ fetch, token: async () => 't' }, project);
    expect(await iam.project(['datastore.entities.get', 'datastore.entities.create'])).toEqual([
      'datastore.entities.get',
    ]);
    expect(await iam.bucket(['storage.objects.create'])).toEqual([]);
    expect(calls[0]).toMatchObject({
      url: 'https://cloudresourcemanager.googleapis.com/v1/projects/legacy-p:testIamPermissions',
      method: 'POST',
      body: { permissions: ['datastore.entities.get', 'datastore.entities.create'] },
    });
    expect(new URL(calls[1]?.url ?? '').searchParams.getAll('permissions')).toEqual(['storage.objects.create']);
  });
});

describe('assertReadOnlyRequest', () => {
  it('allows GETs and the read-only POSTs only', () => {
    expect(() => assertReadOnlyRequest('GET', `${DOCS}/profiles/u1`)).not.toThrow();
    expect(() => assertReadOnlyRequest('POST', `${DOCS}:runQuery`)).not.toThrow();
    expect(() =>
      assertReadOnlyRequest('POST', 'https://identitytoolkit.googleapis.com/v1/projects/p/accounts:lookup'),
    ).not.toThrow();
    expect(() => assertReadOnlyRequest('POST', `${DOCS}:commit`)).toThrow(/only reads/);
    expect(() => assertReadOnlyRequest('POST', `${DOCS}:batchWrite?x=:runQuery`)).toThrow(/only reads/);
    expect(() => assertReadOnlyRequest('PATCH', `${DOCS}/profiles/u1`)).toThrow(/only reads/);
    expect(() => assertReadOnlyRequest('DELETE', `${DOCS}/profiles/u1`)).toThrow(/only reads/);
  });
});
