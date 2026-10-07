import type { DocumentReference, Firestore } from 'firebase-admin/firestore';

import {
  CONNECTOR_ACCESS_TTL_MS,
  CONNECTOR_CODE_TTL_MS,
  CONNECTOR_REFRESH_TTL_MS,
  ConnectorConnection,
  ConnectorGrant,
  sameResource,
  type ConnectorClient,
  type ConnectorGrantKind,
  type ConnectorRevokeReason,
  type ConnectorScope,
} from '@materia/domain';

import { DENIAL_DESCRIPTIONS, resolvePrincipal, toDate, type ConnectorPrincipal } from './access';
import {
  connectionPath,
  connectionsPath,
  grantPath,
  grantsPath,
  newConnectorToken,
  parseConnectorToken,
  pkceMatches,
} from './tokens';
import type { Log } from '../core/log';
import type { Clock } from '../ports';

type Data = Record<string, unknown>;

export interface GrantDeps {
  db: Firestore;
  clock: Clock;
  log: Log;
}

/** An OAuth error response (RFC 6749 5.2). Its description never names a person or record. */
export class OAuthError extends Error {
  constructor(
    readonly error:
      | 'invalid_request'
      | 'invalid_client'
      | 'invalid_grant'
      | 'invalid_scope'
      | 'invalid_target'
      | 'unsupported_grant_type',
    readonly description: string,
  ) {
    super(description);
    this.name = 'OAuthError';
  }
}

