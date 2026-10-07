import * as z from 'zod';

import { type ResolvedConnectorSettings } from './connector-settings';
import { can, type Action } from './permissions';
import { DocIdSchema, InstantSchema, withMeta } from './schemas/common';
import type { Role } from './schemas/enums';

/**
 * The Claude connector (INT-07, ADR-064): a person connects their own Claude (claude.ai, the Claude
 * apps or Claude Code) to Materia over MCP. Claude reads what the person could see in Materia, minus
 * privileged matters and document text, and can only propose changes as suggestion cards a person
 * accepts in Materia (ADR-037). Materia is its own OAuth 2.1 authorization server for it: Claude's
 * clients are pinned below (their client ID metadata documents), PKCE is required, and tokens are
 * opaque, short-lived and stored only as hashes.
 */

// ---------- addresses ----------

/** The MCP endpoint, on the app's own origin (a Hosting rewrite to `connector-api`). */
export const CONNECTOR_MCP_PATH = '/mcp';
/** The consent page (the OAuth authorization endpoint): an app route. */
export const CONNECTOR_AUTHORIZE_PATH = '/connect/claude';
export const CONNECTOR_TOKEN_PATH = '/oauth/token';
export const CONNECTOR_REVOKE_PATH = '/oauth/revoke';
/** RFC 9728 protected resource metadata, for the MCP endpoint and at the root. */
export const CONNECTOR_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';
/** RFC 8414 authorization server metadata. */
export const CONNECTOR_AS_METADATA_PATH = '/.well-known/oauth-authorization-server';
/** Settings → Claude connector. */
export const CONNECTOR_SETTINGS_PATH = '/settings/claude';

/** The MCP server URL a person adds to Claude: the app's origin and `/mcp`. */
export function connectorServerUrl(origin: string): string {
  return `${origin.replace(/\/+$/, '')}${CONNECTOR_MCP_PATH}`;
}

// ---------- scopes ----------

export const CONNECTOR_SCOPES = ['materia.read', 'materia.propose'] as const;
export const ConnectorScopeSchema = z.enum(CONNECTOR_SCOPES);
export type ConnectorScope = z.infer<typeof ConnectorScopeSchema>;

export const CONNECTOR_SCOPE_INFO: Readonly<Record<ConnectorScope, { label: string; description: string }>> = {
  'materia.read': {
    label: 'Read your matters',
    description:
      'Matters you can see, with their deadlines, tasks and time totals. Never privileged matters or the text of documents.',
  },
  'materia.propose': {
    label: 'Suggest changes',
    description:
      'Suggest tasks, file notes and time entries. Each one waits on the matter as a suggestion until someone accepts it in Materia.',
  },
};

/**
 * The scopes a request asks for (`scope`, space-separated). Unknown scopes are ignored; none (or
 * only unknown ones) means all of them. Always in `CONNECTOR_SCOPES` order.
 */
export function parseConnectorScopes(scope: string | null | undefined): ConnectorScope[] {
  const asked = new Set((scope ?? '').split(/\s+/).filter(Boolean));
  const known = CONNECTOR_SCOPES.filter((s) => asked.has(s));
  return known.length ? known : [...CONNECTOR_SCOPES];
}

// ---------- lifetimes and limits ----------

/** An authorization code: used once, within five minutes. */
export const CONNECTOR_CODE_TTL_MS = 5 * 60_000;
/** An access token: an hour. */
export const CONNECTOR_ACCESS_TTL_MS = 60 * 60_000;
/** A refresh token: 30 days, rotated on every use (the session policy ends the connection sooner). */
export const CONNECTOR_REFRESH_TTL_MS = 30 * 86_400_000;
/** Tool calls one connection may make per minute (per server instance). */
export const CONNECTOR_CALLS_PER_MINUTE = 120;
/** Rows a list tool returns. */
export const CONNECTOR_LIST_MAX = 50;

// ---------- Claude's clients ----------

export interface ConnectorClient {
  /** The client ID: the URL of its client ID metadata document. */
  id: string;
  /** What the consent page and Settings call it. */
  name: string;
  /** Its registered redirect URIs, compared exactly (except loopback ones, below). */
  redirectUris: readonly string[];
  /** A native client: an `http://localhost` or `http://127.0.0.1` redirect may use any port (RFC 8252). */
  loopback: boolean;
}

