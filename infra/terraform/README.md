# infra/terraform

Terraform for the Materia v2 GCP/Firebase environments (FND-03, ADR-003/004). Manual steps are listed in [`../MANUAL.md`](../MANUAL.md).

| Path                     | What                                                                                                                                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bootstrap/`             | Admin project `materia-v2-admin` and the state bucket `materia-tfstate-<suffix>` (local state; run once)                                                                                                        |
| `modules/firebase_env/`  | One environment: project, APIs, Firebase, Firestore (PITR), Storage buckets, Identity Platform, KMS, Artifact Registry, web app, service accounts, WIF for GitHub, budget, `ANTHROPIC_API_KEY` secret container |
| `*.tf` (this folder)     | Root stack that instantiates the module for one environment                                                                                                                                                     |
| `envs/<env>.tfvars`      | Non-secret settings per environment (committed)                                                                                                                                                                 |
| `envs/<env>.backend.hcl` | State bucket (`materia-tfstate-blakepixhil`) and prefix per environment                                                                                                                                         |
| `imports.tf`             | Import blocks that adopt console-created resources (the projects, their Firebase projects, enabled APIs, Firebase's budget), driven by the `adopt_*` variables in `envs/<env>.tfvars`                           |

MVP mode: **dev and prod** only. `envs/staging.*` is kept for later. No organisation (owner decision): `org_id` and `folder_id` stay `null`.

## Apply

```sh
# 0. Credentials that can create projects and link billing (see MANUAL.md step 1)
gcloud auth application-default login

# 1. Bootstrap (once)
cd infra/terraform/bootstrap
cp terraform.tfvars.example terraform.tfvars   # billing account, state bucket suffix (gitignored)
terraform init && terraform apply

# 2. Each environment
cd ..
export TF_VAR_billing_account=XXXXXX-XXXXXX-XXXXXX   # the account the project is linked to now
export TF_VAR_budget_alert_emails='["you@example.com"]'
terraform init -reconfigure -backend-config=envs/dev.backend.hcl
terraform plan -var-file=envs/dev.tfvars -out=dev.plan && terraform apply dev.plan
# Expect "No changes" on a second plan. The project must never be replaced or destroyed.

# 3. Web config for the app
pnpm materia-scripts env --env dev
```

dev and prod were applied on 2026-10-04 (results in [`../MANUAL.md`](../MANUAL.md)). The providers bill API calls to the environment's project (`billing_project`), so a new environment (staging) first needs `-target=module.env.google_project.this`, then a full apply. Prod uses `envs/prod.tfvars` and `envs/prod.backend.hcl`. It enables deletion protection (`ABANDON` on the project, Firestore and the web app; delete protection on Firestore) and restricts the deployer to `v*` tags or the `production` GitHub environment.

## GitHub Actions (FND-04, FND-05)

Authenticate with `google-github-actions/auth` using the `wif_provider` and `deployer_sa` outputs; no JSON keys. The provider only accepts tokens whose immutable `repository_id` and `repository_owner_id` claims match this repository.

## Checks

```sh
terraform fmt -check -recursive
terraform init -backend=false && terraform validate   # in this folder and in bootstrap/
checkov -d . --framework terraform                   # 0 failed; skips are justified inline
```