/** The token response (RFC 6749 5.1). */
export interface TokenSet {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/** Marks connections used at most this often (each MCP call reads the grant anyway). */
export const TOUCH_INTERVAL_MS = 5 * 60_000;

const meta = (now: Date, actor: string) => ({
  createdAt: now,
  createdBy: actor,
  updatedAt: now,
  updatedBy: actor,
});

interface GrantFields {
  connectionId: string;
  uid: string;
  clientId: string;
  scopes: readonly ConnectorScope[];
  resource: string;
}

/** Writes a new grant (with `write`, in a transaction or batch) and returns its token. */
function newGrant(
  orgId: string,
  kind: ConnectorGrantKind,
  fields: GrantFields & { codeChallenge?: string; redirectUri?: string },
  now: Date,
  write: (ref: string, data: Data) => void,
): string {
  const token = newConnectorToken(kind, orgId);
  const parsed = parseConnectorToken(token, kind);
  if (!parsed) throw new Error('A new connector token failed to parse');
  const ttl =
    kind === 'code' ? CONNECTOR_CODE_TTL_MS : kind === 'access' ? CONNECTOR_ACCESS_TTL_MS : CONNECTOR_REFRESH_TTL_MS;
  const data = ConnectorGrant.schema.parse({
    kind,
    connectionId: fields.connectionId,
    uid: fields.uid,
    clientId: fields.clientId,
    scopes: [...fields.scopes],
    resource: fields.resource,
    expireAt: new Date(now.getTime() + ttl),
    ...(fields.codeChallenge ? { codeChallenge: fields.codeChallenge } : {}),
    ...(fields.redirectUri ? { redirectUri: fields.redirectUri } : {}),
    ...meta(now, fields.uid),
    schemaVersion: ConnectorGrant.version,
  });
  write(grantPath(orgId, parsed.hash), data);
  return token;
}

function issuePair(orgId: string, fields: GrantFields, now: Date, write: (ref: string, data: Data) => void): TokenSet {
  return {
    access_token: newGrant(orgId, 'access', fields, now, write),
    token_type: 'Bearer',
    expires_in: Math.floor(CONNECTOR_ACCESS_TTL_MS / 1000),
    refresh_token: newGrant(orgId, 'refresh', fields, now, write),
    scope: fields.scopes.join(' '),
  };
}

export interface NewConnection {
  orgId: string;
  uid: string;
  client: ConnectorClient;
  redirectUri: string;
  codeChallenge: string;
  scopes: readonly ConnectorScope[];
  resource: string;
  /** The Materia sign-in the person allowed it with, and whether it used a second factor. */
  authTime: Date;
  secondFactor: boolean;
}

/** Records a new connection and its authorization code (`connector-authorize`). */
export async function createConnection(
  deps: Pick<GrantDeps, 'db' | 'clock'>,
  input: NewConnection,
): Promise<{ connectionId: string; code: string }> {
  const { db, clock } = deps;
  const now = clock.now();
  const ref = db.collection(connectionsPath(input.orgId)).doc();
  const batch = db.batch();
  batch.create(
    ref,
    ConnectorConnection.schema.parse({
      uid: input.uid,
      clientId: input.client.id,
      clientName: input.client.name,
      scopes: [...input.scopes],
      status: 'active',
      authTime: input.authTime,
      secondFactor: input.secondFactor,
      connectedAt: now,
      ...meta(now, input.uid),
      schemaVersion: ConnectorConnection.version,
    }),
  );
  const code = newGrant(
    input.orgId,
    'code',
    {
      connectionId: ref.id,
      uid: input.uid,
      clientId: input.client.id,
      scopes: input.scopes,
      resource: input.resource,
      codeChallenge: input.codeChallenge,
      redirectUri: input.redirectUri,
    },
    now,
    (path, data) => batch.create(db.doc(path), data),
  );
  await batch.commit();
  return { connectionId: ref.id, code };
}

const grantFields = (grant: Data): GrantFields => ({
  connectionId: String(grant['connectionId']),
  uid: String(grant['uid']),
  clientId: String(grant['clientId']),
  scopes: (grant['scopes'] as ConnectorScope[] | undefined) ?? [],
  resource: String(grant['resource']),
});

const expired = (grant: Data, now: Date) => (toDate(grant['expireAt'])?.getTime() ?? 0) <= now.getTime();

/**
 * The authorization code grant (RFC 6749 4.1.3 with PKCE): one use, by the client it was issued
 * to, with the same redirect URI and the verifier of its challenge. A code used twice revokes the
 * connection it made (RFC 6749 4.1.2: it may have been stolen).
 */
export async function exchangeCode(
  deps: GrantDeps,
  params: { code: unknown; codeVerifier: unknown; clientId: unknown; redirectUri: unknown; resource?: unknown },
): Promise<TokenSet> {
  const { db, clock } = deps;
  const parsed = parseConnectorToken(params.code, 'code');
  if (!parsed) throw new OAuthError('invalid_grant', 'The code is not valid');
  const now = clock.now();
  const outcome = await db.runTransaction(async (tx) => {
    const ref = db.doc(grantPath(parsed.orgId, parsed.hash));
    const snap = await tx.get(ref);
    const grant = snap.data() as Data | undefined;
    if (!grant || grant['kind'] !== 'code') return { error: 'The code is not valid' } as const;
    const fields = grantFields(grant);
    if (grant['usedAt']) return { reused: fields.connectionId } as const;
    if (expired(grant, now)) return { error: 'The code has expired' } as const;
    if (params.clientId !== fields.clientId) return { error: 'The code was issued to another client' } as const;
    if (params.redirectUri !== grant['redirectUri']) return { error: 'redirect_uri does not match' } as const;
    if (!pkceMatches(params.codeVerifier, grant['codeChallenge'] as string | undefined)) {
      return { error: 'code_verifier does not match' } as const;
    }
    if (typeof params.resource === 'string' && params.resource && !sameResource(params.resource, fields.resource)) {
      return { target: true } as const;
    }
    const connection = await tx.get(db.doc(connectionPath(parsed.orgId, fields.connectionId)));
    if (connection.get('status') !== 'active') return { error: 'The connection was disconnected' } as const;
    tx.update(ref, { usedAt: now, updatedAt: now, updatedBy: fields.uid });
    return { tokens: issuePair(parsed.orgId, fields, now, (path, data) => tx.create(db.doc(path), data)) } as const;
  });
  if ('reused' in outcome) {
    await revokeConnection(deps, parsed.orgId, outcome.reused, { actor: 'system', reason: 'refresh_reuse' });
    deps.log.warn('connector code reused: connection revoked', { orgId: parsed.orgId });
    throw new OAuthError('invalid_grant', 'The code was already used');
  }
  if ('target' in outcome) throw new OAuthError('invalid_target', 'The code was issued for another resource');
  if ('error' in outcome) throw new OAuthError('invalid_grant', outcome.error);
  return outcome.tokens;
}

/**
 * The refresh token grant (RFC 6749 6), rotating: each refresh token works once and comes back
 * with a new pair. One that is presented again revokes its connection (RFC 9700 4.14.2). The
 * connection is checked like an MCP call first, so Claude learns at once when it has ended.
 */
export async function refreshGrant(
  deps: GrantDeps,
  params: { refreshToken: unknown; clientId: unknown; scope?: unknown; resource?: unknown },
): Promise<TokenSet> {
  const { db, clock } = deps;
  const parsed = parseConnectorToken(params.refreshToken, 'refresh');
  if (!parsed) throw new OAuthError('invalid_grant', 'The refresh token is not valid');
  const ref = db.doc(grantPath(parsed.orgId, parsed.hash));
  const first = (await ref.get()).data() as Data | undefined;
  if (!first || first['kind'] !== 'refresh') throw new OAuthError('invalid_grant', 'The refresh token is not valid');
  const fields = grantFields(first);
  if (params.clientId !== fields.clientId)
    throw new OAuthError('invalid_grant', 'The token was issued to another client');
  if (typeof params.resource === 'string' && params.resource && !sameResource(params.resource, fields.resource)) {
    throw new OAuthError('invalid_target', 'The token was issued for another resource');
  }
  const scopes = narrowScopes(fields.scopes, params.scope);
  const access = await resolvePrincipal(deps, parsed.orgId, fields.connectionId);
  if (!access.ok) throw new OAuthError('invalid_grant', DENIAL_DESCRIPTIONS[access.reason]);

  const now = clock.now();
  const outcome = await db.runTransaction(async (tx) => {
    const grant = (await tx.get(ref)).data() as Data | undefined;
    if (!grant) return { error: 'The refresh token is not valid' } as const;
    if (grant['usedAt']) return { reused: true } as const;
    if (expired(grant, now)) return { error: 'The refresh token has expired' } as const;
    tx.update(ref, { usedAt: now, updatedAt: now, updatedBy: fields.uid });
    return {
      tokens: issuePair(parsed.orgId, { ...fields, scopes }, now, (path, data) => tx.create(db.doc(path), data)),
    } as const;
  });
  if ('reused' in outcome) {
    await revokeConnection(deps, parsed.orgId, fields.connectionId, { actor: 'system', reason: 'refresh_reuse' });
    deps.log.warn('connector refresh token reused: connection revoked', { orgId: parsed.orgId });
    throw new OAuthError('invalid_grant', 'The refresh token was already used');
  }
  if ('error' in outcome) throw new OAuthError('invalid_grant', outcome.error);
  return outcome.tokens;
}

/** A refresh may ask for fewer scopes (RFC 6749 6), never more. */
function narrowScopes(granted: readonly ConnectorScope[], scope: unknown): ConnectorScope[] {
  if (typeof scope !== 'string' || !scope.trim()) return [...granted];
  const asked = scope.trim().split(/\s+/);
  if (asked.some((s) => !(granted as readonly string[]).includes(s))) {
    throw new OAuthError('invalid_scope', 'A refresh can’t add scopes');
  }
  return granted.filter((s) => asked.includes(s));
}

/**
 * Token revocation (RFC 7009): Claude revokes when a person removes the connector there. Any of a
 * connection's tokens ends the whole connection. Unknown tokens are fine (the response is the same).
 */
export async function revokeToken(deps: GrantDeps, token: unknown): Promise<void> {
  const parsed = parseConnectorToken(token);
  if (!parsed || parsed.kind === 'code') return;
  const grant = (await deps.db.doc(grantPath(parsed.orgId, parsed.hash)).get()).data() as Data | undefined;
  if (!grant) return;
  const fields = grantFields(grant);
  await revokeConnection(deps, parsed.orgId, fields.connectionId, { actor: fields.uid, reason: 'disconnected' });
}

export type Authentication =
  | { ok: true; principal: ConnectorPrincipal }
  | { ok: false; error: 'invalid_token'; description: string; presented: boolean };

/**
 * Checks an MCP request's bearer token: a live access token of this resource, whose connection,
 * member, sign-in, practice switch and flag all still allow it (`resolvePrincipal`). Marks the
 * connection used, at most every few minutes.
 */
export async function authenticate(
  deps: GrantDeps,
  bearer: string | undefined,
  resource: string,
): Promise<Authentication> {
  if (!bearer) return { ok: false, error: 'invalid_token', description: 'Sign in required', presented: false };
  const fail = (description: string): Authentication => ({
    ok: false,
    error: 'invalid_token',
    description,
    presented: true,
  });
  const parsed = parseConnectorToken(bearer, 'access');
  if (!parsed) return fail('The access token is not valid');
  const { db, clock } = deps;
  const ref = db.doc(grantPath(parsed.orgId, parsed.hash));
  const grant = (await ref.get()).data() as Data | undefined;
  const now = clock.now();
  if (!grant || grant['kind'] !== 'access') return fail('The access token is not valid');
  if (expired(grant, now)) return fail('The access token has expired');
  const fields = grantFields(grant);
  if (!sameResource(fields.resource, resource)) return fail('The access token is for another resource');
  const access = await resolvePrincipal(deps, parsed.orgId, fields.connectionId);
  if (!access.ok) return fail(DENIAL_DESCRIPTIONS[access.reason]);
  await touch(deps, ref, parsed.orgId, fields.connectionId, toDate(grant['touchedAt']), now);
  return { ok: true, principal: { ...access.principal, scopes: fields.scopes } };
}

async function touch(
  deps: GrantDeps,
  ref: DocumentReference,
  orgId: string,
  connectionId: string,
  touchedAt: Date | undefined,
  now: Date,
): Promise<void> {
  if (touchedAt && now.getTime() - touchedAt.getTime() < TOUCH_INTERVAL_MS) return;
  try {
    const batch = deps.db.batch();
    batch.update(ref, { touchedAt: now });
    batch.update(deps.db.doc(connectionPath(orgId, connectionId)), { lastUsedAt: now });
    await batch.commit();
  } catch (error) {
    // Best effort: "last used" is a convenience, never a reason to refuse a call.
    deps.log.warn('connector last-used not recorded', { orgId, error: String((error as Error)?.name ?? error) });
  }
}

const DELETE_BATCH = 400;

/**
 * Ends a connection: marks it revoked (once) and deletes every token it has, so the very next MCP
 * call or refresh is refused. Returns whether it was active.
 */
export async function revokeConnection(
  deps: Pick<GrantDeps, 'db' | 'clock'>,
  orgId: string,
  connectionId: string,
  by: { actor: string; reason: ConnectorRevokeReason },
): Promise<boolean> {
  const { db, clock } = deps;
  const now = clock.now();
  const ref = db.doc(connectionPath(orgId, connectionId));
  const changed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get('status') !== 'active') return false;
    tx.update(ref, {
      status: 'revoked',
      revokedAt: now,
      revokedBy: by.actor,
      revokeReason: by.reason,
      updatedAt: now,
      updatedBy: by.actor,
    });
    return true;
  });
  const grants = await db.collection(grantsPath(orgId)).where('connectionId', '==', connectionId).get();
  for (let i = 0; i < grants.docs.length; i += DELETE_BATCH) {
    const batch = db.batch();
    for (const doc of grants.docs.slice(i, i + DELETE_BATCH)) batch.delete(doc.ref);
    await batch.commit();
  }
  return changed;
}

/** Ends every active connection in the practice, or a person's. Returns how many ended. */
export async function revokeConnections(
  deps: Pick<GrantDeps, 'db' | 'clock'>,
  orgId: string,
  filter: { uid?: string },
  by: { actor: string; reason: ConnectorRevokeReason },
): Promise<number> {
  let query = deps.db.collection(connectionsPath(orgId)).where('status', '==', 'active');
  if (filter.uid) query = query.where('uid', '==', filter.uid);
  const active = await query.get();
  let revoked = 0;
  for (const doc of active.docs) if (await revokeConnection(deps, orgId, doc.id, by)) revoked++;
  return revoked;
}
