# ADR-058: Org export and deletion

- **Status:** Accepted
- **Date:** 2026-10-07
- **Ticket:** [SEC-05](https://linear.app/materia-web/issue/MAT-115)
- **Builds on:** [ADR-014](../01-architecture-and-adrs.md) (heavy work on Cloud Tasks), [ADR-021](021-membership-checked-on-every-org-read.md) (membership on every read), [ADR-039](039-matter-closing-retention-and-destruction.md) (matter destruction and legal holds), [ADR-051](051-oauth-token-vault.md) (the token vault), [ADR-055](055-csv-exports-weekly-report.md) (export jobs)

## Context

A practice owns its data. When it leaves Materia it must be able to take everything with it, in a form another system can read, and then have Materia delete it and prove it. When one person leaves a practice, their work has to go to someone else before their access goes. The ticket asks for:

- an owner-only full export (records as JSON Lines with schemas, the files, a README and a manifest of checksums), split into zips of at most 10 GB;
- deleting the practice after a 30-day grace period during which it is read-only and can be cancelled, then a certificate; a legal hold or a running export blocks it;
- offboarding a member, and deleting an account that belongs to no practice.

The practice's data is spread over about 75 Firestore collections (most under `orgs/{orgId}`, a few keyed by `orgId` elsewhere), Storage under `orgs/{orgId}/`, KMS-sealed OAuth tokens held by providers, and every member's custom claims. Triggers and queued tasks keep writing for a while after anything changes.

## Decision

We will:

**Export (`exports-orgFull`, owner, recent sign-in, `acknowledgePrivileged: true`).**
- Reuse the export job pipeline of ADR-055 and CORE-12b: a job of type `org.export` (`target.kind: 'export'`), `export_ready` when done, `jobs-getExportUrl` for 5-minute signed links, `jobs-sweepExports` deleting it after 7 days. Starting one is audited (`export.created`), finishing it too (`export.org_completed`).
- Write it on the `exports-runOrgFull` Cloud Tasks queue as a Cloud Run–backed function, not a Cloud Run job. Each part is a complete, independently readable zip of at most `partBytes` (`ORG_EXPORT_PART_BYTES`, 10 GB; tests pass a few KB). A task writes parts for up to 20 minutes, records a checkpoint (the phase, the collection group, the last path written, the part number, counts) and enqueues the next, so a failure repeats only its own part. Parts are streamed into Storage (resumable uploads) with no temporary files.
- Lay the export out as: `data/{collection}.jsonl` (one `{path, id, data}` line per record, the collection named by its path under the practice, `matters.tasks`), `files/matters/{matterId}/{documentId}/v{n}/{name}` (the current version, or every version), the practice's other stored files under `files/`, `schemas/{collection}.schema.json` (JSON Schema 2020-12, generated from the libs/domain zod schemas, so it can't drift), `README.md` and `manifest.json` (format `materia.org-export` v1, every entry's part, size and SHA-256, and each collection's record count). Values JSON can't hold are tagged (`{"$date": …}`, `{"$ref": …}`, `{"$bytes": …}`).
- Leave out what is useless or dangerous outside Materia: OAuth tokens and connect attempts, invite token hashes, export jobs, and Clerk's search chunks (the document text again). Privileged material is included: it belongs to the practice, and the owner confirms they understand that.

