# Runbook: migration attachment copy (MIG-05)

How the legacy attachments and the profile photo get into the v2 files bucket with `materia-migrate copy-files` ([tool README](../../tools/migration/README.md#copy-files-mig-05), [decision D-18](../migration/decisions.md#d-18-attachment-copy-new)). It runs after the export (MIG-02, [runbook](migration-export.md)) and the transform (MIG-03) of the same run, and before the load (MIG-06), which reads what it writes.

**When:**

- in each rehearsal on dev, after the transform, rolled back afterwards (D-15);
- at cutover (MIG-07), after the transform of the prod export and again after the final delta's.

## What it writes

```text
gs://materia-v2-<env>-files/
  migration-quarantine/<runId>/…     every copy first; infected ones stay here
  orgs/<O>/matters/<M>/documents/<D>/v1   clean copies, unreadable until the load marks them clean
  users/<uid>/avatar.png                  the profile photo, once clean
gs://materia-v2-<env>-migration/runs/<runId>/
  files/documents.jsonl              the transform's documents with version 1, sha256 and scan filled in
  files/avatars.jsonl
  files/report.json                  counts; missing, infected, unscanned and failed files; orphans
```

Each final copy carries `migrationRunId`, `legacyPath`, `sha256`, `scan` and `scannedAt` in its metadata. The report names files by legacy path only.

## Credentials

- **Copying:** one account does the server-side copy, so it needs read on the legacy bucket and write on the files bucket.
  - **prod:** `migration-runner@materia-v2-prod.iam.gserviceaccount.com`, impersonated. Terraform gives it object admin on `materia-v2-prod-files`. **At cutover**, grant it `roles/storage.objectViewer` on `matt-r-1fe15.firebasestorage.app` in the legacy project, and remove the grant once the copy and the final delta are done.
  - **dev:** your own gcloud account, which needs read on the legacy bucket, the run, and object admin on `materia-v2-dev-files`.
- **Scanning:** an ID token for your gcloud account calls the `clamav` Cloud Run service, so you need `run.invoker` on it (owners have it). `--scanner-impersonate` uses a service account instead.
- **Where to run it:** Cloud Shell, so the bytes it reads back for the sha256 and the scan stay in Google Cloud. It keeps them in memory only, never on disk.

## Run it

```sh
NODE_USE_ENV_PROXY=1 pnpm materia-migrate copy-files --run <runId> --env dev
```

It ends with the counts, for example `Copied 70, already there 0, missing in legacy 1, infected 0, unscanned 0, failed 0.`, and writes `files/report.json`.

- **Exit 0:** done. Read the report's `missing` (files legacy lost, reported by the transform too), `infected` and `typeMismatches`, and give the orphans to the user to decide on (D-13).
- **Exit 5:** some files are `unscanned` (the scanner was down) or `failed`. Fix what the reason says and run the same command again. It skips everything already done.

| Reason              | What to do                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| `source_gone`       | The legacy file changed after the export: run a delta export and transform, then copy again       |
| `checksum_mismatch` | The copy differed from the export's listing and was deleted: run it again; if it repeats, stop    |
| `no_checksum`       | The export has no checksum for it: check `raw/storage-objects.jsonl`                              |
| `target_taken`      | Another file is at its document path: investigate before anything else                            |
| `not_an_image`      | The profile photo isn't an image: it is left out                                                  |
| `too_large`         | Over 50 MB: legacy allowed 25 MB, so investigate                                                  |
| `error`             | Run it again; the log says nothing about the file, so look at the report's legacy path            |

## Infected files

They stay at `migration-quarantine/<runId>/…`, which no client can read, and their documents load as infected with no file (as CORE-12 records an infected upload). Tell the user which legacy attachment it was, from the report. Delete the quarantine prefix once that is settled:

```sh
gcloud storage rm --recursive gs://materia-v2-<env>-files/migration-quarantine/<runId>/
```

## After a dev rehearsal

The rollback (MIG-06, [runbook](migration-load.md#roll-back)) deletes the run's documents and its files: the copies carrying its `migrationRunId`, its quarantine and the photo, so the user's files don't stay on dev (D-15). Check nothing is left, then add a row to the export runbook's [cleanup record](migration-export.md#cleanup-record).

```sh
gcloud storage ls gs://materia-v2-dev-files/orgs/<rehearsal orgId>/ gs://materia-v2-dev-files/migration-quarantine/<runId>/
```
