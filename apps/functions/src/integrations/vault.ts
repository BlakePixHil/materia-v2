import { randomUUID } from 'node:crypto';

import type { DocumentSnapshot, Firestore } from 'firebase-admin/firestore';

import {
  DomainError,
  integrationDocId,
  OAUTH_PROVIDER_INFO,
  OAUTH_PROVIDERS,
  PERMISSIONS,
  type IntegrationAccount,
  type IntegrationStatusReason,
  type OAuthProvider,
  type Role,
} from '@materia/domain';

import { retryAfterMs } from './oauth';
import { errorReportFields, type Log } from '../core/log';
import { notify } from '../notifications/notify';
import { OAuthError, type Clock, type OAuthTokenSet, type Ports } from '../ports';

/**
 * The OAuth token vault (INT-01, ADR-019, ADR-051). Each connection's refresh token is encrypted
 * with the `oauth-tokens` KMS key, bound to its document path, in the server-only
 * `integrations/{id}`; `integrationStatus/{id}` mirrors what clients may see. Access tokens live
 * only in this process's memory. Providers build their API clients on `authorizedFetch`.
 */

export const integrationPath = (orgId: string, id: string) => `orgs/${orgId}/integrations/${id}`;
export const integrationStatusPath = (orgId: string, id: string) => `orgs/${orgId}/integrationStatus/${id}`;

/** The longest an access token is reused, whatever the provider says (the ticket: under 50 minutes). */
export const ACCESS_TOKEN_MAX_MS = 50 * 60_000;
/** Access tokens are refreshed this long before they expire. */
export const ACCESS_TOKEN_MARGIN_MS = 2 * 60_000;

/** What the vault needs: a callable's context, or a task's. */
export interface VaultContext {
  orgId: string;
  db: Firestore;
  clock: Clock;
  log: Log;
  ports: Pick<Ports, 'oauth' | 'oauthKms' | 'tasks'>;
}

/** A connection: the provider, and the person for per-person providers (ignored for the practice's). */
export interface ConnectionRef {
  provider: OAuthProvider;
  uid: string | null;
}

function connectionPaths(orgId: string, ref: ConnectionRef) {
  const level = OAUTH_PROVIDER_INFO[ref.provider].level;
  if (level === 'user' && !ref.uid) throw new DomainError('INVALID_ARGUMENT', 'A per-person connection needs a uid');
  const id = integrationDocId(ref.provider, ref.uid ?? '');
  return {
    id,
    level,
    owner: level === 'org' ? null : ref.uid,
    path: integrationPath(orgId, id),
    statusPath: integrationStatusPath(orgId, id),
  };
}

const accessTokens = new Map<string, { connectionId: string; token: string; expiresAt: number }>();
const refreshing = new Map<string, Promise<string>>();

/** Tests: forget every cached access token. */
export function clearAccessTokens(): void {
  accessTokens.clear();
  refreshing.clear();
}

function cacheAccessToken(path: string, connectionId: string, tokens: OAuthTokenSet, now: number): void {
  const lifetime = Math.min(tokens.expiresIn * 1000 - ACCESS_TOKEN_MARGIN_MS, ACCESS_TOKEN_MAX_MS);
  if (lifetime > 0) accessTokens.set(path, { connectionId, token: tokens.accessToken, expiresAt: now + lifetime });
}

/** Revokes a stored refresh token at the provider. Best effort: a failure is logged, never thrown. */
async function revokeStored(
  ctx: VaultContext,
  provider: OAuthProvider,
  path: string,
  ciphertext: unknown,
): Promise<boolean> {
  if (typeof ciphertext !== 'string' || !ciphertext) return false;
  try {
    const refreshToken = await ctx.ports.oauthKms.decrypt(ciphertext, path);
    return await ctx.ports.oauth.revoke(provider, refreshToken);
  } catch (error) {
    ctx.log.warn('integration token revoke failed', {
      provider,
      ...(error instanceof OAuthError ? { failure: error.failure, status: error.status } : errorReportFields(error)),
    });
    return false;
  }
}

