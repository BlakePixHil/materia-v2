# Legacy migration CLI

`pnpm materia-migrate <step>` moves one user's legacy materia data into Materia v2 ([plan](../../docs/08-legacy-migration-plan.md), [decision log](../../docs/migration/decisions.md)). Nothing in this tool writes to the legacy project. MIG-01 adds `audit` and `check-profile`, MIG-02 adds `export`, MIG-03 adds `transform`, MIG-04 adds `auth-import`, MIG-05 adds `copy-files`, and MIG-06 adds `load`, `verify`, `rollback` and `delta`. The other steps print a placeholder until their tickets land.

## `audit` (MIG-01)

Profiles one user's legacy data read-only. It writes `audit-report.json` and `audit-report.md`, which hold counts and shapes only, plus the workflow, swimlane and label names the user sees anyway. No titles, descriptions, comments, file names, client or referrer details appear in either file.

```sh
NODE_USE_ENV_PROXY=1 pnpm materia-migrate audit \
  --profile tools/migration/profiles/tristan-burke.json \
  --out /mnt/project-files/mig-01/audit
```

**Before it reads anything**, it asks IAM (`testIamPermissions`) what the credentials can do in the legacy project and bucket:

- If they can write anything (Firestore, Storage, Auth, rules, IAM or keys), it stops with exit code 3.
- It also stops if a needed read is missing.
- Without `firebaseauth.users.get` it skips the sign-in facts, which MIG-04 needs, and says so.

**Credentials:** short-lived only, never a key file. In order of preference:

1. **Impersonation (default):** `gcloud auth print-access-token --impersonate-service-account legacy-migration-reader@matt-r-1fe15.iam.gserviceaccount.com`. Your gcloud account needs `roles/iam.serviceAccountTokenCreator` on that account.
2. **`--adc`:** Application Default Credentials, when they already are the read-only account.
3. **`MIGRATION_ACCESS_TOKEN`:** a token you minted yourself.

**Options:**

| Option                  | Meaning                                                                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--profile <path>`      | The mapping profile. Scope comes from it, and the report checks the profile covers every workflow and swimlane. Its `subject.legacyUid` is the uid. |
| `--uid <uid>`           | Audit without a profile. The scope is the workflows the user owns or administers, and the others are listed for a decision.                         |
| `--out <dir>`           | Where to write the report. The default is `dist/migration/audit`.                                                                                   |
| `--project`, `--bucket` | The legacy project and bucket. The defaults are `matt-r-1fe15` and its default bucket.                                                              |

**Where the report goes:** keep reports from real data out of the repo. `dist/` is git-ignored, and in the project the report goes to `/mnt/project-files/mig-01/`. A report has no content, but it is still about a real person's practice.

## `check-profile` (MIG-01)

Validates a mapping profile with its zod schema (`src/profile.ts`). With `--report`, it also checks that the profile maps every workflow and swimlane in an audit report, and that every mapping still matches the data, so a renamed column fails loudly.

```sh
pnpm materia-migrate check-profile --profile tools/migration/profiles/tristan-burke.json \
  --report /mnt/project-files/mig-01/audit/audit-report.json
```

It exits 1 when the profile is invalid or incomplete.

## `export` (MIG-02)

Reads one user's legacy data read-only, as one Firestore snapshot, and writes it as JSONL with a manifest to `gs://materia-v2-<env>-migration/runs/<runId>/`. The [runbook](../../docs/runbooks/migration-export.md) has the file layout and the cutover steps, and [D-17](../../docs/migration/decisions.md#d-17-export-new) the choices.

```sh
NODE_USE_ENV_PROXY=1 pnpm materia-migrate export --profile tools/migration/profiles/tristan-burke.json \
  --dry-run --compare-audit /mnt/project-files/mig-01/audit/audit-report.json
```

- **Read-only:**
  - It runs the same IAM check as the audit before it reads anything, and stops with exit code 3 on credentials that could write.
  - The reader sends only GETs and read-only POSTs (`runQuery`, `runAggregationQuery`, `batchGet`, `accounts:lookup`). Anything else throws before it is sent.