/**
 * The clients that may connect, pinned from their client ID metadata documents (fetched 2026-10-07)
 * so the server never fetches a URL a request names. claude.com is Claude's announced next home for
 * its callback.
 */
export const CONNECTOR_CLIENTS: readonly ConnectorClient[] = [
  {
    id: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
    name: 'Claude',
    redirectUris: ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'],
    loopback: false,
  },
  {
    id: 'https://claude.ai/oauth/claude-code-client-metadata',
    name: 'Claude Code',
    redirectUris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
    loopback: true,
  },
];

export function connectorClient(clientId: string | null | undefined): ConnectorClient | undefined {
  return CONNECTOR_CLIENTS.find((client) => client.id === clientId);
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

/** Whether a redirect URI is one of the client's: exact, or a registered loopback URI on any port. */
export function connectorRedirectAllowed(client: ConnectorClient, redirectUri: string): boolean {
  if (client.redirectUris.includes(redirectUri)) return true;
  if (!client.loopback) return false;
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password) return false;
  if (url.hash) return false;
  const portless = `${url.protocol}//${url.hostname}${url.pathname}`;
  return client.redirectUris.includes(portless) && !url.search;
}

// ---------- the authorization request ----------

/** A PKCE S256 challenge: 43 base64url characters (RFC 7636). */
export const PkceChallengeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'A PKCE S256 challenge');

/** What the consent page found in its URL, checked. */
export interface ConnectorAuthorizationRequest {
  client: ConnectorClient;
  redirectUri: string;
  codeChallenge: string;
  scopes: ConnectorScope[];
  state?: string;
  resource?: string;
}

/**
 * Why a request can't go ahead. With `redirect` false the client or redirect URI is wrong, so the
 * page shows the error and sends the browser nowhere (RFC 6749 4.1.2.1); otherwise it goes back
 * to the client with `error`.
 */
export type ConnectorAuthorizationError =
  | { redirect: false; error: 'invalid_client' | 'invalid_redirect_uri' }
  | {
      redirect: true;
      error: 'invalid_request' | 'unsupported_response_type' | 'invalid_target';
      description: string;
      redirectUri: string;
      state?: string;
    };

const STATE_MAX = 1000;

