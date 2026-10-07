import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { HttpsError } from 'firebase-functions/v2/https';

import { can, PERMISSIONS, type ConnectorScope, type Role } from '@materia/domain';

import { authorizeDefinition, disconnectDefinition, setPracticeDefinition } from './callables';
import { revokeConnections, type TokenSet } from './grants';
import { handleConnectorRequest, type ConnectorRequest, type ConnectorResponse } from './http';
import { CallLimiter, MCP_PROTOCOL_VERSIONS } from './mcp';
import { connectionPath, grantsPath, newConnectorToken, parseConnectorToken, pkceMatches } from './tokens';
import { clearRetentionCache } from '../audit/retention';
import { runCallable, type CallableDefinition, type CallableDeps } from '../core/callable';
import { clearFlagCaches, setRemoteFlagLoader } from '../core/flags';
import { createLog } from '../core/log';
import { createDefinition as createNoteDefinition } from '../notes/create';
import { memoryFirestore } from '../orgs/testing';
import { FakeClock, fakePorts } from '../ports/fakes';

const ORG = 'org-claude';
const ORIGIN = 'https://materia-v2-dev.web.app';
const RESOURCE = `${ORIGIN}/mcp`;
const CLAUDE = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
const CLAUDE_CODE = 'https://claude.ai/oauth/claude-code-client-metadata';
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const FLAG = 'integrations.claudeConnector';
const ROLE_LIST = ['owner', 'admin', 'lawyer', 'paralegal', 'readonly'] as const;
const MATTER = `orgs/${ORG}/matters`;

/** Wed 7 October 2026, 12:00 in Melbourne: today is 2026-10-07 and the week ends Sunday the 11th. */
const NOW = new Date('2026-10-07T01:00:00Z');

const matter = (number: string, title: string, extra: Record<string, unknown> = {}) => ({
  number,
  title,
  type: 'probate',
  status: 'open',
  jurisdiction: 'VIC',
  responsibleUid: 'u-lawyer',
  teamUids: ['u-lawyer', 'u-paralegal'],
  clientContactIds: ['c-client'],
  privileged: false,
  deletedAt: null,
  openTaskCount: 1,
  wipCents: 125_000,
  outstandingCents: 0,
  search: [number.toLowerCase().replace(/-/g, ''), ...title.toLowerCase().split(/\s+/)],
  lastActivityAt: new Date('2026-10-06T00:00:00Z'),
  createdAt: new Date('2026-09-01T00:00:00Z'),
  ...extra,
});