/** Maps a provider failure to the error a person sees. */
export function oauthFailure(error: unknown, provider: OAuthProvider): DomainError {
  if (error instanceof DomainError) return error;
  if (!(error instanceof OAuthError)) return new DomainError('UNAVAILABLE', `${provider} OAuth failed`, { provider });
  switch (error.failure) {
    case 'not_configured':
      return new DomainError('INTEGRATION_NOT_CONFIGURED', `${provider} has no OAuth client`, { provider });
    case 'invalid_grant':
      return new DomainError('INTEGRATION_REJECTED', `${provider} refused the grant`, { provider, reason: 'rejected' });
    case 'consent_required':
      return new DomainError('INTEGRATION_REJECTED', `${provider} needs admin consent`, {
        provider,
        reason: 'consent_required',
      });
    case 'rejected':
      return new DomainError('INTEGRATION_REJECTED', `${provider} refused the request`, {
        provider,
        reason: 'rejected',
      });
    default:
      return new DomainError('UNAVAILABLE', `${provider} is unavailable`, {
        provider,
        ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
      });
  }
}

export interface SaveConnectionInput {
  provider: OAuthProvider;
  /** Who connected (and, for per-person providers, whose connection it is). */
  uid: string;
  tokens: OAuthTokenSet;
}

/**
 * Stores a new connection: the refresh token encrypted and bound to the document path, a new
 * `connectionId`, and the status mirror. Connecting again replaces the old token, which is then
 * revoked at the provider.
 */
export async function saveConnection(
  ctx: VaultContext,
  input: SaveConnectionInput,
): Promise<{ replaced: boolean; account?: IntegrationAccount }> {
  const { provider, uid, tokens } = input;
  if (!tokens.refreshToken) {
    // Without offline access there is nothing to keep: the connection would die within the hour.
    throw new DomainError('INTEGRATION_REJECTED', `${provider} returned no refresh token`, {
      provider,
      reason: 'rejected',
    });
  }
  const { db, clock, orgId } = ctx;
  const { level, owner, path, statusPath } = connectionPaths(orgId, { provider, uid });
  const sealed = await ctx.ports.oauthKms.encrypt(tokens.refreshToken, path);
  const connectionId = randomUUID();
  const at = clock.now();
  const scopes = tokens.scopes ?? [];
  const account = tokens.account;
  const previous = await db.runTransaction(async (tx) => {
    const before = await tx.get(db.doc(path));
    const created = { createdAt: before.get('createdAt') ?? at, createdBy: before.get('createdBy') ?? uid };
    tx.set(db.doc(path), {
      provider,
      uid: owner,
      level,
      status: 'connected',
      connectionId,
      scopes,
      ...(account ? { account } : {}),
      encryptedRefreshToken: sealed.ciphertext,
      kmsKeyVersion: sealed.keyVersion,
      connectedAt: at,
      connectedBy: uid,
      ...created,
      updatedAt: at,
      updatedBy: uid,
      schemaVersion: 1,
    });
    tx.set(db.doc(statusPath), {
      provider,
      level,
      uid: owner,
      status: 'connected',
      scopes,
      ...(account ? { account } : {}),
      connectedAt: at,
      connectedBy: uid,
      createdAt: at,
      createdBy: uid,
      updatedAt: at,
      updatedBy: uid,
      schemaVersion: 1,
    });
    return before.exists ? (before.get('encryptedRefreshToken') as unknown) : null;
  });
  cacheAccessToken(path, connectionId, tokens, at.getTime());
  if (previous !== null) await revokeStored(ctx, provider, path, previous);
  ctx.log.info('integration connected', { provider, level, replaced: previous !== null });
  return { replaced: previous !== null, ...(account ? { account } : {}) };
}

/**
 * Deletes a connection's token and marks its status `disconnected`, then revokes the token at the
 * provider where it can (best effort: the token is never used again either way).
 */
export async function removeConnection(
  ctx: VaultContext,
  ref: ConnectionRef,
  by: { actor: string; reason: IntegrationStatusReason },
): Promise<{ removed: boolean; revoked: boolean }> {
  const { db, clock, orgId } = ctx;
  const { level, owner, path, statusPath } = connectionPaths(orgId, ref);
  const at = clock.now();
  const ciphertext = await db.runTransaction(async (tx) => {
    const [token, status] = await Promise.all([tx.get(db.doc(path)), tx.get(db.doc(statusPath))]);
    if (!token.exists) return null;
    tx.delete(token.ref);
    tx.set(db.doc(statusPath), {
      provider: ref.provider,
      level,
      uid: owner,
      status: 'disconnected',
      scopes: [],
      disconnectedAt: at,
      disconnectedBy: by.actor,
      reason: by.reason,
      createdAt: status.get('createdAt') ?? at,
      createdBy: status.get('createdBy') ?? by.actor,
      updatedAt: at,
      updatedBy: by.actor,
      schemaVersion: 1,
    });
    return (token.get('encryptedRefreshToken') as unknown) ?? '';
  });
  accessTokens.delete(path);
  if (ciphertext === null) return { removed: false, revoked: false };
  const revoked = await revokeStored(ctx, ref.provider, path, ciphertext);
  ctx.log.info('integration disconnected', { provider: ref.provider, level, reason: by.reason, revoked });
  return { removed: true, revoked };
}