- **Scope:** the audit's, narrowed by the profile. The user's profile, dashboard items, integrations and workspaces. Every board they are on or own that the profile doesn't exclude, with all its cards (archived too), attachments and checklist templates. Their referrers. Other users' names, the Auth record without secrets, and the Storage objects' metadata. A board the profile doesn't name stops the export with exit code 4.
- **One snapshot:** every Firestore read is at the `readTime` the server gave at the start. Queries page on a `__name__` cursor.
- **Output:**
  - One `{path, id, data, readTime}` per line, sorted, with sorted keys, so the same snapshot gives the same sha256.
  - Files stream up in resumable 8 MiB chunks, and each upload is checked against the MD5 Storage computes.
  - It writes only to a `materia-v2-(dev|prod)-migration` bucket.
- **Logs:** counts only.
- **Options:**

  | Option                    | Meaning                                                                                                                     |
  | ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
  | `--env dev\|prod`         | Where the run goes. Prod is written by `migration-runner`, dev by your gcloud account                                       |
  | `--dry-run`               | Read and count, write nothing. With `--compare-audit <report>`, compare the counts with the audit's                         |
  | `--since <iso>`           | A delta: cards and attachments changed since then, plus `raw/paths.jsonl`                                                   |
  | `--run-id`, `--resume`    | Name a run; finish an interrupted one within 55 minutes                                                                     |
  | `--source-project demo-…` | Read the Firestore, Storage and Auth emulators instead (made-up data). `--env emulator` also writes to the Storage emulator |

## `transform` (MIG-03)