function world(
  options: { practice?: Record<string, unknown> | null; flag?: boolean; security?: Record<string, unknown> } = {},
) {
  const practice = options.practice === undefined ? { enabled: true, allowProposals: true } : options.practice;
  // Flag overrides are cached per org id, which every world shares.
  clearFlagCaches();
  const store = memoryFirestore({
    [`orgs/${ORG}`]: {
      name: 'Harbour & Vine Legal (Fictional)',
      timezone: 'Australia/Melbourne',
      retentionYears: 7,
      flags: { [FLAG]: options.flag ?? true, 'clerk.features.suggestions': true },
      ...(practice ? { settings: { connector: practice } } : {}),
      ...(options.security ? { security: options.security } : {}),
    },
    ...Object.fromEntries(
      ROLE_LIST.map((role) => [
        `orgs/${ORG}/members/u-${role}`,
        { role, status: 'active', displayName: `Fictional ${role[0]?.toUpperCase()}${role.slice(1)}` },
      ]),
    ),
    [`orgs/${ORG}/contacts/c-client`]: { kind: 'person', givenNames: 'Iris', familyName: 'Fictional' },
    [`orgs/${ORG}/contacts/c-deceased`]: { kind: 'person', givenNames: 'Ada', familyName: 'Fictional' },
    [`${MATTER}/m-ada`]: matter('M-2026-0001', 'Estate of Ada Fictional', {
      deceased: { contactId: 'c-deceased', dateOfDeath: '2026-08-20', domicile: 'VIC', lastAddress: '1 Fictional St' },
      facts: { willDate: '2019-05-01' },
      nextDeadline: { id: 'd-soon', dueDate: '2026-10-09', title: 'Advertise for creditors', critical: false },
    }),
    [`${MATTER}/m-secret`]: matter('M-2026-0002', 'Estate of Secret Fictional', { privileged: true }),
    [`${MATTER}/m-closed`]: matter('M-2026-0003', 'Will for Closed Fictional', { status: 'closed', type: 'will' }),
    [`${MATTER}/m-gone`]: matter('M-2026-0004', 'Estate of Gone Fictional', { deletedAt: new Date('2026-09-02') }),
    [`${MATTER}/m-ada/deadlines/d-soon`]: {
      orgId: ORG,
      matterId: 'm-ada',
      title: 'Advertise for creditors',
      dueDate: '2026-10-09',
      kind: 'statutory',
      critical: false,
      status: 'upcoming',
      assigneeUid: 'u-lawyer',
      privileged: false,
      computed: { citation: 'Administration and Probate Act 1958 (Vic) s 33' },
    },
    [`${MATTER}/m-ada/deadlines/d-late`]: {
      orgId: ORG,
      matterId: 'm-ada',
      title: 'File inventory',
      dueDate: '2026-10-01',
      kind: 'internal',
      critical: true,
      status: 'upcoming',
      assigneeUid: 'u-lawyer',
      privileged: false,
    },
    [`${MATTER}/m-secret/deadlines/d-secret`]: {
      orgId: ORG,
      matterId: 'm-secret',
      title: 'Secret deadline',
      dueDate: '2026-10-08',
      kind: 'internal',
      critical: false,
      status: 'upcoming',
      assigneeUid: 'u-lawyer',
      privileged: true,
    },
    [`${MATTER}/m-ada/tasks/t-1`]: {
      orgId: ORG,
      matterId: 'm-ada',
      title: 'Order death certificate',
      status: 'todo',
      priority: 'high',
      dueDate: '2026-10-08',
      assigneeUid: 'u-lawyer',
    },
    [`${MATTER}/m-secret/tasks/t-secret`]: {
      orgId: ORG,
      matterId: 'm-secret',
      title: 'Secret task',
      status: 'todo',
      priority: 'none',
      dueDate: '2026-10-08',
      assigneeUid: 'u-lawyer',
    },
    [`orgs/${ORG}/members/u-lawyer/tasks/p-1`]: {
      orgId: ORG,
      matterId: null,
      title: 'Renew practising certificate',
      status: 'todo',
      priority: 'none',
      dueDate: '2026-10-10',
      assigneeUid: 'u-lawyer',
    },
    [`${MATTER}/m-ada/timeEntries/te-1`]: {
      orgId: ORG,
      matterId: 'm-ada',
      uid: 'u-lawyer',
      date: '2026-10-06',
      minutes: 90,
      amountCents: 45_000,
      billable: true,
      status: 'draft',
      narrative: 'Fictional work',
    },
    [`${MATTER}/m-secret/timeEntries/te-secret`]: {
      orgId: ORG,
      matterId: 'm-secret',
      uid: 'u-lawyer',
      date: '2026-10-06',
      minutes: 30,
      amountCents: 15_000,
      billable: true,
      status: 'draft',
      narrative: 'Secret work',
    },
  });
  const clock = new FakeClock(NOW);
  const ports = fakePorts({ clock });
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
  const token = (extra: Record<string, unknown> = {}) => ({
    orgId: ORG,
    auth_time: Math.floor(clock.now().getTime() / 1000),
    ...extra,
  });
  const call = <O>(def: unknown, data: Record<string, unknown>, role: Role = 'lawyer', extra = {}) =>
    runCallable(
      def as CallableDefinition<never, O>,
      { data: { requestId: randomUUID(), ...data }, auth: { uid: `u-${role}`, token: { ...token(extra), role } } },
      deps,
    );
  const limiter = new CallLimiter();
  const http = (req: Partial<ConnectorRequest>): Promise<ConnectorResponse> =>
    handleConnectorRequest(
      { method: 'POST', path: '/mcp', headers: {}, body: {}, ...req },
      { db: store.db, clock, log: createLog({ fn: 'test' }, () => undefined), origin: ORIGIN, limiter },
    );

  const pkce = () => {
    const verifier = randomBytes(32).toString('base64url');
    return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
  };
  /** Allows Claude on the consent page: the redirect back to Claude, with the code. */
  async function authorize(role: Role = 'lawyer', overrides: Record<string, unknown> = {}, extra = {}) {
    const { verifier, challenge } = pkce();
    const result = await call<{ redirectUrl: string; connectionId: string }>(
      authorizeDefinition,
      {
        clientId: CLAUDE,
        redirectUri: CALLBACK,
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        scopes: ['materia.read', 'materia.propose'] satisfies ConnectorScope[],
        state: 'state-1',
        resource: RESOURCE,
        ...overrides,
      },
      role,
      extra,
    );
    const url = new URL(result.redirectUrl);
    return { url, code: url.searchParams.get('code') ?? '', verifier, connectionId: result.connectionId };
  }
  const exchange = (code: string, verifier: string, overrides: Record<string, unknown> = {}) =>
    http({
      path: '/oauth/token',
      body: {
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: CLAUDE,
        redirect_uri: CALLBACK,
        resource: RESOURCE,
        ...overrides,
      },
    });
  /** The whole flow: consent, then the token exchange. */
  async function connect(role: Role = 'lawyer', overrides: Record<string, unknown> = {}, extra = {}) {
    const consent = await authorize(role, overrides, extra);
    const response = await exchange(consent.code, consent.verifier);
    expect(response.status).toBe(200);
    return { ...consent, tokens: response.body as TokenSet };
  }
  const refresh = (refreshToken: string, overrides: Record<string, unknown> = {}) =>
    http({
      path: '/oauth/token',
      body: { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLAUDE, ...overrides },
    });
  let id = 0;
  const rpc = (accessToken: string, method: string, params?: Record<string, unknown>, headers = {}) =>
    http({
      headers: { authorization: `Bearer ${accessToken}`, ...headers },
      body: { jsonrpc: '2.0', id: ++id, method, ...(params ? { params } : {}) },
    });
  const result = async (accessToken: string, method: string, params?: Record<string, unknown>) =>
    ((await rpc(accessToken, method, params)).body as { result: Record<string, unknown> }).result;
  /** A tool's result: its structured content, or its error text. */
  async function tool(accessToken: string, name: string, args: Record<string, unknown> = {}) {
    const out = (await result(accessToken, 'tools/call', { name, arguments: args })) as {
      content: { text: string }[];
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
    };
    return out.isError ? { error: out.content[0]?.text ?? '' } : (out.structuredContent ?? {});
  }
  const doc = (path: string) => store.docs.get(path);
  const docsUnder = (prefix: string) => [...store.docs.entries()].filter(([path]) => path.startsWith(prefix));
  const audits = () =>
    docsUnder(`orgs/${ORG}/audit/`)
      .map(([, data]) => data)
      .filter((entry) => String(entry['action']).startsWith('connector.'));
  return { store, clock, call, http, authorize, exchange, connect, refresh, rpc, result, tool, doc, docsUnder, audits };
}

const errorOf = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('expected a failure');
    },
    (error: unknown) => error as HttpsError & { details?: { code?: string; error?: string } },
  );

beforeEach(() => {
  clearRetentionCache();
  clearFlagCaches();
  setRemoteFlagLoader(async () => ({}));
});

afterAll(() => setRemoteFlagLoader());

