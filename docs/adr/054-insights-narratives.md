# ADR-054: Clerk explains Insights from pre-formatted figures, and every number it writes is checked

- **Status:** Accepted
- **Date:** 2026-10-06
- **Ticket:** [INS-04](https://linear.app/materia-web/issue/MAT-91)
- **Builds on:** [ADR-034](034-clerk-context-assembly.md) (context assembly), [ADR-048](048-metrics-rollups.md) (metrics rollups), ADR-011a (Clerk provider), [ADR-037](037-clerk-suggestions-engine.md) (Clerk never writes)

## Context

The Insights screen (INS-02) shows a period's figures against a comparison. INS-04 adds a short plain-English explanation of what changed, written by Clerk, with chips that pick out the figure each sentence relies on. The ticket asks for:

- the two periods' metrics and nothing else;
- structured output whose paragraphs cite the metrics they use;
- no causes beyond the data, and saying so when the data is too thin;
- an automated check that every number matches its cited metric;
- a 24-hour cache per (org, period, comparison) with a rate-limited refresh;
- a canary test that no matter or client names reach the model.

A language model is unreliable at arithmetic and at copying long integers in cents, and an owner reading "collections fell 18%" acts on it. The design therefore has to make a wrong number impossible to show, not just unlikely.

## Decision

- **Clerk is given text, not raw counters.** `buildContext` gets a `MetricsScope` (`{org: 'metrics', current, comparison}`, each a `NarrativePeriodInfo` of the months the screen worked out). It reads those months' `month-*` documents and adds their shards (ADR-048). `narrativeFigures` (libs/domain) then builds the figures from a fixed catalogue:
  - billed, collected, WIP, time recorded (value and hours), write-offs, disbursements;
  - matters opened (in total, referred and by type), matters closed, referral fees, active matters;
  - deadline outcomes, critical deadlines missed, the on-time rate, overdue deadlines;
  - the median probate days to grant;
  - money owed by age.

  Each figure is the current and comparison value as display text ("$24,600", "12.5 hours", "75%"), with the change and relative change worked out by Materia ("-$1,000", "-10%", "-5 percentage points"). Figures that are zero in both periods are left out. Counters keyed by a contact or a member (`*.referrer.{contactId}*`, `referrals.industry.*`, `byMember`) are never read into the catalogue. Clerk therefore sees no names or ids, and the canary test checks this.
- **The prompt copies, never calculates.** `insights-narrative@1.0.0` runs at low effort. Its rules: write only numbers copied from `<org_metrics>`, as digits; cite each figure and the period it comes from; describe which figures moved together but give no cause outside them; no forecasts; say when the current period is to date; and never name anyone. The output is `{paragraphs: [{text, citations: [{metric, period, dimension?}]}], insufficientData}`. The prompt asks for at most 4 paragraphs of at most 3 sentences and 6 figures. The schema's caps are looser (8 paragraphs, 32 citations, 2,000 characters), because the API doesn't enforce lengths: the first live eval rejected a sound answer that cited six figures in both periods. The callable keeps the first 4 paragraphs. `insufficientData` is our addition to the ticket's shape. It lets "not enough recorded yet" be a deliberate answer rather than an empty one, and the evals grade it.
- **Every number is checked before it is kept.** `checkNarrativeParagraph` takes every number in a paragraph's text and checks it against three sources:
  - the cited figures' values in the cited periods;
  - their change and relative change, when both periods are cited;
  - the numbers in the period labels ("FY2026–27").

  A paragraph with a number that matches none of these, or that cites a figure Clerk wasn't given, is dropped, and the count of dropped paragraphs is shown ("Clerk left out a paragraph…"). If nothing passes and Clerk didn't say the data was insufficient, the answer is `unverified`: nothing is kept and the person is told. Only checked paragraphs are stored, each citation with the label and value the chip shows.
- **One explanation per selection, kept for 24 hours.**
  - **Where it is kept:** `orgs/{orgId}/insightsNarratives/{first_last__first_last|none}` (server-only) holds the checked paragraphs, how they were written (prompt, model), the months and a hash of the figures.
  - **Modes:** `clerk-explainInsights` has three. `cached` returns a fresh kept explanation or null, which is what opening a selection does. `explain` returns the kept one or writes one. `refresh` writes a new one only once the kept one is 10 minutes old; until then it returns the kept one.
  - **Figures that have moved:** when the hash no longer matches, the kept explanation is shown as `stale` ("The figures have changed since Clerk wrote this").
  - **Who it is shared with:** the explanation is shared by everyone in the practice, since it describes totals every member can already read.
  - **Nothing to explain:** when neither period has any figures, the callable answers "nothing to explain" without a call.
- **The switches apply to kept explanations too.** The gateway's checks (role `clerk.use`, `clerk.enabled`, `clerk.features.insightsNarrative`, the practice's Clerk switch, its "Explain Insights" toggle and the data-use acknowledgement) are now `gateway.assertOn`. The callable runs them before reading a kept explanation, so turning Clerk off hides what it wrote. Read-only members can't use Clerk and don't see the card. The scope is open to every role with `clerk.use`, not only `billing.view` as ADR-034 first planned, because the month documents are readable by every member (ADR-048).
- **The card.** "What changed" sits under the Stats on Insights. Each paragraph lists its figures as chips (label, value, and the comparison period's name when it is that period's value). A chip whose figure is on screen picks it out for 4 seconds: it scrolls to the hero, the Stat or the chart, outlines it, and on matters by type or deadline performance mutes the other bars. Chips for figures the screen doesn't show stay plain. Refresh is disabled until the 10 minutes are up. The card is hidden when the practice has turned the feature off.
- **Behind a flag, with evals.**
  - **Flag:** `clerk.features.insightsNarrative` is server-enforced and off by default.
  - **Wiring:** `CLERK_FEATURES.insightsNarrative` carries `orgFeature: 'insightsNarrative'`, and `CONTEXT_POLICIES.insightsNarrative` allows only the metrics scope, in 16k tokens.
  - **Evals:** the `insights-narrative` suite has 10 snapshots, more than the ticket's 8, because the harness needs at least 10. They cover a fall in collections with ageing debtors, an FY to date against last year, deadlines, a custom quarter, probate cycle time, a month to date, referrals, a steady month, insufficient data and no comparison. They are graded by `numberAccuracy` (the same check as production, per paragraph), `insufficientData`, `noInventions` (no causes such as staff leave or the economy) and `privilegeLeak`. The leak check uses canaries planted in referrer keys that the scope must leave out.

