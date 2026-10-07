# Integrations runbook

How the OAuth token vault connects Materia to other services (INT-01, [ADR-051](../adr/051-oauth-token-vault.md)), how to add a provider, and what to do when a connection stops working.

## How a connect works

1. Someone presses Connect. The app calls `integrations-start({provider, returnTo})`. This needs a sign-in within 5 minutes, the provider's flag on, and, for a practice connection, an owner or admin.
2. The browser goes to the provider's consent page, then back to `https://<env-domain>/integrations/callback/{provider}`.
3. That page calls `integrations-complete({provider, state, code})`. The vault checks that the attempt belongs to the signed-in person and is less than 10 minutes old. It then exchanges the code with the PKCE verifier and stores the refresh token, KMS-encrypted, in `orgs/{orgId}/integrations/{id}`. The non-secret status goes in `integrationStatus/{id}`.
4. Disconnecting (`integrations-disconnect`) deletes the token and revokes it where the provider supports that.

`{id}` is `{uid}_{provider}` for a person's own connection (Microsoft, Google) and `{provider}` for the practice's (Xero).

## Adding a provider

1. **Register an app** in the provider's developer console. Give it one redirect URI per environment: `https://materia-v2-dev.web.app/integrations/callback/{provider}` (dev), plus the staging and prod domains. Ask for offline access (a refresh token).
2. **Secrets:** add `{PROVIDER}_CLIENT_ID` and `{PROVIDER}_CLIENT_SECRET` to `google_secret_manager_secret.this` and to the placeholder versions in `infra/terraform/modules/firebase_env/security.tf`. Functions don't deploy while a secret they declare has no version. Merge that first, so `infra.yml` applies it to dev. Then add the values with `printf %s "$VALUE" | gcloud secrets versions add {PROVIDER}_CLIENT_ID --data-file=- --project materia-v2-<env>`. Never put a value in code, Terraform or a ticket. Xero's two secrets already exist (infra/MANUAL.md).
3. **Registry:** add the provider to `OAUTH_PROVIDER_CONFIGS` in `apps/functions/src/integrations/providers.ts`. That entry holds the endpoints, scopes, `clientAuth` (`basic` or `post`), `clientId`/`clientSecret` read through `secretValue(() => SECRET.value())`, and `secrets`.
4. **Flag:** give it a server-enforced flag in `libs/domain/src/lib/flags.ts` and point `OAUTH_PROVIDER_INFO[provider].flag` at it. Turn it on for dev with a Remote Config parameter (client and server templates).
5. Build the provider's API client on `authorizedFetch(ctx, {provider, uid}, url, init)`. It adds the bearer token, refreshes after a 401, and honours `Retry-After`.

## When a connection stops working

