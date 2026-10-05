# Environments, CI/CD & release

## Environments

| Env | Firebase/GCP project | Deployed from | Data | Who |
|---|---|---|---|---|
| local | emulators (`demo-materia`) | the dev's machine | seed script (fictional) | everyone |
| dev | `materia-v2-dev` | every PR → Hosting preview channel `pr-<n>` (7-day expiry); `main` → live | seed + throwaway | engineers and agents |
| staging | `materia-v2-staging` | every merge to `main` | anonymised or fictional; migration rehearsals | engineers, UAT, migrated-user preview |
| prod | `materia-v2-prod` | git tag `v*` + manual approval (GitHub Environment `production`) | real client data | customers |

- **Region:** `australia-southeast1` for Firestore, Functions, Run, Tasks and Storage.
- **Backups:** buckets in `australia-southeast2`.
- **Project ids:** final ids are recorded in `infra/terraform/envs/*.tfvars` by FND-03.

## Identity & secrets

- **GitHub → GCP:** Workload Identity Federation, so there are no JSON keys. There is one deployer service account per env, holding only the roles it needs:
  - `firebase.admin` is scoped down where possible;
  - `cloudfunctions.developer`, `run.developer`, `iam.serviceAccountUser` on the runtime SA, `firebasehosting.admin`, `datastore.indexAdmin` and `firebaserules.admin`.
- **Runtime service accounts:** one per function group. The default compute SA is not used.
- **Secrets:** Secret Manager, accessed with `defineSecret()` in functions. Examples:
  - `POSTMARK_TOKEN` and `POSTMARK_WEBHOOK_SECRET` (FND-20, infra/MANUAL.md);
  - `ANTHROPIC_API_KEY`: unused since AI-02a (each firm brings its own key, KMS-encrypted; ADR-011b), kept as an empty container;
  - `XERO_CLIENT_SECRET`, `MS_CLIENT_SECRET`, `GOOGLE_CLIENT_SECRET`.
- **Client config** (the Firebase web config) is not secret. It is generated per env into `apps/web/src/environments/` by `tools/scripts/env.ts` from Terraform outputs.

## CI (GitHub Actions, `.github/workflows/ci.yml`)

Triggered by `pull_request` and `push` to `main`. Jobs:

1. `setup`: pnpm with a cache, plus the Nx cache through Nx Cloud or the GH cache.
2. `lint`: `nx affected -t lint`, plus Prettier check.
3. `typecheck`: `nx affected -t typecheck`.
4. `unit`: `nx affected -t test`, with coverage. The gate is libs/domain and libs/deadlines ≥ 90%, and everything else ≥ 70%.
5. `rules`: emulator, then `nx run firebase:test-rules`. Required whenever `firebase/` or `libs/domain` changes.
6. `build`: `nx affected -t build`, with the bundle budget enforced. Initial JS must be ≤ 300 kB gzip.
7. `e2e`: emulators, then build, then Playwright (chromium plus WebKit-mobile), with axe checks. This job is sharded.
8. `security`: CodeQL, `pnpm audit --prod` (high fails), gitleaks.
9. `preview` (PRs only): deploy hosting to a dev preview channel and comment the URL.

All of these jobs are required checks on `main`. Branch protection requires 1 review, linear history (squash), and passing checks.

## CD

- **`deploy-staging.yml`:** on push to `main`, after CI is green, run `firebase deploy` for hosting, functions, firestore rules and indexes, and storage, to staging. Then run the smoke e2e suite (`@smoke`) against staging.
- **`deploy-prod.yml`:** on a `v*` tag, run the same artefacts against prod. This needs approval in the GitHub `production` environment.
  - Functions deploy with `--force` only when explicitly flagged.
  - Index deploys run *before* function deploys.
  - Destructive index deletes need a separate manual workflow.
- **Terraform:** `infra.yml` runs `terraform plan` on PRs that touch `infra/`, and `apply` on merge to staging. Prod apply is manual.
- **Release notes:** generated from conventional commits (`release-please`).

## Rollback

- **Hosting:** `firebase hosting:rollback`, or redeploy the previous tag.
- **Functions:** redeploy the previous tag. Functions are backward compatible for one release: never remove a callable that the previous web build calls.
- **Rules:** keep the previous rules file in the release artefact and redeploy it.
- **Data migrations:** every backfill script has a `--down`, or documents why it cannot.

## Runbooks (`docs/runbooks/`)

These are created by the tickets that introduce them:
- deploy;
- rollback;
- restore from PITR or export;
- rotate secret;
- incident response;
- migration cutover;
- disable Clerk (kill switch).
