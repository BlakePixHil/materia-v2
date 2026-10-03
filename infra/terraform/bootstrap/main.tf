# Bootstrap: an admin project and the Terraform state bucket (FND-03).
# Run once, by the owner or a service account with Project Creator + Billing User.

provider "google" {
  region = var.region
  default_labels = {
    app = "materia"
    env = "admin"
  }
}

resource "google_project" "admin" {
  project_id          = var.admin_project_id
  name                = "Materia v2 admin"
  billing_account     = var.billing_account
  org_id              = var.folder_id == null ? var.org_id : null
  folder_id           = var.folder_id
  deletion_policy     = "PREVENT"
  auto_create_network = false
}

# Admin and data-access audit logs for every service (who read or changed Terraform state).
resource "google_project_iam_audit_config" "admin" {
  project = google_project.admin.project_id
  service = "allServices"

  audit_log_config {
    log_type = "ADMIN_READ"
  }
  audit_log_config {
    log_type = "DATA_READ"
  }
  audit_log_config {
    log_type = "DATA_WRITE"
  }
}

resource "google_project_service" "admin" {
  for_each = toset([
    "storage.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "cloudbilling.googleapis.com",
    "billingbudgets.googleapis.com",
    "serviceusage.googleapis.com",
    "iam.googleapis.com",
  ])

  project            = google_project.admin.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_storage_bucket" "tfstate" {
  #checkov:skip=CKV_GCP_62:Object access is captured by Cloud Audit Logs (DATA_READ/DATA_WRITE on allServices).
  project                     = google_project.admin.project_id
  name                        = "materia-tfstate-${var.state_bucket_suffix}"
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  versioning {
    enabled = true
  }

  # Keep 30 days of superseded state versions.
  lifecycle_rule {
    condition {
      days_since_noncurrent_time = 30
      with_state                 = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }

  depends_on = [google_project_service.admin]
}
