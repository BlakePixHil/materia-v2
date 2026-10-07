# Runbook: Clerk reads the migrated files (MIG-09)

After a migration run loads, Clerk reads its documents for search and citations and proposes each open estate matter's key dates, once an owner or admin approves the cost ([decision D-21](../migration/decisions.md#d-21-enrichment-after-the-load-new)). It runs after the load (MIG-06, [runbook](migration-load.md)), on dev in each rehearsal and on prod at cutover.

**When:**

- in each rehearsal on dev: after `verify`, before the user reviews;
- at cutover (MIG-07): after the prod load, and again after the `delta` (each run has its own).

## What it reads and writes

```text
Firestore (the target project)
  orgs/<O>/migrations/<runId>              the run's record: its turning `succeeded` starts the enrichment
  orgs/<O>/migrationEnrichments/<runId>    status, estimate, allowance, spend, progress
  orgs/<O>/matters/<M>/documents/<D>       ingest status, chunks; `needsReview: MIG_W_DOCUMENT_UNREADABLE` when Clerk can't read it
  orgs/<O>/matters/<M>/suggestions/<S>     the key dates (`event`) and classifications (`document_meta`)
  orgs/<O>/notifications/migration-enrich-<runId>-*   estimate, paused and done
Cloud Tasks
  migration-enrich                         one step at a time across the project
```

Logs carry counts, ids and error types only, never document text or names.

## Steps

1. **Wait for the estimate.** The load sets the run's record to `succeeded`, and `migration-onRunWrite` starts counting. Nothing is spent while it counts. Owners and admins get "Clerk can read the migrated files" once it has the estimate (pages, scanned pages, estate matters and the cost).
2. **Before approving**, check the org's Clerk setup in Settings → Clerk and AI: the key is valid, the disclosure is acknowledged, Clerk and Suggestions are on. On dev, the flags `clerk.enabled` and `clerk.features.suggestions` must be on in Remote Config.
3. **Approve.** In Settings → Clerk and AI → Migrated files, an owner or admin sets the allowance (the estimate with headroom is offered) and approves. At cutover that's Tristan, or Blake for him. "Not now" leaves it until someone approves it.
4. **Watch it read.** The card shows documents read and estate matters read, and what it has spent. It reads one document or matter at a time beside the practice's own Clerk use.
5. **If it pauses**, the card and a notification say why:
   - **the allowance is used:** resume with a larger one;
   - **the practice's month is nearly used** (80% of its token budget or spend limit): resume next month, or after raising the limit;
   - **Clerk or Suggestions is off, or the key is missing:** fix it, then resume.
6. **When it's done**, the approver and the owners get "Clerk has read the migrated files" with the counts. The key dates wait in the Inbox and each matter's suggestions. Accepting a date records it, and the matter's deadlines are worked out from it; ones already past are flagged for review.
7. **Documents it couldn't read** are flagged `MIG_W_DOCUMENT_UNREADABLE` and listed in the migration review queue (MIG-08, Settings → Migration → Review).
8. **Restate the historical figures** so Insights shows the months before the move, legacy billing counted by its billing dates:

   ```sh
   NODE_USE_ENV_PROXY=1 pnpm materia-scripts backfill-metrics --project <project> --org <orgId> --from earliest --dry-run
   NODE_USE_ENV_PROXY=1 pnpm materia-scripts backfill-metrics --project <project> --org <orgId> --from earliest
   ```

   On dev, agents run it through the `dev-script` workflow (command `backfill-metrics`, args `--org <orgId> --from earliest`). Proof: Insights → Billed shows the past months, with "Includes … billed in the previous system".

## Rollback and re-runs

- **Rolling the run back** (`materia-migrate rollback`) cancels its enrichment: a step running then stops at its next save. Suggestions on the run's matters go with them.
- **Loading the same run again** keeps its enrichment. A new run (a delta, or a fresh rehearsal) gets its own, which reads only what that run loaded.
- **Nothing reads a migrated document before the approval:** the ingest trigger skips the load's writes, and `documents-backfillIngest` and `backfill-ingest` leave migrated documents alone until the enrichment has read them.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| No estimate after the load | Check the run's record says `succeeded`, and the `migration-onRunWrite` logs |
| "Counting" for a long time | Each step counts for up to 5 minutes and hands over; check the `migration-enrich` queue and its logs |
| Approve fails: "Clerk is off" | Step 2: the flags, the key, the disclosure and Suggestions |
| A document stays unread | It is flagged for review: `ingest.reason` says why Clerk skipped it, or `ingest.error` why it failed three times |
| Fewer key dates than expected | A date is kept only when Clerk quotes the note or page stating it; dates the matter already records, two dates for one step and future dates are dropped (D-21) |
