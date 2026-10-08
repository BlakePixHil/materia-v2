# Runbook: disable Clerk

How to switch Clerk off, for one firm or for everyone, and back on (SEC-08, [docs/07](../07-clerk-ai.md#kill-switches--failure-modes)). The rest of the app never depends on Clerk: every Clerk feature has a manual path, so switching it off loses convenience, never work.

## When

- **Clerk shows a person something they shouldn't see** (another matter's or firm's details, a privileged document to a role without `privileged.view`): SEV-1. Switch it off for everyone first, then follow [incident-response.md](incident-response.md) and the NDB assessment in [data-breach.md](data-breach.md).
- **Clerk writes or suggests something harmful or plainly wrong at scale**, or record text is found steering it (prompt injection): switch off the feature involved for everyone, then fix and run the evals ([docs/07](../07-clerk-ai.md)) before switching it back on.
- **Cost is running away for one firm:** lower that firm's monthly spend limit (Settings → Clerk and AI), or switch Clerk off for the firm. Its Anthropic key is the firm's own, so the bill is the firm's.
- **The model provider is down:** nothing to do. Clerk answers "Clerk is unavailable" by itself and recovers when the provider does.

## The switches

The gateway checks them in this order on **every** Clerk call, including answers already queued and background work (filing suggestions, briefs), so any one of them stops Clerk (`apps/functions/src/clerk/gateway.ts`, `assertOn`).

| Scope | Switch | Who | Takes effect |
| --- | --- | --- | --- |
| Everyone | Remote Config `clerk_enabled` = `false` | the operator, in the Firebase console | Functions within a minute (they cache flags for 60 s). The web app hides Clerk at its next Remote Config fetch, up to an hour later in prod; until then its Clerk requests are refused with "Clerk isn't turned on for your practice" |
| One feature, everyone | Remote Config `clerk_features_<feature>` = `false` (table below) | the operator | the same |
| One firm | Settings → Clerk and AI → **Clerk** off (writes `settings.clerk.enabled: false` on `orgs/{orgId}`) | the firm's owner or admin; the operator in an emergency (below) | at once |
| One feature, one firm | Settings → Clerk and AI → the feature's switch | the firm's owner or admin | at once |

Remote Config parameters for the features (the flag key with `.` replaced by `_`):

| Parameter | Feature |
| --- | --- |
| `clerk_features_chat` | Chat with Clerk in a matter (AI-06) |
| `clerk_features_matterBrief` | The matter brief (AI-06c) |
| `clerk_features_suggestions` | Suggestion cards (AI-07) |
| `clerk_features_classification` | Filing and classifying uploads (AI-04) |
| `clerk_features_drafting` | Drafting letters (AI-10) |
| `clerk_features_willExtraction` | Will extraction (AI-08) |
| `clerk_features_brief` | The daily brief on Today (AI-09) |
| `clerk_features_timeAssist` | Time entry suggestions (AI-11) |
| `clerk_features_insightsNarrative` | The Insights narrative (INS-04) |
| `clerk_features_intakePrefill` | Intake prefill (CORE-05) |

## Switch it off for everyone

1. Firebase console → the project (`materia-v2-prod` or `materia-v2-dev`) → **Remote Config**.
2. On the **Server** template, set `clerk_enabled` (or the feature's parameter) to `false`, creating the parameter if it doesn't exist, and **Publish**. This is the one that stops the calls.
3. On the **Client** template, do the same and **Publish**, so the app stops offering Clerk.
4. **Check for org overrides.** An org override beats Remote Config: a firm whose org document has `flags` → `clerk.enabled: true` (set only by a platform admin through `flags-setOrgOverride`, and audited as `flag.override_set`) keeps Clerk. If one exists, switch Clerk off for that firm as below too.
5. **Check it took:** after a minute, Logs Explorer with `jsonPayload.message="rejected" jsonPayload.code="CLERK_DISABLED"` shows Clerk requests being refused, and no new `jsonPayload.message="clerk chat answered"` lines appear.

On dev, agents don't change Remote Config by themselves: dev flags go through `infra/remote-config/dev.json` and only when the owner names the change. Prod is always a person's change in the console.

## Switch it off for one firm

Ask the firm's owner or admin to turn **Clerk** off in Settings → Clerk and AI. If you can't reach them and it can't wait, the operator sets it in the Firestore console: `orgs/{orgId}` → `settings` → `clerk` → `enabled` = `false` (boolean). That edit bypasses the audit log, so note it on the incident ticket and tell the firm what you changed and why. The firm can switch it back on themselves, so agree with them when that's safe.

## Switch it back on

Undo the same switch, in reverse order for Remote Config (Client, then Server, so the app doesn't offer what the server still refuses for longer than a minute). Before switching a feature back on after an output problem, run the evals for that feature and check its baseline ([docs/07](../07-clerk-ai.md)). Note on the incident ticket when Clerk was off and why.

## The Claude connector is not Clerk

People's own Claude reaching Materia over MCP (INT-07) has its own switches: Remote Config `integrations_claudeConnector`, and each practice's Settings → Claude connector, which ends every connection at once ([integrations.md](integrations.md#claude-connector-int-07)).
