import type { IntegrationAccount, OAuthProvider } from '@materia/domain';

import { OAUTH_PROVIDER_CONFIGS, type OAuthProviderConfig } from './providers';
import { secretValue } from '../core/secrets';
import { OAuthError, type OAuthPort, type OAuthTokenSet } from '../ports';

/** How long a token endpoint call may take. */
export const OAUTH_TIMEOUT_MS = 15_000;

/**
 * `Retry-After` as milliseconds: delta-seconds or an HTTP date (RFC 9110). Undefined when absent
 * or unreadable.
 */
export function retryAfterMs(header: string | null | undefined, now: number = Date.now()): number | undefined {
  if (!header) return undefined;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** The claims of a JWT, unverified: only for ID tokens read straight from the token endpoint over TLS. */
export function jwtClaims(token: unknown): Record<string, unknown> | undefined {
  if (typeof token !== 'string') return undefined;
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' ? (claims as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const text = (value: unknown, max: number) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;

/** The standard OpenID claims: email (or the sign-in name), name and an Entra tenant id. */
export function defaultAccount(claims: Record<string, unknown>): IntegrationAccount | undefined {
  const email = text(claims['email'], 320) ?? text(claims['preferred_username'], 320);
  const name = text(claims['name'], 200);
  const tenantId = text(claims['tid'], 200);
  const account = { ...(email ? { email } : {}), ...(name ? { name } : {}), ...(tenantId ? { tenantId } : {}) };
  return Object.keys(account).length ? account : undefined;
}

/**
 * A refused token request, classified from the RFC 6749 error code. Only the code goes in the
 * message: `error_description` can echo request details.
 */
export function classifyTokenError(status: number, body: unknown, retryAfter?: number): OAuthError {
  const code = body && typeof body === 'object' ? (body as Record<string, unknown>)['error'] : undefined;
  const message = `token endpoint: ${typeof code === 'string' ? code : status}`;
  if (status === 429 || status >= 500) return new OAuthError('transient', message, status, retryAfter);
  if (code === 'invalid_grant') return new OAuthError('invalid_grant', message, status);
  if (code === 'consent_required' || code === 'interaction_required')
    return new OAuthError('consent_required', message, status);
  return new OAuthError('rejected', message, status);
}

export interface HttpOAuthOptions {
  configs?: Partial<Record<OAuthProvider, OAuthProviderConfig>>;
  fetch?: typeof fetch;
}

/**
 * OAuth 2.0 over HTTP for every registered provider (INT-01, ADR-051): authorisation code with
 * PKCE (`S256`), refresh, and RFC 7009 revocation. Never logs, and never puts a token, code or the
 * provider's error description in an error.
 */
export function httpOAuth(options: HttpOAuthOptions = {}): OAuthPort {
  const configs = options.configs ?? OAUTH_PROVIDER_CONFIGS;
  const doFetch = options.fetch ?? fetch;

  function configFor(provider: OAuthProvider): OAuthProviderConfig & { id: string; secret: string } {
    const config = configs[provider];
    const id = config ? secretValue(config.clientId) : '';
    const secret = config ? secretValue(config.clientSecret) : '';
    if (!config || !id || !secret) throw new OAuthError('not_configured', `${provider} has no OAuth client`);
    return { ...config, id, secret };
  }

  async function post(
    config: ReturnType<typeof configFor>,
    url: string,
    params: Record<string, string>,
  ): Promise<{ status: number; body: unknown; retryAfter?: number }> {
    const body = new URLSearchParams(params);
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    };
    if (config.clientAuth === 'basic') {
      const pair = `${encodeURIComponent(config.id)}:${encodeURIComponent(config.secret)}`;
      headers['authorization'] = `Basic ${Buffer.from(pair).toString('base64')}`;
    } else {
      body.set('client_id', config.id);
      body.set('client_secret', config.secret);
    }
    let response: Response;
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers,
        body: body.toString(),
        signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
      });
    } catch {
      throw new OAuthError('transient', 'token endpoint unreachable');
    }
    const raw = await response.text().catch(() => '');
    let parsed: unknown = undefined;
    try {
      parsed = raw ? JSON.parse(raw) : undefined;
    } catch {
      parsed = undefined;
    }
    const retryAfter = retryAfterMs(response.headers.get('retry-after'));
    return { status: response.status, body: parsed, ...(retryAfter !== undefined ? { retryAfter } : {}) };
  }

  async function tokenRequest(provider: OAuthProvider, params: Record<string, string>): Promise<OAuthTokenSet> {
    const config = configFor(provider);
    const { status, body, retryAfter } = await post(config, config.tokenUrl, params);
    if (status < 200 || status >= 300) throw classifyTokenError(status, body, retryAfter);
    const json = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const accessToken = json['access_token'];
    if (typeof accessToken !== 'string' || !accessToken)
      throw new OAuthError('rejected', 'token endpoint: no access token', status);
    const refreshToken = typeof json['refresh_token'] === 'string' ? json['refresh_token'] : undefined;
    const expiresIn = Number(json['expires_in']);
    const scopes = typeof json['scope'] === 'string' ? json['scope'].split(/\s+/).filter(Boolean) : undefined;
    const claims = jwtClaims(json['id_token']);
    const account = claims ? (config.account ?? defaultAccount)(claims) : undefined;
    return {
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600,
      ...(scopes ? { scopes } : {}),
      ...(account ? { account } : {}),
    };
  }

  return {
    async authorizationUrl(provider, request) {
      const config = configFor(provider);
      const url = new URL(config.authorizeUrl);
      const params: Record<string, string> = {
        response_type: 'code',
        client_id: config.id,
        redirect_uri: request.redirectUri,
        scope: config.scopes.join(' '),
        state: request.state,
        code_challenge: request.codeChallenge,
        code_challenge_method: 'S256',
        ...config.authorizeParams,
      };
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      return url.toString();
    },

    exchangeCode(provider, request) {
      return tokenRequest(provider, {
        grant_type: 'authorization_code',
        code: request.code,
        redirect_uri: request.redirectUri,
        code_verifier: request.codeVerifier,
      });
    },

    refresh(provider, refreshToken) {
      return tokenRequest(provider, { grant_type: 'refresh_token', refresh_token: refreshToken });
    },

    async revoke(provider, refreshToken) {
      const config = configFor(provider);
      if (!config.revokeUrl) return false;
      const { status, body, retryAfter } = await post(config, config.revokeUrl, {
        token: refreshToken,
        token_type_hint: 'refresh_token',
      });
      if (status < 200 || status >= 300) throw classifyTokenError(status, body, retryAfter);
      return true;
    },
  };
}
