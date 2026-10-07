import * as z from 'zod';

import {
  AuthorizeConnectorInput,
  canManageConnections,
  connectorServerUrl,
  DisconnectConnectorInput,
  DomainError,
  parseConnectorAuthorization,
  PERMISSIONS,
  resolveConnectorSettings,
  ROLES,
  SENSITIVE_REAUTH_MINUTES,
  SetConnectorPracticeInput,
  usedSecondFactor,
  type AuthorizeConnectorResult,
  type DisconnectConnectorResult,
  type SetConnectorPracticeResult,
} from '@materia/domain';

import { createConnection, revokeConnection, revokeConnections } from './grants';
import { connectionPath } from './tokens';
import { audit } from '../audit/audit';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { isEmulator } from '../core/env';
import { requireFlag } from '../core/flags';
import { appUrl } from '../orgs/shared';

/** Local origins the emulator may serve the consent page and MCP endpoint on. */
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

/** The issuer and MCP resource's origin: the app's address; only the emulator follows the browser's. */
export function connectorIssuer(origin: string | undefined): string {
  if (isEmulator() && origin && LOCAL_ORIGIN.test(origin)) return origin;
  return appUrl();
}

const AuthorizeInput = AuthorizeConnectorInput.extend({
  /** The consent page's origin; only the emulator uses it. */
  origin: z.string().max(200).optional(),
});

/**
 * `connector-authorize` (INT-07, ADR-064): the person allowed Claude on the consent page. Needs the
 * flag, the practice's switch, and a sign-in within five minutes (connecting an app is
 * sensitive, as for INT-01). The request is checked again against the pinned clients, PKCE and
 * this server's resource. Records the connection with the sign-in it was allowed under (it ends
 * with that sign-in, SEC-04) and returns the redirect back to Claude with a one-use code.
 */
export const authorizeDefinition = {
  name: 'connector-authorize',
  input: AuthorizeInput,
  roles: ROLES,
  idempotent: true,
  recentLoginMinutes: SENSITIVE_REAUTH_MINUTES,
  handler: async (ctx): Promise<AuthorizeConnectorResult> => {
    const { input, uid, orgId, token, db, log } = ctx;
    await requireFlag(ctx, 'integrations.claudeConnector');
    const org = await db.doc(`orgs/${orgId}`).get();
    if (!resolveConnectorSettings(org.get('settings')?.connector).enabled) {
      throw new DomainError('CONNECTOR_OFF', 'The practice hasn’t turned the Claude connector on');
    }
    const issuer = connectorIssuer(input.origin);
    const parsed = parseConnectorAuthorization(
      {
        response_type: 'code',
        client_id: input.clientId,
        redirect_uri: input.redirectUri,
        code_challenge: input.codeChallenge,
        code_challenge_method: input.codeChallengeMethod,
        scope: input.scopes.join(' '),
        state: input.state,
        resource: input.resource,
      },
      connectorServerUrl(issuer),
    );
    if (!parsed.ok) {
      throw new DomainError('CONNECTOR_REQUEST_INVALID', 'The connection request isn’t valid', { error: parsed.error });
    }
    const { client, redirectUri, codeChallenge, scopes, state } = parsed.request;
    const authTime = typeof token['auth_time'] === 'number' ? new Date(token['auth_time'] * 1000) : ctx.clock.now();
    const { connectionId, code } = await createConnection(ctx, {
      orgId,
      uid,
      client,
      redirectUri,
      codeChallenge,
      scopes,
      resource: connectorServerUrl(issuer),
      authTime,
      secondFactor: usedSecondFactor(token),
    });
    await audit(ctx, {
      action: 'connector.connected',
      entity: { path: connectionPath(orgId, connectionId) },
      summary: `${client.name} connected`,
      data: { client: client.name, scopes },
    });
    log.info('connector connected', { client: client.name, scopes });
    const url = new URL(redirectUri);
    url.searchParams.set('code', code);
    if (state) url.searchParams.set('state', state);
    url.searchParams.set('iss', issuer);
    return { redirectUrl: url.toString(), connectionId };
  },
} satisfies CallableDefinition<typeof AuthorizeInput, AuthorizeConnectorResult>;