describe('tokens', () => {
  it('round-trips the kind and org, and keeps only the hash as the id', () => {
    const token = newConnectorToken('access', ORG);
    expect(token).toMatch(/^mta\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    const parsed = parseConnectorToken(token);
    expect(parsed).toEqual({ kind: 'access', orgId: ORG, hash: createHash('sha256').update(token).digest('hex') });
    expect(parseConnectorToken(token, 'refresh')).toBeNull();
  });

  it('refuses anything malformed', () => {
    const secret = 'a'.repeat(43);
    const org = Buffer.from(ORG).toString('base64url');
    for (const bad of [
      undefined,
      '',
      'mta',
      `mtx.${org}.${secret}`,
      `mta.${org}.short`,
      `mta.${org}.${secret}.extra`,
      `mta.${Buffer.from('a/b').toString('base64url')}.${secret}`,
      `mta.${org}=.${secret}`,
      `mta.${org}.${secret}`.padEnd(500, 'x'),
    ]) {
      expect(parseConnectorToken(bad), String(bad)).toBeNull();
    }
  });

  it('checks a PKCE verifier against its S256 challenge', () => {
    const verifier = 'v'.repeat(43);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    expect(pkceMatches(verifier, challenge)).toBe(true);
    expect(pkceMatches('w'.repeat(43), challenge)).toBe(false);
    expect(pkceMatches('short', challenge)).toBe(false);
    expect(pkceMatches(verifier, undefined)).toBe(false);
  });
});

describe('discovery', () => {
  it('publishes the protected resource metadata, at the root and for /mcp', async () => {
    const w = world();
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const response = await w.http({ method: 'GET', path });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        resource: RESOURCE,
        authorization_servers: [ORIGIN],
        scopes_supported: ['materia.read', 'materia.propose'],
        bearer_methods_supported: ['header'],
      });
    }
  });

  it('publishes authorization server metadata for public clients with PKCE and client ID metadata documents', async () => {
    const response = await world().http({ method: 'GET', path: '/.well-known/oauth-authorization-server' });
    expect(response.body).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/connect/claude`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      revocation_endpoint: `${ORIGIN}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
    expect(response.body).not.toHaveProperty('registration_endpoint');
  });

  it('answers an MCP request without a token with 401 and where to find the metadata', async () => {
    const w = world();
    const response = await w.http({ body: { jsonrpc: '2.0', id: 1, method: 'initialize' } });
    expect(response.status).toBe(401);
    expect(response.headers['WWW-Authenticate']).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp", scope="materia.read materia.propose"`,
    );
    const bad = await w.http({ headers: { authorization: 'Bearer nonsense' }, body: {} });
    expect(bad.status).toBe(401);
    expect(bad.headers['WWW-Authenticate']).toContain('error="invalid_token"');
  });

  it('answers unknown paths with 404 and only POST on /mcp', async () => {
    const w = world();
    expect((await w.http({ path: '/oauth/other' })).status).toBe(404);
    const get = await w.http({ method: 'GET' });
    expect(get.status).toBe(405);
    expect(get.headers['Allow']).toBe('POST');
  });
});

describe('connector-authorize (the consent page)', () => {
  it('records the connection under the sign-in it was allowed with and sends Claude a one-use code', async () => {
    const w = world();
    const { url, code, connectionId } = await w.authorize();
    expect(url.origin + url.pathname).toBe(CALLBACK);
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('iss')).toBe(ORIGIN);
    expect(parseConnectorToken(code, 'code')?.orgId).toBe(ORG);
    expect(w.doc(connectionPath(ORG, connectionId))).toMatchObject({
      uid: 'u-lawyer',
      clientId: CLAUDE,
      clientName: 'Claude',
      scopes: ['materia.read', 'materia.propose'],
      status: 'active',
      secondFactor: false,
    });
    // Only hashes are stored: the code itself is nowhere in the database.
    expect(JSON.stringify([...w.store.docs.values()])).not.toContain(code);
    expect(w.audits()).toEqual([
      expect.objectContaining({ action: 'connector.connected', summary: 'Claude connected' }),
    ]);
  });

  it('accepts Claude Code on any loopback port', async () => {
    const w = world();
    const { url } = await w.authorize('paralegal', {
      clientId: CLAUDE_CODE,
      redirectUri: 'http://localhost:53682/callback',
    });
    expect(url.host).toBe('localhost:53682');
  });

  it('refuses an unknown client, a foreign redirect or another resource', async () => {
    const w = world();
    for (const overrides of [
      { clientId: 'https://evil.example/client' },
      { redirectUri: 'https://evil.example/callback' },
      { resource: 'https://evil.example/mcp' },
    ]) {
      const error = await errorOf(w.authorize('lawyer', overrides));
      expect(error.details?.code).toBe('CONNECTOR_REQUEST_INVALID');
    }
  });

  it('needs the flag, the practice’s switch and a recent sign-in', async () => {
    expect((await errorOf(world({ flag: false }).authorize())).details?.code).toBe('FEATURE_DISABLED');
    expect((await errorOf(world({ practice: null }).authorize())).details?.code).toBe('CONNECTOR_OFF');
    expect(
      (await errorOf(world({ practice: { enabled: false, allowProposals: true } }).authorize())).details?.code,
    ).toBe('CONNECTOR_OFF');
    const w = world();
    const stale = { auth_time: Math.floor(NOW.getTime() / 1000) - 3600 };
    expect((await errorOf(w.authorize('lawyer', {}, stale))).details?.code).toBe('REAUTH_REQUIRED');
  });
});

