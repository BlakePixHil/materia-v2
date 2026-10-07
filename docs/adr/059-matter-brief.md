# ADR-059: One shared brief per matter, built from facts every reader may see, with a template when Clerk can't write it

- **Status:** Accepted
- **Date:** 2026-10-07
- **Ticket:** [AI-06c](https://linear.app/materia-web/issue/MAT-169)
- **Builds on:** [ADR-034](034-clerk-context-assembly.md) (context assembly), [ADR-037](037-clerk-suggestions-engine.md) (Clerk never writes), [ADR-054](054-insights-narratives.md) (checked numbers), ADR-011a (Clerk provider)

## Context

The matter Overview had a "Coming in AI-06" placeholder where the design's ClerkBrief card goes. AI-06c fills it with a short brief: what changed since the last visit, what's due (overdue and the next 14 days) and a suggested next step, at most five items, each citing the record it comes from and linking to it. The ticket also asks for:

- facts only, never document text;
- a brief generated when the Overview opens and the kept one is stale (over 24 hours old, or the matter changed), cached at `matters/{matterId}/briefs/latest`;
- Refresh limited to 3 a day per matter, low effort and a strict per-org budget;
- a deterministic template when Clerk is off, the feature is off or the call fails, never a placeholder;
- privileged matters' briefs readable only with `privileged.view`;
- read-only: actions open existing tabs and suggestion cards;
- a facts builder AI-09's daily brief can reuse.

A matter is read by people with different roles. A per-person brief would multiply cost by the team's size and still need the same privilege rules, so the brief is shared, and the facts it is built from must be ones every reader of the matter may see.

## Decision

- **The facts are built once, in libs/domain.** `matterBriefFacts` (pure, `libs/domain/src/lib/matter-brief.ts`) takes the matter's open deadlines and tasks, its feed lines and documents added in the last 14 days, and its open suggestions. It returns:
  - overdue and next-14-day deadlines and tasks, a few undated open tasks, the changes and documents added, the open suggestions, each list capped (`BRIEF_FACT_LIMITS`) with the totals in `counts`;
  - each dated row with its date written out against today ("Fri 16 Oct") and `inDays`, so Clerk copies dates rather than working them out;
  - a ref per record (`deadline:dl-1`, `document:d-2`) with its label, tone (overdue, due within 3 days or critical) and the time it changed;
  - `read` (what was used, for the footer), a `hash` of the facts with today in them, and `quiet` (nothing to say).

  Documents are names and categories only. Privileged documents and suggestions are left out unless the matter itself is privileged, because then only `privileged.view` roles can read the brief at all. `readMatterBriefFacts` (Functions) reads the rows; `buildContext`'s policy `facts: 'brief'` wraps the facts in `<matter_facts kind="brief">`, a tag the system prompt already treats as data. No notes, document text or retrieval are sent.
- **Clerk writes, the checks decide.** `matter-brief@1.0.0` runs at low effort (8k-token context, 1,500 output tokens) and returns `{headline, items[{kind: due|changed|next, text, refs[]}]}`. `checkBrief` keeps an item only when:
  - every ref is in the facts;
  - every number outside a date is in the facts it cites, the windows (14) or the counts of the kinds it cites;
  - every day-and-month date is in the facts it cites.

  It keeps at most five items and replaces a headline whose numbers or dates aren't in the totals or the kept items' facts with the template's. When nothing passes, the template is used. Logs carry counts, cost and tokens only, never the text.
- **The template is the fallback, and the brief when Clerk can't be used.** `templateBrief` writes the same shape from the same facts ("Deadline “X” was due Thu 1 Oct.", "Next on the task list: “…”."), with a reason: `off` (Clerk, the feature or the practice's toggle is off), `role` (the opener can't use Clerk), `failed`, `limit` (budget or the org's daily cap) or `quiet`. The card shows it plain (no Clerk mark or glow) and labels it "Matter brief".
- **One callable, and the server decides when it is stale.** `clerk-matterBrief({matterId, mode: open|refresh})` checks the matter as the rules would (missing, deleted, destroyed or privileged without `privileged.view` is NOT_FOUND), works out whether Clerk may write it for this person (`gateway.assertOn`), reads the facts, then in one transaction:
  - keeps a brief whose hash matches, is under 24 hours old and has the matter's privilege, unless it is the template and Clerk may now write it;
  - leaves it to another call that is writing it (`pendingUntil`, a 2-minute lease);
  - otherwise writes the template and, when Clerk may write it and the org's daily cap (300) allows, claims it for Clerk and counts it (`orgs/{orgId}/counters/clerk-matter-briefs`).

  After a failure or a limit, opening the matter waits 30 minutes (`retryAfter`) before asking Clerk again; Refresh (3 a day per matter, `refreshes {day, count}`, RATE_LIMITED after) asks at once. The feature is a background one for the gateway: the per-person rate limit doesn't apply, the practice's monthly budget does.
