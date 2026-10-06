import {
  assertReadOnlyRequest,
  decodeValue,
  emulatorEndpoints,
  exportAuthRecord,
  restIamTester,
  restReader,
  serverReadTime,
  type RestDeps,
} from './rest.ts';

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

  const name = (path: string) => `projects/legacy-p/databases/(default)/documents/${path}`;

  it('gets a document by path with batchGet, and null when it is missing', async () => {
    const { fetch, calls } = fakeFetch([
      (c) => {
        if (c.url !== `${DOCS}:batchGet`) return undefined;
        const [doc] = (c.body as { documents: string[] }).documents;
        return doc === name('profiles/u 1')
          ? { json: [{ found: { name: name('profiles/u 1'), fields: { a: { stringValue: 'x' } } } }] }
          : { json: [{ missing: doc }] };
      },
    ]);
    const reader = restReader(deps(fetch), project);
    expect(await reader.get('profiles/u 1')).toEqual({ path: 'profiles/u 1', data: { a: 'x' } });
    expect(await reader.get('profiles/none')).toBeNull();
    expect(calls[0]).toMatchObject({ method: 'POST', auth: 'Bearer short-lived' });
    expect(calls[0]?.body).toEqual({ documents: [name('profiles/u 1')] });
  });

  it('lists a subcollection with runQuery, a page at a time from a __name__ cursor', async () => {
    const page = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        document: { name: name(`workflows/w 1/cards/c${String(from + i).padStart(3, '0')}`) },
      }));
    const { fetch, calls } = fakeFetch([
      (c) => {
        if (c.url !== `${DOCS}/workflows/w%201:runQuery`) return undefined;
        const cursor = (c.body as { structuredQuery: { startAt?: unknown } }).structuredQuery.startAt;
        return { json: cursor ? [...page(300, 2), { readTime: 't' }] : page(0, 300) };
      },
    ]);
    const docs = await restReader(deps(fetch), project).list('workflows/w 1/cards');
    expect(docs).toHaveLength(302);
    expect(docs.at(-1)?.path).toBe('workflows/w 1/cards/c301');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body).toEqual({
      structuredQuery: {
        from: [{ collectionId: 'cards' }],
        orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
        limit: 300,
      },
    });
    expect(calls[1]?.body).toMatchObject({
      structuredQuery: {
        startAt: { values: [{ referenceValue: name('workflows/w 1/cards/c299') }], before: false },
      },
    });
  });

  it('lists a top-level collection against the database root', async () => {
    const { fetch, calls } = fakeFetch([
      (c) => (c.url === `${DOCS}:runQuery` ? { json: [{ readTime: 't' }] } : undefined),
    ]);
    expect(await restReader(deps(fetch), project).list('referrers')).toEqual([]);
    expect(calls[0]?.body).toMatchObject({ structuredQuery: { from: [{ collectionId: 'referrers' }] } });
  });

  it('queries a top-level collection with runQuery', async () => {
    const { fetch, calls } = fakeFetch([
      (c) =>
        c.url === `${DOCS}:runQuery`
          ? { json: [{ document: { name: name('workflows/w1') } }, { readTime: 'x' }] }
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
        orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
        limit: 300,
      },
    });
    expect(calls[1]?.body).toMatchObject({ structuredQuery: { where: { fieldFilter: { op: 'EQUAL' } } } });
  });

  it('reads every document at the readTime it is given', async () => {
    const { fetch, calls } = fakeFetch([
      (c) =>
        c.url.endsWith(':runAggregationQuery')
          ? { json: [{ result: { aggregateFields: { count: { integerValue: '7' } } } }] }
          : undefined,
      () => ({ json: [] }),
    ]);
    const reader = restReader(deps(fetch), project, { readTime: '2026-10-06T21:00:00.123456Z' });
    await reader.get('profiles/u1');
    await reader.list('workflows/w/cards');
    await reader.query('workflows', 'uids', 'array-contains', 'u1');
    expect(await reader.count?.('notifications', 'recipientUids', 'array-contains', 'u1')).toBe(7);
    expect(calls.map((c) => (c.body as { readTime?: string }).readTime)).toEqual(
      Array(4).fill('2026-10-06T21:00:00.123456Z'),
    );
    expect(calls[3]?.body).toMatchObject({
      structuredAggregationQuery: {
        structuredQuery: {
          from: [{ collectionId: 'notifications' }],
          where: { fieldFilter: { field: { fieldPath: 'recipientUids' }, op: 'ARRAY_CONTAINS' } },
        },
        aggregations: [{ alias: 'count', count: {} }],
      },
    });
  });

  it('keeps values whole when lossless', async () => {
    const { fetch } = fakeFetch([
      () => ({
        json: [
          {
            found: {
              name: name('cards/c1'),
              fields: {
                y: { bytesValue: 'AAEC' },
                d: { doubleValue: 'NaN' },
                a: { arrayValue: { values: [{ bytesValue: 'AA==' }] } },
              },
            },
          },
        ],
      }),
    ]);
    expect((await restReader(deps(fetch), project, { lossless: true }).get('cards/c1'))?.data).toEqual({
      y: { $bytes: 'AAEC' },
      d: { $double: 'NaN' },
      a: [{ $bytes: 'AA==' }],
    });
  });

  it('sends every request to the endpoints it is given', async () => {
    const endpoints = emulatorEndpoints({
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
      FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:9199',
      FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
    });
    const { fetch, calls } = fakeFetch([() => ({ json: [] })]);
    const reader = restReader(deps(fetch), project, { endpoints });
    await reader.get('profiles/u1');
    await reader.objects('workflows/');
    await reader.authUser?.('u1');
    expect(calls.map((c) => c.url.split('?')[0])).toEqual([
      'http://127.0.0.1:8080/v1/projects/legacy-p/databases/(default)/documents:batchGet',
      'http://127.0.0.1:9199/storage/v1/b/legacy-b.firebasestorage.app/o',
      'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/projects/legacy-p/accounts:lookup',
    ]);
    expect(() => emulatorEndpoints({})).toThrow(/FIRESTORE_EMULATOR_HOST is not set/);
  });

  it("takes the snapshot's readTime from the server", async () => {
    const { fetch, calls } = fakeFetch([() => ({ json: [{ readTime: '2026-10-06T21:00:00.5Z' }] })]);
    expect(await serverReadTime(deps(fetch), 'legacy-p', 'u1')).toBe('2026-10-06T21:00:00.5Z');
    expect(calls[0]?.body).toMatchObject({
      structuredQuery: {
        select: { fields: [{ fieldPath: '__name__' }] },
        where: { fieldFilter: { value: { referenceValue: name('profiles/u1') } } },
      },
    });
    const empty = fakeFetch([() => ({ json: [] })]);
    await expect(serverReadTime(deps(empty.fetch), 'legacy-p', 'u1')).rejects.toThrow(/no readTime/);
  });

  it('lists Storage objects across pages, with numeric sizes', async () => {
    const { fetch, calls } = fakeFetch([
      (c) =>
        c.url.includes('pageToken=p2') ? { json: { items: [{ name: 'workflows/w/b.pdf', size: '20' }] } } : undefined,
      (c) =>
        c.url.startsWith('https://storage.googleapis.com/storage/v1/b/legacy-b.firebasestorage.app/o?')
          ? {
              json: {
                items: [
                  {
                    name: 'workflows/w/a.pdf',
                    size: '10',
                    contentType: 'application/pdf',
                    md5Hash: 'bWQ1',
                    crc32c: 'Y3Jj',
                    generation: '17',
                    updated: '2025-01-01T00:00:00.000Z',
                  },
                ],
                nextPageToken: 'p2',
              },
            }
          : undefined,
    ]);
    expect(await restReader(deps(fetch), project).objects('workflows/w/')).toEqual([
      {
        name: 'workflows/w/a.pdf',
        size: 10,
        contentType: 'application/pdf',
        md5Hash: 'bWQ1',
        crc32c: 'Y3Jj',
        generation: '17',
        updated: '2025-01-01T00:00:00.000Z',
      },
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

  it('keeps sign-in facts and dates for the export, never a hash, salt or provider id', async () => {
    const record = exportAuthRecord({
      localId: 'u1',
      email: 'someone@example.com',
      emailVerified: true,
      displayName: 'Some One',
      passwordHash: 'REDACTED',
      salt: 'c2FsdA==',
      providerUserInfo: [
        { providerId: 'password', rawId: 'someone@example.com' },
        { providerId: 'google.com', rawId: '1234567890', federatedId: 'x' },
      ],
      createdAt: '1640995200000',
      lastLoginAt: '1700000000000',
      passwordUpdatedAt: 1,
    });
    expect(record).toEqual({
      email: 'someone@example.com',
      emailVerified: true,
      disabled: false,
      displayName: 'Some One',
      photoUrl: null,
      providers: ['google.com', 'password'],
      hasPassword: true,
      mfaEnrolled: false,
      createdAt: '2022-01-01T00:00:00.000Z',
      lastSignInAt: '2023-11-14T22:13:20.000Z',
    });
    expect(JSON.stringify(record)).not.toMatch(/REDACTED|c2FsdA|1234567890/);
    expect(exportAuthRecord({})).toMatchObject({ email: null, createdAt: null, lastSignInAt: null, providers: [] });
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
    expect(() => assertReadOnlyRequest('POST', `${DOCS}/workflows/w:runQuery`)).not.toThrow();
    expect(() => assertReadOnlyRequest('POST', `${DOCS}:runAggregationQuery`)).not.toThrow();
    expect(() => assertReadOnlyRequest('POST', `${DOCS}:batchGet`)).not.toThrow();
    expect(() => assertReadOnlyRequest('POST', `${DOCS}:batchWrite`)).toThrow(/only reads/);
    expect(() => assertReadOnlyRequest('POST', `${DOCS}:beginTransaction`)).toThrow(/only reads/);
    expect(() =>
      assertReadOnlyRequest('POST', 'https://identitytoolkit.googleapis.com/v1/projects/p/accounts:lookup'),
    ).not.toThrow();
    expect(() => assertReadOnlyRequest('POST', `${DOCS}:commit`)).toThrow(/only reads/);
    expect(() => assertReadOnlyRequest('POST', `${DOCS}:batchWrite?x=:runQuery`)).toThrow(/only reads/);
    expect(() => assertReadOnlyRequest('PATCH', `${DOCS}/profiles/u1`)).toThrow(/only reads/);
    expect(() => assertReadOnlyRequest('DELETE', `${DOCS}/profiles/u1`)).toThrow(/only reads/);
  });
});
