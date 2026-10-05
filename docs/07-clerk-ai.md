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

- **Model ([ADR-011b](adr/ADR-011b-clerk-byok.md)):** Claude Sonnet 5.5 (`claude-sonnet-5-5`) by default; an admin can opt the org into Claude Opus 5.5 (`claude-opus-5-5`) in Settings → Clerk.
  - Adaptive thinking (`thinking: {type: "adaptive"}`).
  - Every prompt sets `effort` explicitly (Sonnet 5.5's default is `high` and its levels differ from Opus 5.5's). Use `high` for will extraction and chronology, and `low` for the brief and classification.
  - Stream whenever output may be long.
- **Credentials: [ADR-011b](adr/ADR-011b-clerk-byok.md)** (bring your own key): each org's owner or admin saves the firm's own Anthropic API key in Settings → Clerk. It is validated, encrypted with Cloud KMS (`clerk-api-keys`) and stored in the server-only `orgs/{orgId}/integrations/anthropic`. With no key, Clerk is off for the org. There is no platform key.
- **Provider: [ADR-011a](adr/ADR-011a-clerk-provider.md)** (accepted for the MVP): the **Anthropic API (1P)**, with refusals handled by server-side `fallbacks: "default"`. The owner accepted processing outside Australia for the MVP. Bedrock's `AU` profile is the only route with Australian inference, and is the documented path if that's needed later. Candidates evaluated:
  1. **Claude on Google Vertex AI** (`AnthropicVertex` client). It is the same GCP org and IAM as Firebase, with no API key. Check that the model is available in an Australian region and what regional versus global endpoint pricing applies.
  2. **Claude Platform on AWS / Amazon Bedrock in `ap-southeast-2`** (Sydney).
  3. **Anthropic API (1P)** with `inference_geo` / data-residency controls if they cover Australia, and a zero-data-retention agreement.
- Platform differences to respect, per the Claude platform-availability table:
  - The Message Batches and Files APIs are 1P/P-AWS only.
  - Server-side `fallbacks` are 1P/P-AWS only. On Vertex or Bedrock, implement fallback in the gateway: retry, then fall back to a configured secondary model.
  - Citations, PDF input, prompt caching and adaptive thinking are available on all of them. Structured outputs (`output_config.format`) work on the chosen 1P route. They are listed as not supported on Claude in Amazon Bedrock, so a future move to Bedrock needs a schema-in-prompt plus zod-repair fallback.
- **The gateway hides the provider.** Swapping providers is a config change plus an eval run.

### `claude-opus-5-5` and `claude-sonnet-5-5` API facts every Clerk ticket must respect

