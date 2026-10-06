import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { OAuthProvider } from '@materia/domain';

import { classifyTokenError, defaultAccount, httpOAuth, jwtClaims, retryAfterMs } from './oauth';
import type { OAuthProviderConfig } from './providers';
import { newPkce, pkceChallenge } from './state';
import { OAuthError } from '../ports';

/** A fake OAuth server on localhost: records each request and answers from `next`. */
interface Seen {
  path: string;
  headers: IncomingMessage['headers'];
  form: URLSearchParams;
}
let server: Server;
let base = '';
const seen: Seen[] = [];
let next: (request: Seen) => { status: number; body?: unknown; headers?: Record<string, string> };

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      const entry = { path: request.url ?? '', headers: request.headers, form: new URLSearchParams(body) };
      seen.push(entry);
      const answer = next(entry);
      response.writeHead(answer.status, { 'content-type': 'application/json', ...answer.headers });
      response.end(answer.body === undefined ? '' : JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  seen.length = 0;
  next = () => ({ status: 500 });
});

const jwt = (claims: Record<string, unknown>) =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;

function config(overrides: Partial<OAuthProviderConfig> = {}): OAuthProviderConfig {
  return {
    authorizeUrl: 'https://login.example.test/authorize',
    tokenUrl: `${base}/token`,
    revokeUrl: `${base}/revoke`,
    scopes: ['openid', 'email', 'offline_access', 'accounting.transactions'],
    clientAuth: 'basic',
    clientId: () => 'fictional-client',
    clientSecret: () => 'fictional-secret',
    secrets: [],
    ...overrides,
  };
}
const P: OAuthProvider = 'xero';
const client = (overrides: Partial<OAuthProviderConfig> = {}) => httpOAuth({ configs: { [P]: config(overrides) } });

