# Private web sourcemaps (FND-21). deploy.yml uploads each release's hidden maps to
# web/<sha>/ and never serves them; `materia-scripts decode-stack` reads them to deobfuscate stacks
# from Error Reporting.
resource "google_storage_bucket" "sourcemaps" {
  #checkov:skip=CKV_GCP_62:Object access is captured by Cloud Audit Logs (DATA_READ/DATA_WRITE on allServices).
  #checkov:skip=CKV_GCP_78:Sourcemaps are rebuilt from the tagged commit; versioning adds nothing.
  project                     = var.project_id
  name                        = "${var.project_id}-sourcemaps"
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = !var.deletion_protection
  labels                      = var.labels

  lifecycle_rule {
    condition {
      age = var.sourcemap_retention_days
    }
    action {
      type = "Delete"
    }
  }
}

# objectUser (not objectCreator): re-running a deploy for the same commit overwrites its maps.
resource "google_storage_bucket_iam_member" "deployer_sourcemaps" {
  bucket = google_storage_bucket.sourcemaps.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${var.deployer_sa}"
}

# system-logClientError's per-session rate-limit docs expire a day after their minute.
resource "google_firestore_field" "client_error_limits_ttl" {
  project    = var.project_id
  database   = "(default)"
  collection = "clientErrorLimits"
  field      = "expiresAt"

  ttl_config {}
  # No single-field indexes: the docs are only read by id.
  index_config {}
}

# Error Reporting's API (its console page and `gcloud beta error-reporting`); ingestion from the
# ERROR log entries works without it.
resource "google_project_service" "error_reporting" {
  project            = var.project_id
  service            = "clouderrorreporting.googleapis.com"
  disable_on_destroy = false
}