- **"Needs reconnecting" (`reconnect_required`):** the provider refused the refresh token. It was revoked in the provider, expired from disuse (Xero: 60 days), or the password changed. The person (or, for the practice's connection, the owners and admins) got an `integration_error` notification. Fix it by connecting again; nothing retries in the meantime.
- **"Isn't set up for Materia yet" (`INTEGRATION_NOT_CONFIGURED`):** this environment has no client id or secret for the provider, or they are still the placeholder `unset`. See step 2 above.
- **"The connection wasn't allowed" (`INTEGRATION_REJECTED`):** consent was declined, the code was already used, or the provider needs an administrator's approval (`details.reason: consent_required`).
- **"That connection link has expired" (`INTEGRATION_STATE_INVALID`):** the attempt is over 10 minutes old, was already used, or was started by someone else. Start again from Settings.

Logs (`integration connect refused`, `integration needs reconnecting`, `integration token revoke failed`) carry the provider and a reason, never a token or code.

## Xero (BILL-09)

How invoices reach Xero and payments come back: [ADR-053](../adr/053-xero-sync.md). Behind `integrations.xero` (Remote Config `integrations_xero`, client and server).

- **Set up:** an owner or admin connects Xero in Settings → Integrations, then chooses the organisation, the accounts for fees and disbursements, whether to send each invoice when it's issued, and the first issue date to send. Saving says how many invoices and credit notes since then aren't in Xero; "Send them to Xero" queues them.
- **An invoice shows "Not sent to Xero":** its `xero.error` says why.
  - `rejected`: Xero refused it, with Xero's message (a deleted account code, a contact Xero archived). Fix it in Xero or Settings, then press "Try again" on the invoice.
  - `number_taken`: Xero has a different invoice with the number. Check Xero; renumber or delete the one typed in by hand there, then "Try again". Materia never overwrites it.
  - `not_connected`: Xero needs reconnecting, or no organisation is chosen. Reconnect in Settings, then "Send unsent to Xero".
  - `unavailable`: Xero didn't answer after 5 tries over a few hours. "Try again" once Xero is up ([status.xero.com](https://status.xero.com)).
- **"Payments in Xero not recorded here":** a payment made in Xero would overpay the invoice in Materia, or the invoice is void here. Usually the same money was recorded in both places. Reverse whichever is wrong; the next hourly run records the Xero payment if it now fits.
- **Payments aren't coming across:** check the `xero-pullPayments` logs and `integrationStatus/xero.sync.paymentsCheckedAt` (shown in Settings as "Payments last checked"). The job skips an org quietly while its connection needs reconnecting.
- **Logs:** `xero push failed` (with `kind`, `code`, `retry`), `xero rate limited; rescheduled`, `xero payments skipped`, `xero payments failed`. None carries a token, an amount or a client's name.

## Claude connector (INT-07)

People use Materia from their own Claude or Claude Code over MCP ([ADR-064](../adr/064-claude-connector.md)). Behind `integrations.claudeConnector` (server-enforced; on in dev through `infra/remote-config/dev.json`, off in prod until the data wording is reviewed with the legal pages, SEC-01a). Nothing to provision: `connector-api` and the Hosting rewrites deploy with everything else. While the flag is off the metadata still answers, but the consent page says Claude can't connect and every MCP request and refresh is refused.

- **Turn it on for a practice:** an owner or admin turns on "Let people connect Claude" in Settings → Claude connector, and "Let Claude suggest changes" if they want suggestions. Turning the first switch off ends every connection at once.
- **Connect:** the page shows the address, `https://<env-domain>/mcp`. In Claude: Settings → Connectors → Add custom connector, paste it, then Connect, sign in to Materia and Allow. In Claude Code: `claude mcp add --transport http materia https://<env-domain>/mcp`, then `/mcp`.
- **Check the server:** `curl -s https://<env-domain>/.well-known/oauth-authorization-server` returns JSON whose `issuer` is the app's origin. HTML instead means the Hosting rewrites didn't deploy. `curl -si -X POST https://<env-domain>/mcp` returns 401 with a `WWW-Authenticate: Bearer resource_metadata=…` header. Every deploy's smoke tests check both, with a made-up token whose 401 must say `error="invalid_token"`: that shows Hosting passed the Authorization header to the function.
- **"Claude can't connect yet" on the consent page:** the flag is off for the practice, or its switch is. **"This connection request isn't valid":** the client id or redirect URI isn't one of the pinned ones in `CONNECTOR_CLIENTS` (libs/domain `connector.ts`). If Claude has changed its client metadata document or redirect URIs, update the pinned copy there.
- **Claude asks to connect again:** every request re-checks the person, and a refusal returns 401 `invalid_token` with the reason in `error_description`: disconnected, access ended or paused, signed out everywhere, past the practice's session length, now needs two-step sign-in, the practice's switch, or the flag. The connection's `revokeReason` (`disconnected`, `member_removed`, `practice_off`, `refresh_reuse`) says why one ended. `refresh_reuse` means a refresh token was used twice, which can mean a stolen token: check the audit log for that person's `connector.*` entries.
- **End someone's access now:** Settings → Claude connector → Everyone's connections → Disconnect, or remove the member. Their next request is refused; no token has to expire.
- **Audit:** `connector.connected`, `connector.disconnected`, `connector.practice_enabled`, `connector.practice_disabled` and `connector.tool_used` (tool, matter, count, refused), never what was asked or returned. Tokens are stored only as SHA-256 hashes in `connectorGrants` and expire by TTL.
- **Add another client** (another MCP app): add it to `CONNECTOR_CLIENTS` with its client id and its published redirect URIs, and say what it is in the consent copy. Never fetch a client's metadata at request time.

## Key rotation

The `oauth-tokens` KMS key rotates every 90 days. Cloud KMS finds the key version from the ciphertext, so stored tokens keep decrypting. `kmsKeyVersion` records which version encrypted each one. A token re-encrypts with the newest version whenever the provider rotates it.
