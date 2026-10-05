# Runbook: deploy

How code reaches dev and prod (FND-05). Nobody deploys from a laptop: every deploy is a GitHub Actions run that authenticates through Workload Identity Federation, with no JSON keys.

MVP mode has two environments, **dev** (`materia-v2-dev`) and **prod** (`materia-v2-prod`). Wherever older docs say "staging", read dev. `infra/terraform/envs/staging.*` and the `staging` entry in the root `.firebaserc` are unused.

## The pipeline

| Workflow | Trigger | What it does |
| -- | -- | -- |
| `ci.yml` | every PR and push to `main`, a morning run (about 06:30 Melbourne), or a manual dispatch | Lint, tests, build, e2e; `ci-ok` is the merge gate (FND-04). The `gate` job trims runs to save Actions minutes (see [Quiet hours](#quiet-hours-and-actions-minutes)) |
| `preview.yml` | PRs from branches of this repo that touch the web app (paths filter), outside quiet hours | Builds the web app for dev and deploys it to the Hosting channel `pr-<number>` of `materia-v2-dev` (expires after 7 days), then comments the URL |
| `deploy-dev.yml` | `ci` succeeds on `main` with its `build` job run (a daytime push, the morning run or a dispatch of `ci`), or a manual dispatch | Builds the release once (web for dev, web for prod, functions, the Cloud Run jobs bundle) as the artifact `release-<sha>` (kept 90 days), then runs `deploy.yml` against dev |
| `deploy.yml` | called by the two deploy workflows | Deploys in order: Firestore indexes → Firestore and Storage rules → Cloud Run jobs (builds the image from the bundle, pushes it to Artifact Registry `jobs`, deploys the job `pdf`) → functions (`--only functions:core`) → hosting, all `--non-interactive`, then runs the Playwright `@smoke` tests against the deployed site |
| `release.yml` | push to `main` | release-please: keeps a release PR open; merging it tags `vX.Y.Z`, publishes the changelog and starts `deploy-prod.yml` |
| `deploy-prod.yml` | `v*` tag, or a manual dispatch with a tag | Finds the successful `deploy-dev` run for the tagged commit, waits for approval in the `production` environment, then promotes that run's artifact to prod with `deploy.yml` (no rebuild) |
| `infra.yml` | PRs and pushes touching `infra/terraform/`, or a manual dispatch | `terraform plan` comment on PRs (dev and prod); apply to dev on merge; apply to prod by dispatch, after approval |

Deploys queue rather than run in parallel (concurrency groups `deploy-dev` and `deploy-prod`, no cancelling). A failure stops the run and marks it red. Nothing retries automatically.

### Quiet hours and Actions minutes

Actions minutes are billed, and most of them go to CI. CI's `gate` job (`.github/scripts/ci-gate.sh`) picks a mode per run:

| Mode | When | Runs |
| -- | -- | -- |
| `full` | PRs, the morning run, a manual dispatch | every job |
| `main` | a push to `main` in the day | lint, typecheck, unit, rules, integration, build (e2e, Storybook, container tests, Terraform and security already passed on the PR) |
| `docs` | only docs changed (`docs/`, top-level Markdown, READMEs) | lint |
| `skip` | a push to `main` in quiet hours (22:00–07:30 Melbourne), or a morning run with nothing new | nothing |

`deploy-dev` deploys only CI runs whose `build` job ran, so merges in quiet hours are not deployed when they land. The morning run (cron 19:30 and 20:30 UTC; the gate keeps the one at about 06:30 Melbourne, daylight saving or not) skips when dev already runs `main`; otherwise it runs full CI against everything since the last dev deploy, and deploy-dev follows. Merges between the morning run and 07:30 deploy with the next daytime merge. Release commits (the release-please PR) are never held back, so `deploy-prod` always finds its dev deploy. To deploy overnight, for example to check a pipeline fix, dispatch `ci` on `main` (tested deploy) or `deploy-dev` (deploys without CI). PR CI is never trimmed by time: agents merge overnight on green checks.

### Release versions

`/health` shows the version, the commit SHA and the environment. The `system-ping` callable returns the same version and SHA (`MATERIA_RELEASE_VERSION` / `MATERIA_RELEASE_SHA`, written to `dist/apps/functions/.env` by `pnpm materia-scripts stamp`). The version is `v` plus `.release-please-manifest.json`, so a dev build between releases shows the last released version: the SHA tells builds apart. Previews show `pr-<number>`.

### What previews cannot show

Previews deploy hosting only. The preview app calls the dev project's functions, rules and indexes, which come from `main`. A PR that changes a callable, a rule or an index is only testable in the emulators (CI e2e) until it merges.

## Releasing to prod

1. Merge PRs to `main`. Each PR body ends with its Conventional Commit, for example:

   ```
   BEGIN_COMMIT_OVERRIDE
   feat(matters): archive a matter
   END_COMMIT_OVERRIDE
   ```

   Main's squash commits are titled `[KEY] <title>`, which release-please cannot read, so it uses this block instead. `feat` bumps the minor version, `fix` the patch; `chore`, `docs`, `test`, `ci` and `refactor` don't release.
2. Check that `deploy-dev` is green for the commit you want to release, and look at <https://materia-v2-dev.web.app/health>.
3. Merge the release PR that release-please opened (`chore(main): release X.Y.Z`). `release.yml` tags `vX.Y.Z` and starts `deploy-prod`.
4. In **Actions → deploy-prod**, wait for "find the dev-tested release". It waits up to 45 minutes for the release commit's dev deploy. Then **Review deployments → production → Approve**.
5. When the run is green, open <https://materia-v2-prod.web.app/health> and check the version and SHA.

A tag on a commit with no successful `deploy-dev` run, or one whose artifact has expired after 90 days, is refused.

## When a deploy fails midway

The order is chosen so that a partial deploy leaves prod working: indexes are additive (deploys never delete them), rules changes must suit both the old and the new code, and hosting goes last, so users only see the new UI once its functions exist.

1. Open the failed step's log. Typical causes are a permission the deployer lacks (the error names it, see below), a quota, or the CLI refusing to delete a function.
2. **"would delete functions"**: the source no longer has a function that is deployed. The CLI is non-interactive and the workflow never passes `--force`, so it fails. If the deletion is intended, delete it by hand first (`pnpm exec firebase functions:delete <name> --region australia-southeast1 --project <project>`, needs owner credentials), then re-run the failed jobs.
3. Fix the cause and use **Re-run failed jobs**. Each step is safe to repeat. If the fix is a code change, merge it to `main`. For prod, release it as a patch version.
4. If prod is broken in the meantime, roll back: [`rollback.md`](rollback.md).

## One-time setup (owner)

The workflows skip with a notice, or fail with a message naming the missing setting, until these are done. Settings → Secrets and variables → Actions:

- [ ] **Variable `FIREBASE_WEB_CONFIG_DEV`**: the output of `terraform output -raw web_app_config` for dev (public Firebase web config JSON). Previews and dev deploys skip until it exists.
- [ ] **Variable `FIREBASE_WEB_CONFIG_PROD`**: the same for prod. Without it, releases have no prod bundle and can't be promoted.
- [ ] **Variables `GCP_PROJECT_PROD`, `GCP_WIF_PROVIDER_PROD`, `GCP_DEPLOYER_SA_PROD`**: `materia-v2-prod`, `projects/664690513020/locations/global/workloadIdentityPools/github/providers/github`, `deployer@materia-v2-prod.iam.gserviceaccount.com`. Repository or `production` environment variables both work. The dev ones exist.
- [ ] **Environment `production`** (Settings → Environments): add yourself as a required reviewer. Optionally limit deployment branches and tags to `main` and `v*`.
- [ ] **Terraform in CI**: apply `infra/terraform/bootstrap` (it adds the Workload Identity pool for `terraform-agent`; the bootstrap state is local, with you). Then set the variables `TF_WIF_PROVIDER` and `TF_SERVICE_ACCOUNT` (bootstrap outputs `terraform_wif_provider` and `terraform_service_account`), and the secrets `TF_VAR_BILLING_ACCOUNT` and `TF_VAR_BUDGET_ALERT_EMAILS` (a JSON list, for example `["you@example.com"]`). Environment `infra-dev` is created on the first run; leave it without reviewers so PR plans run.
- [ ] **Optional secret `RELEASE_PLEASE_TOKEN`**: a fine-grained token (this repo; contents and pull requests read/write). Without it, CI does not run on release PRs, so with `ci-ok` required you merge them as an admin.
- [ ] After the first successful dev deploy: `gcloud iam service-accounts keys list --iam-account deployer@materia-v2-dev.iam.gserviceaccount.com --managed-by user` is empty (same for prod). Once `infra.yml` has applied, delete `terraform-agent`'s key ([`infra/MANUAL.md`](../../infra/MANUAL.md)).

### Deployer permissions

The deployer has the roles listed in `infra/terraform/modules/firebase_env/iam.tf`. If the first deploy fails with a permission error, add the named role there, open a PR (the plan comment shows the change), and let `infra.yml` apply it to dev; apply prod by dispatch.
