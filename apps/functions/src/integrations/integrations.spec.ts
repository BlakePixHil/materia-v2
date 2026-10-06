import { randomUUID } from 'node:crypto';

import { Timestamp } from 'firebase-admin/firestore';
import type { HttpsError } from 'firebase-functions/v2/https';

import { IntegrationStatus, type Role } from '@materia/domain';

import { completeDefinition, disconnectDefinition, startDefinition } from './callables';
import { integrationStatePath, pkceChallenge } from './state';
import {
  accessToken,
  authorizedFetch,
  clearAccessTokens,
  integrationPath,
  integrationStatusPath,
  removeMemberConnections,
  type VaultContext,
} from './vault';
import { clearRetentionCache } from '../audit/retention';
import { runCallable, type CallableDefinition, type CallableDeps } from '../core/callable';
import { clearFlagCaches, setRemoteFlagLoader } from '../core/flags';
import { createLog } from '../core/log';
import { memoryFirestore } from '../orgs/testing';
import { OAuthError } from '../ports';
import { FakeClock, FakeKms, FakeOAuth, FakeTaskQueue, fakePorts } from '../ports/fakes';

const ORG = 'org-vault';
const MS = 'integrations.microsoft';

const member = (role: Role) => ({ role, status: 'active', displayName: `Fictional ${role}` });

function world(orgFlags: Record<string, unknown> = { [MS]: true }) {
  const store = memoryFirestore({
    [`orgs/${ORG}`]: { name: 'Fictional Vault Legal', retentionYears: 7, flags: orgFlags },
    ...Object.fromEntries(
      (['owner', 'admin', 'lawyer', 'paralegal', 'readonly'] as const).flatMap((role) => [
        [`orgs/${ORG}/members/u-${role}`, member(role)],
        [`users/u-${role}`, { email: `${role}@example.test` }],
      ]),
    ),
  });
  const clock = new FakeClock(new Date('2026-10-06T00:00:00Z'));
  const oauth = new FakeOAuth();
  const kms = new FakeKms('fake-kms/oauth-tokens/cryptoKeyVersions/3');
  const tasks = new FakeTaskQueue();
  const ports = fakePorts({ oauth, oauthKms: kms, clock, tasks });
  const deps: CallableDeps = {
    db: () => store.db,
    clock,
    ports: () => ports,
    memberLookup: async () => true,
    idempotency: {
      begin: async () => ({ replay: false }),
      complete: async () => undefined,
      abandon: async () => undefined,
    },
    sink: () => undefined,
  };
  const recent = () => ({ auth_time: Math.floor(clock.now().getTime() / 1000) });
  const call = <O>(def: unknown, data: Record<string, unknown>, role: Role = 'lawyer', uid = `u-${role}`) =>
    runCallable(
      def as CallableDefinition<never, O>,
      { data: { requestId: randomUUID(), ...data }, auth: { uid, token: { orgId: ORG, role, ...recent() } } },
      deps,
    );
  const vault: VaultContext = {
    orgId: ORG,
    db: store.db,
    clock,
    log: createLog({ fn: 'test' }, () => undefined),
    ports,
  };
  const doc = (path: string) => store.docs.get(path);
  const docsUnder = (prefix: string) =>
    [...store.docs.entries()].filter(([path]) => path.startsWith(prefix)).map(([, data]) => data);

  /** Starts connecting and follows the fake provider's redirect: the callback's state and code. */
  async function consent(provider = 'microsoft', role: Role = 'lawyer', extra: Record<string, unknown> = {}) {
    const { url } = await call<{ url: string }>(startDefinition, { provider, returnTo: '/settings', ...extra }, role);
    const back = new URL(url);
    return { url: back, state: back.searchParams.get('state') ?? '', code: back.searchParams.get('code') ?? '' };
  }
  async function connect(provider = 'microsoft', role: Role = 'lawyer') {
    const { state, code } = await consent(provider, role);
    return call<{ provider: string; returnTo: string }>(completeDefinition, { provider, state, code }, role);
  }
  return { store, clock, oauth, kms, tasks, call, vault, doc, docsUnder, consent, connect };
}

const errorOf = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('expected a failure');
    },
    (error: unknown) => error as HttpsError & { details?: { code?: string; reason?: string } },
  );

const TOKEN_PATH = integrationPath(ORG, 'u-lawyer_microsoft');
const STATUS_PATH = integrationStatusPath(ORG, 'u-lawyer_microsoft');