/** The MCP resource names, compared without a trailing slash. */
export function sameResource(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

/**
 * Checks an authorization request's query parameters (OAuth 2.1 with PKCE, RFC 8707's `resource`)
 * against the pinned clients and this server's MCP resource. Used by the consent page before it
 * shows anything, and again by `connector-authorize`.
 */
export function parseConnectorAuthorization(
  params: Readonly<Record<string, string | null | undefined>>,
  resource: string,
): { ok: true; request: ConnectorAuthorizationRequest } | ({ ok: false } & ConnectorAuthorizationError) {
  const client = connectorClient(params['client_id']);
  if (!client) return { ok: false, redirect: false, error: 'invalid_client' };
  const redirectUri = params['redirect_uri'] ?? '';
  if (!connectorRedirectAllowed(client, redirectUri)) {
    return { ok: false, redirect: false, error: 'invalid_redirect_uri' };
  }
  const rawState = params['state'];
  const state = rawState && rawState.length <= STATE_MAX ? rawState : undefined;
  const fail = (
    error: 'invalid_request' | 'unsupported_response_type' | 'invalid_target',
    description: string,
  ): { ok: false } & ConnectorAuthorizationError => ({
    ok: false,
    redirect: true,
    error,
    description,
    redirectUri,
    ...(state ? { state } : {}),
  });
  if (rawState && !state) return fail('invalid_request', 'state is too long');
  if (params['response_type'] !== 'code') return fail('unsupported_response_type', 'Only response_type=code');
  if (params['code_challenge_method'] !== 'S256') return fail('invalid_request', 'PKCE with S256 is required');
  const challenge = PkceChallengeSchema.safeParse(params['code_challenge']);
  if (!challenge.success) return fail('invalid_request', 'code_challenge is missing or malformed');
  const asked = params['resource'];
  if (asked && !sameResource(asked, resource)) return fail('invalid_target', 'Unknown resource');
  return {
    ok: true,
    request: {
      client,
      redirectUri,
      codeChallenge: challenge.data,
      scopes: parseConnectorScopes(params['scope']),
      ...(state ? { state } : {}),
      ...(asked ? { resource: asked } : {}),
    },
  };
}

/** The redirect back to the client with an error (`access_denied` when the person says no). */
export function connectorErrorRedirect(
  redirectUri: string,
  error: string,
  options: { state?: string | undefined; description?: string | undefined; issuer?: string | undefined } = {},
): string {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  if (options.description) url.searchParams.set('error_description', options.description);
  if (options.state) url.searchParams.set('state', options.state);
  if (options.issuer) url.searchParams.set('iss', options.issuer);
  return url.toString();
}

// The practice's switch (`settings.connector`) is in connector-settings.ts, which the org schema imports.

// ---------- connections and grants ----------

export const CONNECTOR_CONNECTION_STATUSES = ['active', 'revoked'] as const;
export const ConnectorConnectionStatusSchema = z.enum(CONNECTOR_CONNECTION_STATUSES);
export type ConnectorConnectionStatus = z.infer<typeof ConnectorConnectionStatusSchema>;

/**
 * Why a connection ended: its person (or an owner or admin) disconnected it, they left the
 * practice, the practice turned the connector off, or a used refresh token came back (stolen).
 */
export const ConnectorRevokeReasonSchema = z.enum(['disconnected', 'member_removed', 'practice_off', 'refresh_reuse']);
export type ConnectorRevokeReason = z.infer<typeof ConnectorRevokeReasonSchema>;

/**
 * `connectorConnections/{id}` (INT-07): one person's Claude connected to the practice, readable by
 * that person and by owners and admins, with nothing secret. Written only by functions. Its
 * tokens live in `connectorGrants`.
 */
export const ConnectorConnection = withMeta(
  () => ({
    uid: DocIdSchema,
    clientId: z.string().max(300),
    clientName: z.string().max(80),
    scopes: z.array(ConnectorScopeSchema),
    status: ConnectorConnectionStatusSchema,
    /**
     * When the person signed in to Materia before allowing it (the ID token's `auth_time`): like
     * that sign-in, the connection ends once the practice's session length passes or the person
     * is signed out everywhere (SEC-04).
     */
    authTime: InstantSchema,
    /** That sign-in used a second factor: once the practice requires one, a connection made without it stops. */
    secondFactor: z.boolean().default(false),
    connectedAt: InstantSchema,
    /** Updated at most every few minutes. */
    lastUsedAt: InstantSchema.optional(),
    revokedAt: InstantSchema.optional(),
    /** A uid, or `system`. */
    revokedBy: z.string().min(1).optional(),
    revokeReason: ConnectorRevokeReasonSchema.optional(),
  }),
  { path: 'orgs/{orgId}/connectorConnections', migratable: false, updatable: [] },
);
export type ConnectorConnection = z.infer<typeof ConnectorConnection.schema>;

export const ConnectorGrantKindSchema = z.enum(['code', 'access', 'refresh']);
export type ConnectorGrantKind = z.infer<typeof ConnectorGrantKindSchema>;

/**
 * `connectorGrants/{sha256(token)}` (INT-07): an authorization code, access token or refresh token
 * of a connection, server-only. Only the token's hash is stored, as the id; Firestore TTL deletes
 * it after `expireAt`. A code or refresh token is used once (`usedAt`).
 */
export const ConnectorGrant = withMeta(
  () => ({
    kind: ConnectorGrantKindSchema,
    connectionId: DocIdSchema,
    uid: DocIdSchema,
    clientId: z.string().max(300),
    scopes: z.array(ConnectorScopeSchema),
    /** The MCP resource the token is for (RFC 8707). */
    resource: z.string().max(2000),
    expireAt: InstantSchema,
    usedAt: InstantSchema.optional(),
    /** A code's PKCE challenge and redirect URI, checked when it is exchanged. */
    codeChallenge: z.string().max(128).optional(),
    redirectUri: z.string().max(2000).optional(),
    /** When a use last marked the connection used (an access token's). */
    touchedAt: InstantSchema.optional(),
  }),
  { path: 'orgs/{orgId}/connectorGrants', migratable: false, updatable: [] },
);
export type ConnectorGrant = z.infer<typeof ConnectorGrant.schema>;

// ---------- callables ----------

export const CONNECTOR_CALLABLES = {
  authorize: 'connector-authorize',
  setPractice: 'connector-setPractice',
  disconnect: 'connector-disconnect',
} as const;

/** `connector-authorize`: the person allowed Claude on the consent page. */
export const AuthorizeConnectorInput = z.object({
  requestId: z.uuid(),
  clientId: z.string().max(300),
  redirectUri: z.string().max(2000),
  codeChallenge: PkceChallengeSchema,
  codeChallengeMethod: z.literal('S256'),
  scopes: z.array(ConnectorScopeSchema).min(1).max(CONNECTOR_SCOPES.length),
  state: z.string().max(STATE_MAX).optional(),
  resource: z.string().max(2000).optional(),
});
export type AuthorizeConnectorInput = z.infer<typeof AuthorizeConnectorInput>;

export interface AuthorizeConnectorResult {
  /** Back to Claude, with the code. */
  redirectUrl: string;
  connectionId: string;
}

/** `connector-setPractice`: an owner or admin turns the connector, or its suggestions, on or off. */
export const SetConnectorPracticeInput = z.object({
  requestId: z.uuid(),
  enabled: z.boolean(),
  allowProposals: z.boolean(),
});
export type SetConnectorPracticeInput = z.infer<typeof SetConnectorPracticeInput>;

export interface SetConnectorPracticeResult extends ResolvedConnectorSettings {
  /** Connections ended because the connector was turned off. */
  revoked: number;
}

/** `connector-disconnect`: a person's own connection, or anyone's for an owner or admin. */
export const DisconnectConnectorInput = z.object({
  requestId: z.uuid(),
  connectionId: DocIdSchema,
});
export type DisconnectConnectorInput = z.infer<typeof DisconnectConnectorInput>;

export interface DisconnectConnectorResult {
  revoked: boolean;
}

/** Who may see and end every connection in the practice (everyone sees and ends their own). */
export const CONNECTOR_ADMIN_ACTION: Action = 'org.settings';

export function canManageConnections(role: Role): boolean {
  return can(role, CONNECTOR_ADMIN_ACTION);
}

// ---------- the tools ----------

export const CONNECTOR_READ_TOOLS = [
  'get_my_day',
  'search_matters',
  'get_matter',
  'list_deadlines',
  'list_tasks',
  'get_time_summary',
] as const;
export const CONNECTOR_PROPOSE_TOOLS = ['propose_task', 'propose_note', 'propose_time_entry'] as const;
export type ConnectorReadTool = (typeof CONNECTOR_READ_TOOLS)[number];
export type ConnectorProposeTool = (typeof CONNECTOR_PROPOSE_TOOLS)[number];
export type ConnectorTool = ConnectorReadTool | ConnectorProposeTool;

export interface ConnectorToolInfo {
  title: string;
  scope: ConnectorScope;
  /** The action a role needs for it, besides seeing the matter. */
  action?: Action;
}

/** What each tool is called in Settings and the audit log, its scope, and the action it needs. */
export const CONNECTOR_TOOL_INFO: Readonly<Record<ConnectorTool, ConnectorToolInfo>> = {
  get_my_day: { title: 'My day', scope: 'materia.read' },
  search_matters: { title: 'Find matters', scope: 'materia.read' },
  get_matter: { title: 'Matter summary', scope: 'materia.read' },
  list_deadlines: { title: 'Deadlines', scope: 'materia.read' },
  list_tasks: { title: 'Tasks', scope: 'materia.read' },
  get_time_summary: { title: 'Time summary', scope: 'materia.read' },
  propose_task: { title: 'Suggest a task', scope: 'materia.propose', action: 'task.edit' },
  propose_note: { title: 'Suggest a file note', scope: 'materia.propose', action: 'note.write' },
  propose_time_entry: { title: 'Suggest a time entry', scope: 'materia.propose', action: 'time.record' },
};

/** The `promptId` of suggestions made through the connector (AI-07 records which feature proposed). */
export const CONNECTOR_PROMPT_ID = 'connector.claude';
export const CONNECTOR_PROMPT_VERSION = '1.0.0';
/** The `model` of a connector suggestion: the person's own Claude, whose model Materia doesn't see. */
export const CONNECTOR_MODEL = 'claude (connector)';

/** Whether a suggestion came from a person's Claude rather than from Clerk. */
export function isConnectorSuggestion(suggestion: { promptId?: unknown }): boolean {
  return suggestion.promptId === CONNECTOR_PROMPT_ID;
}

/** Whether a role may use a tool (scopes aside): every read tool, and a proposal it could accept. */
export function connectorToolAllowed(role: Role, tool: ConnectorTool): boolean {
  const action = CONNECTOR_TOOL_INFO[tool].action;
  return action ? can(role, action) && can(role, 'clerk.use') : can(role, 'matter.view');
}
