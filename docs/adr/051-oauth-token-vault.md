# ADR-051: The OAuth token vault finishes connects in a callable and keeps each attempt server-side

- **Status:** Accepted
- **Date:** 2026-10-06
- **Ticket:** [INT-01](https://linear.app/materia-web/issue/MAT-93)
- **Refines:** ADR-019: Integrations ([Architecture & ADRs](../01-architecture-and-adrs.md))

## Context

ADR-019 says OAuth runs server-side and refresh tokens are KMS-encrypted in `integrations/{uid}_{provider}`, which clients can't read. INT-01 builds that vault for every provider: Xero (BILL-09), Microsoft 365 (INT-01b) and Google (INT-04). The ticket sketched an HTTPS callback function that validates a signed `state`, exchanges the code and redirects to Settings.

On 2026-10-06 INT-01 was split so the vault could ship before Blake registers a Microsoft app. Everything Microsoft moved to INT-01b; this decision covers the provider-neutral part.

Two things make the HTTPS-function callback weaker than it looks:

- The browser arrives at the callback with no Firebase ID token, so the function can only trust what `state` says about who started the connect. If anyone else finishes the flow (for example a victim opening an attacker's consent link), the victim's account is connected to the attacker's Materia user. This is the classic OAuth login-CSRF.
- A signed `state` needs a signing secret in every environment, and it can be replayed until it expires.

## Decision

- **The callback is an app route.** Each provider's redirect URI is `https://<env-domain>/integrations/callback/{provider}`. The page calls `integrations-complete({provider, state, code})` as the signed-in person. The attempt must belong to that person and org, so only whoever started a connect can finish it. There is no separate HTTPS function.
- **Each attempt is stored server-side.** `integrations-start` makes 256 random bits of `state` and a PKCE pair (`S256`). It stores `orgs/{orgId}/integrationStates/{sha256(state)}` with the uid, provider, level, verifier, redirect URI and return path, expiring after 10 minutes (`expireAt`, Firestore TTL). `integrations-complete` deletes the attempt in a transaction before exchanging the code, so each one is used once. An attempt that belongs to someone else is refused and left for its owner. A stale, reused, made-up or other-provider state is refused with `INTEGRATION_STATE_INVALID`. Only the hash is stored, so reading the collection never yields a usable state.
- **Connections are per person or per practice.** `OAUTH_PROVIDER_INFO` (libs/domain) gives each provider a level. Per-person connections are `integrations/{uid}_{provider}`; per-practice connections are `integrations/{provider}` (Xero), like the Anthropic key. Only `org.settings` roles connect or disconnect the practice's. Connecting needs a sign-in within 5 minutes (Security doc) and the provider's server-enforced flag. A provider with no flag can't be connected.
- **Tokens are bound to their path.** The refresh token is encrypted with the `oauth-tokens` KMS key, with the document path as additional authenticated data, so a ciphertext copied to another org won't decrypt. Each connect gets a new `connectionId`. A refresh that rotates the token (Xero rotates on every refresh) writes the new one only if the `connectionId` is unchanged, so a refresh never overwrites a newer connection. Connecting again replaces the token and revokes the old one.
- **Clients see a mirror.** `integrationStatus/{same id}` holds the provider, level, status (`connected`, `reconnect_required`, `disconnected`), scopes, account (email, name, tenant) and dates, and nothing secret. The rules let members read the practice's and each person read their own. Only the vault writes it.
- **Access tokens stay in memory.** `accessToken()` reuses an access token until 2 minutes before it expires, and for at most 50 minutes. Concurrent callers in one instance share a single refresh. `authorizedFetch()` adds the bearer token, retries once with a fresh token after a 401, and waits out a short `Retry-After` on 429 or 503. A longer wait is thrown as `RATE_LIMITED` with `retryAfterMs`, so a Cloud Task can be rescheduled.
- **A refused refresh token stops everything.** `invalid_grant` sets `reconnect_required` on both documents once and sends one `integration_error` notification: to the person for their own connection, or to owners and admins for the practice's. Later calls fail fast with `INTEGRATION_RECONNECT_REQUIRED` and never call the provider again until someone reconnects.
- **Providers plug in through a registry.** `OAUTH_PROVIDER_CONFIGS` (apps/functions/src/integrations/providers.ts) holds endpoints, scopes, client authentication (Basic or form fields) and the Secret Manager secrets for each provider's client id and secret. The functions that connect, refresh or revoke declare those secrets. The emulator and tests use `FakeOAuth`, which consents instantly and checks PKCE like a real provider.
- **Leaving cleans up.** `orgs-removeMember` revokes and deletes the person's own connections. This is best effort, so a provider outage never blocks a removal.

## Consequences

- No HTTPS endpoint to secure, and no state-signing secret to provision. A connect is a pair of ordinary callables with the usual auth, role, membership, session and idempotency checks.
- The person who started a connect must finish it in a browser signed in to the same account and org. A link forwarded to someone else fails for them, by design.
- Each provider's redirect URI must be the app's own address (`appUrl()`). Preview channels can't complete a real connect. The emulator follows the browser's localhost origin.
- The audit log records `integration.connected` and `integration.disconnected`. The trigger skips the status mirror, the attempts, and updates that only rotate the token.
- Adding a provider means adding a registry entry, its secrets in Terraform, a flag in `OAUTH_PROVIDER_INFO` and its redirect URI in the provider's developer console ([integrations runbook](../runbooks/integrations.md)).

## Alternatives considered

- **An HTTPS callback function with an HMAC-signed state:** binds the flow only to whatever the state claims, needs a signing secret, and allows replay within the expiry.
- **Keeping the access token in Firestore too:** shares it across instances but puts a usable credential in a document. Memory plus a refresh every 30 to 50 minutes costs little.
- **One token document per provider for the whole org (Microsoft too):** calendars and mailboxes are personal. Only accounting (Xero) belongs to the practice.
