# Clerk (AI) architecture & guardrails

Clerk is Materia's AI assistant. It reads the matter, drafts, extracts and suggests. **It never commits changes.** Every change it proposes is a `suggestion` that a person accepts, edits or dismisses.

## The seven Clerk rules (from the design system — product requirements)

1. **Always marked.** Clerk content always carries the violet Clerk mark and the label "Clerk".
2. **Always cited.** Any factual claim about the matter cites a source: document + page + quote, or a record (deadline, event, time entry). Uncited claims are rejected or labelled "not from your file".
3. **Proposes, never commits.** All writes go through `suggestions` and human acceptance. There is no auto-accept, and no tool can mutate data.
4. **Scoped.** A Clerk session is scoped to one org and, usually, one matter. Retrieval and tools are filtered by `orgId`/`matterId` server-side, never by the prompt.
5. **Honest about limits.** When it doesn't know, or the context was truncated, it says so. It never invents citations, legislation or case law.
6. **Respects privilege.** Privileged documents are used only for lawyer-role users. Clerk outputs that include privileged material are themselves marked privileged. Nothing goes outside the matter.
7. **Never predicts outcomes for clients.** Internal strength assessments are for lawyers only. Clerk refuses to draft client-facing predictions of litigation outcomes.

## Provider & model

- **Model:** `claude-opus-5-5`.
  - Adaptive thinking (`thinking: {type: "adaptive"}`).
  - Effort `medium` by default. Use `high` for will extraction and chronology, and `low` for the brief and classification.
  - Stream whenever output may be long.
- **Provider: [ADR-011a](adr/ADR-011a-clerk-provider.md)** (accepted for the MVP): the **Anthropic API (1P)**, with the key in Secret Manager (`defineSecret('ANTHROPIC_API_KEY')`) and refusals handled by server-side `fallbacks: "default"`. The owner accepted processing outside Australia for the MVP. Bedrock's `AU` profile is the only route with Australian inference, and is the documented path if that's needed later. Candidates evaluated:
  1. **Claude on Google Vertex AI** (`AnthropicVertex` client). It is the same GCP org and IAM as Firebase, with no API key. Check that the model is available in an Australian region and what regional versus global endpoint pricing applies.
  2. **Claude Platform on AWS / Amazon Bedrock in `ap-southeast-2`** (Sydney).
  3. **Anthropic API (1P)** with `inference_geo` / data-residency controls if they cover Australia, and a zero-data-retention agreement.
- Platform differences to respect, per the Claude platform-availability table:
  - The Message Batches and Files APIs are 1P/P-AWS only.
  - Server-side `fallbacks` are 1P/P-AWS only. On Vertex or Bedrock, implement fallback in the gateway: retry, then fall back to a configured secondary model.
  - Citations, PDF input, prompt caching and adaptive thinking are available on all of them. Structured outputs (`output_config.format`) work on the chosen 1P route. They are listed as not supported on Claude in Amazon Bedrock, so a future move to Bedrock needs a schema-in-prompt plus zod-repair fallback.
- **The gateway hides the provider.** Swapping providers is a config change plus an eval run.

### `claude-opus-5-5` API facts every Clerk ticket must respect

- **Thinking is always on.** Omit `thinking`, or send `{type: "adaptive"}`. `{type: "disabled"}` or a token budget returns a 400.
- **Effort:** control depth with `output_config.effort` (`low|medium|high|xhigh|max`; the default is `medium`).
- **No forced tool use.** A forced `tool_choice` (`any` or a named tool) returns a 400. For structured results, use `output_config.format` with a JSON schema (`zodOutputFormat` and `messages.parse` in the TypeScript SDK). Tools are for model-chosen retrieval only.
- **Check `stop_reason` before reading content.** Handle `refusal` and `max_tokens` first.
- **Preserved thinking.** Thinking blocks are bound to the model and the conversation. Store assistant turns verbatim and replay them unchanged. **Never edit earlier turns.** Fallback-model turns start a fresh branch.
- **Limits:** 1M context and 128K max output. The prompt-cache minimum prefix is 512 tokens.
- **Indicative pricing:** $4 / $20 per million input and output tokens, with cache reads at $0.20. Confirm per provider in AI-01.

## Gateway (`apps/functions/src/clerk/gateway.ts`)

```ts
interface ClerkModelPort {
  // Streams when onEvent is given; always resolves with the final message.
  run(req: ClerkModelRequest, onEvent?: (e: ClerkStreamEvent) => void): Promise<ClerkModelResult>;
}
```

