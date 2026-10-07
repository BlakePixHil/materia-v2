# Runbook: migration load, verify, rollback and delta (MIG-06)

How a transformed run gets into its v2 org, is checked, comes out again, and takes later changes, with `materia-migrate load`, `verify`, `rollback` and `delta` ([tool README](../../tools/migration/README.md#load-verify-rollback-and-delta-mig-06), [decision D-20](../migration/decisions.md#d-20-load-verify-rollback-and-delta-new)). It runs after the auth import (MIG-04, [runbook](migration-auth-import.md)), the transform (MIG-03) and the attachment copy (MIG-05, [runbook](migration-copy-files.md)) of the same run.

**When:**

- in each rehearsal on dev: load, verify, the user reviews, then roll back (D-15);
- at cutover (MIG-07): load the prod run, verify, then `delta` for the final changes.

## What it reads and writes

```text
gs://materia-v2-<env>-migration/runs/<runId>/
  report.json, transformed/*.jsonl   the transform's output (MIG-03), checked by sha256
  files/documents.jsonl              the copy's documents (MIG-05)
  raw/paths.jsonl                    delta runs: every card and attachment still in legacy
  load/report.json                   counts per file, conflicts, failures
  verify/report.json, verify/verify-report.md
  rollback/report.json
  delta/deletions.json
Firestore (the target project)
  orgs/<O>/…, users/<uid>            the records, each with migration {runId, legacyPath, loadedAt}
  orgs/<O>/migrations/<runId>        the run's record: status, counts, conflicts, operator
  orgs/<O>/audit/migration-<runId>-loaded   one audit entry per load (and per rollback, per delta's deletions)
```

Logs and reports carry counts and paths only, never client data.

## Credentials

Application Default Credentials, for Firestore, Auth, the run and the files bucket. Run it in **Cloud Shell** as yourself (an owner of the project). Elsewhere, `gcloud auth application-default login` first. The Admin SDK takes no other credentials for Firestore, so there is no impersonation here.

## Load

1. Check the person has a v2 account (the auth import); the load refuses without one.
2. Dry run, and read the plan per file (create, update, unchanged, user edited…):

   ```sh
   NODE_USE_ENV_PROXY=1 pnpm materia-migrate load --run <runId> --env dev --dry-run
   ```

3. Load. In prod, add `--confirm-prod` and type the org's name when asked.

   ```sh
   NODE_USE_ENV_PROXY=1 pnpm materia-migrate load --run <runId> --env dev
   ```

- **Exit 0:** loaded. `load/report.json` lists the conflicts: `MIG_C_USER_EDITED` (changed in v2 since the load, so left as it is) and `MIG_C_NOT_MIGRATED` (made in v2, such as the person's own `users/<uid>` when they already use v2).
- **Exit 5:** some writes failed, and later phases weren't written. Run the same command again: it writes only what is missing or differs.
- **Exit 1, "Refused, nothing written":** fix what it says. Typical causes:

| Message                                                | What to do                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `report.json lists no files`                           | The transform rejected records: fix the profile or pass the transform `--allow-rejects`     |
| `isn't the file the transform's report lists`          | The run's files changed after the transform: transform it again                             |
| `run copy-files first` / `copied from an earlier transform` | Run `copy-files` for this transform                                                    |
| `the copy is unscanned` / `failed`                     | Run `copy-files` again, or load them as files to review with `--skip-unfinished-files`     |
| `There is no v2 account`                               | Run the auth import first                                                                   |
| `matter numbers are already held by other matters`     | The org has matters of its own since: transform again against this org                     |

## Verify

```sh
NODE_USE_ENV_PROXY=1 pnpm materia-migrate verify --run <runId> --env dev
```

Exit 0 when it passed; 5 when not. Read `verify/verify-report.md` in the run's folder:

- **Different / Missing:** a record isn't what the run loaded. Load again (it fixes what nobody edited), then verify again.
- **File problems:** an attachment's object is missing or differs: run `copy-files` again.
- **Access:** the member's claims don't name the org with their role. Load again (it syncs them), or check the member document's `status`.
- **Privileged:** none expected (legacy had no such flag). Investigate.
- **Changed in v2** and **reloaded later** are counted and pass.

On dev and prod it checks the claims; the emulator test reads every record as the person through the rules.

## Roll back

```sh
NODE_USE_ENV_PROXY=1 pnpm materia-migrate rollback --run <runId> --env dev --dry-run
NODE_USE_ENV_PROXY=1 pnpm materia-migrate rollback --run <runId> --env dev
```

It deletes everything the run loaded, what v2 hung under it, the run's matter numbers and files (its copies, its quarantine, the profile photo), and the org when the run created it. The person's Auth account stays (the auth import's `--rollback` removes it on dev).

- **Refused, "records under this run's weren't loaded by it":** someone made records in v2 under migrated ones (or a later run loaded them: roll that back first). Nothing was deleted. The dry run lists them; decide with the user before deleting them by hand.
- **Exit 5:** some deletes failed; the run's record stays `rolling_back`. Run it again.
- **Run it once more a minute later.** Triggers can still be finishing (counts, metrics) and write under the org after it has gone; a second run sweeps them.
- **After a dev rehearsal:** add a row to the export runbook's [cleanup record](migration-export.md#cleanup-record).

## Delta (cutover)

1. Export with `--since <the last run's readTime>` (MIG-02), transform with `--base-run <the last run>` (MIG-03), and copy its files (MIG-05).
2. Dry run, then apply. Deleting what legacy deleted needs `--apply-deletes`:

   ```sh
   NODE_USE_ENV_PROXY=1 pnpm materia-migrate delta --run <deltaRunId> --env prod --confirm-prod --dry-run
   NODE_USE_ENV_PROXY=1 pnpm materia-migrate delta --run <deltaRunId> --env prod --confirm-prod --apply-deletes
   ```

3. Read `delta/deletions.json`: `deleted`, `reported` (without `--apply-deletes`), `kept_edited` and `kept_has_v2_records` (left alone; tell the user). Then verify the delta run.
