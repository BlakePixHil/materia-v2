import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { getFirestore as getAdminFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';
import type { HttpsError } from 'firebase-functions/v2/https';

import type { Role } from '@materia/domain';

import {
  authorizeDefinition,
  connectorIssuer,
  disconnectDefinition,
  setPracticeDefinition,
} from '../../src/connector/callables';
import type { TokenSet } from '../../src/connector/grants';
import { handleConnectorRequest, type ConnectorRequest } from '../../src/connector/http';
import { CallLimiter } from '../../src/connector/mcp';
import { connectionPath } from '../../src/connector/tokens';
import { runCallable, type CallableDefinition, type CallableDeps } from '../../src/core/callable';
import { clearFlagCaches, setRemoteFlagLoader } from '../../src/core/flags';
import { firestoreIdempotency } from '../../src/core/idempotency';
import { createLog } from '../../src/core/log';
import { cachedMemberLookup } from '../../src/core/members';
import { systemClock } from '../../src/ports/container';
import { fakePorts } from '../../src/ports/fakes';

/**
 * INT-07 against the emulator's Firestore, where what the callables store comes back as Firestore
 * Timestamps rather than the unit tests' Dates: an owner turns the Claude connector on, a lawyer
 * allows Claude, the code is exchanged and refreshed, and Claude reads the practice's matters and
 * suggests a task; disconnecting, signing out everywhere and the practice turning it off each
 * end the access. The callables and the HTTP handler run in this process. Fictional only.
 */
const PROJECT_ID = 'demo-materia';
const ORG = 'org-connector';
const MATTER_ID = 'm-connector';
const CLAUDE = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

let admin: App;
let db: Firestore;

const uidOf = (role: Role) => `cn-${role}`;
const origin = () => connectorIssuer(undefined);
const resource = () => `${origin()}/mcp`;

function call<T>(definition: unknown, role: Role, data: Record<string, unknown>): Promise<T> {
  const clock = systemClock;
  const deps: CallableDeps = {
    db: () => db,
    clock,
    ports: () => fakePorts(),
    memberLookup: cachedMemberLookup(() => db, clock),
    idempotency: firestoreIdempotency(() => db, clock),
    sink: () => undefined,
  };
  const token = { orgId: ORG, role, auth_time: Math.floor(Date.now() / 1000) };
  return runCallable(
    definition as CallableDefinition<never, T>,
    { data: { requestId: randomUUID(), ...data }, auth: { uid: uidOf(role), token } },
    deps,
  );
}

const limiter = new CallLimiter();
const http = (req: Partial<ConnectorRequest>) =>
  handleConnectorRequest(
    { method: 'POST', path: '/mcp', headers: {}, body: {}, ...req },
    {
      db,
      clock: systemClock,
      log: createLog({ fn: 'connector-integration' }, () => undefined),
      origin: origin(),
      limiter,
    },
  );
let rpcId = 0;
const rpc = (accessToken: string, method: string, params?: Record<string, unknown>) =>
  http({
    headers: { authorization: `Bearer ${accessToken}` },
    body: { jsonrpc: '2.0', id: ++rpcId, method, ...(params ? { params } : {}) },
  });
async function tool(accessToken: string, name: string, args: Record<string, unknown> = {}) {
  const response = await rpc(accessToken, 'tools/call', { name, arguments: args });
  expect(response.status).toBe(200);
  const result = (response.body as { result: { structuredContent?: Record<string, unknown>; isError?: boolean } })
    .result;
  expect(result.isError ?? false).toBe(false);
  return result.structuredContent ?? {};
}

const setPractice = (enabled: boolean) =>
  call<{ enabled: boolean; revoked: number }>(setPracticeDefinition, 'owner', { enabled, allowProposals: true });

/** A lawyer allows Claude on the consent page, and Claude exchanges the code for tokens. */
async function connect(): Promise<{ connectionId: string; tokens: TokenSet }> {
  const verifier = randomBytes(32).toString('base64url');
  const { redirectUrl, connectionId } = await call<{ redirectUrl: string; connectionId: string }>(
    authorizeDefinition,
    'lawyer',
    {
      clientId: CLAUDE,
      redirectUri: CALLBACK,
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
      codeChallengeMethod: 'S256',
      scopes: ['materia.read', 'materia.propose'],
      state: 'state-1',
      resource: resource(),
    },
  );
  const back = new URL(redirectUrl);
  expect(back.searchParams.get('iss')).toBe(origin());
  const exchanged = await http({
    path: '/oauth/token',
    body: {
      grant_type: 'authorization_code',
      code: back.searchParams.get('code'),
      code_verifier: verifier,
      client_id: CLAUDE,
      redirect_uri: CALLBACK,
      resource: resource(),
    },
  });
  expect(exchanged.status, JSON.stringify(exchanged.body)).toBe(200);
  return { connectionId, tokens: exchanged.body as TokenSet };
}

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('expected a failure');
    },
    (error: unknown) => error as HttpsError & { details?: { code?: string } },
  );