The gateway is responsible for:

- **Auth and limits:** auth, org and role checks; feature-flag and kill-switch checks (`clerk.enabled` per org, plus a global switch); per-org and per-user rate limits; per-org monthly token budgets.
- **Prompt management:** prompts are rendered from versioned templates in `libs/clerk/prompts/<id>@<version>.md`. Every call logs `promptId@version`.
- **Prompt caching:** a stable system prompt plus matter context comes first, with a cache breakpoint after the static prefix.
- **Structured outputs:** proposals use `output_config.format` with the JSON schema derived from the zod schema in `libs/clerk/schemas`. Validate again with zod on receipt. If validation fails, record a failure and don't retry blindly.
- **Citations:** source documents go in as `document` content blocks (PDF or text) with `citations: {enabled: true}`, or as search-result blocks for chunks. Citation char/page ranges are mapped back to `{documentId, page, quote}`.
- **Streaming to the client:** the function writes partial message text to `clerkThreads/{t}/messages/{m}` every 250 ms or so, and the client listens. This avoids long-lived HTTP from Functions and gives offline-safe history.
- **Stop:** the client sets `stopRequested: true` on the message, and the gateway checks this between stream events and aborts.
- **Metering:** `usage` (input, output and cache-read tokens) is written to `orgs/{orgId}/metrics/clerk-{month}` and to the message.
- **Logging:** metadata only (ids, token counts, latency, stop reason). **Never prompt or completion text.**

### As built (AI-02)

