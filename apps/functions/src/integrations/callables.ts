import {
  CompleteIntegrationInput,
  DEFAULT_INTEGRATION_RETURN,
  DisconnectIntegrationInput,
  DomainError,
  INTEGRATION_STATE_TTL_MS,
  integrationCallbackPath,
  integrationDocId,
  OAUTH_PROVIDER_INFO,
  PERMISSIONS,
  ROLES,
  SENSITIVE_REAUTH_MINUTES,
  StartIntegrationInput,
  type CompleteIntegrationResult,
  type DisconnectIntegrationResult,
  type IntegrationLevel,
  type OAuthProvider,
  type Role,
  type StartIntegrationResult,
} from '@materia/domain';

import { OAUTH_SECRETS } from './providers';
import { integrationStatePath, newPkce, newState } from './state';
import { integrationPath, oauthFailure, removeConnection, saveConnection } from './vault';
import { audit } from '../audit/audit';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { isEmulator } from '../core/env';
import { requireFlag } from '../core/flags';
import { appUrl } from '../orgs/shared';

/** A practice connection is an owner's or admin's to make or remove; a person's own is theirs. */
function assertMayConnect(role: Role, level: IntegrationLevel, provider: OAuthProvider): void {
  if (level === 'org' && !(PERMISSIONS['org.settings'] as readonly Role[]).includes(role)) {
    throw new DomainError('PERMISSION_DENIED', `Role ${role} cannot connect the practice’s ${provider}`);
  }
}

/** Local origins the emulator may send the browser back to (the dev server and Hosting's emulator). */
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

/**
 * Where the provider sends the browser back: the deployed app's own address, which is what each
 * provider has registered. Only the emulator follows the browser's origin.
 */
function redirectOrigin(origin: string | undefined): string {
  if (isEmulator() && origin && LOCAL_ORIGIN.test(origin)) return origin;
  return appUrl();
}

/**
 * `integrations-start` (INT-01, ADR-051): begins connecting a provider. Needs the provider's flag,
 * a sign-in within five minutes (Security doc) and, for a practice connection, `org.settings`.
 * Stores the attempt (the PKCE verifier, who started it and where to come back to) under the
 * hash of a random `state`, and returns the provider's consent page.
 */
export const startDefinition = {
  name: 'integrations-start',
  input: StartIntegrationInput,
  roles: ROLES,
  idempotent: true,
  recentLoginMinutes: SENSITIVE_REAUTH_MINUTES,
  secrets: OAUTH_SECRETS,
  handler: async (ctx): Promise<StartIntegrationResult> => {
    const { input, uid, orgId, role, db, clock, ports, log } = ctx;
    const { provider } = input;
    const info = OAUTH_PROVIDER_INFO[provider];
    assertMayConnect(role, info.level, provider);
    if (!info.flag) throw new DomainError('FEATURE_DISABLED', `${provider} isn’t available yet`, { provider });
    await requireFlag(ctx, info.flag);

    const state = newState();
    const pkce = newPkce();
    const redirectUri = `${redirectOrigin(input.origin)}${integrationCallbackPath(provider)}`;
    let url: string;
    try {
      url = await ports.oauth.authorizationUrl(provider, { state, codeChallenge: pkce.challenge, redirectUri });
    } catch (error) {
      throw oauthFailure(error, provider);
    }
    const at = clock.now();
    await db.doc(integrationStatePath(orgId, state)).create({
      provider,
      level: info.level,
      uid,
      codeVerifier: pkce.verifier,
      redirectUri,
      returnTo: input.returnTo ?? DEFAULT_INTEGRATION_RETURN,
      expireAt: new Date(at.getTime() + INTEGRATION_STATE_TTL_MS),
      createdAt: at,
      createdBy: uid,
      updatedAt: at,
      updatedBy: uid,
      schemaVersion: 1,
    });
    log.info('integration connect started', { provider });
    return { url };
  },
} satisfies CallableDefinition<typeof StartIntegrationInput, StartIntegrationResult>;

type Attempt =
  | { ok: true; codeVerifier: string; redirectUri: string; returnTo: string }
  | { ok: false; reason: 'unknown' | 'other_user' | 'provider' | 'expired' };

