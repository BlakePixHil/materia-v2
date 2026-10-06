# Runbook: migration export (MIG-02)

How one user's legacy data is read out of `matt-r-1fe15`, read-only, into the v2 migration bucket with `materia-migrate export` ([tool README](../../tools/migration/README.md#export-mig-02), [decision D-17](../migration/decisions.md#d-17-export-new)). The transform (MIG-03) and the attachment copy (MIG-05) read the run it writes.

**When:**

- a dry run whenever the counts need checking;
- an export to dev for each rehearsal, deleted afterwards (D-15);
- the export to prod at cutover (MIG-07), followed by a final delta.

## What a run writes

```text
gs://materia-v2-<env>-migration/runs/<runId>/
  raw/profiles.jsonl                   the user's own profile
  raw/dashboard-checklist-items.jsonl
  raw/integrations.jsonl
  raw/workspaces.jsonl
  raw/workflows.jsonl                  the boards the profile doesn't exclude
  raw/cards.jsonl                      every card on them, archived ones too
  raw/attachments.jsonl
  raw/checklist-templates.jsonl
  raw/referrers.jsonl
  raw/people.jsonl                     other users the data names: their names only
  raw/auth.jsonl                       providers, email, verified, dates; no hash
  raw/storage-objects.jsonl            names, sizes, types, MD5, CRC32C, generations; no content
  raw/paths.jsonl                      a delta only: every card and attachment in scope
  checkpoint.json                      the snapshot's readTime and the files written so far
  manifest.json                        written last: counts, a sha256 per file, the readTime
```

- **Lines:** each one is `{"path", "id", "data", "readTime"}`. They are sorted by path, and `data` has its keys sorted, so the same snapshot always gives the same bytes.
- **Values JSON can't hold** stay tagged, for example `{"$timestamp": "…"}` (see `TaggedValue` in `src/legacy/snapshot.ts`). Bytes stay whole as base64.
- **Download tokens** are taken out of Firebase download URLs (D-17). The manifest counts them.
- **Notifications** are counted in the manifest and never exported (D-14).

The bucket is CMEK-encrypted with uniform access and object versioning. Its lifecycle deletes objects after 90 days and old versions after 7.

## Credentials

- **Legacy (read-only):** the tool impersonates `legacy-migration-reader@matt-r-1fe15.iam.gserviceaccount.com`, as the audit does.
  - Before reading anything, it asks IAM what the account can do. It stops with exit code 3 if it can write anything, or can't read what it needs.
  - It only ever sends reads to the legacy project.
- **Writer:**
  - **prod:** `migration-runner@materia-v2-prod.iam.gserviceaccount.com`, impersonated. Your account needs `roles/iam.serviceAccountTokenCreator` on it.
  - **dev:** dev has no runner account, so your own gcloud account writes. It needs object create, read and delete on `materia-v2-dev-migration`.
  - `--writer-impersonate` or `--writer-adc` overrides either.
- Behind an HTTPS proxy, set `NODE_USE_ENV_PROXY=1`.

## Dry run

It reads everything, counts it and writes nothing. With `--compare-audit` it puts the counts beside a MIG-01 audit's:

```sh
NODE_USE_ENV_PROXY=1 pnpm materia-migrate export --profile tools/migration/profiles/tristan-burke.json \
  --dry-run --compare-audit /mnt/project-files/mig-01/audit/audit-report.json
```

A count that differs means the data changed since the audit, or the profile did. The log holds counts, permission names and the readTime, never data.

## Rehearse on dev

**With made-up data**, as the integration test does: load the fixtures into the emulators under a `demo-` project, then export to the real dev bucket.

```sh
pnpm materia-migrate export --profile tools/migration/fixtures/legacy/mapping-profile.json \
  --source-project demo-legacy --env dev --run-id rehearsal-<date>
```

Run it under `firebase emulators:exec --only auth,firestore,storage` with the fixtures loaded. A `demo-` source can never go to prod.

**With the real user** (a MIG-07 rehearsal): the same command as the cutover export below, with `--env dev`. Afterwards, delete the run with every version of every file, so his data doesn't stay on dev (D-15):

```sh
gcloud storage rm --all-versions --recursive gs://materia-v2-dev-migration/runs/<runId>/
gcloud storage ls --all-versions --recursive gs://materia-v2-dev-migration/runs/<runId>/   # must list nothing
```

Then add a row to the [cleanup record](#cleanup-record).

## Export at cutover

1. **Dry run** (above). The counts should match the latest audit, or the differences should be explained.
2. **Export:**

   ```sh
   NODE_USE_ENV_PROXY=1 pnpm materia-migrate export --profile tools/migration/profiles/tristan-burke.json --env prod
   ```

   It prints the run id and ends with `Exported … to gs://materia-v2-prod-migration/runs/<runId>/ (manifest.json)`.
3. **Note the manifest's `readTime`.** The final delta starts from it.
4. **Final delta**, after the user stops using legacy:

   ```sh
   … export --profile … --env prod --since <readTime from step 3>
   ```

   Its manifest says `"kind": "delta"`, and `raw/paths.jsonl` tells the load what was deleted.

## Interrupted runs

`checkpoint.json` records the snapshot's readTime and every file already written. To finish an interrupted run within 55 minutes of its start, re-run with `--resume --run-id <runId>`. Firestore can't read further back than an hour, so after that, start a new run. A finished run (with a `manifest.json`) can't be resumed or overwritten, and a run id in use is refused.

## Exit codes

| Code | Meaning |
| -- | -- |
| 0 | Exported, or a dry run |
| 1 | Bad arguments, a refused run (run id in use, resume that doesn't match) or an error |
| 3 | The legacy credentials could write, or can't read |
| 4 | The profile doesn't map one of the user's boards. Run a fresh audit and `check-profile --report`, update the profile, then export again |

## Cleanup record

Every run that held real data outside prod, and when it was deleted.

| Date | What | Deleted |
| -- | -- | -- |
| 2026-10-06 | MIG-02 dev rehearsal with made-up data only (`rehearsal-mig02-20261006T210206Z`). The real user was dry-run only, which writes nothing | Same day: every version under the run deleted, and the bucket listed empty |
