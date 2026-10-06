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

## Key rotation

The `oauth-tokens` KMS key rotates every 90 days. Cloud KMS finds the key version from the ciphertext, so stored tokens keep decrypting. `kmsKeyVersion` records which version encrypted each one. A token re-encrypts with the newest version whenever the provider rotates it.