describe('the token endpoint', () => {
  it('exchanges a code once, with its verifier, for an hour’s access and a refresh token', async () => {
    const w = world();
    const { code, verifier } = await w.authorize();
    const response = await w.exchange(code, verifier);
    expect(response.status).toBe(200);
    expect(response.headers['Cache-Control']).toBe('no-store');
    expect(response.body).toMatchObject({
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'materia.read materia.propose',
    });
    const tokens = response.body as TokenSet;
    expect(parseConnectorToken(tokens.access_token, 'access')).not.toBeNull();
    expect(parseConnectorToken(tokens.refresh_token, 'refresh')).not.toBeNull();
    expect(JSON.stringify([...w.store.docs.values()])).not.toContain(tokens.access_token);
  });

  it('refuses a wrong verifier, redirect, client or resource, and an expired code', async () => {
    const w = world();
    const cases: [Record<string, unknown>, number, string][] = [
      [{ code_verifier: 'x'.repeat(43) }, 400, 'invalid_grant'],
      [{ redirect_uri: 'https://claude.com/api/mcp/auth_callback' }, 400, 'invalid_grant'],
      [{ client_id: CLAUDE_CODE }, 400, 'invalid_grant'],
      [{ client_id: 'https://evil.example/client' }, 401, 'invalid_client'],
      [{ resource: 'https://evil.example/mcp' }, 400, 'invalid_target'],
      [{ grant_type: 'password' }, 400, 'unsupported_grant_type'],
    ];
    for (const [overrides, status, error] of cases) {
      const { code, verifier } = await w.authorize();
      const response = await w.exchange(code, verifier, overrides);
      expect([response.status, (response.body as { error: string }).error], JSON.stringify(overrides)).toEqual([
        status,
        error,
      ]);
    }
    const { code, verifier } = await w.authorize();
    w.clock.advance(5 * 60_000 + 1);
    expect((await w.exchange(code, verifier)).body).toMatchObject({ error: 'invalid_grant' });
  });

  it('treats a code used twice as stolen: refused, and its connection ended', async () => {
    const w = world();
    const { code, verifier, connectionId } = await w.authorize();
    const first = await w.exchange(code, verifier);
    expect(first.status).toBe(200);
    expect((await w.exchange(code, verifier)).body).toMatchObject({ error: 'invalid_grant' });
    expect(w.doc(connectionPath(ORG, connectionId))).toMatchObject({
      status: 'revoked',
      revokeReason: 'refresh_reuse',
    });
    const access = (first.body as TokenSet).access_token;
    expect((await w.rpc(access, 'ping')).status).toBe(401);
  });

  it('rotates refresh tokens, and ends the connection when a used one comes back', async () => {
    const w = world();
    const { tokens, connectionId } = await w.connect();
    const next = await w.refresh(tokens.refresh_token);
    expect(next.status).toBe(200);
    const rotated = next.body as TokenSet;
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
    expect((await w.rpc(rotated.access_token, 'ping')).status).toBe(200);
    // A refresh may narrow the scopes, never widen them.
    const narrowed = await w.refresh(rotated.refresh_token, { scope: 'materia.read' });
    expect(narrowed.body).toMatchObject({ scope: 'materia.read' });
    expect(
      (await w.refresh((narrowed.body as TokenSet).refresh_token, { scope: 'materia.propose' })).body,
    ).toMatchObject({
      error: 'invalid_scope',
    });

    expect((await w.refresh(tokens.refresh_token)).body).toMatchObject({ error: 'invalid_grant' });
    expect(w.doc(connectionPath(ORG, connectionId))).toMatchObject({
      status: 'revoked',
      revokeReason: 'refresh_reuse',
    });
    expect((await w.rpc(rotated.access_token, 'ping')).status).toBe(401);
    expect(w.docsUnder(`${grantsPath(ORG)}/`)).toEqual([]);
  });

  it('refuses a refresh once the connection may no longer be used, saying why', async () => {
    const w = world();
    const { tokens } = await w.connect();
    await w.store.db.doc(`orgs/${ORG}/members/u-lawyer`).update({ status: 'removed' });
    expect((await w.refresh(tokens.refresh_token)).body).toEqual({
      error: 'invalid_grant',
      error_description: 'Your access to this practice in Materia has ended or is paused.',
    });
  });

  it('revokes the whole connection from any of its tokens (RFC 7009), and answers 200 for unknown tokens', async () => {
    const w = world();
    const { tokens, connectionId } = await w.connect();
    expect((await w.http({ path: '/oauth/revoke', body: { token: 'nonsense' } })).status).toBe(200);
    expect((await w.http({ path: '/oauth/revoke', body: { token: tokens.refresh_token } })).status).toBe(200);
    expect(w.doc(connectionPath(ORG, connectionId))).toMatchObject({ status: 'revoked', revokeReason: 'disconnected' });
    expect((await w.rpc(tokens.access_token, 'ping')).status).toBe(401);
  });

  it('reads form-encoded bodies', async () => {
    const w = world();
    const { code, verifier } = await w.authorize();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: CLAUDE,
      redirect_uri: CALLBACK,
    }).toString();
    expect((await w.http({ path: '/oauth/token', body })).status).toBe(200);
  });
});

