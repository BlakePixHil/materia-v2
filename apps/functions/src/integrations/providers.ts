import type { SecretParam } from 'firebase-functions/params';

import type { IntegrationAccount, OAuthProvider } from '@materia/domain';

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
 * The live providers. None yet: Xero arrives with BILL-09, Microsoft with INT-01b and Google with
 * INT-04, each with its secrets in Terraform (`modules/firebase_env/security.tf`) and its flag in
 * `OAUTH_PROVIDER_INFO`. Until then the real adapter answers `not_configured`; the emulator's fake
 * connects any provider whose flag is on.
 */
export const OAUTH_PROVIDER_CONFIGS: Partial<Record<OAuthProvider, OAuthProviderConfig>> = {};

/** Every provider's secrets, for the functions that connect, refresh or revoke. */
export const OAUTH_SECRETS: SecretParam[] = Object.values(OAUTH_PROVIDER_CONFIGS).flatMap((config) => [
  ...(config?.secrets ?? []),
]);
