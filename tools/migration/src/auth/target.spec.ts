import type { Auth, UserRecord } from 'firebase-admin/auth';

import type { LegacyAuthRecord } from './record.ts';
import { adminTarget, enabledProviders, readSecret, readTargetState, type TargetAuth } from './target.ts';
import type { RestDeps } from '../legacy/rest.ts';

function restDeps(routes: Record<string, unknown>, seen: { url: string; headers: Headers }[] = []): RestDeps {
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    seen.push({ url: href, headers: new Headers(init?.headers) });
    const route = Object.keys(routes).find((path) => href.endsWith(path));
    if (route === undefined) return new Response('not found', { status: 404 });
    const body = routes[route];
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { fetch: fetchImpl as typeof globalThis.fetch, token: async () => 'token' };
}

describe('enabledProviders', () => {
  it('lists email sign-in and the enabled identity providers, billed to the target', async () => {
    const seen: { url: string; headers: Headers }[] = [];
    const deps = restDeps(
      {
        '/projects/materia-v2-dev/config': { signIn: { email: { enabled: true } } },
        '/defaultSupportedIdpConfigs?pageSize=100': {
          defaultSupportedIdpConfigs: [
            { name: 'projects/1/defaultSupportedIdpConfigs/google.com', enabled: true },
            { name: 'projects/1/defaultSupportedIdpConfigs/microsoft.com', enabled: false },
          ],
        },
        '/oauthIdpConfigs?pageSize=100': {
          oauthIdpConfigs: [{ name: 'projects/1/oauthIdpConfigs/oidc.entra', enabled: true }],
        },
      },
      seen,
    );
    expect([...(await enabledProviders(deps, 'materia-v2-dev'))].sort()).toEqual([
      'google.com',
      'oidc.entra',
      'password',
    ]);
    expect(seen.every((call) => call.headers.get('x-goog-user-project') === 'materia-v2-dev')).toBe(true);
    expect(seen.every((call) => call.headers.get('authorization') === 'Bearer token')).toBe(true);
  });

  it('is empty when nothing is configured, and fails on an API error', async () => {
    expect([...(await enabledProviders(restDeps({}), 'p'))]).toEqual([]);
    const denied = restDeps({ '/projects/p/config': new Response('denied', { status: 403 }) });
    await expect(enabledProviders(denied, 'p')).rejects.toThrow(/403 denied/);
  });
});

describe('readSecret', () => {
  it('decodes the latest version, and is null when there is no secret', async () => {
    const deps = restDeps({
      '/projects/p/secrets/LEGACY_SCRYPT_PARAMS/versions/latest:access': {
        payload: { data: Buffer.from('{"rounds":8}').toString('base64') },
      },
    });
    expect(await readSecret(deps, 'p', 'LEGACY_SCRYPT_PARAMS')).toBe('{"rounds":8}');
    expect(await readSecret(deps, 'p', 'OTHER')).toBeNull();
  });
});

function record(uid: string, metadata: Partial<UserRecord['metadata']> = {}, claims?: object): UserRecord {
  return {
    uid,
    email: `${uid}@example.com`,
    providerData: [{ providerId: 'google.com', uid: `g-${uid}` }],
    metadata: { creationTime: 'Sat, 01 Jan 2022 00:00:00 GMT', lastSignInTime: '', ...metadata },
    ...(claims ? { customClaims: claims } : {}),
  } as unknown as UserRecord;
}

describe('adminTarget', () => {
  const notFound = Object.assign(new Error('no user'), { code: 'auth/user-not-found' });
  const auth = {
    getUser: async (uid: string) => {
      if (uid === 'boom') throw new Error('network');
      if (uid === 'missing') throw notFound;
      return record(uid, { lastSignInTime: 'Mon, 06 Oct 2026 01:00:00 GMT' }, { orgId: 'o' });
    },
    getUserByEmail: async () => {
      throw notFound;
    },
    getUserByProviderUid: async (_provider: string, rawId: string) => record(rawId.replace('g-', '')),
    importUsers: vi.fn(async (users: unknown[]) =>
      users.length && (users[0] as { uid: string }).uid === 'bad'
        ? { failureCount: 1, successCount: 0, errors: [{ index: 0, error: new Error('UID_EXISTS') }] }
        : { failureCount: 0, successCount: 1, errors: [] },
    ),
    deleteUser: vi.fn(async () => undefined),
  } as unknown as Auth;
  const target = adminTarget(auth);

  it('maps users, and a missing user to null', async () => {
    expect(await target.getUser('u1')).toEqual({
      uid: 'u1',
      email: 'u1@example.com',
      providers: [{ providerId: 'google.com', uid: 'g-u1' }],
      createdAt: 'Sat, 01 Jan 2022 00:00:00 GMT',
      lastSignInAt: 'Mon, 06 Oct 2026 01:00:00 GMT',
      hasCustomClaims: true,
    });
    expect(await target.getUser('missing')).toBeNull();
    expect(await target.getUserByEmail('x@example.com')).toBeNull();
    expect(await target.getUserByIdentity('google.com', 'g-u2')).toMatchObject({ uid: 'u2', hasCustomClaims: false });
    await expect(target.getUser('boom')).rejects.toThrow('network');
  });

  it('throws when Identity Platform refuses the import', async () => {
    await expect(target.importUser({ uid: 'ok' })).resolves.toBeUndefined();
    await expect(target.importUser({ uid: 'bad' })).rejects.toThrow('Identity Platform refused the import: UID_EXISTS');
    await target.deleteUser('u1');
    expect(auth.deleteUser).toHaveBeenCalledWith('u1');
  });
});

describe('readTargetState', () => {
  it('finds the uid and, once each, anyone else holding the email or an identity', async () => {
    const other = { uid: 'other', providers: [], hasCustomClaims: false };
    const fake: TargetAuth = {
      getUser: async () => null,
      getUserByEmail: async () => other,
      getUserByIdentity: async (providerId) => (providerId === 'google.com' ? other : null),
      importUser: async () => undefined,
      deleteUser: async () => undefined,
    };
    const legacy = {
      uid: 'legacy-1',
      email: 'a@example.com',
      identities: [
        { providerId: 'google.com', rawId: 'g' },
        { providerId: 'microsoft.com', rawId: 'm' },
        { providerId: 'apple.com', rawId: '' },
      ],
    } as LegacyAuthRecord;
    expect(await readTargetState(fake, legacy, 'any')).toEqual({
      byUid: null,
      conflicts: [other],
      enabledProviders: 'any',
    });
  });
});
