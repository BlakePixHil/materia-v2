# ADR-011a: Clerk provider and Australian data residency

- **Status:** Accepted for the MVP: **Anthropic API (first party)**. The product owner approved on [AI-01 (MAT-54)](https://linear.app/materia-web/issue/MAT-54) on 2026-10-03: "I don't really care about data sovereignty at this stage when it comes to AI. The solution to this will be just to be able to hook up an Anthropic API key and use their models from that." This is the explicit sign-off that ADR-011 requires for the Anthropic API route. The Bedrock `AU` analysis below stays as the documented path if Australian processing becomes a requirement.
- **Date:** 2026-10-03 (proposed); 2026-10-03 (accepted, route changed by the owner)
- **Ticket:** [AI-01](https://linear.app/materia-web/issue/MAT-54)
- **Refines:** [ADR-011: Clerk (AI)](011-clerk-ai.md)

## Context

Clerk sends privileged, sensitive client material (wills, medical evidence in capacity disputes, financial records) to Claude `claude-opus-5-5`. APP 8 (cross-border disclosure) and client expectations favour processing in Australia. ADR-011 set this order of preference:

1. Claude on Vertex AI in an Australian region.
2. Claude Platform on AWS, or Amazon Bedrock, in Sydney.
3. Anthropic API with zero data retention, but only with an explicit privacy sign-off.

The research below was done on 2026-10-03, from Anthropic's live platform documentation and public search results. Some cloud-provider console pages couldn't be reached from the agent environment; the claims that rest on secondary sources are marked **(verify)**, and the owner checks them in the console as part of the human steps.

## Findings

### Can each route keep `claude-opus-5-5` inference in Australia?

| Route | Australian inference for Opus 5.5? | Evidence |
| -- | -- | -- |
| **Vertex AI** | **No.** Opus 5.5 is served only from the `global` endpoint or the `us`/`eu` multi-region endpoints. Single-region endpoints serve Claude Sonnet 4.6 and earlier, and no Australian region is listed for Claude at all | [Claude on Google Cloud](https://platform.claude.com/docs/en/build-with-claude/claude-on-vertex-ai): "Dynamically route requests across regions within a geographic area (currently `us` and `eu`)" and "Specific regional endpoints support Claude Sonnet 4.6 and earlier; newer models use the global or multi-region endpoints" |
| **Claude Platform on AWS** | **No.** Anthropic-operated; `inference_geo` is `us` or `global` only, and workspace geo (data at rest) is `us` only | [Data residency](https://platform.claude.com/docs/en/manage-claude/data-residency): "Only `"us"` and `"global"` are available", "Currently, `"us"` is the only available workspace geo" |
| **Anthropic API (1P)** | **No.** Same `inference_geo` limits as above | Same page |
| **Amazon Bedrock** (Claude in Amazon Bedrock, Mantle endpoint) | **Yes.** `ap-southeast-2` (Sydney) offers the `AU` geography inference profile; `ap-southeast-4` (Melbourne) offers both `AU` and in-region-only routing. AWS operates the inference infrastructure with zero Anthropic operator access | [Claude in Amazon Bedrock](https://platform.claude.com/docs/en/build-with-claude/claude-in-amazon-bedrock), Regions table: `ap-southeast-2 … Global, AU`; `ap-southeast-4 … Global, AU, In-region only`. That Opus 5.5 is open to every AU account is **(verify)**: the page lists Opus 5.5 access as per-model criteria |

### Retention and training

| Route | Terms |
| -- | -- |
| Bedrock | "Data handling for this offering is governed by Amazon Bedrock" ([AWS data protection](https://docs.aws.amazon.com/bedrock/latest/userguide/data-protection.html)). AWS's published position is that Bedrock does not store prompts or completions, or use them for training, unless the customer turns on invocation logging **(verify on that page)**. We keep model-invocation logging **off**. Anthropic personnel have no access to the inference infrastructure |
| Vertex | Governed by Google Cloud's Vertex AI data-governance and ZDR terms |
| Claude Platform on AWS / 1P | Anthropic is the processor. ZDR is available for Opus 5.5 (it isn't a "Covered Model" like Fable 5.1), but storage and inference are US or global |

### Features Clerk relies on (Opus 5.5)

| Feature | 1P / P-AWS | Bedrock | Vertex |
| -- | -- | -- | -- |
| Streaming, PDF input, citations, prompt caching, adaptive thinking + effort | Yes | Yes | Yes |
| Structured outputs (`output_config.format`) | Yes | **Listed as not supported** on Anthropic's live Bedrock page (the skill's cached matrix says yes). **(verify in the hello call)** | Yes |
| Server-side `fallbacks` | Yes | No: the gateway implements fallback | No |
| Message Batches, Files API | Yes | No | No |
| `inference_geo` | `us`/`global` | n/a (the region is in the endpoint) | n/a |

**Consequence for AI-02:** the gateway's structured-output step must sit behind a strategy. Use `output_config.format` where the provider supports it; otherwise, a schema-in-prompt JSON answer, validated with zod, plus **one** repair attempt that quotes the validation error. Validation failures are recorded, never retried blindly (Clerk doc). No forced `tool_choice` on Opus 5.5 either way.

### Embeddings (ADR-012) and speech (MOB-03)

- **Embeddings:** Vertex AI in `australia-southeast1` offers `text-embedding-005` (768 dimensions, 2,048-token input) and `gemini-embedding-001` (supports `output_dimensionality: 768`). ADR-012 is unchanged: embeddings stay on Vertex in Sydney, at 768 dimensions for the Firestore vector index. **(Verify that the chosen model is enabled in the dev project.)**
- **Speech-to-text:** Chirp 3 is **not** offered in `australia-southeast1` (it's GA in `asia-southeast1`, Singapore). For MOB-03 (out of MVP scope), either Amazon Transcribe in `ap-southeast-2` (`en-AU`) on the same AWS footprint as Clerk, or an older Chirp model if one is regional in Sydney. Decide in MOB-03.

### Latency benchmark

`tools/scripts/src/clerk-bench.ts` (run it with `pnpm materia-scripts clerk-bench --provider <route>`) runs a 20k-token fictional prompt through one route (5 runs) and prints TTFT and output tokens per second. **It hasn't been run against a real provider yet**, because no API key exists yet; follow-up AI-01b runs it with `--provider anthropic`. The offline dry run (`--provider fake`) checks the script and the table format. Paste the real results here:

| Route | Region | Median TTFT (ms) | Median output tok/s | Runs | Date |
| -- | -- | -- | -- | -- | -- |
| **Anthropic API (chosen)** | `global` | _pending (AI-01b)_ | _pending_ | 5 | |
| Bedrock, AU profile (future path) | `ap-southeast-2` | not run | not run | | |

Run it from a dev Cloud Function or Cloud Shell in `australia-southeast1`, so network distance matches production.

### Cost model (10-lawyer firm, per month)

Opus 5.5 list price is $4 input, $20 output and $0.20 cache read per million tokens. Bedrock and Vertex regional or geography endpoints add **10%** over global ([Bedrock regions](https://platform.claude.com/docs/en/build-with-claude/claude-in-amazon-bedrock#regions)). Bedrock's own price sheet is authoritative **(verify)**. Output counts include thinking tokens; cache writes are ignored (about +5–10%). Volumes are planning assumptions: 21 working days, 10 lawyers.

| Feature (ticket) | Calls/month | Uncached input | Cached input | Output | Cost (AU, +10%) |
| -- | -- | -- | -- | -- | -- |
| Chat panel (AI-06) | 3,150 (15/lawyer/day) | 8,000 | 22,000 | 1,500 | $230 |
| Suggestions (AI-07) | 2,000 | 4,000 | 6,000 | 800 | $73 |
| Doc classification (AI-04) | 400 | 6,000 | 2,000 | 300 | $13 |
| Will extraction (AI-08) | 25 | 40,000 | 3,000 | 6,000 | $8 |
| Daily brief (AI-09) | 210 | 12,000 | 3,000 | 1,200 | $17 |
| Drafting (AI-10) | 120 | 15,000 | 5,000 | 3,000 | $16 |
| Time capture assist (AI-11) | 1,050 | 2,500 | 1,500 | 500 | $23 |
| Chronology (LIT-06) | 6 | 150,000 | 0 | 12,000 | $6 |
| Orders extraction (LIT-04) | 10 | 20,000 | 2,000 | 3,000 | $2 |
| Insights narrative (INS-04) | 8 | 5,000 | 0 | 1,000 | <$1 |
| **Total** | | | | | **≈ US$390/month** (≈ $355 on global endpoints) |

The MVP features (chat, suggestions, classification) come to about $316/month. The AU premium costs about $35/month at this volume, which is small next to the privacy benefit.

### Operations

- **Credentials:** Cloud Functions (GCP) call Bedrock through **workload identity federation**. The function's Google service account presents its OIDC token to AWS STS (`AssumeRoleWithWebIdentity`) for an IAM role that may only `bedrock-mantle:CreateInference` on the allowed model ARNs. No long-lived AWS keys; nothing goes in Secret Manager except the role ARN and region config.
- **Quotas:** Bedrock's default is 2M input TPM, and up to 5M input / 500k output TPM can be requested without Anthropic approval: far above the volumes above. RPM limits are set on the AWS side.
- **Monitoring:** CloudWatch metrics and CloudTrail for the AWS side. The gateway's own metadata-only logs (ids, token counts, latency, stop reason) feed Cloud Monitoring (ADR-018). Bedrock model-invocation logging stays **off**, so prompts are never stored.
- **Cost of the second cloud:** one AWS account in `ap-southeast-2`/`ap-southeast-4`, Terraform-managed alongside the GCP projects (FND-03), with budgets and alerts.

## Decision (accepted for the MVP)

1. **Route:** Claude `claude-opus-5-5` through the **Anthropic API (first party)**, called only from Cloud Functions (`australia-southeast1`) with the official `@anthropic-ai/sdk` client.
2. **Credentials:** an Anthropic API key in **Secret Manager**, read with `defineSecret('ANTHROPIC_API_KEY')`. It is never in code, Firestore, the client bundle or logs. Each environment (dev, prod) has its own key in its own Anthropic workspace, so usage and spend can be capped per environment in the Console.
3. **Inference geography:** the workspace default (`global`). The owner has accepted processing outside Australia for the MVP. `inference_geo: "us"` is available (at 1.1×) if a US-only posture is ever preferred; no Australian option exists on this route.
4. **Embeddings** stay on Vertex AI in `australia-southeast1` (ADR-012), at 768 dimensions. This is unaffected by the Claude route.
5. `ClerkModelPort` keeps the provider swappable. The **Bedrock `AU` route** (the findings above) is the documented migration path if Australian processing becomes a requirement (for example, once more firms onboard). That swap is a config change plus an eval run, recorded in a superseding ADR.
6. Until the API key exists in Secret Manager, Clerk runs against the **fake model** with `clerk.enabled` off (handbook MVP fallback).

## Fallback strategy

The first-party API supports the server-side `fallbacks` parameter, so refusals are handled by the API itself. The gateway handles availability errors.

| Trigger | Action |
| -- | -- |
| `stop_reason: "refusal"` | Send every request with `betas: ["server-side-fallback-2026-07-01"]` and `fallbacks: "default"`, so the API reroutes by refusal category without us maintaining a model list. If the final response is still a refusal, show it honestly (Clerk doc). Fallback turns are a **fresh branch**: thinking blocks are bound to the model (preserved thinking) |
| HTTP 529 (overloaded), 5xx, or a stream timeout | SDK retries (`maxRetries: 2`, exponential backoff), then the gateway retries once on the **secondary model**, `claude-opus-5`, then the **tertiary model**, `claude-sonnet-5-5`; then "Clerk is unavailable", with the manual path |
| HTTP 429 (rate limited) | No model switch. Show "Clerk is busy" and back off per `retry-after` |
| Secondary-model share above 20% of calls, or a gateway error rate above 5%, over 15 min | Alert (FND-21). An owner may flip `clerk.enabled` off per org or globally |
| Anthropic API outage | Clerk degrades to manual paths (the app never depends on Clerk). Switching to another provider is a deliberate config change, not automatic |

## Consequences

- The full first-party feature set: structured outputs (`output_config.format`), citations, PDF input, prompt caching, streaming, server-side fallbacks, Message Batches and the Files API. The Bedrock structured-output gap doesn't apply.
- No second cloud to run: just one secret per environment.
- Clerk prompts (matter context and document excerpts) are processed by Anthropic outside Australia. This must be disclosed in the privacy policy and the sub-processor list (SEC-01), and in the Clerk data-use disclosure (AI-13).
- Standard (global) pricing: about **US$355/month** at the volumes above, with no regional premium.
- Recommended follow-up (not blocking): ask Anthropic for **zero data retention** on the Materia organisation. Opus 5.5 is available under ZDR, unlike Fable 5.1, which requires 30-day retention. Record the outcome in `infra/MANUAL.md`.

## Alternatives considered

- **Amazon Bedrock, `AU` profile:** the only route with Australian inference (see Findings). Deferred: it adds an AWS account, cross-cloud IAM and a structured-output workaround, and the owner doesn't need Australian processing for the MVP. It remains the documented path.
- **Vertex AI (global or `us`):** same cloud as Firebase, but no Australian endpoint for Opus 5.5 and no server-side fallbacks, Batches or Files API. No residency advantage over the first-party API.
- **Claude Platform on AWS:** first-party parity, but it needs AWS billing and IAM for no residency gain (US or global only).

## Sub-processor input for SEC-01

| Sub-processor | Service | Data | Location |
| -- | -- | -- | -- |
| Anthropic | Claude API (Clerk inference) | Clerk prompts: matter context and document excerpts | Outside Australia (global routing; workspace data stored in the US) |
| Google Cloud | Firebase (Firestore, Storage, Functions, Auth), Vertex AI embeddings | All application data; document text for embeddings | Australia (`australia-southeast1`, backups `australia-southeast2`) |

## Human steps (owner)

- [x] Approve the route (done on MAT-54, 2026-10-03).
- [ ] Create an Anthropic Console organisation with workspaces for `dev` and `prod`; set spend limits.
- [ ] Create an API key per workspace and add it to Secret Manager as `ANTHROPIC_API_KEY` in the matching GCP project (once FND-03 has created the projects). Never paste keys into tickets, chat or code.
- [ ] Optional: request zero data retention from Anthropic.
- [ ] Record the workspace names, spend limits and retention setting (not the keys) in `infra/MANUAL.md`.

The hello call and the latency benchmark (`pnpm materia-scripts clerk-bench --provider anthropic`) move to follow-up ticket **AI-01b** ([MAT-120](https://linear.app/materia-web/issue/MAT-120)), which runs once the key is in the dev project's Secret Manager.
