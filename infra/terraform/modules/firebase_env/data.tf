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

  # SEC-03: a deleted or overwritten object can be brought back for 30 days from soft delete, and
  # for 90 days as a non-current version (docs/runbooks/restore.md). Matter destruction (CORE-19)
  # deletes every generation; soft delete still holds those bytes for 30 days.
  soft_delete_policy {
    retention_duration_seconds = var.files_soft_delete_days * 86400
  }

  lifecycle_rule {
    condition {
      days_since_noncurrent_time = var.files_noncurrent_days
      with_state                 = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }

  # The web app reads document bytes (PDF.js, text and email previews) with fetch() from 5-minute
  # signed URLs (`documents-getDownloadUrl`, CORE-12), which are cross-origin reads of this bucket.
  # Reads only, from the app's own origins; uploads go through Firebase Storage, which has its own
  # CORS. Range headers let PDF.js fetch large PDFs a part at a time.
  cors {
    origin = concat(
      ["https://${var.project_id}.web.app", "https://${var.project_id}.firebaseapp.com"],
      [for domain in var.auth_authorized_domains : "https://${domain}"],
    )
    method          = ["GET", "HEAD"]
    response_header = ["Content-Type", "Content-Length", "Content-Range", "Content-Disposition", "Accept-Ranges", "Range"]
    max_age_seconds = 3600
  }

  depends_on = [time_sleep.services_ready]
}

resource "google_firebase_storage_bucket" "default" {
  provider  = google-beta
  project   = google_firebase_project.this.project
  bucket_id = google_storage_bucket.default.name
}

# Backups in the backup region (SEC-03, backups.tf): the nightly Firestore exports under daily/ and
# monthly/, and the nightly copy of the files bucket under files/.
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

  # Exports are never overwritten, so their non-current versions are the ones the rules above
  # expired; drop them a week later.
  lifecycle_rule {
    condition {
      days_since_noncurrent_time = 7
      with_state                 = "ARCHIVED"
      matches_prefix             = ["daily/", "monthly/"]
    }
    action {
      type = "Delete"
    }
  }

  # The files copy mirrors deletions (a destroyed matter's documents leave the copy the next night),
  # so what the copy deleted or overwrote stays restorable as a non-current version for as long as
  # the daily exports are kept.
  lifecycle_rule {
    condition {
      days_since_noncurrent_time = var.backup_daily_retention_days
      with_state                 = "ARCHIVED"
      matches_prefix             = ["files/"]
    }
    action {
      type = "Delete"
    }
  }

  depends_on = [time_sleep.services_ready]
}

# Where the nightly Firestore export lands first (SEC-03, backups.tf). Firestore exports to and
# imports from buckets in the database's own region only, so the export is written here and Storage
# Transfer copies it into the backups bucket in the backup region. Imports (the drill, a restore)
# read from here; an export older than this bucket keeps is copied back from the backups bucket
# first (docs/runbooks/restore.md).
resource "google_storage_bucket" "exports" {
  #checkov:skip=CKV_GCP_62:Object access is captured by Cloud Audit Logs (DATA_READ/DATA_WRITE on allServices).
  #checkov:skip=CKV_GCP_78:Short-lived staging copies; the versioned copy is the backups bucket.
  project                     = google_project.this.project_id
  name                        = "${var.project_id}-exports"
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = !var.deletion_protection
  labels                      = local.labels

  lifecycle_rule {
    condition {
      age = var.export_staging_retention_days
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