beforeEach(() => {
  clearRetentionCache();
  clearAccessTokens();
  clearFlagCaches();
  setRemoteFlagLoader(async () => ({}));
});

afterAll(() => setRemoteFlagLoader());

describe('integrations-start', () => {
  it('returns the consent page with a random state and an S256 PKCE challenge, keeping only the state’s hash', async () => {
    const w = world();
    const { url, state } = await w.consent();
    expect(url.origin + url.pathname).toBe('https://materia-v2-dev.web.app/integrations/callback/microsoft');
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const attempt = w.doc(integrationStatePath(ORG, state));
    expect(attempt).toMatchObject({ provider: 'microsoft', level: 'user', uid: 'u-lawyer', returnTo: '/settings' });
    expect(String(attempt?.['codeVerifier'])).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(w.docsUnder(`orgs/${ORG}/integrationStates/`))).not.toContain(state);
    // The fake provider checks the challenge on exchange; here, that it is the verifier's S256.
    const claims = JSON.parse(
      Buffer.from((url.searchParams.get('code') ?? '').replace('fake-code.', ''), 'base64url').toString(),
    ) as { challenge: string };
    expect(claims.challenge).toBe(pkceChallenge(String(attempt?.['codeVerifier'])));
  });

  it('needs the provider’s flag, and a provider with no flag yet isn’t available', async () => {
    const off = world({});
    expect((await errorOf(off.call(startDefinition, { provider: 'microsoft' }))).details?.code).toBe(
      'FEATURE_DISABLED',
    );
    const w = world();
    expect((await errorOf(w.call(startDefinition, { provider: 'google' }))).details?.code).toBe('FEATURE_DISABLED');
  });

  it('keeps the practice’s connections to owners and admins', async () => {
    const w = world();
    expect((await errorOf(w.call(startDefinition, { provider: 'xero' }, 'lawyer'))).details?.code).toBe(
      'PERMISSION_DENIED',
    );
  });

  it('needs a sign-in within five minutes', async () => {
    const w = world();
    const stale = runCallable(
      startDefinition as unknown as CallableDefinition<never, unknown>,
      {
        data: { requestId: randomUUID(), provider: 'microsoft' },
        auth: { uid: 'u-lawyer', token: { orgId: ORG, role: 'lawyer', auth_time: 1 } },
      },
      {
        db: () => w.store.db,
        clock: w.clock,
        ports: () => fakePorts(),
        memberLookup: async () => true,
        idempotency: {
          begin: async () => ({ replay: false }),
          complete: async () => undefined,
          abandon: async () => undefined,
        },
        sink: () => undefined,
      },
    );
    expect((await errorOf(stale)).details?.code).toBe('REAUTH_REQUIRED');
  });

  it('answers not configured when the provider has no client in this environment', async () => {
    const w = world();
    w.oauth.failNext(new OAuthError('not_configured'));
    expect((await errorOf(w.call(startDefinition, { provider: 'microsoft' }))).details?.code).toBe(
      'INTEGRATION_NOT_CONFIGURED',
    );
  });

  it('rejects a return path that leaves the app', async () => {
    const w = world();
    for (const returnTo of ['//evil.example/x', 'https://evil.example', '/\\evil.example']) {
      expect((await errorOf(w.call(startDefinition, { provider: 'microsoft', returnTo }))).details?.code).toBe(
        'INVALID_ARGUMENT',
      );
    }
  });
});

