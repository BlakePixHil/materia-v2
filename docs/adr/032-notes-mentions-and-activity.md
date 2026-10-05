# ADR-032: Note text goes through callables, and the activity feed is built from the audit log

- **Status:** Accepted
- **Date:** 2026-10-05
- **Ticket:** [CORE-13](https://linear.app/materia-web/issue/MAT-48)

## Context

CORE-13 adds matter notes (Markdown with `@member` and `#matter` mentions, pinning, history) and the matter's activity feed. Until now notes were a client-editable collection: any `note.write` role could write `bodyMd`, `privileged` and, in principle, `mentions` directly. That leaves three problems:

- **Mentions** must notify the people mentioned, once, and only people who can open the note. A client can't be trusted to say who it mentioned, and the rules can't parse Markdown or send notifications.
- **History** is a legal record: a note edited after the fact must keep what it said before, and two people editing the same note must not silently overwrite each other.
- **Privilege**: a note on a privileged matter, or marked privileged, must never reach a role without `privileged.view`, including through a notification or the feed.

The feed needs a line for most changes on a matter (status, stage, parties, events, deadlines, documents, notes). The audit log (FND-18) already records every write (as a redacted diff) and every semantic event from the callables (`matter.status_changed`, `deadline.overridden`…), with the actor and the matter. Tasks already write their own feed lines (CORE-08).

## Decision

We will create notes and change their text only through two callables, and build the activity feed from audit entries with a mapping table.

- **`notes-create` and `notes-update`** (`note.write`, idempotent) do everything in one transaction: parse mentions on the server (`parseMentions`; member mentions of anyone who isn't an active member are dropped), write the note, and notify members mentioned for the first time (`newlyMentioned`) through `notify(…, {tx})`. The author is never notified. A member who can't open the note is left out and returned as `unreachable`, so the editor can say so. Notification titles name the author and the matter number only; bodies are generic.
- **Revisions and conflicts.** `notes-update` appends the previous text to `notes/{id}/revisions/{requestId}` (who wrote that version and when) before writing, and refuses a save whose `expectedUpdatedAt` isn't the note's `updatedAt` with `FAILED_PRECONDITION` `note_conflict` (the current `updatedAt` and `updatedBy` in the details), unless the caller chose to overwrite. Unchanged text and flag is a no-op.
- **Privilege.** Only `privileged.view` roles set or clear `privileged`; a note on a privileged matter is always privileged. A revision is readable only when both it and its note are visible.
- **Client writes shrink** to `pinned`, soft delete and restore (`Note.updatable: ['pinned']`). Text, mentions, the flag and the edit stamp are server-owned.
- **`activity-onAudit`** runs on every new audit entry and looks it up in `ACTIVITY_RULES` (`apps/functions/src/activity/mapping.ts`), keyed by the semantic action or by `{collection}.{action}` for a write. A listed entry becomes `matters/{matterId}/activity/audit-{entryId}` (`kind`, `summary`, `actorUid`, `at`, `refs`) and moves `lastActivityAt`. Anything unlisted, without a matter, about tasks or from the migration is not activity. When a callable records both its write and a semantic event, the table maps one of them.
- **Summaries are actor-less and never privileged.** The UI puts the member's name in front ("Jordan Price · Changed the status from Open to On hold"), as task lines already do. Summaries come from ids, enums, dates and names the reader can see; they never include note text, and on a privileged matter or for a privileged record they name nothing ("Added a document"), because every member reads the feed.

## Consequences

- One place decides what is activity and how it reads; adding a line for a new audited action is one table entry and one test case. The feed is complete wherever the audit log is, and the audit trigger's exclusions (`activity`) and noise fields (`lastActivityAt`) mean the projection can't loop.
- A feed line lags its change by two trigger hops (the audit entry, then the projection), typically well under a second. Lines are written once per entry id, so redelivered events don't duplicate them. The projection does a few reads per line (the matter, sometimes the record, stage titles or a contact name).
- Pinning moves `updatedAt`, so an editor open across a pin gets a conflict (and can choose to overwrite). A dedicated content version would avoid that if it proves annoying.
- Roles without `privileged.view` must list notes and revisions with `privileged == false`; both have composite indexes.
- Existing semantic audit summaries stay as they are (ids and enums); the feed's wording lives in the mapping table, not in the callables.
- Notes created by Clerk, voice capture or the migration need their own server paths (they will reuse the same helpers); the migration's notes produce no feed lines.

## Alternatives considered

- **Client writes with a trigger that parses mentions and notifies.** Simpler for the client, but the trigger runs after the write: no conflict check, no revision in the same transaction, and a client could still write `mentions` or a privileged flag the rules can't fully check.
- **Each callable writes its own feed line** (as tasks do). That spreads wording over every callable and misses client-direct writes (documents, pins, deletes); the audit log already sees all of them.
- **Feed lines with the actor's name baked in.** Names change and the UI already resolves members; actor-less summaries keep the line stable and let the UI style the name.
