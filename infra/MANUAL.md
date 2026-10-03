# Manual infrastructure changes

ADR-004: everything is provisioned with Terraform, except where Terraform has no support. Each manual change is recorded here: what, where, who, when, and why it can't be in Terraform.

| Date      | Who   | Environment       | Change                                                                                                          | Why manual                                                        |
| --------- | ----- | ----------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| _pending_ | owner | Anthropic Console | Create the organisation and the `dev` and `prod` workspaces with spend limits; create one API key per workspace | The Anthropic Console has no Terraform provider (AI-01, ADR-011a) |
| _pending_ | owner | GCP dev, prod     | Add the matching key to Secret Manager as `ANTHROPIC_API_KEY`                                                   | Secret values are never committed or held in Terraform state      |

## Clerk provider (AI-01, ADR-011a)

Fill in after setup. **Never record key values here.**

- Anthropic organisation and workspace names: _pending_
- Spend limits per workspace: _pending_
- Data retention (standard or zero data retention) and the date agreed: _pending_
- Secret Manager secret: `ANTHROPIC_API_KEY` in dev (_pending_) and prod (_pending_)

## GCP and Firebase (FND-03)

MVP mode: **dev and prod only** (staging deferred). **No organisation or folder**: confirmed by the owner on 2026-10-03, so `org_id` and `folder_id` stay `null` and the `gcp.resourceLocations` org policy is not set. Location is enforced in Terraform instead: every regional resource uses `var.region` (`australia-southeast1`) and backups use `var.backup_region` (`australia-southeast2`).

Steps Terraform can't do, or that must happen before it can run:

| #   | When                   | Step                                                                                                                                                                                                                                                                        | Why manual                                                        |
| --- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1   | Before bootstrap       | Provide the **billing account id**, and credentials that can create projects and link billing: either your own `gcloud auth application-default login`, or a service account with Project Creator (on your account, no org) and Billing Account User on the billing account | Billing and project creation need an identity outside any project |
| 2   | Before bootstrap       | Confirm the project ids `materia-v2-admin`, `materia-v2-dev` and `materia-v2-prod` are free. If one is taken, add a suffix in `bootstrap/terraform.tfvars` or `envs/<env>.tfvars` and in `firebase/.firebaserc`                                                             | Project ids are global                                            |
| 3   | After bootstrap        | Put the state bucket name into `infra/terraform/envs/{dev,prod}.backend.hcl`                                                                                                                                                                                                | Output of the bootstrap stack                                     |
| 4   | After the first `init` | Generate a multi-platform provider lock and commit it: `terraform providers lock -platform=linux_amd64 -platform=darwin_arm64 -platform=darwin_amd64` (in `infra/terraform` and `infra/terraform/bootstrap`)                                                                | The agent's environment couldn't reach the Terraform registry     |
| 5   | After apply            | **Auth authorized domains** for custom domains: add them to `auth_authorized_domains` (Terraform-managed) once DNS exists. The Firebase defaults and `localhost` are already included                                                                                       | Domains don't exist yet                                           |
| 6   | FND-22                 | **reCAPTCHA Enterprise key** for App Check: created by FND-22 (Terraform or gcloud); this ticket only enables the APIs                                                                                                                                                      | Out of scope here                                                 |
| 7   | FND-05 / launch        | **Hosting custom domain DNS**: add the TXT and A records Firebase Hosting shows                                                                                                                                                                                             | DNS is outside GCP                                                |
| 8   | After apply            | Add the secret **value** for `ANTHROPIC_API_KEY` (Terraform creates the empty secret): `printf %s "$KEY" \| gcloud secrets versions add ANTHROPIC_API_KEY --data-file=- --project materia-v2-<env>`                                                                         | Secret values never go in Terraform state                         |
| 9   | After apply            | Confirm the budget email channels: Google sends a verification email to each address in `budget_alert_emails`                                                                                                                                                               | Email verification                                                |

Applied state (fill in after each apply):

- Admin project and state bucket: _pending_
- dev project id and number: _pending_
- prod project id and number: _pending_
- `gcloud firestore databases describe --project <id>` location (must be `australia-southeast1`): _pending_