describe('integrations-complete', () => {
  it('stores the refresh token encrypted and bound to its path, and mirrors a status with no secrets', async () => {
    const w = world();
    const result = await w.connect();
    expect(result).toEqual({
      provider: 'microsoft',
      returnTo: '/settings',
      account: { email: 'connected@example.test', name: 'Fictional Account' },
    });

    const stored = w.doc(TOKEN_PATH);
    expect(stored).toMatchObject({
      provider: 'microsoft',
      uid: 'u-lawyer',
      level: 'user',
      status: 'connected',
      kmsKeyVersion: 'fake-kms/oauth-tokens/cryptoKeyVersions/3',
      connectedBy: 'u-lawyer',
    });
    const ciphertext = String(stored?.['encryptedRefreshToken']);
    expect(ciphertext).toMatch(/^fakekms\./);
    expect(ciphertext).not.toContain('fake-refresh');
    expect(w.kms.calls).toContainEqual({ op: 'encrypt', aad: TOKEN_PATH });

    const status = w.doc(STATUS_PATH);
    expect(status).toMatchObject({ provider: 'microsoft', uid: 'u-lawyer', status: 'connected' });
    const asRead = Object.fromEntries(
      Object.entries(status ?? {}).map(([key, value]) => [key, value instanceof Timestamp ? value.toDate() : value]),
    );
    expect(IntegrationStatus.schema.safeParse(asRead).success).toBe(true);
    expect(JSON.stringify(status)).not.toMatch(/fake-refresh|fake-access|fakekms|encrypted/i);
    // The schema itself refuses token fields.
    expect(IntegrationStatus.schema.safeParse({ ...asRead, encryptedRefreshToken: 'x' }).success).toBe(false);

    const audits = w.docsUnder(`orgs/${ORG}/audit/`);
    expect(audits).toContainEqual(expect.objectContaining({ action: 'integration.connected' }));
    expect(JSON.stringify(audits)).not.toMatch(/fake-refresh|fakekms/);
  });

  it('rejects a made-up, reused, expired or other provider’s state', async () => {
    const w = world();
    const made = await errorOf(
      w.call(completeDefinition, { provider: 'microsoft', state: 'x'.repeat(43), code: 'fake-code.x' }),
    );
    expect(made.details).toMatchObject({ code: 'INTEGRATION_STATE_INVALID', reason: 'unknown' });

    const once = await w.consent();
    await w.call(completeDefinition, { provider: 'microsoft', state: once.state, code: once.code });
    const reused = await errorOf(
      w.call(completeDefinition, { provider: 'microsoft', state: once.state, code: once.code }),
    );
    expect(reused.details).toMatchObject({ code: 'INTEGRATION_STATE_INVALID', reason: 'unknown' });

    const late = await w.consent();
    w.clock.advance(10 * 60_000 + 1);
    const expired = await errorOf(
      w.call(completeDefinition, { provider: 'microsoft', state: late.state, code: late.code }),
    );
    expect(expired.details).toMatchObject({ code: 'INTEGRATION_STATE_INVALID', reason: 'expired' });

    const swapped = await w.consent();
    const other = await errorOf(
      w.call(completeDefinition, { provider: 'google', state: swapped.state, code: swapped.code }),
    );
    expect(other.details).toMatchObject({ code: 'INTEGRATION_STATE_INVALID', reason: 'provider' });
  });

  it('won’t complete someone else’s attempt, and leaves it for them', async () => {
    const w = world();
    const { state, code } = await w.consent('microsoft', 'lawyer');
    const stolen = await errorOf(w.call(completeDefinition, { provider: 'microsoft', state, code }, 'paralegal'));
    expect(stolen.details).toMatchObject({ code: 'INTEGRATION_STATE_INVALID', reason: 'other_user' });
    expect(w.doc(integrationPath(ORG, 'u-paralegal_microsoft'))).toBeUndefined();
    // The person who started it still can.
    await w.call(completeDefinition, { provider: 'microsoft', state, code }, 'lawyer');
    expect(w.doc(TOKEN_PATH)?.['status']).toBe('connected');
  });

  it('stores nothing when the provider refuses the code (wrong code or PKCE verifier)', async () => {
    const w = world();
    const { state } = await w.consent();
    const refused = await errorOf(
      w.call(completeDefinition, { provider: 'microsoft', state, code: FakeOAuth.deniedCode() }),
    );
    expect(refused.details).toMatchObject({ code: 'INTEGRATION_REJECTED', reason: 'rejected' });
    expect(w.doc(TOKEN_PATH)).toBeUndefined();
    expect(w.doc(integrationStatePath(ORG, state))).toBeUndefined();
  });

  it('replaces the token when the same person connects again, and revokes the old one', async () => {
    const w = world();
    await w.connect();
    const first = await w.kms.decrypt(String(w.doc(TOKEN_PATH)?.['encryptedRefreshToken']), TOKEN_PATH);
    const firstConnection = w.doc(TOKEN_PATH)?.['connectionId'];
    await w.connect();
    expect(w.doc(TOKEN_PATH)?.['connectionId']).not.toBe(firstConnection);
    expect(w.oauth.revoked).toEqual([first]);
  });
});