/**
 * `connector-setPractice` (INT-07): an owner or admin turns the Claude connector on or off for the
 * practice, and whether Claude may suggest changes. Turning it off ends every connection, so
 * turning it back on means each person connects again. Audited either way.
 */
export const setPracticeDefinition = {
  name: 'connector-setPractice',
  input: SetConnectorPracticeInput,
  roles: PERMISSIONS['org.settings'],
  idempotent: true,
  recentLoginMinutes: SENSITIVE_REAUTH_MINUTES,
  handler: async (ctx): Promise<SetConnectorPracticeResult> => {
    const { input, uid, orgId, db, clock, log } = ctx;
    await requireFlag(ctx, 'integrations.claudeConnector');
    const ref = db.doc(`orgs/${orgId}`);
    const at = clock.now();
    const before = await db.runTransaction(async (tx) => {
      const org = await tx.get(ref);
      if (!org.exists) throw new DomainError('NOT_FOUND', 'Org not found');
      const current = resolveConnectorSettings(org.get('settings')?.connector);
      tx.update(ref, {
        'settings.connector': {
          enabled: input.enabled,
          allowProposals: input.allowProposals,
          updatedBy: uid,
          updatedAt: at,
        },
        updatedAt: at,
        updatedBy: uid,
      });
      return current;
    });
    const revoked = input.enabled ? 0 : await revokeConnections(ctx, orgId, {}, { actor: uid, reason: 'practice_off' });
    const changes: Record<string, { from: boolean; to: boolean }> = {};
    if (before.enabled !== input.enabled) changes['enabled'] = { from: before.enabled, to: input.enabled };
    if (before.allowProposals !== input.allowProposals) {
      changes['allowProposals'] = { from: before.allowProposals, to: input.allowProposals };
    }
    if (Object.keys(changes).length || revoked) {
      await audit(ctx, {
        action: input.enabled ? 'connector.practice_enabled' : 'connector.practice_disabled',
        entity: { path: `orgs/${orgId}/settings/connector` },
        summary: input.enabled
          ? `Claude connector turned on${input.allowProposals ? '' : ', without suggestions'}`
          : 'Claude connector turned off',
        data: { changes, ...(revoked ? { connectionsEnded: revoked } : {}) },
      });
    }
    log.info('connector practice settings', { enabled: input.enabled, allowProposals: input.allowProposals, revoked });
    return { enabled: input.enabled, allowProposals: input.allowProposals, revoked };
  },
} satisfies CallableDefinition<typeof SetConnectorPracticeInput, SetConnectorPracticeResult>;

/**
 * `connector-disconnect` (INT-07): ends a connection at once, the person's own or (for an owner or
 * admin) anyone's. Claude's next call or refresh is refused. Allowed while the practice is
 * read-only (SEC-05): it takes access away.
 */
export const disconnectDefinition = {
  name: 'connector-disconnect',
  input: DisconnectConnectorInput,
  roles: ROLES,
  idempotent: true,
  handler: async (ctx): Promise<DisconnectConnectorResult> => {
    const { input, uid, orgId, role, db } = ctx;
    const snap = await db.doc(connectionPath(orgId, input.connectionId)).get();
    // Someone else's connection doesn't exist to a person who can't manage it.
    if (!snap.exists || (snap.get('uid') !== uid && !canManageConnections(role))) {
      throw new DomainError('NOT_FOUND', 'No such connection');
    }
    const revoked = await revokeConnection(ctx, orgId, input.connectionId, { actor: uid, reason: 'disconnected' });
    if (revoked) {
      await audit(ctx, {
        action: 'connector.disconnected',
        entity: { path: connectionPath(orgId, input.connectionId) },
        summary: `${String(snap.get('clientName') ?? 'Claude')} disconnected`,
        data: { ...(snap.get('uid') !== uid ? { ofMember: String(snap.get('uid')) } : {}) },
      });
    }
    return { revoked };
  },
} satisfies CallableDefinition<typeof DisconnectConnectorInput, DisconnectConnectorResult>;

export const authorize = defineCallable(authorizeDefinition);
export const setPractice = defineCallable(setPracticeDefinition);
export const disconnect = defineCallable(disconnectDefinition);
