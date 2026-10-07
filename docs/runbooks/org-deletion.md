# Runbook: deleting a practice

How a practice is exported and deleted (SEC-05, [ADR-058](../adr/058-org-export-and-deletion.md)), how to check on a deletion, stop one, and what to do when the deletion job fails. Data rights in general: [docs/09](../09-security-privacy-compliance.md) (Data rights).

## How it goes

1. **Export.** An owner opens Settings → Data and deletion and presses "Export everything" (after confirming they understand it includes privileged material). `exports-orgFull` queues an `org.export` job; `exports-runOrgFull` writes the zips (each at most 10 GB) into `orgs/{orgId}/exports/` and the owner gets an `export_ready` notification. The download page (`/exports/{jobId}`) lists every part. The files are deleted after 7 days.
2. **Request.** An owner presses "Delete this practice…" and types its name. `orgs-requestDeletion` sets `deletionScheduledAt` to 30 days on (`deletionRequestedBy`, `deletionRequestedAt` say who and when), audits `org.deletion_requested` and sends every active member an `org_deletion` notification (in-app and email). It is refused while a legal hold is on (`LEGAL_HOLD`) or a full export is still being written (`EXPORT_RUNNING`).
3. **Grace period (30 days).** The practice is read-only. Every page shows "… will be deleted on …"; callables outside the allow-list fail with `ORG_READ_ONLY` and the rules refuse client writes. People can still read and export everything. Any owner can cancel in Settings → Data and deletion (`orgs-cancelDeletion`, audited `org.deletion_cancelled`, everyone told).
4. **Purge.** `orgs-purgeDeletedOrgs` runs daily at 02:30 Melbourne time. It queues every practice whose date has passed (and resumes any deletion that stopped part way) on `orgs-purge`, one step per task:

   | Stage | What it does | Then |
   | --- | --- | --- |
   | `marked` | Checks again: a legal hold now stops the deletion (`deletionScheduledAt` cleared, `org.deletion_blocked` audited, owners told); an export still running postpones it an hour. Otherwise writes the tombstone `deletedOrgs/{orgId}` (`status: 'purging'`). From here it can't be cancelled, and triggers and queued tasks for the practice are skipped. | 2 minutes |
   | `integrations` | Revokes every connection's token with Microsoft, Google or Xero and deletes it | at once |
   | `storage` | Deletes everything under `orgs/{orgId}/` in the documents bucket, every version | at once |
   | `firestore` | Deletes the org document and everything under it, audit log included | at once |
   | `users` | Removes each member's timer, recent matters, saved views and drafts for the practice, drops it from `users/{uid}.orgIds` and recomputes their claims (other practices are untouched) | 10 minutes |
   | `verified` | Deletes anything that arrived since, then fails if a record or file is left | at once |
   | `certificate` | Writes the certificate of deletion (`deletedOrgs/{orgId}/{certificateId}.pdf` in the bucket, its SHA-256 on the tombstone) and emails it to the owners | done |

   The tombstone ends as `status: 'deleted'` with `deletedAt`, `certificateId` and `counts` (records, files, connections, memberships).

## Checking on a deletion

- **Scheduled?** The org document's `deletionScheduledAt` (Firestore console, `orgs/{orgId}`). The audit log shows `org.deletion_requested` and `org.deletion_cancelled`.
- **Under way or done?** `deletedOrgs/{orgId}`: `status`, `stage`, `purgeStartedAt`, `deletedAt`, `counts`.
- **Logs** (Cloud Logging, `jsonPayload.fn="orgs-purge"` and `"orgs-purgeDeletedOrgs"`): `org purge: connections revoked`, `files deleted`, `records deleted`, `members released`, `org deleted`, with counts and ids only. `skipped: the practice is being deleted` from other functions is expected while it runs.
- **The certificate again:** `gcloud storage cp gs://<bucket>/deletedOrgs/<orgId>/<certificateId>.pdf .` and send it to an owner who asks (the tombstone's `ownerUids`).

## Stopping a deletion

- **During the grace period:** any owner cancels in the app. If no owner can sign in (for example the only owner left), confirm the request with the practice in writing, then remove `deletionScheduledAt`, `deletionRequestedBy` and `deletionRequestedAt` from `orgs/{orgId}` in the Firestore console and record it on a Linear ticket. Callables pick it up within a minute.
- **A legal hold:** a matter's hold is placed in the app (`matters-setLegalHold`, owners and admins). A hold on the whole practice is set by Materia support only: in the Firestore console, set `legalHold` on `orgs/{orgId}` to `{on: true, reason: "<why, no client details>", by: "<your email>", at: <now>}`. Either stops the deletion: refused when asked for, and stopped at the `marked` stage if placed during the grace period. Release it by setting `legalHold.on` to `false`.
- **After `marked`:** it can't be stopped. A tombstone exists and the practice is being taken apart; let it finish.

## When the purge fails

`orgs-purge` retries each step 10 times (from a minute to an hour apart), and each step is safe to repeat. If it still fails, the daily run resumes every tombstone still `purging`. To resume sooner, run the scheduler job: `gcloud scheduler jobs run firebase-schedule-orgs-purgeDeletedOrgs-australia-southeast1 --location=australia-southeast1 --project <project>`.

- **`Records or files remain after the deletion`** (`verified`): something kept writing. Find what in the logs around the time (a trigger or task not skipped for the practice), fix it, and resume: `verified` deletes what's left first.
- **A connection that won't revoke** (`integration token revoke failed`, or `org purge: connection not revoked`): the provider refused or was down. The deletion carries on, and the `firestore` stage deletes the sealed token with everything else; it then expires at the provider unused.
- **No certificate email** (`mail not configured`, or an owner's address is undeliverable): the PDF is in the bucket; send it by hand.

## Backups and restores

Backups are not edited. The certificate states when copies expire (point-in-time recovery after 7 days, daily backups after 7, daily exports and the nightly file copy after 35, weekly backups after 14 weeks, monthly exports after 400 days, deleted files after 30 days and replaced versions after 90). A deleted practice is never restored: `restore-matter` refuses any matter of a practice with a tombstone, and after a full restore step 7 of the [restore runbook](restore.md) deletes such a practice again.

## Other data rights

- **Removing a member** (Settings → Team and roles → Remove…): the wizard asks who takes their open tasks, deadlines and matters, and whether to export their personal tasks to you (CSV, 7 days) or delete them. Their timer is saved as draft time and their connections are revoked. While the practice waits to be deleted, Remove only takes access away.
- **Deleting an account:** someone in no practice uses "Delete my account" on the onboarding page and types DELETE (`auth-deleteAccount`). Someone still in a practice is refused (`ACCOUNT_HAS_ORGS`): they leave or are removed first.
- **A legacy migration rollback** (`tools/migration`) is refused once a deletion is requested; cancel the deletion first.