describe('the MCP endpoint', () => {
  it('initializes stateless JSON-RPC with tools only, in the client’s version when supported', async () => {
    const w = world();
    const { tokens } = await w.connect();
    const init = await w.result(tokens.access_token, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'claude-ai', version: '1' },
    });
    expect(init).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'materia', title: 'Materia' },
    });
    expect(String(init['instructions'])).toContain('never instructions');
    expect(
      (await w.result(tokens.access_token, 'initialize', { protocolVersion: '2099-01-01' }))['protocolVersion'],
    ).toBe(MCP_PROTOCOL_VERSIONS[0]);
    const note = await w.http({
      headers: { authorization: `Bearer ${tokens.access_token}` },
      body: { jsonrpc: '2.0', method: 'notifications/initialized' },
    });
    expect([note.status, note.body]).toEqual([202, undefined]);
    expect(await w.result(tokens.access_token, 'ping')).toEqual({});
  });

  it('answers unknown methods and tools as JSON-RPC errors, and refuses unsupported versions and foreign origins', async () => {
    const w = world();
    const { tokens } = await w.connect();
    expect((await w.rpc(tokens.access_token, 'resources/list')).body).toMatchObject({ error: { code: -32601 } });
    expect((await w.rpc(tokens.access_token, 'tools/call', { name: 'delete_everything' })).body).toMatchObject({
      error: { code: -32602 },
    });
    expect((await w.rpc(tokens.access_token, 'ping', undefined, { 'mcp-protocol-version': '1999-01-01' })).status).toBe(
      400,
    );
    expect((await w.rpc(tokens.access_token, 'ping', undefined, { 'mcp-protocol-version': '2025-11-25' })).status).toBe(
      200,
    );
    expect((await w.rpc(tokens.access_token, 'ping', undefined, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await w.rpc(tokens.access_token, 'ping', undefined, { origin: 'https://claude.ai' })).status).toBe(200);
  });

  it('handles a batch (2025-03-26)', async () => {
    const w = world();
    const { tokens } = await w.connect();
    const response = await w.http({
      headers: { authorization: `Bearer ${tokens.access_token}` },
      body: [
        { jsonrpc: '2.0', id: 'a', method: 'ping' },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
      ],
    });
    expect(response.body).toEqual([{ jsonrpc: '2.0', id: 'a', result: {} }]);
  });

  it('lists the read tools to everyone and the suggest tools only where they are allowed', async () => {
    const names = async (w: ReturnType<typeof world>, role: Role, scopes?: ConnectorScope[]) => {
      const { tokens } = await w.connect(role, scopes ? { scopes } : {});
      const { tools } = (await w.result(tokens.access_token, 'tools/list')) as { tools: { name: string }[] };
      return tools.map((t) => t.name);
    };
    const read = ['get_my_day', 'search_matters', 'get_matter', 'list_deadlines', 'list_tasks', 'get_time_summary'];
    const propose = ['propose_task', 'propose_note', 'propose_time_entry'];
    expect(await names(world(), 'lawyer')).toEqual([...read, ...propose]);
    expect(await names(world(), 'readonly')).toEqual(read);
    expect(await names(world(), 'paralegal', ['materia.read'])).toEqual(read);
    expect(await names(world({ practice: { enabled: true, allowProposals: false } }), 'lawyer')).toEqual(read);

    const w = world();
    const { tokens } = await w.connect();
    const { tools } = (await w.result(tokens.access_token, 'tools/list')) as {
      tools: { name: string; inputSchema: Record<string, unknown>; annotations: Record<string, unknown> }[];
    };
    const search = tools.find((t) => t.name === 'search_matters');
    expect(search?.inputSchema).toMatchObject({ type: 'object' });
    expect(search?.inputSchema).not.toHaveProperty('$schema');
    expect(search?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    expect(tools.find((t) => t.name === 'propose_task')?.annotations).toMatchObject({ readOnlyHint: false });
  });

  it('limits calls per connection', () => {
    const limiter = new CallLimiter(2, 60_000);
    expect([limiter.take('c', 0), limiter.take('c', 1), limiter.take('c', 2)]).toEqual([true, true, false]);
    expect(limiter.take('other', 2)).toBe(true);
    expect(limiter.take('c', 60_001)).toBe(true);
  });
});

describe('access ends with the person’s access to Materia', () => {
  const denied = async (w: ReturnType<typeof world>, accessToken: string) => {
    const response = await w.rpc(accessToken, 'ping');
    return [response.status, (response.body as { error_description?: string }).error_description];
  };

  it('when the member is suspended or removed', async () => {
    const w = world();
    const { tokens } = await w.connect();
    await w.store.db.doc(`orgs/${ORG}/members/u-lawyer`).update({ status: 'suspended' });
    expect((await denied(w, tokens.access_token))[0]).toBe(401);
  });

  it('when they are signed out everywhere, or their sign-in outlives the practice’s session length', async () => {
    const w = world();
    const { tokens } = await w.connect();
    w.clock.advance(60_000);
    await w.store.db.doc(`orgs/${ORG}/members/u-lawyer`).update({ sessionsValidAfter: w.clock.now() });
    expect(await denied(w, tokens.access_token)).toEqual([
      401,
      'You were signed out of Materia everywhere. Connect Claude to Materia again.',
    ]);

    const v = world();
    const second = await v.connect();
    v.clock.advance(14 * 86_400_000 + 1);
    expect((await denied(v, second.tokens.access_token))[0]).toBe(401);
    expect((await v.refresh(second.tokens.refresh_token)).body).toMatchObject({ error: 'invalid_grant' });
  });

  it('when the practice requires a second factor the sign-in didn’t use', async () => {
    const enforced = {
      mfaRequired: true,
      mfaRequiredSince: new Date('2026-01-01'),
      mfaEnforceAfter: new Date('2026-01-02'),
    };
    const w = world({ security: enforced });
    const withMfa = await w.connect('lawyer', {}, { firebase: { sign_in_second_factor: 'phone' } });
    expect((await w.rpc(withMfa.tokens.access_token, 'ping')).status).toBe(200);
    const id = withMfa.connectionId;
    await w.store.db.doc(connectionPath(ORG, id)).update({ secondFactor: false });
    expect((await w.rpc(withMfa.tokens.access_token, 'ping')).status).toBe(401);
  });

  it('when the flag goes off', async () => {
    const w = world();
    const { tokens } = await w.connect();
    // The flag's key has dots, so the whole map is replaced rather than a dotted path.
    await w.store.db.doc(`orgs/${ORG}`).update({ flags: { [FLAG]: false, 'clerk.features.suggestions': true } });
    clearFlagCaches();
    expect((await w.rpc(tokens.access_token, 'ping')).status).toBe(401);
  });

  it('when the practice turns the connector off: every connection ends, and turning it on again needs reconnecting', async () => {
    const w = world();
    const lawyer = await w.connect('lawyer');
    const paralegal = await w.connect('paralegal');
    expect(
      (await errorOf(w.call(setPracticeDefinition, { enabled: false, allowProposals: true }, 'lawyer'))).details?.code,
    ).toBe('PERMISSION_DENIED');
    const off = await w.call<{ revoked: number }>(
      setPracticeDefinition,
      { enabled: false, allowProposals: true },
      'admin',
    );
    expect(off).toEqual({ enabled: false, allowProposals: true, revoked: 2 });
    expect(w.doc(`orgs/${ORG}`)?.['settings']).toMatchObject({ connector: { enabled: false, updatedBy: 'u-admin' } });
    await w.call(setPracticeDefinition, { enabled: true, allowProposals: true }, 'owner');
    expect((await w.rpc(lawyer.tokens.access_token, 'ping')).status).toBe(401);
    expect((await w.rpc(paralegal.tokens.access_token, 'ping')).status).toBe(401);
    expect(w.audits().map((entry) => entry['action'])).toEqual(
      expect.arrayContaining(['connector.practice_disabled', 'connector.practice_enabled']),
    );
  });

  it('when the member leaves: their connections end', async () => {
    const w = world();
    const lawyer = await w.connect('lawyer');
    const paralegal = await w.connect('paralegal');
    const ended = await revokeConnections(
      { db: w.store.db, clock: w.clock },
      ORG,
      { uid: 'u-lawyer' },
      {
        actor: 'system',
        reason: 'member_removed',
      },
    );
    expect(ended).toBe(1);
    expect(w.doc(connectionPath(ORG, lawyer.connectionId))).toMatchObject({
      status: 'revoked',
      revokeReason: 'member_removed',
    });
    expect(w.doc(connectionPath(ORG, paralegal.connectionId))).toMatchObject({ status: 'active' });
  });
});

