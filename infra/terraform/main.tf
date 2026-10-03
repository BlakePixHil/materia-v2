# One Firebase environment per state prefix (FND-03). Usage:
#   terraform init -backend-config=envs/dev.backend.hcl
#   terraform plan -var-file=envs/dev.tfvars
# MVP mode: dev and prod only; staging is deferred (envs/staging.tfvars is kept for later).

provider "google" {
  region = var.region
  default_labels = {
    app = "materia"
    env = var.env
  }
}

provider "google" {
  alias                 = "billing"
  region                = var.region
  billing_project       = var.admin_project_id
  user_project_override = true
}

provider "google-beta" {
  region = var.region
  default_labels = {
    app = "materia"
    env = var.env
  }
}

module "env" {
  source = "./modules/firebase_env"

  providers = {
    google         = google
    google.billing = google.billing
    google-beta    = google-beta
  }

  env                          = var.env
  project_id                   = var.project_id
  billing_account              = var.billing_account
  org_id                       = var.org_id
  folder_id                    = var.folder_id
  region                       = var.region
  backup_region                = var.backup_region
  github_repository            = var.github_repository
  restrict_deploys_to_releases = var.restrict_deploys_to_releases
  enable_migration_runner      = var.enable_migration_runner
  deletion_protection          = var.deletion_protection
  budget_amount                = var.budget_amount
  budget_currency              = var.budget_currency
  budget_alert_emails          = var.budget_alert_emails
}
