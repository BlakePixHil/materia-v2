import { randomUUID } from 'node:crypto';

import type { Firestore } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';

import {
  CONNECTOR_AS_METADATA_PATH,
  CONNECTOR_AUTHORIZE_PATH,
  CONNECTOR_MCP_PATH,
  CONNECTOR_RESOURCE_METADATA_PATH,
  CONNECTOR_REVOKE_PATH,
  CONNECTOR_SCOPES,
  CONNECTOR_SETTINGS_PATH,
  CONNECTOR_TOKEN_PATH,
  connectorClient,
  connectorServerUrl,
} from '@materia/domain';

import { authenticate, exchangeCode, OAuthError, refreshGrant, revokeToken } from './grants';
import { CallLimiter, handleMcpMessage, JSON_RPC, MCP_PROTOCOL_VERSIONS } from './mcp';
import { REGION } from '../config';
import { adminDb } from '../core/admin';
import { isEmulator } from '../core/env';
import { createLog, errorReportFields, functionsSink, type Log } from '../core/log';
import { appUrl } from '../orgs/shared';
import type { Clock } from '../ports';
import { systemClock } from '../ports/container';

/**
 * `connector-api` (INT-07, ADR-064): the Claude connector's HTTP side, on the app's own origin
 * through Hosting rewrites: the MCP endpoint, the OAuth token and revocation endpoints, and the
 * metadata documents Claude discovers them from. The consent page (the authorization endpoint) is
 * an app route, `/connect/claude`, which calls `connector-authorize`.
 */
export interface ConnectorRequest {
  method: string;
  /** The path as the browser or Claude sent it (Hosting keeps it). */
  path: string;
  /** Lower-case header names. */
  headers: Readonly<Record<string, string | undefined>>;
  /** The parsed body: JSON, or form fields. */
  body: unknown;
}

export interface ConnectorResponse {
  status: number;
  headers: Record<string, string>;
  body?: unknown;
}

export interface ConnectorHttpDeps {
  db: Firestore;
  clock: Clock;
  log: Log;
  /** The app's origin: the issuer, and the MCP resource's base. */
  origin: string;
  limiter: CallLimiter;
}

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };
const METADATA_CACHE = { 'Cache-Control': 'public, max-age=300' };

const json = (status: number, body: unknown, headers: Record<string, string> = NO_STORE): ConnectorResponse => ({
  status,
  headers: { ...headers, 'Content-Type': 'application/json' },
  body,
});

/** RFC 9728 protected resource metadata for the MCP endpoint. */
export function resourceMetadata(origin: string) {
  return {
    resource: connectorServerUrl(origin),
    authorization_servers: [origin],
    scopes_supported: [...CONNECTOR_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'Materia',
    resource_documentation: `${origin}${CONNECTOR_SETTINGS_PATH}`,
  };
}

/**
 * RFC 8414 authorization server metadata. Public clients only (PKCE, no secrets), identified by
 * their client ID metadata documents; there is no dynamic registration.
 */
export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}${CONNECTOR_AUTHORIZE_PATH}`,
    token_endpoint: `${origin}${CONNECTOR_TOKEN_PATH}`,
    revocation_endpoint: `${origin}${CONNECTOR_REVOKE_PATH}`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...CONNECTOR_SCOPES],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${origin}${CONNECTOR_SETTINGS_PATH}`,
  };
}

const RESOURCE_METADATA_PATHS = new Set([
  CONNECTOR_RESOURCE_METADATA_PATH,
  `${CONNECTOR_RESOURCE_METADATA_PATH}${CONNECTOR_MCP_PATH}`,
]);

/** Browsers' origins the MCP endpoint answers (DNS rebinding, MCP transport security): Claude's and ours. */
function originAllowed(header: string | undefined, origin: string): boolean {
  if (!header) return true;
  if (header === origin) return true;
  try {
    const url = new URL(header);
    return url.protocol === 'https:' && /(^|\.)(claude\.ai|claude\.com|anthropic\.com)$/.test(url.hostname);
  } catch {
    return false;
  }
}

/** Form fields or JSON as a flat record of strings. */
function fields(body: unknown): Record<string, string | undefined> {
  let value = body;
  if (typeof value === 'string' || value instanceof Buffer) {
    const text = value.toString();
    try {
      value = JSON.parse(text);
    } catch {
      value = Object.fromEntries(new URLSearchParams(text));
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, typeof v === 'string' ? v : undefined]),
  );
}

function oauthError(error: OAuthError): ConnectorResponse {
  return json(error.error === 'invalid_client' ? 401 : 400, {
    error: error.error,
    error_description: error.description,
  });
}

async function token(req: ConnectorRequest, deps: ConnectorHttpDeps): Promise<ConnectorResponse> {
  if (req.method !== 'POST') return json(405, { error: 'invalid_request' }, { ...NO_STORE, Allow: 'POST' });
  const params = fields(req.body);
  try {
    if (!connectorClient(params['client_id'])) throw new OAuthError('invalid_client', 'Unknown client');
    switch (params['grant_type']) {
      case 'authorization_code':
        return json(
          200,
          await exchangeCode(deps, {
            code: params['code'],
            codeVerifier: params['code_verifier'],
            clientId: params['client_id'],
            redirectUri: params['redirect_uri'],
            resource: params['resource'],
          }),
        );
      case 'refresh_token':
        return json(
          200,
          await refreshGrant(deps, {
            refreshToken: params['refresh_token'],
            clientId: params['client_id'],
            scope: params['scope'],
            resource: params['resource'],
          }),
        );
      default:
        throw new OAuthError('unsupported_grant_type', 'Use authorization_code or refresh_token');
    }
  } catch (error) {
    if (error instanceof OAuthError) {
      deps.log.info('connector token refused', { error: error.error, grantType: params['grant_type'] });
      return oauthError(error);
    }
    throw error;
  }
}