describe('connector-disconnect', () => {
  it('ends a person’s own connection at once, and anyone’s for owners and admins', async () => {
    const w = world();
    const mine = await w.connect('lawyer');
    const theirs = await w.connect('paralegal');
    expect(
      (await errorOf(w.call(disconnectDefinition, { connectionId: theirs.connectionId }, 'lawyer'))).details?.code,
    ).toBe('NOT_FOUND');
    expect(await w.call(disconnectDefinition, { connectionId: mine.connectionId }, 'lawyer')).toEqual({
      revoked: true,
    });
    expect((await w.rpc(mine.tokens.access_token, 'ping')).status).toBe(401);
    expect(await w.call(disconnectDefinition, { connectionId: mine.connectionId }, 'lawyer')).toEqual({
      revoked: false,
    });
    expect(await w.call(disconnectDefinition, { connectionId: theirs.connectionId }, 'admin')).toEqual({
      revoked: true,
    });
    expect(w.doc(connectionPath(ORG, theirs.connectionId))).toMatchObject({
      revokedBy: 'u-admin',
      revokeReason: 'disconnected',
    });
    expect(w.audits().filter((entry) => entry['action'] === 'connector.disconnected')).toHaveLength(2);
  });
});

describe('the read tools', () => {
  it('finds matters by name or number, never privileged or deleted ones', async () => {
    const w = world();
    const { tokens } = await w.connect();
    const byName = (await w.tool(tokens.access_token, 'search_matters', { query: 'estate' })) as {
      matters: { number: string; title: string; type: string; status: string; responsible: string; link: string }[];
    };
    expect(byName.matters.map((m) => m.number)).toEqual(['M-2026-0001']);
    expect(byName.matters[0]).toMatchObject({
      title: 'Estate of Ada Fictional',
      type: 'Probate',
      status: 'Open',
      responsible: 'Fictional Lawyer',
      link: `${ORIGIN}/matters/m-ada/overview`,
    });
    const byNumber = (await w.tool(tokens.access_token, 'search_matters', { query: 'M-2026-0001' })) as {
      matters: { number: string }[];
    };
    expect(byNumber.matters.map((m) => m.number)).toEqual(['M-2026-0001']);
    // Without a query: active matters (the closed one only when asked for).
    const listed = (await w.tool(tokens.access_token, 'search_matters', {})) as { matters: { number: string }[] };
    expect(listed.matters.map((m) => m.number)).toEqual(['M-2026-0001']);
    const closed = (await w.tool(tokens.access_token, 'search_matters', { status: 'closed' })) as {
      matters: { number: string }[];
    };
    expect(closed.matters.map((m) => m.number)).toEqual(['M-2026-0003']);
    expect(await w.tool(tokens.access_token, 'search_matters', { query: 'x' })).toEqual({
      error: 'Search with at least two letters or digits.',
    });
  });

  it('summarises a matter, with billing figures only for roles that see billing', async () => {
    const w = world();
    const lawyer = await w.connect('lawyer');
    const summary = await w.tool(lawyer.tokens.access_token, 'get_matter', { matter: 'M-2026-0001' });
    expect(summary).toMatchObject({
      id: 'm-ada',
      number: 'M-2026-0001',
      status: 'Open',
      responsible: 'Fictional Lawyer',
      team: ['Fictional Paralegal'],
      clients: ['Iris Fictional'],
      deceased: { name: 'Ada Fictional', dateOfDeath: '2026-08-20' },
      keyFacts: { willDate: '2019-05-01' },
      nextDeadline: { title: 'Advertise for creditors', dueDate: '2026-10-09' },
      wip: '$1,250.00',
    });
    const paralegal = await w.connect('paralegal');
    const limited = await w.tool(paralegal.tokens.access_token, 'get_matter', { matter: 'm-ada' });
    expect(limited).not.toHaveProperty('wip');
    expect(limited).toMatchObject({ number: 'M-2026-0001' });
  });

  it('refuses a privileged matter, which doesn’t exist to roles that can’t see privileged matters', async () => {
    const w = world();
    const lawyer = await w.connect('lawyer');
    expect(await w.tool(lawyer.tokens.access_token, 'get_matter', { matter: 'M-2026-0002' })).toEqual({
      error: 'That matter is privileged, so Materia doesn’t share it with Claude. Open it in Materia.',
    });
    const paralegal = await w.connect('paralegal');
    expect(await w.tool(paralegal.tokens.access_token, 'get_matter', { matter: 'm-secret' })).toEqual({
      error: 'No matter matches “m-secret”. Use search_matters to find it.',
    });
    expect(await w.tool(lawyer.tokens.access_token, 'list_tasks', { matter: 'm-gone' })).toMatchObject({
      error: expect.stringContaining('No matter matches'),
    });
  });

  it('gives the person’s day: overdue and this week’s deadlines and tasks, without privileged matters', async () => {
    const w = world();
    const { tokens } = await w.connect();
    const day = (await w.tool(tokens.access_token, 'get_my_day')) as Record<string, { title: string }[]> & {
      today: string;
      weekEnds: string;
    };
    expect([day.today, day.weekEnds]).toEqual(['2026-10-07', '2026-10-11']);
    expect(day['overdueDeadlines']?.map((d) => d.title)).toEqual(['File inventory']);
    expect(day['deadlinesThisWeek']?.map((d) => d.title)).toEqual(['Advertise for creditors']);
    expect(day['tasksThisWeek']?.map((t) => t.title)).toEqual([
      'Order death certificate',
      'Renew practising certificate',
    ]);
    expect(JSON.stringify(day)).not.toContain('Secret');
    expect(day['overdueDeadlines']?.[0]).toMatchObject({ overdue: true, critical: true });
  });

  it('lists deadlines and tasks on a matter or the person’s own', async () => {
    const w = world();
    const { tokens } = await w.connect();
    const deadlines = (await w.tool(tokens.access_token, 'list_deadlines', { matter: 'M-2026-0001' })) as {
      deadlines: { title: string; rule?: string; assignee?: string }[];
    };
    expect(deadlines.deadlines.map((d) => d.title)).toEqual(['File inventory', 'Advertise for creditors']);
    expect(deadlines.deadlines[1]).toMatchObject({
      rule: 'Administration and Probate Act 1958 (Vic) s 33',
      assignee: 'Fictional Lawyer',
    });
    const mine = (await w.tool(tokens.access_token, 'list_deadlines', {})) as { deadlines: { title: string }[] };
    expect(mine.deadlines.map((d) => d.title)).toEqual(['File inventory', 'Advertise for creditors']);
    const tasks = (await w.tool(tokens.access_token, 'list_tasks', {})) as {
      tasks: { title: string; matter: unknown; link: string }[];
    };
    expect(tasks.tasks.map((t) => t.title)).toEqual(['Order death certificate', 'Renew practising certificate']);
    expect(tasks.tasks[1]).toMatchObject({ matter: null, link: `${ORIGIN}/tasks` });
  });

  it('summarises the person’s time, leaving out privileged matters, with amounts only for billing roles', async () => {
    const w = world();
    const { tokens } = await w.connect();
    const mine = await w.tool(tokens.access_token, 'get_time_summary', {});
    expect(mine).toMatchObject({
      from: '2026-10-01',
      to: '2026-10-07',
      entries: 1,
      totalMinutes: 90,
      billableMinutes: 90,
      amount: '$450.00',
      byMatter: [{ matter: { number: 'M-2026-0001' }, minutes: 90 }],
    });
    const paralegal = await w.connect('paralegal');
    const matterTime = await w.tool(paralegal.tokens.access_token, 'get_time_summary', { matter: 'M-2026-0001' });
    expect(matterTime).toMatchObject({ totalMinutes: 90, whose: 'everyone on the matter' });
    expect(matterTime).not.toHaveProperty('amount');
  });

  it('records every call in the audit log, without its content', async () => {
    const w = world();
    const { tokens } = await w.connect();
    await w.tool(tokens.access_token, 'get_matter', { matter: 'M-2026-0001' });
    const used = w.audits().filter((entry) => entry['action'] === 'connector.tool_used');
    expect(used).toEqual([
      expect.objectContaining({
        summary: 'Claude used “Matter summary”',
        actor: { uid: 'u-lawyer' },
        data: { tool: 'get_matter', matterId: 'm-ada', records: 1 },
      }),
    ]);
    expect(JSON.stringify(used)).not.toContain('Ada');
  });
});

