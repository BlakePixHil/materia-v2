# Keyless Terraform from GitHub Actions (FND-05, infra.yml). GitHub's OIDC token is exchanged
# through this pool for the terraform-agent service account, so CI needs no JSON key. Once the
# owner has applied this and infra.yml has run, delete terraform-agent's key (infra/MANUAL.md).
#
# Only jobs that run in the GitHub environments `infra-dev` (plan and dev apply) or `production`
# (prod apply, with required reviewers) of this repository can use the pool.

resource "google_project_service" "wif" {
  for_each = toset(["iamcredentials.googleapis.com", "sts.googleapis.com"])

  project            = google_project.admin.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_iam_workload_identity_pool" "github" {
  project                   = google_project.admin.project_id
  workload_identity_pool_id = "github"
  display_name              = "GitHub Actions (Terraform)"
  depends_on                = [google_project_service.wif]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  #checkov:skip=CKV_GCP_125:The condition pins immutable repository_id and repository_owner_id claims and the GitHub environment, which is stricter than a sub match.
  project                            = google_project.admin.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub OIDC (Terraform)"
  attribute_condition = join(" && ", [
    "assertion.repository_id == '${var.github_repository_id}'",
    "assertion.repository_owner_id == '${var.github_repository_owner_id}'",
    "assertion.environment in ['infra-dev', 'production']",
  ])

  attribute_mapping = {
    "google.subject"          = "assertion.sub"
    "attribute.repository_id" = "assertion.repository_id"
    "attribute.environment"   = "assertion.environment"
    "attribute.ref"           = "assertion.ref"
    "attribute.actor"         = "assertion.actor"
  }

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

# terraform-agent was created by hand (infra/MANUAL.md), so it is referenced by email.
resource "google_service_account_iam_member" "terraform_wif" {
  service_account_id = "projects/${google_project.admin.project_id}/serviceAccounts/${var.terraform_service_account_email}"
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository_id/${var.github_repository_id}"
}
