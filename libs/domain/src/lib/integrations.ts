import * as z from 'zod';

import type { FlagKey } from './flags';

/**
 * OAuth integrations (INT-01, ADR-019, ADR-051): the providers the token vault can connect, and
 * whether each is connected once for the whole practice (`org`) or by each person (`user`).
 * Refresh tokens stay on the server; clients only ever see `integrationStatus`.
 */
export const OAUTH_PROVIDERS = ['microsoft', 'google', 'xero'] as const;
export const OAuthProviderSchema = z.enum(OAUTH_PROVIDERS);
export type OAuthProvider = z.infer<typeof OAuthProviderSchema>;

export const IntegrationLevelSchema = z.enum(['user', 'org']);
export type IntegrationLevel = z.infer<typeof IntegrationLevelSchema>;

export interface OAuthProviderInfo {
  label: string;
  level: IntegrationLevel;
  /** The server-enforced flag that turns the provider on. Without one it can't be connected yet. */
  flag?: FlagKey;
  /** The ticket that makes the provider live. */
  ticket: string;
  /** Where a person fixes the connection (the link in its `integration_error` notification). */
  settingsPath: string;
}

export const OAUTH_PROVIDER_INFO: Record<OAuthProvider, OAuthProviderInfo> = {
  microsoft: {
    label: 'Microsoft 365',
    level: 'user',
    flag: 'integrations.microsoft',
    ticket: 'INT-01b',
    settingsPath: '/settings',
  },
  google: { label: 'Google Workspace', level: 'user', ticket: 'INT-04', settingsPath: '/settings' },
  xero: { label: 'Xero', level: 'org', ticket: 'BILL-09', settingsPath: '/settings' },
};

/**
 * The id of a connection in `integrations` and `integrationStatus`: `{uid}_{provider}` for a
 * person's own connection, `{provider}` for the practice's.
 */
export function integrationDocId(provider: OAuthProvider, uid: string): string {
  return OAUTH_PROVIDER_INFO[provider].level === 'org' ? provider : `${uid}_${provider}`;
}

/** How long a connect attempt may take, from `integrations-start` to `integrations-complete`. */
export const INTEGRATION_STATE_TTL_MS = 10 * 60_000;

/** The app route the provider sends the browser back to (the OAuth redirect URI's path). */
export function integrationCallbackPath(provider: OAuthProvider): string {
  return `/integrations/callback/${provider}`;
}

/** Where the app goes after connecting: an app path only (never `//host`, `/\host` or a scheme). */
export const AppReturnPathSchema = z
  .string()
  .max(300)
  .regex(/^\/(?![/\\])[^\s\\]*$/, 'An app path such as /settings/billing');

/** The default page to come back to. */
export const DEFAULT_INTEGRATION_RETURN = '/settings';

/** The provider account a connection is for (it may differ from the person's sign-in). No secrets. */
export const IntegrationAccountSchema = z
  .object({
    email: z.string().max(320).optional(),
    name: z.string().max(200).optional(),
    /** The provider's organisation: an Entra tenant, a Xero organisation. */
    tenantId: z.string().max(200).optional(),
    tenantName: z.string().max(200).optional(),
  })
  .strict();
export type IntegrationAccount = z.infer<typeof IntegrationAccountSchema>;

/** What `integrationStatus` shows: connected, needs reconnecting (the provider refused the token), or off. */
export const IntegrationConnectionStatusSchema = z.enum(['connected', 'reconnect_required', 'disconnected']);
export type IntegrationConnectionStatus = z.infer<typeof IntegrationConnectionStatusSchema>;

/** Why a connection needs reconnecting or was disconnected. */
export const IntegrationStatusReasonSchema = z.enum(['revoked', 'disconnected', 'member_removed']);
export type IntegrationStatusReason = z.infer<typeof IntegrationStatusReasonSchema>;

export const StartIntegrationInput = z.object({
  requestId: z.uuid(),
  provider: OAuthProviderSchema,
  returnTo: AppReturnPathSchema.optional(),
  /**
   * The app's origin as the browser sees it. Only the emulator uses it (the app runs on
   * localhost:4200 or 127.0.0.1:5000 there); deployed apps use their registered redirect URI.
   */
  origin: z.string().max(200).optional(),
});
export type StartIntegrationInput = z.infer<typeof StartIntegrationInput>;

export interface StartIntegrationResult {
  /** The provider's consent page. The browser goes there, then back to the callback route. */
  url: string;
}

export const CompleteIntegrationInput = z.object({
  requestId: z.uuid(),
  provider: OAuthProviderSchema,
  state: z.string().min(32).max(128),
  code: z.string().min(1).max(4096),
});
export type CompleteIntegrationInput = z.infer<typeof CompleteIntegrationInput>;

export interface CompleteIntegrationResult {
  provider: OAuthProvider;
  returnTo: string;
  account?: IntegrationAccount;
}

export const DisconnectIntegrationInput = z.object({ requestId: z.uuid(), provider: OAuthProviderSchema });
export type DisconnectIntegrationInput = z.infer<typeof DisconnectIntegrationInput>;

export interface DisconnectIntegrationResult {
  disconnected: boolean;
  /** Whether the provider confirmed the token is revoked (some providers can't revoke). */
  revoked: boolean;
}