/**
 * `integrations-complete` (INT-01, ADR-051): the app's callback route calls it with the `state` and
 * `code` the provider sent back. The attempt must exist, belong to the caller and be under ten
 * minutes old; it is used up either way (someone else's attempt is left alone). Then the code is
 * exchanged with the PKCE verifier and the vault stores the encrypted refresh token.
 */
export const completeDefinition = {
  name: 'integrations-complete',
  input: CompleteIntegrationInput,
  roles: ROLES,
  idempotent: true,
  secrets: OAUTH_SECRETS,
  handler: async (ctx): Promise<CompleteIntegrationResult> => {
    const { input, uid, orgId, role, db, clock, ports, log } = ctx;
    const { provider } = input;
    const info = OAUTH_PROVIDER_INFO[provider];
    const ref = db.doc(integrationStatePath(orgId, input.state));
    const now = clock.now().getTime();
    const attempt = await db.runTransaction(async (tx): Promise<Attempt> => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return { ok: false, reason: 'unknown' };
      // Someone else's attempt (a link sent to the wrong person) stays theirs to finish.
      if (snapshot.get('uid') !== uid) return { ok: false, reason: 'other_user' };
      tx.delete(ref);
      if (snapshot.get('provider') !== provider) return { ok: false, reason: 'provider' };
      const expireAt = snapshot.get('expireAt') as { toMillis(): number } | undefined;
      if (!expireAt || expireAt.toMillis() <= now) return { ok: false, reason: 'expired' };
      return {
        ok: true,
        codeVerifier: String(snapshot.get('codeVerifier')),
        redirectUri: String(snapshot.get('redirectUri')),
        returnTo: String(snapshot.get('returnTo') ?? DEFAULT_INTEGRATION_RETURN),
      };
    });
    if (!attempt.ok) {
      log.warn('integration connect refused', { provider, reason: attempt.reason });
      throw new DomainError('INTEGRATION_STATE_INVALID', 'Unknown, used, expired or someone else’s attempt', {
        provider,
        reason: attempt.reason,
      });
    }
    // The role may have changed since the attempt started.
    assertMayConnect(role, info.level, provider);

    let tokens;
    try {
      tokens = await ports.oauth.exchangeCode(provider, {
        code: input.code,
        codeVerifier: attempt.codeVerifier,
        redirectUri: attempt.redirectUri,
      });
    } catch (error) {
      throw oauthFailure(error, provider);
    }
    const { replaced, account } = await saveConnection(ctx, { provider, uid, tokens });
    await audit(ctx, {
      action: 'integration.connected',
      entity: { path: integrationPath(orgId, integrationDocId(provider, uid)) },
      summary: `${info.label} connected`,
      data: { provider, level: info.level, replaced, scopes: tokens.scopes ?? [] },
    });
    return { provider, returnTo: attempt.returnTo, ...(account ? { account } : {}) };
  },
} satisfies CallableDefinition<typeof CompleteIntegrationInput, CompleteIntegrationResult>;

/**
 * `integrations-disconnect` (INT-01): deletes the connection's token, marks it disconnected and
 * revokes the token where the provider can. Works whether or not the provider's flag is on.
 */
export const disconnectDefinition = {
  name: 'integrations-disconnect',
  input: DisconnectIntegrationInput,
  roles: ROLES,
  idempotent: true,
  secrets: OAUTH_SECRETS,
  handler: async (ctx): Promise<DisconnectIntegrationResult> => {
    const { input, uid, orgId, role } = ctx;
    const { provider } = input;
    const info = OAUTH_PROVIDER_INFO[provider];
    assertMayConnect(role, info.level, provider);
    const { removed, revoked } = await removeConnection(ctx, { provider, uid }, { actor: uid, reason: 'disconnected' });
    if (removed) {
      await audit(ctx, {
        action: 'integration.disconnected',
        entity: { path: integrationPath(orgId, integrationDocId(provider, uid)) },
        summary: `${info.label} disconnected`,
        data: { provider, level: info.level, revoked },
      });
    }
    return { disconnected: removed, revoked };
  },
} satisfies CallableDefinition<typeof DisconnectIntegrationInput, DisconnectIntegrationResult>;

export const start = defineCallable(startDefinition);
export const complete = defineCallable(completeDefinition);
export const disconnect = defineCallable(disconnectDefinition);