Maps an exported run to v2 documents and writes them beside it: `transformed/<entity>.jsonl`, `idmap.jsonl` and `report.json`. The [runbook](../../docs/runbooks/migration-transform.md) has the steps, and [D-19](../../docs/migration/decisions.md#d-19-transform-new) the choices.

```sh
NODE_USE_ENV_PROXY=1 pnpm materia-migrate transform --run <runId> \
  --profile tools/migration/profiles/tristan-burke.json --target-org new --env dev
```

- **Reads** the run's `raw/*.jsonl`, each checked against the manifest's sha256, and nothing else. It never touches the legacy project or a v2 database.
- **Maps** with pure functions, one module per entity in `src/transform/`. `run.ts` puts them together:
  - `user.ts`: the org, user, member and profile photo;
  - `card.ts`: matters, with `fee.ts`, `comments.ts`, `checklists.ts`, `history.ts`, `attachments.ts` and `html.ts`;
  - `personal.ts` and `dashboard.ts`: personal tasks;
  - `numbers.ts`: matter numbers, their reservations and counters;
  - `referrers.ts` and `collaborators.ts`: contacts;
  - `templates.ts`: checklist templates.
- **Validates** every record against its `libs/domain` schema. A record that fails is rejected with everything under it. The run then writes only `report.json` and exits 5, unless `--allow-rejects`.
- **Same output every time:**
  - ids are `deterministicId('mig', legacyPath)`;
  - the reference time is the export's `readTime`;
  - each line is `{path, legacyPath, data, copy?}` with sorted keys, Timestamps as `{"$timestamp": "<ISO>"}`, and lines sorted by path.
  - So a re-run writes the same bytes.
- **Report:** counts in and out, every warning code (`MIG_W_*`) with its count and legacy paths, review totals by reason, rejects, files to copy and orphans. It holds no names, titles or values. A real run's report stays out of the repo.
- **Logs:** counts only.
- **Options:**

  | Option                   | Meaning                                                                                           |
  | ------------------------ | ------------------------------------------------------------------------------------------------- |
  | `--target-org <id\|new>` | The org to load into, or `new`, whose id comes from the user's uid                                |
  | `--env dev\|prod`        | Where the run is. `--env emulator` uses the Storage emulator's dev migration bucket               |
  | `--dir <path>`           | Runs in a local directory (`<path>/<runId>/raw/…`), for made-up data only                         |
  | `--base-run <runId>`     | For a delta: the run it continues, whose matter numbers it keeps                                  |
  | `--allow-rejects`        | Write the output without the records that failed validation                                       |
  | `--impersonate`, `--adc` | Who reads and writes the run: migration-runner in prod and your gcloud account in dev, by default |

- **Exit codes:** 0 when transformed; 5 when records failed validation; 1 on bad arguments, a refused run or an error.

## `auth-import` (MIG-04)

Moves one legacy Firebase Auth account into a v2 project with the same uid. It keeps the Auth record's email, every sign-in identity with the provider's id for the person (so Google sign-in finds the same account), and the password hash with the legacy scrypt parameters when there is one. The [runbook](../../docs/runbooks/migration-auth-import.md) has the cutover steps.

```sh
NODE_USE_ENV_PROXY=1 pnpm materia-migrate auth-import --target materia-v2-dev \
  --profile tools/migration/profiles/tristan-burke.json --dry-run
```

- **Plans before it writes.** `src/auth/plan.ts` decides from the account and the target's state alone.
- **Skips** when the uid is already there with the same email, so a re-run is a no-op.
- **Stops with exit code 4, for a person,** on:
  - a disabled account, second factors or phone sign-in;
  - a provider the target hasn't turned on;
  - a password whose hash it can't see;
  - the uid held with another email;
  - another v2 user holding the email or identity. That user is deleted only when named with `--replace-user`.
- **Source:** the legacy account comes from `accounts:lookup` through the read-only account, after the same IAM check as the audit. A password hash needs a `firebase auth:export` file filtered to the one user (`--record`).
- **Target:**
  - The Admin SDK `importUsers`, then a read-back check.
  - It never writes to a legacy project, and refuses `materia-v2-prod` without `--confirm-prod`.
  - With `FIREBASE_AUTH_EMULATOR_HOST` set, it targets the emulator (a `demo-` project).
- **Hash parameters:** read from the target's Secret Manager (`LEGACY_SCRYPT_PARAMS`), or from the environment on the emulator. Never logged, and emails aren't either.
- **`--rollback`:** deletes the imported account after a rehearsal. In prod, only if it never signed in.

## `copy-files` (MIG-05)

Copies every attachment the transform planned, and the profile photo, from the legacy bucket into the v2 files bucket, server to server. The [runbook](../../docs/runbooks/migration-copy-files.md) has the steps, and [D-18](../../docs/migration/decisions.md#d-18-attachment-copy-new) the choices.

```sh
NODE_USE_ENV_PROXY=1 pnpm materia-migrate copy-files --run <runId> --env dev
```

- **Reads** the run's `transformed/documents.jsonl` and `transformed/avatars.jsonl` (MIG-03), the transform's `report.json` for the orphans, and the export's `manifest.json` for the legacy bucket.
- **For each file** (`src/files/copy.ts`):
  1. A server-side copy (GCS `rewrite`) of exactly the generation the export listed, into `migration-quarantine/<runId>/` in the files bucket. No client can read that path.
  2. A check against the export's size, MD5 and CRC32C. A copy that differs is deleted and reported.
  3. A read back in memory (never to disk) for its sha256 and what its bytes are.
  4. The malware scan, by the same ClamAV service that scans uploads (CORE-12a).
  5. **Clean:** moved to `orgs/{O}/matters/{M}/documents/{D}/v1` (or `users/{uid}/avatar.png`), with `migrationRunId`, `legacyPath`, `sha256` and the scan in its metadata. **Infected:** stays in quarantine. **Scanner down:** stays in quarantine until a re-run.
- **Never** writes to the legacy bucket, carries a legacy download token across, or deletes anything outside its quarantine prefix. A path already holding another file is reported, not overwritten.
- **Writes** beside the transform's files:
  - `files/documents.jsonl`: the transform's lines with version 1, the sha256 and `scan.status` filled in, plus each file's `result`. The load (MIG-06) reads this file.
  - `files/avatars.jsonl`;
  - `files/report.json`: counts, then the missing, infected, unscanned and failed files, type mismatches and orphans, by legacy path. No file names or content.
- **Re-runs** skip every file already at its final path with the same content, scanned clean, so a re-run finishes an interrupted run.
- **Logs:** counts only.
- **Options:**

  | Option                   | Meaning                                                                                                |
  | ------------------------ | ------------------------------------------------------------------------------------------------------ |
  | `--run <runId>`          | The run to copy for                                                                                    |
  | `--env dev\|prod`        | The v2 environment. `--env emulator` uses the Storage emulator with a fake scanner (EICAR is infected) |
  | `--concurrency <n>`      | Files at a time (default 8)                                                                            |
  | `--source-bucket`        | The legacy bucket, when not the export manifest's                                                      |
  | `--scanner-url`          | The ClamAV service, when not the `clamav` Cloud Run service in the environment's project               |
  | `--impersonate`, `--adc` | Who copies: migration-runner in prod and your gcloud account in dev, by default                        |

- **Exit codes:** 0 when every file was copied, skipped, missing in legacy or infected (both reported); 5 when some are unscanned or failed, so run it again; 1 on bad arguments or an error.

## `load`, `verify`, `rollback` and `delta` (MIG-06)

Write a transformed run into its v2 org, prove it, take it out again, and apply later changes. The [runbook](../../docs/runbooks/migration-load.md) has the steps, and [D-20](../../docs/migration/decisions.md#d-20-load-verify-rollback-and-delta-new) the choices.

```sh
NODE_USE_ENV_PROXY=1 pnpm materia-migrate load --run <runId> --env dev --dry-run
NODE_USE_ENV_PROXY=1 pnpm materia-migrate load --run <runId> --env dev
NODE_USE_ENV_PROXY=1 pnpm materia-migrate verify --run <runId> --env dev
NODE_USE_ENV_PROXY=1 pnpm materia-migrate rollback --run <runId> --env dev
NODE_USE_ENV_PROXY=1 pnpm materia-migrate delta --run <deltaRunId> --env prod --confirm-prod [--apply-deletes]
```

- **`load`** (`src/load/load.ts`):
  - **Reads** the transform's `transformed/*.jsonl` (MIG-03), each checked against the sha256 its `report.json` lists, and `files/documents.jsonl` from the copy (MIG-05). It refuses a run whose report lists no files (the transform rejected records) and a line its entity's schema rejects.
  - **Writes** in dependency order: org, users, members, counters, matter numbers, contacts, templates, matters, parties, tasks, notes, activity, documents, personal tasks. Each phase finishes before the next starts, through a BulkWriter with retries. Every document carries `migration {runId, legacyPath, loadedAt}`, with `loadedAt` the load's time.
  - **Conflict rule:** a document someone changed in v2 since it was loaded (`updatedAt` after `migration.loadedAt`, by anyone but the system) is left alone and reported as `MIG_C_USER_EDITED`. A document v2 made itself at a migration path is left alone as `MIG_C_NOT_MIGRATED`. Fields v2 maintains (counts, search, claims mirrors) keep v2's values.
  - **Idempotent:** a re-run writes only what differs, so it finishes an interrupted load. What a later run finds unchanged keeps the run that loaded it.
  - **Matter numbers:** the transform reserves them in legacy `createdOn` order. The load raises the org's counter to the run's (never lowers it) and refuses numbers another matter already holds.
  - **After:** syncs each member's claims, writes the run's record (`orgs/{O}/migrations/{runId}`), one `migration.loaded` audit entry with the counts, and `load/report.json`.
  - **Side effects:** the v2 triggers see the write set or restamp `migration` and send no notifications, write no activity or per-document audit entries, and queue no ingestion: Clerk reads the run's documents once an owner approves the cost (MIG-09, [runbook](../../docs/runbooks/migration-enrichment.md)). Counts, search, claims and metrics still follow.
- **`verify`** (`src/load/verify.ts`): reads back every record the run loaded and compares it field by field, checks each copied file's size, sha256 and legacy MD5, each member's claims, and that nothing is privileged. On the emulator it also reads every record as the member through the security rules. Writes `verify/report.json` and `verify/verify-report.md`.
- **`rollback`** (`src/load/rollback.ts`): deletes every document whose `migration.runId` is the run's (a collection-group query per kind, deepest first), what v2 hung under them (audit entries, activity, chunks), the run's matter numbers, its files (copies carrying its id, its quarantine, the profile photo), and the org when the run created it (`--keep-org` keeps it). It refuses, deleting nothing, while a record it didn't load sits under one it did, and lists them.
- **`delta`** (`src/load/delta.ts`): loads a delta run (`export --since`, `transform --base-run`, `copy-files`) under the conflict rule, then finds what legacy deleted since: cards and attachments missing from the export's `raw/paths.jsonl`, and records of a changed card its new transform no longer has. They are listed in `delta/deletions.json` and deleted only with `--apply-deletes`, and never when changed in v2 or holding records made there.
- **Prod** needs `--confirm-prod` and the org's name typed back, for `load`, `rollback` and `delta`. `--dry-run` writes nothing and needs neither.
- **Credentials:** Application Default Credentials: your account in Cloud Shell. Firestore takes no others through the Admin SDK.
- **Logs:** counts and paths only. **Exit codes:** 0 done (conflicts are reported, not errors); 5 some writes failed (run it again) or verify failed; 1 refused or an error, with nothing written when refused.

## Fixtures

`fixtures/legacy/*.json` is a synthetic legacy dataset for the fictional Alex Rivers (no real data), holding every hazard the plan lists, plus his Auth account (`auth-export.json`). See [`fixtures/legacy/README.md`](fixtures/legacy/README.md). MIG-02 and MIG-03 reuse it. `loadLegacyFixtures()` in `src/legacy/fixtures.ts` loads it. `fixtures/golden/` is the transform of its export, byte for byte: `src/transform/run.spec.ts` fails when the output changes, and `pnpm nx test migration --update` rewrites it after a deliberate change.

## Tests

```sh
pnpm nx test migration
pnpm nx run migration:test-integration   # export, transform, auth-import, copy-files and load against the emulators
```

The export test loads the fixtures into a `demo-legacy` Firestore, Storage and Auth, and exports them to the migration bucket on the Storage emulator. Each Firestore file must be byte for byte the export of the fixtures in memory, and match the manifest's count and sha256. It also checks that a change made after the snapshot's `readTime` stays out, and covers a delta, a dry run and a profile that misses a board.

The transform's tests run in memory. They transform the fixtures' export, compare it with the golden files, and check that the same bytes come back whatever order the records arrive in. The CLI test runs the command on a local run, a delta against its base, and a run with rejects. Against the Storage emulator, the transform reads the fixtures' export from the migration bucket and must write the golden files back.

The copy-files test copies made-up attachments from a `demo-legacy` bucket on the Storage emulator. It checks the bytes, metadata and records of a clean file, keeps an EICAR file in quarantine, reports a missing one, fails a copy whose checksum differs from the export's, uploads an image a description embedded, and finds nothing to do on a re-run.

The auth-import test imports a Google-only account and a scrypt password account, made up for each run. A Google credential for the imported identity then signs in to the same uid. The emulator stores hashes without checking them; the dev rehearsal proved a real password sign-in (see the runbook).

The load test (`tests/load.int.spec.ts`) loads MIG-03's golden output (`fixtures/golden/`) into the Firestore emulator, with its files copied as MIG-05 leaves them (`src/load/golden.ts`). The unit tests use a smaller made-up run (`src/load/fixture.ts`). Verify must pass, reading every record as the member through the security rules, while someone outside the org is refused. A record edited in v2 must survive a second load and be reported, and the rollback must leave the emulator as it found it.