## Consequences

- A number Clerk didn't copy from a figure it cited is never shown. The check reads digits only, so a number written as a word ("two") isn't checked. The prompt asks for digits, and the evals measure how often this fails.
- One person's Explain or Refresh is what everyone in the practice sees for that selection until it expires. A refresh costs one low-effort call, at most one every 10 minutes per selection.
- During the day the current period's figures move as records are written, so a kept explanation of "this month" is often marked stale; Refresh fixes that.
- The scope now adds shards, so a sharded org's explanation uses the same figures as the screen (ADR-048's note that Clerk reads documents without their shards no longer applies to INS-04).
- Forecasting stays out of scope. Utilisation isn't a figure (it needs the members' working days), so Clerk describes billable hours instead.
- Prompt changes go through the evals like any Clerk prompt; the first live run sets the suite's baseline.

## Alternatives considered

- **Giving Clerk the raw counters and letting it work out changes:** arithmetic and cents-to-dollars slips would be checkable only with a tolerance, and a tolerance lets a wrong figure through.
- **Rounding tolerance in the check:** "about $24k" for $24,600 would pass, and so would $24,000 for $24,600. Exact copies are both simpler and stricter.
- **Caching per person:** more calls and different explanations of the same figures for colleagues, with no privacy benefit, since every member already reads these totals.
- **Client-readable cache documents:** the screen could read them directly, but then turning Clerk off would leave its old explanations visible.
- **Matter-level drill-down in the explanation ("three probate matters for one referrer"):** that needs names, which the ticket rules out. The chips lead to the charts, whose drill-downs already list the records.