describe('the suggest tools', () => {
  it('create a suggestion on the matter, from the person, that waits for someone to accept it', async () => {
    const w = world();
    const { tokens } = await w.connect();
    const out = await w.tool(tokens.access_token, 'propose_task', {
      matter: 'M-2026-0001',
      title: 'Call the bank about the estate account',
      dueDate: '2026-10-09',
      reason: 'Asked for after the client call',
    });
    expect(out).toMatchObject({
      status: 'suggested',
      matter: { number: 'M-2026-0001' },
      link: `${ORIGIN}/matters/m-ada/overview`,
    });
    const [path, suggestion] = w.docsUnder(`${MATTER}/m-ada/suggestions/`)[0] ?? [];
    expect(path).toBeDefined();
    expect(suggestion).toMatchObject({
      kind: 'task',
      status: 'proposed',
      payload: { title: 'Call the bank about the estate account', dueDate: '2026-10-09' },
      rationale: 'Asked for after the client call',
      promptId: 'connector.claude',
      createdBy: 'u-lawyer',
      requestedBy: { uid: 'u-lawyer', name: 'Fictional Lawyer' },
      privileged: false,
    });
    // Nothing else changed: no task was created.
    expect(w.docsUnder(`${MATTER}/m-ada/tasks/`)).toHaveLength(1);

    expect(
      await w.tool(tokens.access_token, 'propose_task', {
        matter: 'M-2026-0001',
        title: 'Call the bank about the estate account',
        dueDate: '2026-10-09',
      }),
    ).toMatchObject({ error: expect.stringContaining('already waiting') });
  });

  it('suggest notes and time entries, and refuse closed matters', async () => {
    const w = world();
    const { tokens } = await w.connect('paralegal');
    expect(
      await w.tool(tokens.access_token, 'propose_note', { matter: 'm-ada', text: 'Client called about the house.' }),
    ).toMatchObject({
      status: 'suggested',
    });
    expect(
      await w.tool(tokens.access_token, 'propose_time_entry', {
        matter: 'm-ada',
        date: '2026-10-07',
        minutes: 24,
        narrative: 'Telephone call with client',
      }),
    ).toMatchObject({ status: 'suggested' });
    const kinds = w.docsUnder(`${MATTER}/m-ada/suggestions/`).map(([, data]) => [data['kind'], data['payload']]);
    expect(kinds).toEqual(
      expect.arrayContaining([
        ['note', { bodyMd: 'Client called about the house.', pinned: false }],
        ['time_entry', { date: '2026-10-07', minutes: 24, narrative: 'Telephone call with client', billable: true }],
      ]),
    );
    expect(await w.tool(tokens.access_token, 'propose_note', { matter: 'M-2026-0003', text: 'Note' })).toEqual({
      error: 'That matter is closed or archived, so nothing can be added to it.',
    });
  });

  it('are refused to read-only members, read-only connections and practices that turned them off', async () => {
    const w = world();
    const readonly = await w.connect('readonly');
    expect(await w.tool(readonly.tokens.access_token, 'propose_note', { matter: 'm-ada', text: 'x' })).toEqual({
      error: 'The person’s role in Materia can’t do that.',
    });
    const readOnlyScope = await w.connect('lawyer', { scopes: ['materia.read'] });
    expect(
      await w.tool(readOnlyScope.tokens.access_token, 'propose_note', { matter: 'm-ada', text: 'x' }),
    ).toMatchObject({
      error: expect.stringContaining('wasn’t allowed'),
    });
    const off = world({ practice: { enabled: true, allowProposals: false } });
    const lawyer = await off.connect('lawyer');
    expect(await off.tool(lawyer.tokens.access_token, 'propose_note', { matter: 'm-ada', text: 'x' })).toEqual({
      error: 'The practice has turned off suggestions from Claude.',
    });
    expect(w.docsUnder(`${MATTER}/m-ada/suggestions/`)).toEqual([]);
  });

  it('are refused while the practice waits to be deleted; reading still works', async () => {
    const w = world();
    const { tokens } = await w.connect();
    await w.store.db.doc(`orgs/${ORG}`).update({ deletionScheduledAt: new Date('2026-11-01') });
    expect(await w.tool(tokens.access_token, 'propose_note', { matter: 'm-ada', text: 'x' })).toEqual({
      error: 'The practice is scheduled for deletion, so nothing can be added to it.',
    });
    expect(await w.tool(tokens.access_token, 'get_matter', { matter: 'm-ada' })).toMatchObject({
      number: 'M-2026-0001',
    });
  });

  it('validate their input', async () => {
    const w = world();
    const { tokens } = await w.connect();
    expect(
      await w.tool(tokens.access_token, 'propose_time_entry', { matter: 'm-ada', date: 'tomorrow', minutes: 0 }),
    ).toMatchObject({
      error: expect.stringContaining('Invalid input'),
    });
  });
});