async function revoke(req: ConnectorRequest, deps: ConnectorHttpDeps): Promise<ConnectorResponse> {
  if (req.method !== 'POST') return json(405, { error: 'invalid_request' }, { ...NO_STORE, Allow: 'POST' });
  await revokeToken(deps, fields(req.body)['token']);
  // RFC 7009 2.2: the same answer whether or not the token was known.
  return json(200, {});
}

function unauthorized(origin: string, error?: { description: string }): ConnectorResponse {
  const challenge = [
    `Bearer resource_metadata="${origin}${CONNECTOR_RESOURCE_METADATA_PATH}${CONNECTOR_MCP_PATH}"`,
    `scope="${CONNECTOR_SCOPES.join(' ')}"`,
    ...(error ? ['error="invalid_token"', `error_description="${error.description.replace(/["\\]/g, '')}"`] : []),
  ].join(', ');
  return json(
    401,
    { error: 'invalid_token', error_description: error?.description ?? 'Sign in required' },
    { ...NO_STORE, 'WWW-Authenticate': challenge },
  );
}

async function mcp(req: ConnectorRequest, deps: ConnectorHttpDeps): Promise<ConnectorResponse> {
  const { origin, log } = deps;
  if (!originAllowed(req.headers['origin'], origin)) {
    log.warn('connector request from a foreign origin refused');
    return json(403, { error: 'Forbidden origin' });
  }
  // No server-to-client stream and no sessions: only POST (MCP Streamable HTTP lets a server say so).
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, { ...NO_STORE, Allow: 'POST' });
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers['authorization'] ?? '')?.[1];
  const auth = await authenticate(deps, bearer, connectorServerUrl(origin));
  if (!auth.ok) return unauthorized(origin, auth.presented ? auth : undefined);
  const version = req.headers['mcp-protocol-version'];
  if (version && !(MCP_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
    return json(400, {
      jsonrpc: '2.0',
      id: null,
      error: { code: JSON_RPC.INVALID_REQUEST, message: `Unsupported MCP-Protocol-Version: ${version}` },
    });
  }
  let body = req.body;
  if (typeof body === 'string' || body instanceof Buffer) {
    try {
      body = JSON.parse(body.toString());
    } catch {
      body = undefined;
    }
  }
  if (!body || typeof body !== 'object') {
    return json(400, { jsonrpc: '2.0', id: null, error: { code: JSON_RPC.PARSE_ERROR, message: 'Parse error' } });
  }
  const ctx = {
    db: deps.db,
    clock: deps.clock,
    log: log.child({ orgId: auth.principal.orgId, uid: auth.principal.uid }),
    origin,
    principal: auth.principal,
    requestId: randomUUID(),
    limiter: deps.limiter,
  };
  if (Array.isArray(body)) {
    const responses = [];
    for (const message of body.slice(0, 20)) {
      const result = await handleMcpMessage(ctx, message);
      if (result) responses.push(result);
    }
    return responses.length ? json(200, responses) : { status: 202, headers: NO_STORE };
  }
  const result = await handleMcpMessage(ctx, body);
  return result ? json(200, result) : { status: 202, headers: NO_STORE };
}

/** Routes one request. Never throws for a client's mistake; an unexpected error is a 500. */
export async function handleConnectorRequest(
  req: ConnectorRequest,
  deps: ConnectorHttpDeps,
): Promise<ConnectorResponse> {
  const path = req.path.replace(/\/+$/, '') || '/';
  try {
    if (RESOURCE_METADATA_PATHS.has(path)) return json(200, resourceMetadata(deps.origin), METADATA_CACHE);
    if (path === CONNECTOR_AS_METADATA_PATH) return json(200, authorizationServerMetadata(deps.origin), METADATA_CACHE);
    if (path === CONNECTOR_TOKEN_PATH) return await token(req, deps);
    if (path === CONNECTOR_REVOKE_PATH) return await revoke(req, deps);
    if (path === CONNECTOR_MCP_PATH) return await mcp(req, deps);
    return json(404, { error: 'Not found' });
  } catch (error) {
    deps.log.error('connector request failed', { path, ...errorReportFields(error) });
    return json(500, { error: 'server_error' });
  }
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

/**
 * The origin Claude reaches Materia on: the app's address (`appUrl`). In the emulator, the
 * Hosting emulator's own address, so Claude Code can connect to a local stack.
 */
export function connectorOrigin(headers: Readonly<Record<string, string | undefined>>): string {
  if (isEmulator()) {
    const host = headers['x-forwarded-host'] ?? headers['host'];
    if (host && LOCAL_HOST.test(host)) return `http://${host}`;
  }
  return appUrl();
}

const limiter = new CallLimiter();

/** `connector-api`: served at `/mcp`, `/oauth/*` and the `.well-known` metadata by Hosting rewrites. */
export const api = onRequest(
  { region: REGION, invoker: 'public', cors: false, concurrency: 40, timeoutSeconds: 60 },
  async (req, res) => {
    const requestId = randomUUID();
    const log = createLog({ fn: 'connector-api', requestId }, functionsSink);
    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value[0] : value]),
    );
    const response = await handleConnectorRequest(
      { method: req.method, path: req.path, headers, body: req.body },
      { db: adminDb(), clock: systemClock, log, origin: connectorOrigin(headers), limiter },
    );
    res.status(response.status).set(response.headers);
    if (response.body === undefined) res.end();
    else res.send(JSON.stringify(response.body));
  },
);
