# Runbook: rotate a secret

How to replace a secret that leaked, or might have, and the routine rotations (SEC-08). Values never go in code, Terraform, a ticket, a chat or a log: they go straight from the provider into Secret Manager (or GitHub, or the firm's own Settings page).

**A leak is an incident.** If a secret was committed, pasted somewhere public, or used by someone who shouldn't have it, start [incident-response.md](incident-response.md) at SEV-1: rotate first, then check the provider's logs for what the secret was used for. If it could have reached client data (a firm's Anthropic key, the Xero client secret together with a refresh token), start the NDB assessment in [data-breach.md](data-breach.md).

## What there is

| Secret | Where it lives | Who rotates it | How |
| --- | --- | --- | --- |
| `RESEND_API_KEY` | Secret Manager, per environment (FND-20, ADR-057) | the owner | [Secret Manager secrets](#secret-manager-secrets) |
| `RESEND_WEBHOOK_SECRET` | Secret Manager, per environment | the owner | [Secret Manager secrets](#secret-manager-secrets), then [the Resend webhook](#the-resend-webhook) |
| `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET` | Secret Manager, per environment (INT-01, BILL-09) | the owner | [Secret Manager secrets](#secret-manager-secrets), then [Xero](#xero) |
| `ANTHROPIC_API_KEY` | Secret Manager, dev only: the eval-only key the `clerk-evals` workflow reads (AI-12). Unused in prod | the owner | add a new version; nothing to redeploy, the next eval run reads it |
| `demo-login-password` | Secret Manager, dev only (the demo practice) | anyone running the demo | add a new version and run the reset ([demo-practice.md](demo-practice.md)) |
| A firm's Anthropic API key (Clerk) | `orgs/{orgId}/integrations/anthropic`, encrypted with the KMS key `clerk-api-keys` (AI-02a, ADR-011b) | the firm's owner or admin | [A firm's Anthropic key](#a-firms-anthropic-key) |
| Integration refresh tokens (Xero) | `orgs/{orgId}/integrations/{id}`, encrypted with the KMS key `oauth-tokens` (INT-01, ADR-051) | the firm | disconnect and connect again in Settings → Integrations |
| Claude connector tokens | `connectorGrants`, stored only as SHA-256 hashes (INT-07, ADR-064) | the person, or an owner or admin | Settings → Claude connector → Disconnect; refresh tokens also rotate on every use |
| KMS keys `oauth-tokens`, `migration`, `clerk-api-keys` | key ring `materia`, `australia-southeast1`, per environment | Cloud KMS, every 90 days by itself | [KMS keys](#kms-keys) |
| GitHub Actions secrets `RELEASE_PLEASE_TOKEN`, `TF_VAR_BUDGET_ALERT_EMAILS`, `TF_VAR_BILLING_ACCOUNT` | the repository's Actions secrets ([deploy.md](deploy.md#one-time-setup-owner)) | the owner | [GitHub](#github) |

Nothing else is a secret. The Firebase web config and the App Check site key are public by design. GitHub deploys through Workload Identity Federation, so there are no service-account keys to rotate; if `terraform-agent` still has a JSON key, delete it rather than rotate it (infra/MANUAL.md, step 11).

## Secret Manager secrets

Functions read the version of a secret that was newest **when they were deployed**, so a new version takes effect only after the functions are deployed again. The order is: new value at the provider, new version, redeploy, check, then revoke the old value.

1. **Get the new value** from the provider (the sections below say where). Keep the old one working for now, so nothing fails in between.
2. **Add it as a new version**, without it touching a file or your shell history:

   ```sh
   printf %s "$NEW_VALUE" | gcloud secrets versions add <SECRET> --data-file=- --project materia-v2-<env>
   ```

   Or Secret Manager → the secret → **New version** in the console.
3. **Redeploy the functions.**
   - **Dev:** Actions → `deploy-dev` → **Run workflow** on `main`.
   - **Prod:** Actions → `deploy-prod` → **Run workflow** with the tag prod already runs (`/health` shows it), then approve. It promotes the same build again, so only the secret changes.
4. **Check** the feature that uses it:
   - Resend key: a notification email shows `sent` in its `deliveries` (infra/MANUAL.md, Resend step 9).
   - Webhook secret: Resend's webhook log shows `200` for new events.
   - Xero: Settings → Integrations shows "Payments last checked" moving after the next hourly run, and "Try again" on an unsent invoice sends it.
5. **Revoke the old value at the provider**, then disable the old version so nothing can read it:

   ```sh
   gcloud secrets versions list <SECRET> --project materia-v2-<env>
   gcloud secrets versions disable <old-version> --secret <SECRET> --project materia-v2-<env>
   ```

   Destroy it a week later, once you're sure no rollback needs it. Never disable or destroy the only enabled version: functions that declare the secret don't deploy without one (that's why Terraform creates the placeholder `unset`).

A rollback (`deploy-prod` with an older tag) also re-reads the newest version, so it never brings an old secret back.

### Resend

Resend → API Keys → **Create API Key**, named `Materia <env>`, permission **Sending access**, limited to the sending domain (as when it was first set up, infra/MANUAL.md step 7). After the check, delete the old key in Resend. Between the new version and the redeploy, email keeps going out with the old key.

### The Resend webhook

Roll the webhook's signing secret in Resend → Webhooks → the endpoint. If Resend has no roll option, add a second webhook with the same endpoint and the same three events (`email.bounced`, `email.complained`, `email.suppressed`) and delete the old webhook after the check. Deliveries that arrive signed with a secret the function doesn't have yet get `401`, and Resend retries them, so bounces arrive late rather than being lost.

### Xero

In the Xero developer portal: My Apps → the Materia app → Configuration → **Generate a secret**. If the client id itself has to change (a new app), add both `XERO_CLIENT_ID` and `XERO_CLIENT_SECRET`, and every firm reconnects Xero afterwards, because refresh tokens belong to the app that issued them.

A refresh with the wrong client secret fails without marking the connection for reconnecting (only Xero's `invalid_grant` does that, `apps/functions/src/integrations/vault.ts`), so a gap between Xero and the redeploy only delays syncs: invoices wait as `unavailable` and payments are picked up by the next hourly run.

## A firm's Anthropic key

Each firm brings its own key, and only the firm can see it in Anthropic's Console. If it leaks, the firm's owner or admin:

1. creates a new key in the Anthropic Console and **revokes the old one** there (until step 2, Clerk says Anthropic rejected the practice's key);
2. saves the new key in Materia: Settings → Clerk and AI → Anthropic API key → **Replace the key** → **Save key**. Materia checks it with Anthropic before saving.

The operator can't read or set a firm's key. To stop that firm's Clerk calls straight away, see [disable-clerk.md](disable-clerk.md).

## KMS keys

`oauth-tokens`, `migration` and `clerk-api-keys` rotate by themselves every 90 days (Terraform `modules/firebase_env/security.tf`). Cloud KMS reads the key version from the ciphertext, so data encrypted with an older version keeps decrypting, and nothing needs re-encrypting.

Rotating by hand only helps against a key version that leaked, which Google doesn't expose; it doesn't help when a ciphertext and an account allowed to decrypt it leaked together. For that, remove the account's access to the key, then rotate what it protected (the firms reconnect Xero and replace their Anthropic keys). To make a new version primary anyway:

```sh
gcloud kms keys versions create --key <key> --keyring materia --location australia-southeast1 --primary --project materia-v2-<env>
```

Never disable or destroy an older key version while anything encrypted with it is still stored: those tokens and keys would stop decrypting.

## GitHub

Settings → Secrets and variables → Actions → the secret → **Update**.

- **`RELEASE_PLEASE_TOKEN`** is a fine-grained token with an expiry date. Make a new one (this repository; contents and pull requests read and write) before the old one expires, update the secret, then delete the old token in your GitHub settings. Until it's set, release PRs get no CI and you merge them as an admin.
- **`TF_VAR_BUDGET_ALERT_EMAILS`** and **`TF_VAR_BILLING_ACCOUNT`** are configuration rather than credentials. Update them when they change; `infra.yml` uses them on its next run.

## Afterwards

Record the rotation (date, environment, secret name, why; never the value) on the Linear ticket of the incident, or in the review log at the end of `docs/security/threat-model.md` for a routine one.
