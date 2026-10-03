# Firestore and Storage. Everything regional lives in var.region; backups in var.backup_region.

resource "google_firestore_database" "default" {
  project                           = google_project.this.project_id
  name                              = "(default)"
  location_id                       = var.region
  type                              = "FIRESTORE_NATIVE"
  concurrency_mode                  = "PESSIMISTIC"
  point_in_time_recovery_enablement = var.pitr_enabled ? "POINT_IN_TIME_RECOVERY_ENABLED" : "POINT_IN_TIME_RECOVERY_DISABLED"
  delete_protection_state           = var.deletion_protection ? "DELETE_PROTECTION_ENABLED" : "DELETE_PROTECTION_DISABLED"
  deletion_policy                   = var.deletion_protection ? "ABANDON" : "DELETE"

  depends_on = [google_firebase_project.this]
}

# Default Firebase Storage bucket: a regional bucket linked to Firebase.
resource "google_storage_bucket" "default" {
  #checkov:skip=CKV_GCP_62:Object access is captured by Cloud Audit Logs (DATA_READ/DATA_WRITE on allServices).
  project                     = google_project.this.project_id
  name                        = "${var.project_id}-files"
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = !var.deletion_protection
  labels                      = local.labels

  versioning {
    enabled = true
  }

  depends_on = [time_sleep.services_ready]
}

resource "google_firebase_storage_bucket" "default" {
  provider  = google-beta
  project   = google_firebase_project.this.project
  bucket_id = google_storage_bucket.default.name
}

# Backups (Firestore exports, Storage copies) in the backup region (SEC-03 schedules the exports).
resource "google_storage_bucket" "backups" {
  #checkov:skip=CKV_GCP_62:Object access is captured by Cloud Audit Logs (DATA_READ/DATA_WRITE on allServices).
  project                     = google_project.this.project_id
  name                        = "${var.project_id}-backups"
  location                    = var.backup_region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = !var.deletion_protection
  labels                      = local.labels

  versioning {
    enabled = true
  }

  lifecycle_rule {
    condition {
      age            = var.backup_daily_retention_days
      matches_prefix = ["daily/"]
    }
    action {
      type = "Delete"
    }
  }

  lifecycle_rule {
    condition {
      age            = var.backup_monthly_retention_days
      matches_prefix = ["monthly/"]
    }
    action {
      type = "Delete"
    }
  }

  lifecycle_rule {
    condition {
      days_since_noncurrent_time = 7
      with_state                 = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }

  depends_on = [time_sleep.services_ready]
}

# Legacy migration working area (MIG-02): CMEK-encrypted, short-lived.
data "google_storage_project_service_account" "gcs" {
  project    = google_project.this.project_id
  depends_on = [time_sleep.services_ready]
}

resource "google_kms_crypto_key_iam_member" "gcs_migration" {
  crypto_key_id = google_kms_crypto_key.migration.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${data.google_storage_project_service_account.gcs.email_address}"
}

resource "google_storage_bucket" "migration" {
  #checkov:skip=CKV_GCP_62:Object access is captured by Cloud Audit Logs (DATA_READ/DATA_WRITE on allServices).
  project                     = google_project.this.project_id
  name                        = "${var.project_id}-migration"
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = !var.deletion_protection
  labels                      = local.labels

  encryption {
    default_kms_key_name = google_kms_crypto_key.migration.id
  }

  versioning {
    enabled = true
  }

  lifecycle_rule {
    condition {
      days_since_noncurrent_time = 7
      with_state                 = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }

  lifecycle_rule {
    condition {
      age = var.migration_retention_days
    }
    action {
      type = "Delete"
    }
  }

  depends_on = [google_kms_crypto_key_iam_member.gcs_migration]
}

resource "google_artifact_registry_repository" "jobs" {
  #checkov:skip=CKV_GCP_84:Job images contain code only, no client data; Google-managed encryption is sufficient.
  project       = google_project.this.project_id
  location      = var.region
  repository_id = "jobs"
  format        = "DOCKER"
  description   = "Cloud Run job images (ADR-014)"
  labels        = local.labels

  depends_on = [time_sleep.services_ready]
}