/** The person's own connections, revoked and deleted when they leave the org (FND-17). Best effort. */
export async function removeMemberConnections(ctx: VaultContext, uid: string): Promise<number> {
  const snapshot = await ctx.db.collection(`orgs/${ctx.orgId}/integrations`).where('uid', '==', uid).get();
  let removed = 0;
  for (const doc of snapshot.docs) {
    const provider = doc.get('provider') as OAuthProvider;
    if (!(OAUTH_PROVIDERS as readonly string[]).includes(provider)) continue;
    if (OAUTH_PROVIDER_INFO[provider].level !== 'user') continue;
    try {
      const result = await removeConnection(ctx, { provider, uid }, { actor: 'system', reason: 'member_removed' });
      if (result.removed) removed++;
    } catch (error) {
      ctx.log.warn('member integration removal failed', { provider, ...errorReportFields(error) });
    }
  }
  return removed;
}

/** Who hears that a connection stopped working: the person, or the practice's owners and admins. */
export async function reconnectRecipients(ctx: VaultContext, owner: string | null): Promise<string[]> {
  if (owner) return [owner];
  const admins = PERMISSIONS['org.settings'] as readonly Role[];
  const members = await ctx.db.collection(`orgs/${ctx.orgId}/members`).where('status', '==', 'active').get();
  return members.docs.filter((member) => admins.includes(member.get('role') as Role)).map((member) => member.id);
}

/**
 * The provider refused the refresh token (`invalid_grant`): the connection needs reconnecting.
 * Marks it once (unless it was replaced or removed meanwhile) and tells whoever can reconnect it.
 * Nothing retries: every later call fails fast until someone connects again.
 */
async function markReconnectRequired(ctx: VaultContext, ref: ConnectionRef, connectionId: string): Promise<void> {
  const { db, clock, orgId } = ctx;
  const { owner, path, statusPath, id } = connectionPaths(orgId, ref);
  accessTokens.delete(path);
  const at = clock.now();
  const changed = await db.runTransaction(async (tx) => {
    const current = await tx.get(db.doc(path));
    if (!current.exists || current.get('connectionId') !== connectionId || current.get('status') !== 'connected')
      return false;
    tx.update(current.ref, {
      status: 'reconnect_required',
      reconnectRequiredAt: at,
      updatedAt: at,
      updatedBy: 'system',
    });
    tx.set(
      db.doc(statusPath),
      { status: 'reconnect_required', reason: 'revoked', reconnectRequiredAt: at, updatedAt: at, updatedBy: 'system' },
      { merge: true },
    );
    return true;
  });
  if (!changed) return;
  ctx.log.warn('integration needs reconnecting', { provider: ref.provider });
  const info = OAUTH_PROVIDER_INFO[ref.provider];
  try {
    await notify(ctx, {
      kind: 'integration_error',
      provider: ref.provider,
      title: `${info.label} needs reconnecting`,
      body: owner
        ? `Materia can no longer reach your ${info.label} account. Connect it again in Settings.`
        : `Materia can no longer reach the practice’s ${info.label}. An owner or admin needs to connect it again in Settings.`,
      link: info.settingsPath,
      recipients: await reconnectRecipients(ctx, owner),
      key: `integration-${id}-${connectionId}`,
    });
  } catch (error) {
    ctx.log.warn('integration reconnect notification failed', { provider: ref.provider, ...errorReportFields(error) });
  }
}

interface LiveConnection {
  path: string;
  connectionId: string;
  snapshot: DocumentSnapshot;
}

async function liveConnection(ctx: VaultContext, ref: ConnectionRef): Promise<LiveConnection> {
  const { path } = connectionPaths(ctx.orgId, ref);
  const snapshot = await ctx.db.doc(path).get();
  if (!snapshot.exists)
    throw new DomainError('INTEGRATION_RECONNECT_REQUIRED', `${ref.provider} is not connected`, {
      provider: ref.provider,
      reason: 'not_connected',
    });
  if (snapshot.get('status') !== 'connected')
    throw new DomainError('INTEGRATION_RECONNECT_REQUIRED', `${ref.provider} needs reconnecting`, {
      provider: ref.provider,
      reason: 'reconnect_required',
    });
  return { path, connectionId: String(snapshot.get('connectionId') ?? ''), snapshot };
}

