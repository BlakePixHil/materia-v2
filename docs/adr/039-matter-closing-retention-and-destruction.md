# ADR-039: Matter closing, retention and destruction

- **Status:** Accepted
- **Date:** 2026-10-05
- **Ticket:** [CORE-19](https://linear.app/materia-web/issue/MAT-62) (practitioner sign-off: CORE-19a)

## Context

Closed matters have to be kept for the firm's retention period, then destroyed with proof, and never destroyed while originals are in custody, a party is a minor, or a legal hold applies. Closing needs a checklist so nothing is left open. Destruction is irreversible, so it needs a person's explicit approval and a record that survives it. The retention periods themselves need a practitioner's review before they are relied on in production.

## Decision

- **One closing path.** A matter closes only through `matters-close`, which re-evaluates the closing checklist (`evaluateClosing` in `libs/domain/src/lib/retention.ts`, shared with the close dialog) in the same transaction that closes it. `matters-changeStatus` refuses `closed` (`closing_checklist_required`). The checklist is fixed in code for now; org- and template-level checklists are a follow-up.
- **`destroyAfter` is a stored date.** Closing sets `closedOn + retentionYears` (end-of-month clamped) or leaves it unset with the holds that prevent it (`closing.holds`). A retention change only ever moves it later (`matters-onRetentionChanged`); reopening clears it; a legal hold clears it and releasing the hold recomputes it from the closing day.
- **Archive after 90 days.** A nightly job archives matters closed 90 days ago. Archived means read-only: the rules refuse every client update under an archived matter (a `get()` of the matter in each subcollection's update rule) and Storage refuses uploads to it; the matter callables refuse with `matter_archived`. Lawyers and above can still add notes through `notes-create`, which audits them.
- **Queue, approve, destroy.** A monthly job lists due matters in `destructionQueue`. An owner or admin approves each one by typing its number after a sign-in in the last 5 minutes (the existing `requireRecentLogin`; the UI asks them to sign in again). Approval enqueues `matters-destroy` on Cloud Tasks.
- **Destruction is staged and resumable.** Files (every Storage generation, since the bucket is versioned), then the tombstone, then the records (recursive, chunks included), then other references (Clerk threads, notifications), then the certificate. Each stage and the running counts are stored on the queue entry in the same batch as the deletes, so a retry resumes with correct counts. The tombstone is written before the records go so the matter's triggers (activity, denormalise, task and deadline counters) see `destroyedAt` and leave it alone. The certificate is issued only when every stage is done. The audit trail is kept.
- **The certificate is rendered in the function** with pdf-lib, not by the FND-24 Cloud Run render job: the job's exports expire after 7 days and have no download path for a document that must be kept, the certificate is one short page, and the function already has the facts. It lives at `orgs/{orgId}/certificates/dc-{matterId}.pdf` and is downloaded through a 5-minute signed URL.
- **Behind a flag.** `matters.destruction` (server-enforced, default off) gates queueing and approval. Closing, archiving and legal holds are always on. The flag stays off in production until CORE-19a's practitioner sign-off.

## Consequences

- Backups (daily exports for 35 days, monthly copies for a year, PITR, Storage soft-delete) still hold a destroyed matter until they expire. The certificate and the security doc say so, and restore drills must not bring one back.
- The archived check adds one `get()` to subcollection update rules; rule tests cover every matter subcollection on a closed and an archived matter.
- Closing a matter in bulk (the Matters list and board) isn't possible: each needs its checklist. The board offers "Open matter" when a drop on Closed is refused.
- Descoped (CORE-19): unbilled WIP on the checklist (BILL-03), creating a safe-custody packet from the checklist (CORE-17's contract, a follow-up once it merges), org- and template-level checklists, "destroyed document" court-book references (no LIT-10 yet), purging recents (they hold ids only) and job records, admin notifications when the queue fills, and a settings control for `destructionKeepsTitle` (Settings is another thread's; the field is client-writable for `org.settings` roles).