describe('httpOAuth', () => {
  it('builds the consent URL with the client, redirect URI, scopes, state and S256 challenge', async () => {
    const url = new URL(
      await client({ authorizeParams: { prompt: 'consent' } }).authorizationUrl(P, {
        state: 'state-123',
        codeChallenge: 'challenge-abc',
        redirectUri: 'https://materia-v2-dev.web.app/integrations/callback/xero',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://login.example.test/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'fictional-client',
      redirect_uri: 'https://materia-v2-dev.web.app/integrations/callback/xero',
      scope: 'openid email offline_access accounting.transactions',
      state: 'state-123',
      code_challenge: 'challenge-abc',
      code_challenge_method: 'S256',
      prompt: 'consent',
    });
  });

  it('exchanges a code with the PKCE verifier and HTTP Basic client auth, reading the account from the ID token', async () => {
    next = () => ({
      status: 200,
      body: {
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 1800,
        scope: 'openid email offline_access',
        id_token: jwt({ email: 'bookkeeper@example.test', name: 'Fictional Bookkeeper', tid: 'tenant-1' }),
      },
    });
    const tokens = await client().exchangeCode(P, {
      code: 'code-1',
      codeVerifier: 'verifier-1',
      redirectUri: 'https://materia-v2-dev.web.app/integrations/callback/xero',
    });
    expect(tokens).toEqual({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresIn: 1800,
      scopes: ['openid', 'email', 'offline_access'],
      account: { email: 'bookkeeper@example.test', name: 'Fictional Bookkeeper', tenantId: 'tenant-1' },
    });
    const [request] = seen;
    expect(request?.path).toBe('/token');
    expect(request?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(request?.headers['authorization']).toBe(
      `Basic ${Buffer.from('fictional-client:fictional-secret').toString('base64')}`,
    );
    expect(Object.fromEntries(request?.form ?? [])).toEqual({
      grant_type: 'authorization_code',
      code: 'code-1',
      redirect_uri: 'https://materia-v2-dev.web.app/integrations/callback/xero',
      code_verifier: 'verifier-1',
    });
  });

  it('sends the client credentials as form fields when the provider wants them there', async () => {
    next = () => ({ status: 200, body: { access_token: 'access-2', expires_in: 3600 } });
    const tokens = await client({ clientAuth: 'post' }).refresh(P, 'refresh-1');
    expect(tokens).toEqual({ accessToken: 'access-2', expiresIn: 3600 });
    const [request] = seen;
    expect(request?.headers['authorization']).toBeUndefined();
    expect(Object.fromEntries(request?.form ?? [])).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-1',
      client_id: 'fictional-client',
      client_secret: 'fictional-secret',
    });
  });

  it('returns a rotated refresh token', async () => {
    next = () => ({ status: 200, body: { access_token: 'access-3', refresh_token: 'refresh-2', expires_in: 1800 } });
    expect((await client().refresh(P, 'refresh-1')).refreshToken).toBe('refresh-2');
  });

  it('classifies refusals without echoing the provider’s description', async () => {
    next = () => ({ status: 400, body: { error: 'invalid_grant', error_description: 'token refresh-1 revoked' } });
    const revoked = (await client()
      .refresh(P, 'refresh-1')
      .catch((error: unknown) => error)) as OAuthError;
    expect(revoked).toBeInstanceOf(OAuthError);
    expect(revoked).toMatchObject({ failure: 'invalid_grant', status: 400 });
    expect(revoked.message).not.toContain('refresh-1');

    next = () => ({ status: 400, body: { error: 'consent_required' } });
    await expect(client().refresh(P, 'r')).rejects.toMatchObject({ failure: 'consent_required' });
    next = () => ({ status: 401, body: { error: 'invalid_client' } });
    await expect(client().refresh(P, 'r')).rejects.toMatchObject({ failure: 'rejected' });
    next = () => ({ status: 429, headers: { 'retry-after': '30' } });
    await expect(client().refresh(P, 'r')).rejects.toMatchObject({ failure: 'transient', retryAfterMs: 30_000 });
    next = () => ({ status: 503 });
    await expect(client().refresh(P, 'r')).rejects.toMatchObject({ failure: 'transient' });
    next = () => ({ status: 200, body: { token_type: 'Bearer' } });
    await expect(client().refresh(P, 'r')).rejects.toMatchObject({ failure: 'rejected' });
  });

  it('is transient when the token endpoint can’t be reached', async () => {
    await expect(client({ tokenUrl: 'http://127.0.0.1:1/token' }).refresh(P, 'r')).rejects.toMatchObject({
      failure: 'transient',
    });
  });

  it('is not configured without a client id or secret, or for a provider it doesn’t know', async () => {
    await expect(
      client({ clientSecret: () => 'unset' }).authorizationUrl(P, { state: 's', codeChallenge: 'c', redirectUri: 'r' }),
    ).rejects.toMatchObject({ failure: 'not_configured' });
    await expect(client().refresh('google', 'r')).rejects.toMatchObject({ failure: 'not_configured' });
    expect(seen).toHaveLength(0);
  });

  it('revokes a refresh token (RFC 7009), or says it can’t', async () => {
    next = () => ({ status: 200 });
    expect(await client().revoke(P, 'refresh-1')).toBe(true);
    expect(seen[0]?.path).toBe('/revoke');
    expect(Object.fromEntries(seen[0]?.form ?? [])).toEqual({ token: 'refresh-1', token_type_hint: 'refresh_token' });
    const noRevoke = config();
    delete noRevoke.revokeUrl;
    expect(await httpOAuth({ configs: { [P]: noRevoke } }).revoke(P, 'refresh-1')).toBe(false);
    next = () => ({ status: 400, body: { error: 'unsupported_token_type' } });
    await expect(client().revoke(P, 'refresh-1')).rejects.toMatchObject({ failure: 'rejected' });
  });
});

describe('helpers', () => {
  it('reads Retry-After as seconds or a date', () => {
    const now = Date.parse('2026-10-06T00:00:00Z');
    expect(retryAfterMs('5', now)).toBe(5000);
    expect(retryAfterMs('Tue, 06 Oct 2026 00:00:10 GMT', now)).toBe(10_000);
    expect(retryAfterMs('soon', now)).toBeUndefined();
    expect(retryAfterMs(null, now)).toBeUndefined();
  });

  it('reads JWT claims and the standard account claims', () => {
    expect(jwtClaims(jwt({ email: 'a@example.test' }))).toEqual({ email: 'a@example.test' });
    expect(jwtClaims('not-a-jwt')).toBeUndefined();
    expect(jwtClaims(undefined)).toBeUndefined();
    expect(defaultAccount({ preferred_username: 'b@example.test' })).toEqual({ email: 'b@example.test' });
    expect(defaultAccount({ sub: '123' })).toBeUndefined();
  });

  it('classifies by status before the error code', () => {
    expect(classifyTokenError(500, { error: 'invalid_grant' }).failure).toBe('transient');
    expect(classifyTokenError(400, undefined).failure).toBe('rejected');
  });

  it('makes a fresh S256 PKCE pair each time', () => {
    const a = newPkce();
    const b = newPkce();
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.challenge).toBe(pkceChallenge(a.verifier));
    expect(a.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(b.verifier).not.toBe(a.verifier);
  });
});
