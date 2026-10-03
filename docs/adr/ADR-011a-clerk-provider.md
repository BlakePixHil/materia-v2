# ADR-011a: Clerk provider and Australian data residency

- **Status:** Proposed. Awaiting product-owner approval, recorded on [AI-01 (MAT-54)](https://linear.app/materia-web/issue/MAT-54).
- **Date:** 2026-10-03
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

`tools/scripts/clerk-bench.ts` runs a 20k-token fictional prompt through one route (5 runs) and prints TTFT and output tokens per second. **It hasn't been run against a real provider yet**, because no provider credentials exist (see Human steps). The offline dry run (`--provider fake`) checks the script and the table format. Paste the real results here:

| Route | Region | Median TTFT (ms) | Median output tok/s | Runs | Date |
| -- | -- | -- | -- | -- | -- |
| Bedrock, in-region | `ap-southeast-4` | _pending_ | _pending_ | 5 | |
| Bedrock, AU profile | `ap-southeast-2` | _pending_ | _pending_ | 5 | |
| Vertex, global (reference only) | `global` | _pending_ | _pending_ | 5 | |

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

## Decision (proposed)

1. **Primary route:** Claude `claude-opus-5-5` on **Amazon Bedrock (Claude in Amazon Bedrock, Mantle Messages endpoint)**, called from Cloud Functions in `australia-southeast1` through `@anthropic-ai/bedrock-sdk` (`AnthropicBedrockMantle`), using the **`AU` geography inference profile** so inference stays in Sydney or Melbourne. Where strict single-region residency is wanted, use **`ap-southeast-4` in-region**; it's a config change.
2. **Never** route Clerk traffic to the `global` endpoint, Vertex, Claude Platform on AWS or the 1P API automatically: each sends data outside Australia. Changing route needs a new ADR and owner sign-off.
3. **Embeddings** stay on Vertex AI in `australia-southeast1` (ADR-012), at 768 dimensions.
4. `ClerkModelPort` keeps the provider swappable (Vertex and 1P adapters remain possible for tests and future residency changes). The MVP default is the **fake model**, with `clerk.enabled` off, until the hello call passes.

## Fallback strategy

All fallbacks stay on the Bedrock `AU` route. Server-side `fallbacks` aren't available on Bedrock, so the gateway implements them.

| Trigger | Action |
| -- | -- |
| `stop_reason: "refusal"` | Show the refusal honestly. For proposal-type features only, retry once on the **secondary model**, `anthropic.claude-opus-5`, on the same route, as a **fresh branch** (preserved thinking: Opus 5 can't read Opus 5.5's thinking blocks) |
| HTTP 529 (overloaded), 5xx, or a stream timeout | Up to 2 retries with exponential backoff and jitter, then the **secondary model**. If that also fails, the **tertiary model**, `anthropic.claude-sonnet-5-5`; then "Clerk is unavailable", with the manual path |
| HTTP 429 (rate limited) | No model switch. Show "Clerk is busy" and back off per `retry-after` |
| Secondary-model share above 20% of calls, or a gateway error rate above 5%, over 15 min | Alert (FND-21). An owner may flip `clerk.enabled` off per org or globally |
| Region-wide Bedrock outage | Clerk degrades to manual paths. No automatic cross-geography failover (decision 2) |

Whether `claude-opus-5` and `claude-sonnet-5-5` are offered on the `AU` profile **(verify in the Bedrock console)** goes into `infra/MANUAL.md`. If either isn't, the fallback list shrinks to what is.

## Consequences

- Australian processing for Clerk, which supports the APP 8 position and client expectations.
- A second cloud (AWS) to run: an account, IAM, budgets, and Terraform state.
- Batches, Files API, server-side fallbacks, and (pending verification) native structured outputs are unavailable, so the gateway owns these concerns. Prompt caching, citations, PDF input and streaming, which Clerk needs most, are available.
- About a 10% price premium over global endpoints.

## Alternatives considered

- **Vertex AI (global or `us`):** same cloud and IAM as Firebase, no extra account. Rejected: Opus 5.5 can't be pinned to Australia.
- **Claude Platform on AWS:** full API parity (fallbacks, batches, Files). Rejected: inference and storage are US or global only.
- **Anthropic API with ZDR:** simplest, and ZDR is available for Opus 5.5. Rejected as the default, because processing would be in the US or global. ADR-011 allows it only with an explicit privacy sign-off.

## Sub-processor input for SEC-01

| Sub-processor | Service | Data | Location |
| -- | -- | -- | -- |
| Amazon Web Services | Amazon Bedrock (Claude inference) | Clerk prompts: matter context and document excerpts | Australia (`ap-southeast-2`, `ap-southeast-4`) |
| Google Cloud | Firebase (Firestore, Storage, Functions, Auth), Vertex AI embeddings | All application data; document text for embeddings | Australia (`australia-southeast1`, backups `australia-southeast2`) |
| Anthropic | Model developer. No processing role on the Bedrock route: AWS runs inference, and Anthropic has no operator access | None | n/a |

## Human steps (owner)

- [ ] Create or choose an AWS account for Materia. Enable Claude Opus 5.5 (plus Opus 5 and Sonnet 5.5 for fallback) in Bedrock model access, in `ap-southeast-2` and `ap-southeast-4`, and accept the terms.
- [ ] Confirm in the console that Opus 5.5 is offered on the `AU` profile and in-region in `ap-southeast-4`, and whether structured outputs are accepted. Record the model and profile ids.
- [ ] Request quota if the default 2M input TPM isn't granted. Keep model-invocation logging off.
- [ ] Record the agreement, retention settings and ids in `infra/MANUAL.md`.
- [ ] Provide credentials for the hello call: an IAM role that a GCP service account can assume (or, temporarily, short-lived dev credentials), once FND-03 has created the dev project.
- [ ] Approve or reject this ADR on MAT-54.