describe('integrations-disconnect', () => {
  it('deletes the token, marks the status disconnected and revokes it', async () => {
    const w = world();
    await w.connect();
    const token = await w.kms.decrypt(String(w.doc(TOKEN_PATH)?.['encryptedRefreshToken']), TOKEN_PATH);
    const result = await w.call(disconnectDefinition, { provider: 'microsoft' });
    expect(result).toEqual({ disconnected: true, revoked: true });
    expect(w.doc(TOKEN_PATH)).toBeUndefined();
    expect(w.doc(STATUS_PATH)).toMatchObject({
      status: 'disconnected',
      reason: 'disconnected',
      disconnectedBy: 'u-lawyer',
    });
    expect(w.oauth.revoked).toEqual([token]);
    expect(w.docsUnder(`orgs/${ORG}/audit/`)).toContainEqual(
      expect.objectContaining({ action: 'integration.disconnected' }),
    );
    expect(await w.call(disconnectDefinition, { provider: 'microsoft' })).toEqual({
      disconnected: false,
      revoked: false,
    });
  });

  it('still disconnects when the provider can’t revoke', async () => {
    const w = world();
    await w.connect();
    w.oauth.failNext(new OAuthError('transient'));
    // failNext applies to the next provider call, which is the revoke.
    expect(await w.call(disconnectDefinition, { provider: 'microsoft' })).toEqual({
      disconnected: true,
      revoked: false,
    });
    expect(w.doc(TOKEN_PATH)).toBeUndefined();
  });

  it('removes a person’s own connections when they leave the practice', async () => {
    const w = world();
    await w.connect();
    expect(await removeMemberConnections(w.vault, 'u-lawyer')).toBe(1);
    expect(w.doc(TOKEN_PATH)).toBeUndefined();
    expect(w.doc(STATUS_PATH)).toMatchObject({
      status: 'disconnected',
      reason: 'member_removed',
      disconnectedBy: 'system',
    });
    expect(w.oauth.revoked).toHaveLength(1);
  });
});