- **Shared, and read through the matter's rules.** `matters/{matterId}/briefs/latest` is written only by the callable. The rules let a member read it when the brief and its matter are both visible to them, so a brief never outlives a change to the matter's privilege; a missing brief reads as missing so the Overview can listen before the first one exists. The brief's `privileged` follows the matter's.
- **The card.** At the top of the Overview's left column: the kept brief shows at once from the listener, and the callable (called each time the tab opens) replaces it when it was stale. Each item's sources are chips that open the record's tab (a document its page, a suggestion the "Clerk suggests…" card). Items whose only sources are suggestions are hidden when that card isn't shown (the feature is off, or the role can't use Clerk). Changes newer than this device's last visit to the Overview are marked "New since your last visit" (remembered in the browser, per matter). Refresh shows for roles that can use Clerk when the feature is on; "Ask a follow-up" opens ⌘J on the matter when the chat is on, except on phones. Nothing on the card changes the matter.
- **Behind a flag, with evals.** `clerk.features.matterBrief` is server-enforced and off by default; `CLERK_FEATURES.matterBrief` carries `orgFeature: 'matterBrief'` (the "Matter brief" toggle in Settings → Clerk and AI) and `CONTEXT_POLICIES.matterBrief` allows only the matter scope. With the flag off every reader gets the template. The `matter-brief` eval suite (10 cases) runs production's facts, context and checks, graded by `factAccuracy` (items the checks keep), `recordRecall` (the records a person must see are cited), `privilegeLeak` and `noInventions`.

## Consequences

- A wrong date, count or record never reaches the card: the checks drop it, and the template covers what Clerk got wrong or couldn't do. Numbers written as words aren't checked; the prompt asks for digits.
- Opening an Overview reads the matter's open deadlines and tasks plus up to 40 feed lines, 20 documents and 30 suggestions, even when the kept brief is fresh, because the hash is the staleness check. That is a few dozen reads per open and no model call.
- Everyone on a matter sees the same brief. A read-only person opening a stale matter writes the template; the next person who can use Clerk upgrades it. Budget alerts aren't in the shared brief (not every reader has `billing.view`).
- "Since your last visit" is per device. A brief is rebuilt at most once per matter per day for the date to move on, more often only when the matter changes.
- `matterBriefFacts`, `templateBrief` and `checkBrief` are pure and in libs/domain, so AI-09's daily brief can build per-matter facts the same way.

## Alternatives considered

- **A brief per person.** Exact "since your last visit" and role-specific items, but one model call per person per matter per day and the same privilege filtering anyway. Rejected for cost; the client marks what is new instead.
- **Staleness from triggers.** Marking the brief stale on every deadline, task, document or feed write would add a trigger write to hot paths and still need a daily expiry. Hashing the facts on open is simpler and exact.
- **Showing nothing when Clerk is off.** The ticket asks for a brief either way, and the template is useful on its own.
