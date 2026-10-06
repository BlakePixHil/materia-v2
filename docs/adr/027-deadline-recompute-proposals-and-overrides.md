# ADR-027: Recomputing deadlines in a matter transaction, with proposals instead of silent moves

- **Status:** Accepted
- **Date:** 2026-10-05
- **Ticket:** [CORE-10](https://linear.app/materia-web/issue/MAT-42)

## Context

CORE-09 gave us a pure engine (`compute`, `diff`, `explain`) and a versioned Victorian rule set. CORE-10 has to persist its output and keep it current as events, stages and rule sets change. These invariants have to hold under concurrency and retries:

- a date in force never moves silently (invariant 4);
- an override always wins;
- recomputing twice gives the same result;
- a missing calendar year never turns holidays into business days.

Statutory rules are illustrative until a practitioner signs them off, behind a flag per rule-set version.

## Decision

**One transaction per matter.** `recomputeMatter` reads and writes inside one transaction on `matters/{id}`, and runs for every caller: `deadlines-upsertEvent`, `deadlines-deleteEvent`, `deadlines-recompute`, matter creation, stage changes and the backfill.

- **Reads.** The transaction reads the matter, its events, deadlines, pending proposals, template and the linked tasks.
- **Planning.** It computes, then plans with the pure `planRecompute` (libs/deadlines).
- **Writes.** It writes the plan and bumps `recomputeVersion` whenever it writes anything.
- **Concurrency.** Concurrent recomputes and event edits of one matter are therefore serialised by Firestore's optimistic concurrency.
- **No-op runs.** A recompute with nothing to change writes nothing.
- **Ids.** These are deterministic, so retries and concurrent runs converge:
  - deadlines are `rule-{ruleId}`;
  - proposals are `{deadlineId}-v{recomputeVersion}`;
  - linked tasks are `dlt-{dedupeKey}`.

**What the planner does.** `dueDate` is always the date in force, with any override applied. The planner:

- creates new deadlines, as `upcoming`, or as `blocked` with the rule's reason and `blockedCode`;
- updates provenance in place when the date doesn't change;
- dates a blocked deadline, or revives a superseded one, directly, because no date was in force;
- turns a changed or removed upcoming date into a `deadlineChanges` proposal, which notifies the responsible lawyer (`deadline_changed`).

**Deciding a proposal.** A lawyer accepts or rejects it through `deadlines-resolveChange`. Accepting a critical change needs the matter number typed. A rejection is remembered on the deadline (`declined`), so the same proposal isn't made again. A proposal that no longer matches its deadline is superseded.

**Overrides.** An override is stored beside the engine's provenance. The engine keeps computing. When its date moves earlier than its previous date and lands before the override, the deadline is flagged (`overrideConflict`) and the lawyer is notified. The flag clears once the engine's date is no longer before the override.

**Which rules run:**

- The latest published version of the jurisdiction's rule set, bundled or in `ruleSets/{id}/versions/*`.
- Statutory rules only while `${flag}.v${version}` is on. When the flag is off, they are skipped and existing deadlines are left as they are.
- With templates on, only the template's `deadlineRuleIds`.

**Calendars.** They are bundled, not read from Firestore. A missing calendar year blocks only the rules that need it (`calendar_missing`) and logs an ops alert (ERROR). An existing upcoming date is kept, not removed.

**Status changes are server-only:**

- `done` (task.edit);
- `waived` with a reason (deadline.override);
- `missed`, which a lawyer confirms after the daily `deadlines-flagMissed` job asks (`missedCheck`). The job never marks a deadline missed by itself.

Clients still create and edit manual deadlines (contractual, internal or court) directly, and may reassign or acknowledge a computed one.

## Consequences

- Every recompute of a matter is consistent and exactly-once in effect. A burst of event edits retries transactions rather than interleaving writes.
- A matter's transaction reads all its deadlines and proposals. That is fine at tens per matter, but it is the limit if a matter ever has hundreds.
- `matter.nextDeadline` is kept by a separate trigger (`deadlines-onWrite`), not by the recompute. Manual edits and completions update it too.
- A rule-set upgrade is a paged, admin-run callable (`deadlines-proposeRulesetUpgrade`), which the hourly `deadlines-upgradeRuleSets` also runs, once per org and published version, when the org has deadlines from an older version. It changes nothing in force: unchanged dates take the new provenance, and changed ones become proposals.
- Rule tasks are created once the matter reaches the rule's stage (`createsTask.stage`), so a stage change recomputes. Their open count is added by the recompute (`countedOpen: true`).
- The web app's task actions must close a linked deadline through `deadlines-complete`. Direct status writes to deadlines are refused.

## Alternatives considered

- **Recompute in a trigger on event writes.** Clients would write events directly, and a trigger would recompute. This was rejected because of four problems:
  - there is no transaction with the event write;
  - there are no synchronous validation errors, such as a future date of death;
  - a retry-free trigger loses a failed recompute;
  - the UI can't show the resulting proposals in the same round trip.
- **Moving dates automatically and logging the change.** This breaks invariant 4. Critical statutory dates must never move without a lawyer.
- **A recompute lock document per matter.** It adds a second document and a lease to manage, while the matter's `recomputeVersion` already serialises writers.
- **Reading calendars from Firestore.** It adds a read per year per recompute and a way for bad data to change dates. Calendar changes ship as code, reviewed and locked like rule sets.
