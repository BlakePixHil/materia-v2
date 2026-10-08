# One Firebase environment per state prefix (FND-03). Usage:
#   terraform init -backend-config=envs/dev.backend.hcl
#   terraform plan -var-file=envs/dev.tfvars
# MVP mode: dev and prod only; staging is deferred (envs/staging.tfvars is kept for later).

# Quota project: APIs such as Firebase Management, Identity Toolkit and KMS need one. Without it a
# service-account caller is billed to its own (admin) project, where they're disabled. Pinning
# billing_project covers resources that ignore user_project_override; it assumes the project
# exists, so a brand-new environment is created first (see README).
provider "google" {
  region                = var.region
  billing_project       = var.project_id
  user_project_override = true
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
  region                = var.region
  billing_project       = var.project_id
  user_project_override = true
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
  restrict_deploys_to_releases = var.restrict_deploys_to_releases
  enable_migration_runner      = var.enable_migration_runner
  container_scanning           = var.container_scanning
  deletion_protection          = var.deletion_protection
  budget_amount                = var.budget_amount
  budget_currency              = var.budget_currency
  budget_alert_emails          = var.budget_alert_emails
  custom_domain                = var.custom_domain
}

# Observability (FND-21): log-based metrics, alerts, uptime checks, the Ops overview dashboard and
# the private sourcemaps bucket.
module "monitoring" {
  source = "./modules/monitoring"

  env                   = var.env
  project_id            = module.env.project_id
  region                = var.region
  notification_channels = module.env.alert_channels
  deployer_sa           = module.env.deployer_sa
  deletion_protection   = var.deletion_protection
  labels = {
    app = "materia"
    env = var.env
  }
}