**Deletion.**
- `orgs-requestDeletion` (owner, recent sign-in, the practice's name typed) sets `deletionScheduledAt` to 30 days on, records who asked, audits `org.deletion_requested` and tells every active member (`org_deletion` notification). It is refused with `LEGAL_HOLD` while the practice or any matter is on hold, and with `EXPORT_RUNNING` while a full export is queued or running (heard from in the last two hours). `orgs-cancelDeletion` (any owner) clears it and tells everyone.
- While `deletionScheduledAt` is set the practice is read-only, enforced centrally:
  - the callable wrapper (`defineCallable`) refuses every callable outside the allow-list `READ_ONLY_CALLABLES` with `ORG_READ_ONLY` (reads, exports and downloads, the deletion and its cancel, legal holds, accepting new terms, and taking access away). It reads the date with the session policy, cached for 60 seconds per instance;
  - the Firestore rules' `validMeta()` refuses client writes at once (`notBeingDeleted()`), except to a person's own notifications and member document (their profile and personal tasks). It costs no reads until a deletion is scheduled, and fits the rules' 1,000-expression limit;
  - the upload pipeline refuses new files and versions; accepting an invite into it is refused; a legacy migration rollback is refused.
- `orgs-purgeDeletedOrgs` runs daily at 02:30 Melbourne time (in Terraform's `scheduled_jobs`, so a missed run alerts) and queues each due practice on `orgs-purge`, which takes it apart one stage per task (`ORG_PURGE_STAGES`), each safe to repeat:
  1. `marked`: checks again (a legal hold placed during the grace period cancels the deletion, audits `org.deletion_blocked` and tells the owners; a running export postpones it an hour), then writes the tombstone `deletedOrgs/{orgId}` (`purging`). From here nothing cancels it.
  2. `integrations`: every connection's token revoked with its provider and deleted.
  3. `storage`: everything under `orgs/{orgId}/`, every generation.
  4. `firestore`: the org document and every subcollection, recursively.
  5. `users`: each member's practice-keyed user records (timer, recent, views, drafts), `orgIds` updated and claims recomputed. Other memberships stay.
  6. `verified`: deletes anything that landed meanwhile, then fails (and retries) if the practice still has a record or a stored file.
  7. `certificate`: a PDF certificate of deletion stored at `deletedOrgs/{orgId}/{certificateId}.pdf` and emailed to the owners. It states what was deleted, the counts, and when backups taken before it expire (SEC-03; every copy within about 13 months).
- Keep only the tombstone `{orgId, name, deletedAt, certificateId, …}`, server-only (the rules deny every client). From `marked` on, triggers (`runTrigger`) and queued tasks (`defineQueue`) for the practice are skipped, using a per-instance lookup that remembers a "yes" for good and a "no" for 30 seconds; the purge waits two minutes after `marked` so every instance has seen it.

**Members and accounts.**
- `orgs-offboardingPlan` and `orgs-offboardMember` (owners and admins; the second with a recent sign-in) extend FND-17's removal: open matter tasks, upcoming deadlines and responsible matters go to people chosen in the team page's wizard (active, not read-only, able to see privileged matters when any of it is privileged); personal tasks are exported to the admin as a CSV or deleted; a running timer is saved as draft time; the leaver's connections are revoked; then they are removed. While the practice is read-only the team page only takes access away (`orgs-removeMember`).
- `auth-deleteAccount` deletes the account of someone in no practice, after they type DELETE.

**Rollout.** The feature ships on, with no flag: everything is owner-initiated, behind a recent sign-in and a typed confirmation, and the deletion has a 30-day undo.

## Consequences

- A practice can leave with everything, readable without Materia, and verify every file against the manifest.
- Deletion is provable: the integration test seeds one record of every org-scoped entity and every kind of stored file, runs the purge, and scans every collection group, every top-level collection and the bucket for the `orgId`; the certificate states what was deleted.
- Up to 60 seconds after a deletion request, a callable can still change the practice on an instance that cached the session before it (the rules apply at once). The UI shows the banner as soon as the org document changes.
- Every new collection under the practice is covered automatically (the export walks the entity schemas; the purge deletes the org document recursively). A new top-level collection that holds a practice's records by `orgId` (like `users/{uid}/timer`) must be added to `USER_ORG_COLLECTIONS` in the purge, and seeded in the integration test, whose scan then proves it goes.
- The `deadlines` collection group needs an index on `(orgId, assigneeUid, status)` for offboarding (`firestore.indexes.json`).
- Backups are not edited. They expire on their own schedule, and a restore must never bring back a deleted practice: `restore-matter` refuses a practice with a tombstone, and a full restore deletes such a practice again (the restore runbook, step 7).
- The scheduler and the two queues are created by the functions deploy; no Terraform beyond the `scheduled_jobs` alert.

## Alternatives considered

- **A Cloud Run job for the export.** It suits a single long run, but the export is naturally checkpointed per part, and a Cloud Tasks function reuses the queue, retry, notification and audit plumbing every other export already has.
- **One zip, or a zip per collection.** One zip can't hold a 200 GB practice in a browser download; a zip per collection splits documents from their records. Self-contained parts of a fixed size are both downloadable and complete together.
- **Exporting Firestore's own format (managed export).** Readable only by Firestore, without the files, and not per-practice.
- **Deleting at once, without a grace period.** One mistaken click would destroy a firm's records; the grace period is the undo, and read-only stops the data changing under an export.
- **Read-only enforced in each callable.** Over 120 callables, and every new one would have to remember. An allow-list in the wrapper fails closed.
- **Keeping the audit log after deletion.** It is the practice's data (names, matters, actions), so it goes too; the tombstone and certificate are the record that the deletion happened.