- **Entry point:** `createClerkGateway(deps).run({ctx, feature, promptId, vars, documents?, searchResults?, stream?, output?})` returns `{status, text, parsed, citations, usage, stopReason, model, promptRef, fallbackUsed, costMicros}`. Callables get one from `clerkGateway({db, ports, clock})` (`apps/functions/src/clerk/service.ts`).
- **Order:** role (`clerk.use`) → kill switches (`clerk.enabled`, `clerk.features.<feature>`, `org.settings.clerk.enabled === false`, all `CLERK_DISABLED`) → prompt render → monthly budget (`CLERK_BUDGET_EXCEEDED`) → per-user window (`CLERK_RATE_LIMITED`) → the call → status → structured-output validation → citations → metering → message → log.
- **Features** (`clerk/features.ts`): each has a kill-switch flag and a timeout. `hello` (the connectivity check) has no feature flag of its own.
- **Limits:** a sliding window per user in `orgs/{orgId}/counters/clerk-rate-{uid}` (default 30 per 10 minutes) and a monthly token budget across all token kinds (default 200M). Both can be set in `orgs/{orgId}.settings.clerk` (`userRateLimit`, `monthlyTokenBudget`). Months run in Melbourne time.
- **Statuses** on the message and the result: `done`, `refused` (`stop_reason: refusal`, shown honestly), `truncated` (`max_tokens`), `invalid_output` (structured output that doesn't parse or validate; never retried), `stopped` (the owner set `stopRequested`), and `error` (the stream dropped after text arrived; the partial text is kept).
- **Resilience:** the SDK runs with `maxRetries: 0`, so the gateway owns retries. It retries the primary model twice on 429, 529, 5xx, timeouts and connection drops, with jittered backoff (0.5 s, then 1 s, × 0.5–1.5, or the provider's `retry-after`). It then tries `claude-opus-5`, then `claude-sonnet-5-5`, once each, as a fresh branch with no earlier assistant turns. A provider 429 never switches models; it ends as `CLERK_BUSY`. If everything fails, the result is `CLERK_UNAVAILABLE`. Refusals use the API's server-side `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`) on the primary only. Any hop sets `fallbackUsed`.
- **Prompts:** `libs/clerk/prompts/<id>@<semver>.md` with front-matter (`id`, `version`, `effort`, `maxTokens`, `outputSchema?`, `tools?`), then a `# System` and a `# User` section. `renderPrompt` fails on a missing or unused variable. `pnpm materia-scripts clerk-prompts` compiles the files into `prompt-sources.generated.ts` for the Functions bundle, and a libs/clerk test fails when the two drift. Output schemas live in `libs/clerk/src/lib/schemas.ts`.
- **Messages:** the gateway creates the assistant message (never overwriting one) and writes text at most every 250 ms. The final write adds the status, citations, usage, model and `fallbackUsed`. The verbatim assistant turn (thinking blocks included) is stored as JSON in the server-only `messages/{m}/private/raw`, so later turns can replay it unchanged.
- **Metering:** `orgs/{orgId}/metrics/clerk-YYYY-MM` holds `values.{calls,tokens,inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,costMicros}`, plus `feature.<f>.{calls,tokens,costMicros}` and `user.<uid>.{calls,tokens,costMicros}`. Costs come from `CLERK_PRICES` (`libs/clerk/src/lib/prices.ts`). A model without a confirmed price is costed at the primary's price and counted in `estimatedCostCalls`. A stopped stream meters the call with zero tokens, because the API reports no usage for an aborted stream.
- **SDK boundary:** ESLint `no-restricted-imports` blocks model SDKs everywhere except `apps/functions/src/clerk/providers/` (and the AI-01 bench script). `tools/scripts/src/model-sdk-imports.spec.ts` proves it.
- **Smoke test:** the `clerk-hello` callable runs the `hello` prompt through the whole gateway. It needs `clerk.enabled` on for the org. In the emulator it uses the fake model; with `ANTHROPIC_API_KEY` in Secret Manager it is the live check (AI-01b, MAT-120).

## Context assembly (AI-03)

- **The scope is resolved server-side** from the request (`orgId`, `matterId`, `uid`). Role checks run before any retrieval.
- **What goes in the context:**
  - the matter summary record;
  - key facts, parties, upcoming deadlines and open tasks (compact JSON);
  - retrieved chunks, top-k from vector search filtered by matter, de-duplicated by document and page;
  - documents the user explicitly attached.
- **Token budget:** a fixed budget per feature. When content is truncated, the prompt says so and the answer must disclose it (rule 5).
- **Prompt-injection defence:** document text is wrapped in `<document>` blocks and labelled untrusted. The system prompt says instructions inside documents are data. Tools are read-only, so an injection cannot cause writes. Evals include injection cases such as "ignore previous instructions" inside a will.
- **Privileged documents:**
  - They are excluded for `paralegal` and `readonly` roles unless the matter grants access.
  - Outputs citing them get `privileged: true`.
- **Never cross matters**, except Insights narratives, which only see aggregated metrics.

## Features → tickets

| Feature | Ticket | Output | Effort |
|---|---|---|---|
| Chat panel (⌘J) | AI-06 | streamed text + citations + suggestion cards | medium |
| Suggestions engine | AI-07 | `suggestions` per kind | medium |
| Document classification on ingest | AI-04 | category + title + date | low |
| Will extraction | AI-08 | testator, date, executors, beneficiaries, gifts, guardians, trusts, attestation red flags | high |
| Daily brief | AI-09 | ClerkBrief items, each citing a record | low |
| Drafting | AI-10 | a letter draft (Markdown → docx) | medium |
| Time capture assist | AI-11 | time-entry suggestions | low |
| Chronology from documents | LIT-06 | chronology suggestions with sources | high |
| Orders extraction | LIT-04 | order suggestions with due dates | high |
| Insights narrative | INS-04 | narrative citing metric cells | low |
| Voice → structured | MOB-03 | note and time-entry suggestions | low |

## Evals (AI-12)

- **Golden sets** live in `libs/clerk/evals/<feature>/*.json`. They use fictional matters and PDFs, generated or hand-written. **Never real client data.**
- **Graders:**
  - schema validity (exact);
  - field accuracy against the gold labels (exact or normalised);
  - citation precision (does the cited quote exist on that page and support the claim?);
  - an LLM-judge rubric for drafts;
  - a refusal check for outcome predictions;
  - an injection-resistance check;
  - a privilege-leak check (a paralegal context must not surface privileged text).
- **When evals run:** in CI, on any change to `libs/clerk/**` (subset), and in full nightly. Prompt changes cannot merge if a metric regresses by more than its threshold.
- **Cost guard:** each eval run reports its spend, and the nightly budget is capped.

## Kill switches & failure modes

- `clerk.enabled` (global), `clerk.features.<id>` (per feature) and `org.settings.clerk.enabled` (per org).
- **Model errors:** overloaded or 529 errors back off, then use the secondary model. Rate-limited requests are surfaced as "Clerk is busy". A `refusal` stop reason shows the refusal honestly.
- **Budget exhausted:** a clear message, and admins are notified.
- **The app never depends on Clerk.** Every Clerk feature has a manual path.
