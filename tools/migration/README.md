# Legacy migration CLI

`pnpm materia-migrate <step>` moves one user's legacy materia data into Materia v2 ([plan](../../docs/08-legacy-migration-plan.md), [decision log](../../docs/migration/decisions.md)). Nothing in this tool writes to the legacy project. MIG-01 adds `audit` and `check-profile`, and MIG-04 adds `auth-import`. The other steps print a placeholder until their tickets land.

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

## Fixtures

`fixtures/legacy/*.json` is a synthetic legacy dataset for the fictional Alex Rivers (no real data), holding every hazard the plan lists, plus his Auth account (`auth-export.json`). See [`fixtures/legacy/README.md`](fixtures/legacy/README.md). MIG-02 and MIG-03 reuse it. `loadLegacyFixtures()` in `src/legacy/fixtures.ts` loads it.

## Tests

```sh
pnpm nx test migration
pnpm nx run migration:test-integration   # auth-import against the Auth emulator
```

The emulator test imports a Google-only account and a scrypt password account, made up for each run. A Google credential for the imported identity then signs in to the same uid. The emulator stores hashes without checking them; the dev rehearsal proved a real password sign-in (see the runbook).
