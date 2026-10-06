import type { SecretParam } from 'firebase-functions/params';

import type { IntegrationAccount, OAuthProvider } from '@materia/domain';

import { secretValue, XERO_CLIENT_ID, XERO_CLIENT_SECRET } from '../core/secrets';

/**
 * How the token vault talks to one OAuth provider (INT-01, ADR-051). Endpoints and scopes are
 * code; the client id and secret come from Secret Manager, so every function that uses the
 * provider declares `secrets` (`OAUTH_SECRETS` covers them all).
 */
export interface OAuthProviderConfig {
  authorizeUrl: string;
  tokenUrl: string;
  /** RFC 7009 revocation. Without one, disconnecting only deletes the token. */
  revokeUrl?: string;
  scopes: readonly string[];
  /** How the client authenticates at the token endpoint: HTTP Basic, or `client_id`/`client_secret` fields. */
  clientAuth: 'basic' | 'post';
  /** Read inside a function that declares `secrets` (`''` when unset or a placeholder). */
  clientId: () => string;
  clientSecret: () => string;
  /** Extra authorisation parameters (`prompt`, `response_mode`…). */
  authorizeParams?: Readonly<Record<string, string>>;
  /** Who the tokens are for, from the ID token's claims. Default: email, name and tenant claims. */
  account?: (claims: Record<string, unknown>) => IntegrationAccount | undefined;
  secrets: readonly SecretParam[];
}

/**
 * Xero (BILL-09, ADR-053): the practice's organisation. Granular scopes, which Xero requires of
 * apps registered since March 2026: contacts, invoices and credit notes, payments, and reading
 * the chart of accounts. `openid profile email` name who connected it. Refresh tokens rotate on
 * every refresh and expire after 60 days unused.
 */
export const XERO_OAUTH: OAuthProviderConfig = {
  authorizeUrl: 'https://login.xero.com/identity/connect/authorize',
  tokenUrl: 'https://identity.xero.com/connect/token',
  revokeUrl: 'https://identity.xero.com/connect/revocation',
  scopes: [
    'openid',
    'profile',
    'email',
    'offline_access',
    'accounting.contacts',
    'accounting.invoices',
    'accounting.payments',
    'accounting.settings.read',
  ],
  clientAuth: 'basic',
  clientId: () => secretValue(() => XERO_CLIENT_ID.value()),
  clientSecret: () => secretValue(() => XERO_CLIENT_SECRET.value()),
  secrets: [XERO_CLIENT_ID, XERO_CLIENT_SECRET],
};

/**
 * The live providers: Xero (BILL-09). Microsoft arrives with INT-01b and Google with INT-04, each
 * with its secrets in Terraform (`modules/firebase_env/security.tf`) and its flag in
 * `OAUTH_PROVIDER_INFO`. Until then the real adapter answers `not_configured` for them; the
 * emulator's fake connects any provider whose flag is on.
 */
export const OAUTH_PROVIDER_CONFIGS: Partial<Record<OAuthProvider, OAuthProviderConfig>> = { xero: XERO_OAUTH };

/** Every provider's secrets, for the functions that connect, refresh or revoke. */
export const OAUTH_SECRETS: SecretParam[] = Object.values(OAUTH_PROVIDER_CONFIGS).flatMap((config) => [
  ...(config?.secrets ?? []),
]);