describe('parity with Materia, for every role', () => {
  // What each suggestion becomes when accepted, and the permission Materia checks for it: the
  // rules for tasks and time entries, `notes-create` for notes (both from PERMISSIONS).
  const PROPOSE = [
    ['propose_task', 'task.edit', { matter: 'm-ada', title: 'Fictional parity task' }],
    ['propose_note', 'note.write', { matter: 'm-ada', text: 'Fictional parity note' }],
    [
      'propose_time_entry',
      'time.record',
      { matter: 'm-ada', date: '2026-10-07', minutes: 6, narrative: 'Fictional parity call' },
    ],
  ] as const;

  it.each(ROLE_LIST)('lets %s suggest only what they could do in Materia themselves', async (role) => {
    expect(createNoteDefinition.roles).toEqual(PERMISSIONS['note.write']);
    const w = world();
    const { tokens } = await w.connect(role);
    const { tools } = (await w.result(tokens.access_token, 'tools/list')) as { tools: { name: string }[] };
    for (const [name, action, args] of PROPOSE) {
      const allowed = can(role, action) && can(role, 'clerk.use');
      expect(tools.some((t) => t.name === name)).toBe(allowed);
      const out = await w.tool(tokens.access_token, name, args);
      if (allowed) expect(out).toMatchObject({ status: 'suggested' });
      else expect(out).toEqual({ error: 'The person’s role in Materia can’t do that.' });
    }
  });

  // Canaries (as in AI-03): every privileged record names one, and no read tool may return any.
  const CANARIES = ['Secret', 'm-secret', 'd-secret', 't-secret', 'te-secret', 'M-2026-0002'];

  it.each(ROLE_LIST)('never gives %s anything from a privileged matter, from any read tool', async (role) => {
    const w = world();
    const uid = `u-${role}`;
    // The role's own privileged work too, so "my" lists have something to leak.
    await w.store.db.doc(`${MATTER}/m-secret`).update({ responsibleUid: uid, teamUids: [uid] });
    await w.store.db.doc(`${MATTER}/m-secret/deadlines/d-secret`).update({ assigneeUid: uid });
    await w.store.db.doc(`${MATTER}/m-secret/tasks/t-secret`).update({ assigneeUid: uid });
    await w.store.db.doc(`${MATTER}/m-secret/timeEntries/te-secret`).update({ uid });
    const { tokens } = await w.connect(role);
    const calls: [string, Record<string, unknown>][] = [
      ['get_my_day', {}],
      ['search_matters', {}],
      ['search_matters', { status: 'any' }],
      ['search_matters', { mine: true, status: 'any' }],
      ['search_matters', { query: 'estate' }],
      ['get_matter', { matter: 'M-2026-0002' }],
      ['get_matter', { matter: 'm-secret' }],
      ['list_deadlines', {}],
      ['list_deadlines', { mine: false, withinDays: 366 }],
      ['list_deadlines', { matter: 'm-secret' }],
      ['list_tasks', {}],
      ['list_tasks', { status: 'todo' }],
      ['list_tasks', { matter: 'm-secret' }],
      ['get_time_summary', {}],
      ['get_time_summary', { from: '2026-01-01', to: '2026-10-07' }],
      ['get_time_summary', { matter: 'm-secret' }],
    ];
    for (const [name, args] of calls) {
      const out = JSON.stringify(await w.tool(tokens.access_token, name, args));
      for (const canary of CANARIES) {
        // A refusal may repeat the matter asked for; nothing else may name it.
        if (args['matter'] === canary) continue;
        expect({ name, args, leaked: out.includes(canary) }).toEqual({ name, args, leaked: false });
      }
    }
  });
});