describe('the vault', () => {
  const ref = { provider: 'microsoft' as const, uid: 'u-lawyer' };

  it('reuses the access token from the connect, then refreshes, persisting a rotated refresh token', async () => {
    const w = world();
    await w.connect();
    const first = await accessToken(w.vault, ref);
    expect(first).toMatch(/^fake-access\.microsoft\./);
    expect(await accessToken(w.vault, ref)).toBe(first);
    expect(w.oauth.calls.filter((c) => c.op === 'refresh')).toHaveLength(0);

    // The fake's tokens last 30 minutes: refreshed two minutes before they expire.
    w.clock.advance(28 * 60_000 + 1);
    const before = String(w.doc(TOKEN_PATH)?.['encryptedRefreshToken']);
    const second = await accessToken(w.vault, ref);
    expect(second).not.toBe(first);
    const after = String(w.doc(TOKEN_PATH)?.['encryptedRefreshToken']);
    expect(after).not.toBe(before);
    expect(w.doc(TOKEN_PATH)?.['refreshedAt']).toBeDefined();
    // The rotated token works for the next refresh (the old one is dead at the fake provider).
    clearAccessTokens();
    await expect(accessToken(w.vault, ref)).resolves.toMatch(/^fake-access\./);
  });

  it('shares one refresh between concurrent callers', async () => {
    const w = world();
    await w.connect();
    clearAccessTokens();
    const tokens = await Promise.all([accessToken(w.vault, ref), accessToken(w.vault, ref), accessToken(w.vault, ref)]);
    expect(new Set(tokens).size).toBe(1);
    expect(w.oauth.calls.filter((c) => c.op === 'refresh')).toHaveLength(1);
  });

  it('marks a revoked connection reconnect_required, tells the person once, and never retries', async () => {
    const w = world();
    await w.connect();
    clearAccessTokens();
    const token = await w.kms.decrypt(String(w.doc(TOKEN_PATH)?.['encryptedRefreshToken']), TOKEN_PATH);
    w.oauth.expire(token);

    const failed = await accessToken(w.vault, ref).catch((error: unknown) => error as { code: string });
    expect(failed).toMatchObject({ code: 'INTEGRATION_RECONNECT_REQUIRED' });
    expect(w.doc(TOKEN_PATH)).toMatchObject({ status: 'reconnect_required' });
    expect(w.doc(STATUS_PATH)).toMatchObject({ status: 'reconnect_required', reason: 'revoked' });
    const notices = w.docsUnder(`orgs/${ORG}/notifications/`);
    expect(notices).toEqual([
      expect.objectContaining({
        kind: 'integration_error',
        provider: 'microsoft',
        recipientUid: 'u-lawyer',
        title: 'Microsoft 365 needs reconnecting',
      }),
    ]);

    // Later calls fail fast without asking the provider again.
    const refreshes = w.oauth.calls.filter((c) => c.op === 'refresh').length;
    await expect(accessToken(w.vault, ref)).rejects.toMatchObject({ code: 'INTEGRATION_RECONNECT_REQUIRED' });
    expect(w.oauth.calls.filter((c) => c.op === 'refresh')).toHaveLength(refreshes);
    expect(w.docsUnder(`orgs/${ORG}/notifications/`)).toHaveLength(1);

    // Connecting again brings it back.
    await w.connect();
    await expect(accessToken(w.vault, ref)).resolves.toMatch(/^fake-access\./);
  });

  it('tells the practice’s owners and admins when its connection stops working', async () => {
    const w = world();
    // Connect the practice's Xero directly through the vault (its flag arrives with BILL-09).
    const { saveConnection } = await import('./vault');
    await saveConnection(w.vault, {
      provider: 'xero',
      uid: 'u-admin',
      tokens: { accessToken: 'fake-access.xero.1', refreshToken: 'fake-refresh.xero.1', expiresIn: 1800 },
    });
    expect(w.doc(integrationPath(ORG, 'xero'))).toMatchObject({ uid: null, level: 'org', connectedBy: 'u-admin' });
    clearAccessTokens();
    w.oauth.expire('fake-refresh.xero.1');
    await expect(accessToken(w.vault, { provider: 'xero', uid: null })).rejects.toMatchObject({
      code: 'INTEGRATION_RECONNECT_REQUIRED',
    });
    const recipients = w
      .docsUnder(`orgs/${ORG}/notifications/`)
      .map((n) => n['recipientUid'])
      .sort();
    expect(recipients).toEqual(['u-admin', 'u-owner']);
  });

  it('says a connection that was never made needs connecting', async () => {
    const w = world();
    await expect(accessToken(w.vault, ref)).rejects.toMatchObject({
      code: 'INTEGRATION_RECONNECT_REQUIRED',
      details: { reason: 'not_connected' },
    });
  });

  describe('authorizedFetch', () => {
    const reply = (status: number, headers: Record<string, string> = {}) =>
      new Response(status === 200 ? '{}' : null, { status, headers });

    it('sends the bearer token, and on a 401 refreshes once and retries', async () => {
      const w = world();
      await w.connect();
      const seen: string[] = [];
      const responses = [reply(401), reply(200)];
      const response = await authorizedFetch(
        w.vault,
        ref,
        'https://api.example.test/x',
        { method: 'GET' },
        {
          fetch: (async (_url: string, init: RequestInit) => {
            seen.push(new Headers(init.headers).get('authorization') ?? '');
            return responses.shift() ?? reply(500);
          }) as typeof fetch,
        },
      );
      expect(response.status).toBe(200);
      expect(seen).toHaveLength(2);
      expect(seen[0]).toMatch(/^Bearer fake-access\./);
      expect(seen[1]).not.toBe(seen[0]);
    });

    it('waits out a short Retry-After, and hands a long one back as RATE_LIMITED', async () => {
      const w = world();
      await w.connect();
      const waits: number[] = [];
      const responses = [reply(429, { 'retry-after': '2' }), reply(200)];
      const fetch = (async () => responses.shift() ?? reply(500)) as typeof globalThis.fetch;
      const sleep = async (ms: number) => void waits.push(ms);
      expect((await authorizedFetch(w.vault, ref, 'https://api.example.test/x', {}, { fetch, sleep })).status).toBe(
        200,
      );
      expect(waits).toEqual([2000]);

      const slow = (async () => reply(429, { 'retry-after': '60' })) as typeof globalThis.fetch;
      await expect(
        authorizedFetch(w.vault, ref, 'https://api.example.test/x', {}, { fetch: slow, sleep }),
      ).rejects.toMatchObject({ code: 'RATE_LIMITED', details: { provider: 'microsoft', retryAfterMs: 60_000 } });
    });
  });
});