- **Thinking is always on.** Omit `thinking`, or send `{type: "adaptive"}`. `{type: "disabled"}` or a token budget returns a 400.
- **Effort:** control depth with `output_config.effort` (`low|medium|high|xhigh|max`; the default is `medium`).
- **No forced tool use.** A forced `tool_choice` (`any` or a named tool) returns a 400. For structured results, use `output_config.format` with a JSON schema (`zodOutputFormat` and `messages.parse` in the TypeScript SDK). Tools are for model-chosen retrieval only.
- **Check `stop_reason` before reading content.** Handle `refusal` and `max_tokens` first.
- **Preserved thinking.** Thinking blocks are bound to the model and the conversation. Store assistant turns verbatim and replay them unchanged. **Never edit earlier turns.** Fallback-model turns start a fresh branch.
- **Limits:** 1M context and 128K max output. The prompt-cache minimum prefix is 512 tokens.
- **Pricing per million tokens:** Opus 5.5 $4 input, $20 output, $0.20 cache read; Sonnet 5.5 $2 input, $10 output, $0.20 cache read, $2.50 cache write (5-minute). The firm pays Anthropic directly (BYOK).

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
- **Order:** role (`clerk.use`) → kill switches (`clerk.enabled`, `clerk.features.<feature>`, `org.settings.clerk.enabled === false`, all `CLERK_DISABLED`) → the org's key and model (AI-02a: no key is `CLERK_DISABLED` with `switch: 'org.byok.missing'`; a key Anthropic rejected is `CLERK_KEY_INVALID`) → prompt render → monthly budget (`CLERK_BUDGET_EXCEEDED`) → per-user window (`CLERK_RATE_LIMITED`) → the call → status → structured-output validation → citations → metering → message → log.
- **Features** (`clerk/features.ts`): each has a kill-switch flag and a timeout. `hello` (the connectivity check) has no feature flag of its own.
- **Limits:** a sliding window per user in `orgs/{orgId}/counters/clerk-rate-{uid}` (default 30 per 10 minutes) and a monthly token budget across all token kinds (default 200M). Both can be set in `orgs/{orgId}.settings.clerk` (`userRateLimit`, `monthlyTokenBudget`). Months run in Melbourne time.
- **Statuses** on the message and the result: `done`, `refused` (`stop_reason: refusal`, shown honestly), `truncated` (`max_tokens`), `invalid_output` (structured output that doesn't parse or validate; never retried), `stopped` (the owner set `stopRequested`), and `error` (the stream dropped after text arrived; the partial text is kept).
- **Resilience:** the SDK runs with `maxRetries: 0`, so the gateway owns retries. It retries the primary model twice on 429, 529, 5xx, timeouts and connection drops, with jittered backoff (0.5 s, then 1 s, × 0.5–1.5, or the provider's `retry-after`). It then tries the primary's fallback chain once each (Sonnet 5.5 → `claude-sonnet-5`; Opus 5.5 → `claude-opus-5` → `claude-sonnet-5-5`), as a fresh branch with no earlier assistant turns. A 401/403 marks the org's key invalid and ends as `CLERK_KEY_INVALID`. A provider 429 never switches models; it ends as `CLERK_BUSY`. If everything fails, the result is `CLERK_UNAVAILABLE`. Refusals use the API's server-side `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`) on the primary only. Any hop sets `fallbackUsed`.
- **Prompts:** `libs/clerk/prompts/<id>@<semver>.md` with front-matter (`id`, `version`, `effort`, `maxTokens`, `outputSchema?`, `tools?`), then a `# System` and a `# User` section. `renderPrompt` fails on a missing or unused variable. `pnpm materia-scripts clerk-prompts` compiles the files into `prompt-sources.generated.ts` for the Functions bundle, and a libs/clerk test fails when the two drift. Output schemas live in `libs/clerk/src/lib/schemas.ts`.
- **Messages:** the gateway creates the assistant message (never overwriting one) and writes text at most every 250 ms. The final write adds the status, citations, usage, model and `fallbackUsed`. The verbatim assistant turn (thinking blocks included) is stored as JSON in the server-only `messages/{m}/private/raw`, so later turns can replay it unchanged.
- **Metering:** `orgs/{orgId}/metrics/clerk-YYYY-MM` holds `values.{calls,tokens,inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,costMicros}`, plus `feature.<f>.{calls,tokens,costMicros}` and `user.<uid>.{calls,tokens,costMicros}`. Costs come from `CLERK_PRICES` (`libs/clerk/src/lib/prices.ts`). A model without a confirmed price is costed at the primary's price and counted in `estimatedCostCalls`. A stopped stream meters the call with zero tokens, because the API reports no usage for an aborted stream.
- **SDK boundary:** ESLint `no-restricted-imports` blocks model SDKs everywhere except `apps/functions/src/clerk/providers/` (and the AI-01 bench script). `tools/scripts/src/model-sdk-imports.spec.ts` proves it.
- **Smoke test:** the `clerk-hello` callable runs the `hello` prompt through the whole gateway. It needs `clerk.enabled` on for the org and the org's own key (it declares no secret). In the emulator it uses the fake model; on dev, after an admin saves a real key in Settings → Clerk, it is the live check (AI-02a).

### As built (AI-02a: bring your own key)

- **Callables** (`apps/functions/src/clerk/keys.ts`, owners and admins, `PERMISSIONS['clerk.configure']`): `clerk-setApiKey({requestId, apiKey})` (idempotent, sign-in within 5 minutes; trims the key, checks it looks like `sk-ant-…`, validates it with one `models.list` call, encrypts it with KMS bound to the document path, stores `{encryptedApiKey, kmsKeyVersion, last4, setBy, setAt, validatedAt, status, opusAvailable}`), `clerk-removeApiKey({requestId})`, `clerk-setModel({requestId, model})` (refuses Opus 5.5 for a key that couldn't see it) and `clerk-getApiKeyStatus()` (what the settings page shows; never the key). Audit actions: `clerk.api_key_set`, `clerk.api_key_removed`, `clerk.model_changed`, with `last4` and no key material.
- **Keyring** (`clerk/keyring.ts`): reads `integrations/anthropic` on every call (a rotated key applies to the next call), decrypts with the `clerkKms` port and caches the plaintext per org for 5 minutes while the ciphertext is unchanged. Marking a key invalid only touches the version that was rejected.
- **Adapter:** `anthropicModel()` takes `credentials: {orgId, apiKey}` on each request and caches SDK clients per org for 5 minutes while the key is unchanged. `listModels(apiKey)` validates a key.
- **Ports:** `clerkKms` is Cloud KMS over REST in production (`core/kms.ts`) and `FakeKms` in the emulator and tests. The fake model accepts any well-formed key, rejects keys containing `invalid`, can't reach the API for `unreachable`, and hides Opus 5.5 for `noopus`.
- **Web:** Settings → Clerk (`/settings/clerk`, owners and admins) shows the key status, saves a key from a password field (never echoed, cleared after save, no autocomplete), removes it, switches the model, and carries the data-use disclosure. AI-13 adds budgets and usage to the same page.

### As built (AI-04): document ingestion

See [ADR-035](adr/035-clerk-document-ingestion.md). Code in `apps/functions/src/documents/ingest/`.

- **Flow:** `documents-onIngestChange` (trigger) → `documents-ingest` (Cloud Tasks, 50-page checkpoints, continuation tasks for long files) → `documents/{docId}/chunks/{version}-{ordinal}`. `documents-backfillIngest` (`clerk.configure`) re-queues an org's documents that predate ingestion, were migrated or failed.
- **Extraction:** PDFs page by page (pdfjs-dist); pages under 20 characters are OCR'd (`ocr@1`, Claude vision on a one-page PDF). DOCX (mammoth), emails (headers and body), text and CSV become ~3,000-character pseudo-pages. PNG and JPEG are OCR'd as one page. Spreadsheets, slides, archives, `.doc` and WebP are `skipped` (`unsupported`).
- **Chunks:** ~800 tokens, 100 overlap, never crossing a page (`chunkPages` in libs/clerk). Each holds `{text, page, docVersion, ordinal, orgId, matterId, privileged, ocr?, embedding}`.
- **Search:** `chunkSearch(...).searchChunks({orgId, matterId, query, k ≤ 50, allowPrivileged})` → `{documentId, version, page, ordinal, text, privileged, distance}` sorted by cosine distance.
- **Classification:** `classify-document@1` on the first three pages → a `document_meta` suggestion (`docmeta-{docId}-v{n}`) with category, title, date and parties. It never changes the document.
- **Cost guard:** `settings.clerk.ocrDailyPages` (default 200 pages a day per org); over it the document is `queued` until the next Melbourne day.
- **Status:** `ingest {status: pending|running|queued|done|failed|skipped, version, pages, ocrPages, chars, chunks, lowConfidencePages?, ocrUnavailablePages?, language?, reason?, error?, checkpoint?, queuedUntil?}`.

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

### As built (AI-03)

See [ADR-034](adr/034-clerk-context-assembly.md). Code: `apps/functions/src/clerk/context/`.

- **Entry point:** `clerkContext({db}).buildContext({ctx, scope: {matterId} | {org: 'metrics'}, feature, attachments?, query?})` returns `{system, contextBlocks: {stable, volatile}, documents, searchResults, manifest, truncated}`. Pass the result to the gateway as `run({..., context})`: the base system prompt goes before the feature prompt's system section, the stable blocks (matter facts and recent notes, with the cache breakpoint) come first, then attachments and excerpts, then the volatile `<context_notice>`, then the question. The result carries `manifest`, `truncated` and `privileged`; the message stores `manifest` and `privileged` from the moment it is created.
- **Access:** the role in the request must have `clerk.use`; the member document is re-read uncached (suspended, removed or no longer `clerk.use`: `ACCESS_REVOKED`). The matter must exist, be live and pass `can(role, 'matter.view', {privileged})` for the request's role (else `NOT_FOUND`, which never reveals a privileged matter) and for the current role (else `ACCESS_REVOKED`). Privileged material needs `privileged.view` in both. Ids are checked as document ids (no `/`), so a client can't name a path; everything is read under `orgs/{claim orgId}/matters/{matterId}`.
- **Facts** (compact JSON in `<matter_facts>`): the matter summary (number, title, type, status, stage, clients, deceased, estate, key facts, dispute, costs disclosure, next deadline), the fee summary (only when fee fields exist), parties by name and role, events, upcoming and blocked deadlines with rule citation and trace (top 20), open tasks (top 30, soonest due first). Server-only fields (search tokens, email token, legacy billing) are never picked.
- **Notes:** the 10 newest live notes, each in `<matter_note>`, cut at 2,000 characters with a `[… truncated: N more characters]` marker. Without `privileged.view` the query itself filters `privileged == false`.
- **Attachments:** at most 10 ids, each a live document of the scoped matter (another matter's, a deleted or a hidden privileged one is `NOT_FOUND`). A document not scanned clean or not ingested is left out and counted in `manifest.processing` ("N documents still processing"). Text comes page by page from `DocumentTextPort`, inside `<document>` with page offsets for citations.
- **Retrieval:** only when there is a query, through `ChunkSearchPort.searchChunks({orgId, matterId, query, k: 24, allowPrivileged})` (AI-04's port). Hits are filtered again (privileged, live, clean, current version, this matter, not already attached), de-duplicated by (document, page), and the 12 closest are sent as `search_result` blocks in `<excerpt>`. A matter's documents are never listed: only attachments and hits are read, by id.
- **Budget:** per feature in `context/policy.ts` (`CONTEXT_POLICIES`, e.g. chat 40k tokens). The system prompt, facts and query are fixed; excerpts (farthest first), then notes (oldest first), then attachments (last first) are dropped until the rest fits. `truncated = {droppedDocs, droppedChunks, droppedNotes}` (or `null`) is on the manifest, the gateway result and, as a notice, in the prompt. Tokens are a character estimate (`TokenCounter` port) until the provider adapter exposes the token-counting endpoint.
- **Untrusted framing:** `<matter_facts>`, `<matter_note>`, `<document>`, `<excerpt>` and `<org_metrics>` are data; their text can't open or close a framing tag (escaped to `&lt;`), and JSON escapes `<`. The base system prompt `system@1.0.0` says to ignore and report instructions found inside them.
- **Metrics scope:** `scope: {org: 'metrics'}` is allowed only for a feature whose policy lists `metrics` (none yet; INS-04 adds one) and roles with `billing.view` (as the rules on `metrics/`). It reads the newest `month-*` and `fy-*` rollups, numbers only, with no documents, notes or retrieval.

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
