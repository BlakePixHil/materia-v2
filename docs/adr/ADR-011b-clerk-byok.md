# ADR-011b: Clerk runs on each firm's own Anthropic key (BYOK), Sonnet 5.5 by default

- **Status:** Accepted
- **Date:** 2026-10-05
- **Ticket:** [AI-02a](https://linear.app/materia-web/issue/MAT-126)
- **Supersedes:** [ADR-011a](ADR-011a-clerk-provider.md)'s "Credentials" decision (one platform key per environment in Secret Manager) and its default model (`claude-opus-5-5`). The first-party Anthropic API route, the fallback strategy and the Bedrock analysis in ADR-011a stand.

## Context

ADR-011a chose the Anthropic API with one platform-owned key per environment, so every firm's Clerk usage would run on, and be billed to, the product owner's Anthropic account. On 2026-10-04 the product owner decided Clerk must not run on the owner's own key: each firm brings its own. That also changes who Anthropic's customer is for each firm's data, and how much a default Clerk call costs.

## Decision

**Per-org keys.**

- An owner or admin saves the firm's own Anthropic API key in Settings → Clerk (`clerk-setApiKey`, `PERMISSIONS['clerk.configure']`, a sign-in within 5 minutes).
- The key is trimmed and shape-checked (`sk-ant-…`), then validated with one cheap authenticated call (list models), so a bad key is never saved. A rejected key is `CLERK_KEY_INVALID`; an unreachable API is `CLERK_UNAVAILABLE`.
- It is encrypted with Cloud KMS (key `clerk-api-keys` in ring `materia`, 90-day rotation, `prevent_destroy`, `cryptoKeyEncrypterDecrypter` for `fn-runtime` only), with the document path as additional authenticated data, and stored in `orgs/{orgId}/integrations/anthropic` (closed to every client by the rules) with `{last4, setBy, setAt, validatedAt, status, opusAvailable}`. This follows ADR-019's pattern for integration secrets.
- The plaintext is never stored or logged; logs, responses and audit entries carry ids and `last4` only (`clerk.api_key_set`, `clerk.api_key_removed`).
- The gateway resolves the org's key and model on every call, after the kill switches and before the limits. No key: `CLERK_DISABLED` with `details.switch = 'org.byok.missing'`. A stored key Anthropic rejects (401/403) is marked `status: 'invalid'` and the call returns `CLERK_KEY_INVALID` until an admin replaces it.
- The Anthropic adapter takes the key per request and caches SDK clients per org for 5 minutes, only while the key is unchanged. There is no process-wide client and no platform key: `clerk-hello` declares no secret, and the `ANTHROPIC_API_KEY` Secret Manager container is unused (kept in Terraform, noted in `infra/MANUAL.md`).
- Last write wins when two admins save at once; both saves are audited. A running call finishes on the key it started with; the next call uses the new key.

**Models.**

- Claude **Sonnet 5.5** (`claude-sonnet-5-5`) is the default; an admin can opt the org into Claude **Opus 5.5** (`claude-opus-5-5`) with `clerk-setModel` (audited as `clerk.model_changed`). The choice is `orgs/{orgId}.settings.clerk.model`.
- Fallback chains per primary: Sonnet 5.5 → `claude-sonnet-5`; Opus 5.5 → `claude-opus-5` → `claude-sonnet-5-5`.
- Prices (per million tokens): Sonnet 5.5 $2 input, $10 output, $0.20 cache read, $2.50 cache write (5-minute); Opus 5.5 unchanged. An unpriced fallback hop is costed at the org's primary model's price and flagged estimated.
- Sonnet 5.5 behaves like Opus 5.5 where it matters: adaptive thinking only (`thinking: {type: "disabled"}` is a 400), no forced `tool_choice`, thinking blocks bound to the model. Its default effort is `high` and its levels are recalibrated, so every prompt keeps an explicit `effort` (the prompt front-matter requires it).
- A key that can't see Opus 5.5 when it is saved gets a warning, Opus can't be selected, and an org already on Opus moves back to Sonnet 5.5.

**Privacy position.** Clerk sends matter context to Anthropic under the **firm's own Anthropic account and terms**: the firm is Anthropic's customer and chooses its own retention (for example zero data retention) and spend limits. Materia's servers only relay the request. Settings → Clerk says so next to the key field.

## Consequences

- **SEC-01 sub-processor list:** Anthropic is no longer a sub-processor engaged by Materia for Clerk; it is a provider the firm engages directly, under its own agreement. The privacy policy and sub-processor list (SEC-01) must describe Clerk as "sends matter context to the AI provider your firm configures, under your firm's agreement", and the APP 8 cross-border disclosure becomes the firm's decision, made when it saves a key. Clerk stays off for a firm until it does.
- Budgets and per-user limits (AI-02) still apply; they now protect the firm's own spend. AI-13 builds their UI on the same Settings → Clerk page.
- The live smoke test needs a real key from an account the tester controls (AI-02a's human step).
- Clerk costs about half as much per token by default (Sonnet 5.5), with Opus 5.5 available for firms that want it.

## Alternatives considered

- **Keep one platform key** (ADR-011a): rejected by the product owner; the owner would carry every firm's spend and data relationship.
- **Store the key in Secret Manager per org:** one secret per org needs IAM changes per org and a deploy-time secret list; a KMS-encrypted Firestore document needs neither and matches ADR-019.
- **Opus 5.5 as the default:** twice the token price for a default most firms don't need; it remains an opt-in.
