# Legacy migration CLI

`pnpm materia-migrate <step>` moves one user's legacy materia data into Materia v2 ([plan](../../docs/08-legacy-migration-plan.md), [decision log](../../docs/migration/decisions.md)). Nothing in this tool writes to the legacy project. MIG-01 adds the first two steps: `audit` and `check-profile`. The other steps print a placeholder until their tickets land.

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

## Fixtures

`fixtures/legacy/*.json` is a synthetic legacy dataset for the fictional Alex Rivers (no real data), holding every hazard the plan lists. See [`fixtures/legacy/README.md`](fixtures/legacy/README.md). MIG-02 and MIG-03 reuse it. `loadLegacyFixtures()` in `src/legacy/fixtures.ts` loads it.

## Tests

```sh
pnpm nx test migration
```
