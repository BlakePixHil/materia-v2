# Runbook: migration transform (MIG-03)

How an exported run becomes v2 documents with `materia-migrate transform` ([tool README](../../tools/migration/README.md#transform-mig-03), [decision D-19](../migration/decisions.md#d-19-transform-new)). It runs after the export (MIG-02, [runbook](migration-export.md)) and before the attachment copy (MIG-05, [runbook](migration-copy-files.md)) and the load (MIG-06), which read what it writes.

**When:**

- in each rehearsal on dev, after the export, rolled back afterwards (D-15);
- at cutover (MIG-07), on the prod export, and again on each delta with `--base-run`.

## What it writes

```text
gs://materia-v2-<env>-migration/runs/<runId>/
  transformed/<entity>.jsonl   one {path, legacyPath, data, copy?} per line, sorted by path
  idmap.jsonl                  {legacyPath, v2Path} for every record
  report.json                  written last: counts, warnings, review totals, rejects, files to copy
```

- **Entities:** orgs, users, members, counters, contacts, matters, parties, matter-numbers, tasks, personal-tasks, notes, activity, documents, checklist-templates and avatars. Every file is written, empty ones too.
- **Dates:** each Timestamp is written as `{"$timestamp": "<ISO>"}`.
- **Copies:** documents and avatars carry a `copy` plan that `copy-files` carries out.
- **Report:** it names records by legacy path only, never a name, title or value. It is still the user's data, so it stays in the bucket. Copy it to project files for review, never the repo.

## Credentials

- **prod:** `migration-runner@materia-v2-prod.iam.gserviceaccount.com`, impersonated, reads and writes the run, as for the export. It never touches the legacy project or a v2 database.
- **dev:** your own gcloud account. It needs object create, read and delete on `materia-v2-dev-migration` (a re-run overwrites its files).
- `--impersonate` or `--adc` overrides either, and `MIGRATION_WRITER_TOKEN` supplies a token.
- **Where to run it:** Cloud Shell, so the run's data stays in Google Cloud. It holds the run in memory only and writes nothing to disk.
- Behind an HTTPS proxy, set `NODE_USE_ENV_PROXY=1`.

## Run it

```sh
NODE_USE_ENV_PROXY=1 pnpm materia-migrate transform --run <runId> \
  --profile tools/migration/profiles/tristan-burke.json --target-org new --env dev
```

- **`--target-org new`** creates the org. Its id comes from the user's uid, so a re-run targets the same org.
- **An existing org id** loads into that org instead, with the user as its owner.
- **Profile:** use the one the run was exported under. If the file differs, it warns and the report says `profileChanged: true`.
- **Re-runs:** a re-run of the same run and profile writes the same bytes, so running it again is safe.

## Read the report

- `counts.in` against the export's manifest, and `counts.out` per entity. Every card on a migrated board gives a matter or a personal task.
- `warnings`: every code, with its count, meaning and legacy paths. `MIG_W_DATE_INVALID`, `MIG_W_LINK_DROPPED`, `MIG_W_ATTACHMENT_OBJECT_MISSING` and `MIG_W_ATTACHMENT_NOT_MIGRATED` need a look. The rest are expected hazards.
- `needsReview`: how many records the review queue (MIG-08) shows, by reason.
- `storage`: files to copy and their bytes, missing objects, and the orphans to give the user to decide on (D-13).
- `integrations` and `workspaces`: what doesn't migrate, so the user knows to reconnect.

## Exit codes

| Code | Meaning                                                                                                                                                                                                                     |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Transformed. Next is `copy-files`                                                                                                                                                                                           |
| 1    | Bad arguments, or a refused run: no manifest, a raw file changed since the export, the profile is another user's, or a delta without `--base-run`                                                                           |
| 5    | Records failed their v2 schema. Only `report.json` was written, with the rejects (path, field and zod code) and an empty `files` list. Fix the mapping and run it again, or pass `--allow-rejects` to load without them |

## A delta

The final delta at cutover is exported with `--since <last run's readTime>` (MIG-02), then transformed against the run it continues:

```sh
pnpm materia-migrate transform --run <deltaRunId> --base-run <baseRunId> \
  --profile tools/migration/profiles/tristan-burke.json --target-org new --env prod
```

- **Numbers:** changed matters keep the numbers the base run gave them. New ones continue after the base's counters.
- **Links:** a changed matter can link to an unchanged one, which the delta finds in `raw/paths.jsonl`.

## After a dev rehearsal

The transformed files are the user's data too. Delete the whole run with every version, as the export runbook says, and add a row to its [cleanup record](migration-export.md#cleanup-record).
