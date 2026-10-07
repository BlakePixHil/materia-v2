# Runbook: backups and restore

How Materia's data is backed up and how to get it back (SEC-03). Never restore over prod data without the owner: a restore can lose work done since the restore point.

## What is backed up

| Layer                     | What                                                                                          | Where                                              | Kept                                                 | Restore point          |
| ------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------- | ---------------------- |
| Firestore PITR            | Every version of every document                                                               | The database (australia-southeast1)                | 7 days                                               | Any minute (RPO ≤ 1 min) |
| Firestore managed backups | Whole database, daily and weekly (Sunday)                                                     | Firestore, australia-southeast1                    | Daily 7 days, weekly 14 weeks (Firestore's maximums) | Once a day (RPO ≤ 24 h) |
| Firestore export          | Whole database as of a whole minute, nightly at 02:00 Melbourne (`backups-exportFirestore`)   | Written to `gs://<project>-exports/` (australia-southeast1), copied at 16:00 UTC by Storage Transfer to `gs://<project>-backups/daily/` and `monthly/` (australia-southeast2) | Exports bucket 8 days; `daily/` 35 days, `monthly/` (the 1st) 400 days | Once a day (RPO ≤ 24 h) |
| Files bucket              | Soft delete for deleted objects; non-current versions for overwritten or deleted ones         | `gs://<project>-files`                             | Soft delete 30 days, versions 90 days                | Any change             |
| Files copy                | Nightly Storage Transfer copy of the files bucket (Coldline), mirroring deletions              | `gs://<project>-backups/files/` (australia-southeast2) | Current copy; what it replaced or deleted 35 days | Once a day             |

Everything is in Terraform (`infra/terraform/modules/firebase_env/backups.tf` and `data.tf`). Firestore exports to and imports from buckets in its own region only, which is why exports land in the exports bucket first and every import below reads from it. The export folder is named after its snapshot time in UTC: `daily/2026-10-05T15-00-00Z` holds the database as it was at 15:00 UTC.

**Alerts** (email, FND-21; `backup-status` below shows why): "Scheduled job backups-exportFirestore not running" when no export has finished for 24.5 hours, and "Backup copy failed" when either Storage Transfer job (files, or exports to the backup region) logs a failed copy or delete. Firestore's managed backups have no alert; the drill checks them.

**Targets.** RPO: ≤ 1 minute for the last 7 days (PITR), ≤ 24 hours after that (backups and exports). RTO: ≤ 4 hours for a full restore. The quarterly drill measures both.

All commands below need owner credentials (or `terraform-agent`) and `--project <project>`; examples use dev.

## Pick a procedure

| What happened                                                       | Do this                                                     |
| ------------------------------------------------------------------- | ----------------------------------------------------------- |
| One matter damaged (bad edit, bad migration, a bug), within 7 days  | [Single matter](#single-matter) from a PITR time            |
| One matter damaged, longer ago                                      | Restore a backup or export to a scratch database, then [Single matter](#single-matter) from it |
| A deleted or overwritten document file                              | [Storage objects](#storage-objects)                         |
| The whole database damaged                                          | [Full restore](#full-restore)                               |
| australia-southeast1 lost for a long time                           | [Region loss](#region-loss)                                 |

## Single matter

`materia-scripts restore-matter` puts one matter and everything under it (`orgs/{orgId}/matters/{matterId}/**`: tasks, deadlines, documents and their chunks, notes, activity…) back as it was. It is a dry run unless you pass `--apply`.

1. Find the restore point: the last good time (from the matter's activity or the audit log), in UTC. Within the last hour any second works; older than that it must be a whole minute.
2. Dry run, and read the report: what it would create, overwrite, leave alone, and what was added since.

   ```sh
   pnpm materia-scripts restore-matter --project materia-v2-dev --org <orgId> --matter <matterId> \
     --read-time 2026-10-05T03:15:00Z
   ```

   Older than 7 days, restore a backup or an export next to the live database first (see [Scratch database](#scratch-database)) and use `--from-database restore-20261006` instead of `--read-time`.

3. Run it again with `--apply`. Documents added since the restore point are kept; add `--delete-extra` to delete them too. The restore is audited as `matter.restored` with its run id (and each written document gets its usual audit entry).
4. Bring back the matter's document files if they were deleted too ([Storage objects](#storage-objects)); each document's `storagePath` and `versions[].storagePath` say which.
5. Delete the scratch database if you made one.

The script refuses:

- a **destroyed matter** (CORE-19: a `destructionCertificates/dc-{matterId}` or a tombstone in the live database). Destruction is permanent; a restore must never bring it back;
- to write while a **migration run** is `running` in the org (`orgs/{orgId}/migrations`). Wait for it, or roll it back, then restore. The report lists document counts, so compare them with the run's counts if a migration touched the matter.

Data outside the matter's subtree (contacts, org-level tasks, the matter's search tokens in other documents) isn't restored. Restore contacts the same way by hand if needed, or ask for a script.

### Scratch database

A restored copy next to `(default)`, named `restore-<date>` (4 to 63 of `a-z 0-9 -`):

```sh
# From a managed backup (newest first)
gcloud firestore backups list --location=australia-southeast1 --project materia-v2-dev
gcloud firestore databases restore --project materia-v2-dev \
  --source-backup=projects/materia-v2-dev/locations/australia-southeast1/backups/<id> \
  --destination-database=restore-20261006

# From an export (the last 8 days are in the exports bucket; copy an older one back there first)
gcloud storage ls gs://materia-v2-dev-exports/daily/ gs://materia-v2-dev-backups/daily/ gs://materia-v2-dev-backups/monthly/
gcloud storage cp -r gs://materia-v2-dev-backups/daily/2026-09-05T15-00-00Z gs://materia-v2-dev-exports/daily/
gcloud firestore databases create --database=restore-20261006 --location=australia-southeast1 --project materia-v2-dev
gcloud firestore import gs://materia-v2-dev-exports/daily/2026-09-05T15-00-00Z --database=restore-20261006 --project materia-v2-dev

# From a PITR time (whole minute, within 7 days)
gcloud firestore databases clone --project materia-v2-dev \
  --source-database='projects/materia-v2-dev/databases/(default)' \
  --snapshot-time=2026-10-05T03:15:00Z --destination-database=restore-20261006

# Afterwards
gcloud firestore databases delete --database=restore-20261006 --project materia-v2-dev
```

Restores take minutes for Materia's size. Scratch databases cost storage while they exist; delete them when done.

## Storage objects

Document files live at `orgs/{orgId}/matters/{matterId}/documents/{docId}/v{n}` in `gs://<project>-files`.

```sh
B=gs://materia-v2-dev-files
# Deleted in the last 30 days: soft delete
gcloud storage ls --soft-deleted --long "$B/orgs/<orgId>/matters/<matterId>/**"
gcloud storage restore "$B/<path>#<generation>"
# Overwritten or deleted in the last 90 days: an older version
gcloud storage ls --all-versions --long "$B/<path>"
gcloud storage cp "$B/<path>#<generation>" "$B/<path>"
# From the nightly copy in australia-southeast2 (current, or a version from the last 35 days)
gcloud storage ls --all-versions "gs://materia-v2-dev-backups/files/<path>"
gcloud storage cp "gs://materia-v2-dev-backups/files/<path>#<generation>" "$B/<path>"
```

A restored object must match its document's `sha256`; `documents-getDownloadUrl` serves it again once it's back.

## Full restore

For damage across the database. Firestore can't rename a database, so the restore is built in a scratch database, checked, then copied into a fresh `(default)`. Target: under 4 hours.

1. **Stop writes.** Tell the firm's users. Pause the scheduled jobs: `gcloud scheduler jobs list --location=australia-southeast1`, then `gcloud scheduler jobs pause <job>` for each (`firebase-schedule-…`).
2. **Keep the evidence.** Export the damaged database: `gcloud firestore export gs://<project>-exports/incident-<date> --project <project>`, then copy it somewhere it outlives the exports bucket's 8 days: `gcloud storage cp -r gs://<project>-exports/incident-<date> gs://<project>-backups/`. List the destruction certificates (`destructionCertificates` collection group) in it: they are needed in step 7.
3. **Build the restore** in a scratch database (see [Scratch database](#scratch-database)): a PITR clone for damage in the last 7 days, otherwise the newest good backup or export.
4. **Check it.** Spot-check matters in the console (select the database), and compare counts: `materia-scripts restore-matter … --from-database <scratch>` dry runs show per-matter differences.
5. **Switch.**
   1. Export the scratch database: `gcloud firestore export gs://<project>-exports/restores/<date> --database=<scratch>`.
   2. Prod only: turn off delete protection, `gcloud firestore databases update --database='(default)' --no-delete-protection`.
   3. Delete `(default)`: `gcloud firestore databases delete --database='(default)'`. Its PITR history goes with it, which is why step 2 exported it.
   4. Recreate it with Terraform (Actions → infra → Run workflow; dev also applies on any infra merge): PITR, delete protection and the backup schedules come back with it. Then import: `gcloud firestore import gs://<project>-exports/restores/<date>`.
   5. Redeploy indexes and rules (Actions → deploy-dev, or the prod release), and re-run the backfills that rebuild derived fields (`materia-scripts backfill-search-tokens` and `backfill-matter-roles` through the `dev-script` workflow on dev).
6. **Resume** the scheduled jobs (`gcloud scheduler jobs resume <job>`) and check the app (`/health`, Today, a matter, a document preview).
7. **Re-apply destructions.** A restore from before a destruction brings that matter back. For each certificate from step 2 whose matter is back without a tombstone, copy `destructionCertificates/dc-{matterId}` and `destructionQueue/{matterId}` from the step 2 export (or the scratch copy) and run the destruction again (CORE-19's `matters-destroy` resumes from its stage and leaves the tombstone). The certificate PDFs live in Storage and are unaffected.
8. **Record** the times (stop, restore built, switched, resumed) and the restore point on the incident's Linear ticket, and delete the scratch database once the owner is happy.

Restores overlapping a migration run: check `orgs/{orgId}/migrations` for runs after the restore point and re-run them by run id (MIG CLI) after the switch.

## Region loss

PITR and the managed backups live in australia-southeast1 with the database. The exports' copies and the files copy are in the backups bucket in australia-southeast2, so the data survives the region, and a database created in australia-southeast2 can import straight from that bucket. For a short outage, wait. For a long one, the owner decides on creating a database (or a new environment) in australia-southeast2 and importing the newest export and files copy into it; that needs the functions, hosting config and Terraform pointed at the new region and isn't scripted (single-firm MVP).

## Drill

The `backup-drill` workflow runs quarterly on dev (1 January, April, July and October) and on demand (Actions → backup-drill → Run workflow; source `all`, `backup`, `export` or `pitr`). For each source it restores the newest backup or export into a scratch database `drill-…`, compares every collection group's count with the live database as it was at the snapshot time (PITR; a managed backup's snapshot falls mid-minute, so its counts must lie between the live counts at the minutes either side), writes the RPO and restore time to the run summary, and deletes the scratch database. It first deletes any `drill-…` database a cancelled run left behind. Locally: `pnpm materia-scripts backup-drill --project materia-v2-dev --source backup` (refuses prod).

To see what the backups have done lately without restoring anything, run the workflow with source `status` (or `pnpm materia-scripts backup-status --project <project>`, read-only, prod too). It lists the managed backups, the export folders in the exports bucket (and any that never finished) and their copies in the backups bucket, the files copy, the export's scheduler job and its last 8 days of log lines (including why a failed export failed), and the Storage Transfer jobs' latest runs. A run with source `all` prints it first. Use it for the 7-day evidence and when an export alert fires. Once the cause is fixed, source `run-export` starts the nightly export straight away instead of waiting for 02:00.

After each drill, add a row:

| Date | Source | Snapshot age (RPO) | Restore time | Counts | Run |
| ---- | ------ | ------------------ | ------------ | ------ | --- |
| 2026-10-07 (dev) | backup | 690 min (daily backup of 11:14 UTC) | 793 s, plus 38 s to verify | ✅ 1,150 documents in 38 groups, within the snapshot minute | [37541934598](https://github.com/BlakePixHil/materia-v2/actions/runs/37541934598) |
| 2026-10-07 (dev) | export | 11 min (export run by hand at 00:18 UTC) | 46 s, plus 27 s to verify | ✅ 2,529 documents in 37 groups, exact | [37552119233](https://github.com/BlakePixHil/materia-v2/actions/runs/37552119233) |
| 2026-10-07 (dev) | pitr | 2 min (clone of 00:42 UTC) | 899 s, plus 27 s to verify | ✅ 2,529 documents in 37 groups, exact | [37553458893](https://github.com/BlakePixHil/materia-v2/actions/runs/37553458893) |

## Retention and destruction

Destroying a matter (CORE-19) deletes its live data and files. The copies in backups expire on their own: PITR after 7 days, daily backups and exports after 7 and 35 days, weekly backups after 14 weeks, monthly exports after 400 days, soft-deleted and non-current files after 30 and 90 days, and the files copy's replaced versions after 35 days. The destruction certificate says so. Never restore a destroyed matter (the script refuses), and re-apply destructions after a full restore (step 7).