async function refreshAccessToken(ctx: VaultContext, ref: ConnectionRef, live: LiveConnection): Promise<string> {
  const { db, clock } = ctx;
  const { path, connectionId, snapshot } = live;
  const refreshToken = await ctx.ports.oauthKms.decrypt(String(snapshot.get('encryptedRefreshToken') ?? ''), path);
  let tokens: OAuthTokenSet;
  try {
    tokens = await ctx.ports.oauth.refresh(ref.provider, refreshToken);
  } catch (error) {
    if (error instanceof OAuthError && error.failure === 'invalid_grant') {
      await markReconnectRequired(ctx, ref, connectionId);
      throw new DomainError('INTEGRATION_RECONNECT_REQUIRED', `${ref.provider} refused the refresh token`, {
        provider: ref.provider,
        reason: 'revoked',
      });
    }
    throw oauthFailure(error, ref.provider);
  }
  const at = clock.now();
  if (tokens.refreshToken && tokens.refreshToken !== refreshToken) {
    // The provider rotated the refresh token (Xero does on every refresh): keep the new one, unless
    // the connection was replaced or removed while we refreshed.
    const sealed = await ctx.ports.oauthKms.encrypt(tokens.refreshToken, path);
    await db.runTransaction(async (tx) => {
      const current = await tx.get(db.doc(path));
      if (!current.exists || current.get('connectionId') !== connectionId) return;
      tx.update(current.ref, {
        encryptedRefreshToken: sealed.ciphertext,
        kmsKeyVersion: sealed.keyVersion,
        refreshedAt: at,
        updatedAt: at,
        updatedBy: 'system',
      });
    });
  }
  cacheAccessToken(path, connectionId, tokens, at.getTime());
  return tokens.accessToken;
}

/**
 * A current access token for a connection: from memory while it has more than two minutes left
 * (and at most 50 minutes old), else refreshed. Concurrent callers in one instance share a refresh,
 * so a rotating refresh token is used once. Throws INTEGRATION_RECONNECT_REQUIRED when there is no
 * working connection.
 */
export async function accessToken(ctx: VaultContext, ref: ConnectionRef): Promise<string> {
  const live = await liveConnection(ctx, ref);
  const cached = accessTokens.get(live.path);
  if (cached && cached.connectionId === live.connectionId && cached.expiresAt > ctx.clock.now().getTime())
    return cached.token;
  const key = `${live.path}#${live.connectionId}`;
  let pending = refreshing.get(key);
  if (!pending) {
    pending = refreshAccessToken(ctx, ref, live).finally(() => refreshing.delete(key));
    refreshing.set(key, pending);
  }
  return pending;
}

export interface AuthorizedFetchOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Retries after a 429 or 503 (default 2). */
  maxRetries?: number;
  /** The longest `Retry-After` waited out in-process (default 5 s); longer ones throw RATE_LIMITED. */
  maxWaitMs?: number;
}

/**
 * `fetch` with the connection's bearer token. A 401 drops the cached token and retries once with a
 * fresh one; a 429 or 503 waits out `Retry-After` (or backs off) up to `maxRetries` times, then
 * throws RATE_LIMITED with `details.retryAfterMs` so a task can be rescheduled. The request body
 * must be replayable (a string or bytes). Other responses are returned as they are.
 */
export async function authorizedFetch(
  ctx: VaultContext,
  ref: ConnectionRef,
  url: string,
  init: RequestInit = {},
  options: AuthorizedFetchOptions = {},
): Promise<Response> {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxRetries = options.maxRetries ?? 2;
  const maxWaitMs = options.maxWaitMs ?? 5_000;
  const { path } = connectionPaths(ctx.orgId, ref);
  let reauthorised = false;
  let retries = 0;
  for (;;) {
    const token = await accessToken(ctx, ref);
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    const response = await doFetch(url, { ...init, headers });
    if (response.status === 401 && !reauthorised) {
      reauthorised = true;
      accessTokens.delete(path);
      continue;
    }
    if (response.status === 429 || response.status === 503) {
      const wait = retryAfterMs(response.headers.get('retry-after'), ctx.clock.now().getTime()) ?? 1000 * 2 ** retries;
      if (retries < maxRetries && wait <= maxWaitMs) {
        retries++;
        await sleep(wait);
        continue;
      }
      throw new DomainError('RATE_LIMITED', `${ref.provider} is rate limiting`, {
        provider: ref.provider,
        retryAfterMs: wait,
      });
    }
    return response;
  }
}