beforeAll(async () => {
  admin = initializeAdminApp({ projectId: PROJECT_ID }, 'connector-integration-admin');
  db = getAdminFirestore(admin);
  setRemoteFlagLoader(async () => ({}));
  await db.recursiveDelete(db.doc(`orgs/${ORG}`));
  await db.doc(`orgs/${ORG}`).set({
    name: 'Fictional Connector Practice',
    timezone: 'Australia/Melbourne',
    retentionYears: 7,
    flags: { 'integrations.claudeConnector': true, 'clerk.features.suggestions': true },
  });
  clearFlagCaches();
  for (const role of ['owner', 'lawyer'] as const) {
    await db
      .doc(`orgs/${ORG}/members/${uidOf(role)}`)
      .set({ role, status: 'active', displayName: `Fictional ${role}` });
  }
  await db.doc(`orgs/${ORG}/matters/${MATTER_ID}`).set({
    number: 'CN-2026-0001',
    title: 'Estate of Fictional Wattle',
    type: 'probate',
    status: 'open',
    jurisdiction: 'VIC',
    responsibleUid: uidOf('lawyer'),
    teamUids: [uidOf('lawyer')],
    clientContactIds: [],
    privileged: false,
    deletedAt: null,
    search: ['cn20260001', 'estate', 'of', 'fictional', 'wattle'],
    lastActivityAt: Timestamp.fromDate(new Date('2026-10-06T00:00:00Z')),
    createdAt: Timestamp.fromDate(new Date('2026-09-01T00:00:00Z')),
    createdBy: 'seed',
    updatedAt: Timestamp.fromDate(new Date('2026-09-01T00:00:00Z')),
    updatedBy: 'seed',
    schemaVersion: 1,
  });
});

afterAll(async () => {
  setRemoteFlagLoader();
  await deleteAdminApp(admin);
});

describe('the Claude connector, with what Firestore stored', () => {
  it('connects once an owner turns it on, reads matters, suggests a task and refreshes its tokens', async () => {
    expect((await failure(connect())).details?.code).toBe('CONNECTOR_OFF');

    await setPractice(true);
    // The switch comes back from Firestore with its updatedAt as a Timestamp.
    const stored = (await db.doc(`orgs/${ORG}`).get()).get('settings.connector') as Record<string, unknown>;
    expect(stored).toMatchObject({ enabled: true, allowProposals: true });
    expect(stored['updatedAt']).toBeInstanceOf(Timestamp);

    const { connectionId, tokens } = await connect();
    const connection = await db.doc(connectionPath(ORG, connectionId)).get();
    expect(connection.get('authTime')).toBeInstanceOf(Timestamp);

    const init = await rpc(tokens.access_token, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'integration', version: '1' },
    });
    expect((init.body as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe('materia');
    // Stored Timestamps come out as dates.
    expect(await tool(tokens.access_token, 'search_matters')).toMatchObject({
      matters: [{ id: MATTER_ID, number: 'CN-2026-0001', lastActivity: '2026-10-06' }],
    });
    expect(await tool(tokens.access_token, 'get_matter', { matter: 'CN-2026-0001' })).toMatchObject({
      id: MATTER_ID,
      title: 'Estate of Fictional Wattle',
      opened: '2026-09-01',
    });

    expect(
      await tool(tokens.access_token, 'propose_task', {
        matter: 'CN-2026-0001',
        title: 'Call the bank about the estate account',
        reason: 'Asked for after the client call',
      }),
    ).toMatchObject({ status: 'suggested' });
    const suggestions = await db.collection(`orgs/${ORG}/matters/${MATTER_ID}/suggestions`).get();
    expect(suggestions.docs.map((d) => d.get('promptId'))).toEqual(['connector.claude']);

    const refreshed = await http({
      path: '/oauth/token',
      body: { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: CLAUDE },
    });
    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
    const next = refreshed.body as TokenSet;
    expect((await rpc(next.access_token, 'ping')).status).toBe(200);

    await call(disconnectDefinition, 'lawyer', { connectionId });
    expect((await rpc(next.access_token, 'ping')).status).toBe(401);
  });

  it('ends access when the person signs out everywhere, and when the practice turns it off', async () => {
    await setPractice(true);
    const first = await connect();
    expect((await rpc(first.tokens.access_token, 'ping')).status).toBe(200);
    await db
      .doc(`orgs/${ORG}/members/${uidOf('lawyer')}`)
      .update({ sessionsValidAfter: Timestamp.fromMillis(Date.now() + 60_000) });
    expect((await rpc(first.tokens.access_token, 'ping')).status).toBe(401);
    await db.doc(`orgs/${ORG}/members/${uidOf('lawyer')}`).update({ sessionsValidAfter: null });

    const second = await connect();
    expect((await rpc(second.tokens.access_token, 'ping')).status).toBe(200);
    expect((await setPractice(false)).revoked).toBeGreaterThanOrEqual(1);
    expect((await rpc(second.tokens.access_token, 'ping')).status).toBe(401);
  });
});
