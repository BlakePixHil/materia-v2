# ADR-057: Resend for email

- **Status:** Accepted
- **Date:** 2026-10-07
- **Ticket:** [FND-20b](https://linear.app/materia-web/issue/MAT-166) (Blake's request, 2026-10-07)
- **Supersedes:** [ADR-015](015-email.md) in part (the provider: Postmark becomes Resend)
- **Builds on:** [ADR-030](030-notifications-infrastructure.md) (notifications infrastructure)

## Context

FND-20 sent notification email through Postmark, but nothing has gone out yet: Postmark's token is still the placeholder on dev and prod, and its account, approval and DNS steps waited on the owner. The owner prefers Resend: it is cheaper for a practice-sized volume (its free tier is 3,000 emails a month) and simpler to set up (one domain with three DNS records, no account approval step). Resend also receives email, so INT-05 can use it too.

## Decision

We will:

- send every email through Resend's HTTP API (`POST https://api.resend.com/emails`, no SDK) behind the same `MailPort` (`apps/functions/src/mail/resend.ts`), with the same templates, rendered by `renderMail`. Each send carries the template name as a tag and the message's `idempotencyKey` as the `Idempotency-Key` header, so a retry within 24 hours isn't sent twice;
- keep the delivery outcomes: no key is `not_configured` (recorded `skipped`), a missing or refused key is `not_configured`, 429, 5xx and network failures are `transient` (retried), anything else is `rejected`. Resend accepts mail to an address it suppresses and reports it by webhook, so `inactive_recipient` no longer comes from the adapter;
- replace `notifications-postmarkWebhook` with `notifications-resendWebhook`, which checks Resend's Svix signature (HMAC-SHA256 over `{svix-id}.{svix-timestamp}.{raw body}` with the `whsec_` signing secret, any `v1` entry, constant time, timestamp within five minutes). A permanent `email.bounced`, an `email.suppressed` or an `email.complained` marks the address `undeliverable` and tells the person in-app, exactly as before;
- hold the key and the signing secret in `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET`, created by Terraform with the placeholder `unset`. The owner signs up, adds the domain's DNS records, creates the key and the webhook and pastes both values into Secret Manager (`infra/MANUAL.md`, "Email: Resend"). Open and click tracking stay off (a per-domain setting in Resend, off by default);
- drop the Postmark code (but for the stub below). `POSTMARK_TOKEN` and `POSTMARK_WEBHOOK_SECRET` stay in Terraform until dev's deployed functions no longer reference them, because deleting a secret a deployed function still names stops its new instances starting; a follow-up (FND-20c) removes them.

## Consequences

- The owner's setup is shorter: no account approval, and the DNS records go on a `send` subdomain and `resend._domainkey`, so an existing SPF record on the root domain is untouched.
- Deploys never pass `--force`, so the CLI won't drop `notifications-postmarkWebhook` from dev (`docs/runbooks/deploy.md`). A stub of that name answering 410 kept dev's deploys going until the owner agreed to delete it (2026-10-07); FND-20c then removed the stub and the Postmark secrets, and listed the function in `apps/functions/retired-functions.txt`, which the deploy deletes first. Prod has no functions yet.
- Resend is a US sub-processor of recipient addresses, subjects and bodies, as Postmark was. Subjects never carry matter content (ADR-030). SEC-01's sub-processor list names Resend.
- INT-05 (inbound email to matter) uses Resend's `email.received` webhook instead of Postmark's inbound webhook.
- The weekly practice report (ADR-055) and invoice emails (ADR-045) go out once the owner's Resend setup is done, like every other email.

## Alternatives considered

- **Keep Postmark.** It works and the code was done, but the owner chose Resend for cost and setup effort, and nothing had been sent through Postmark yet.
- **Keep both providers behind a switch.** Twice the adapters, secrets and webhooks to maintain for a single practice; `MailPort` already makes a future swap a small change.
- **Resend's SDK.** We call one endpoint, and the webhook check is a few lines of `node:crypto`; `fetch` keeps the functions bundle free of a dependency, as with Postmark.
