output "project_id" {
  description = "The environment's GCP/Firebase project id."
  value       = google_project.this.project_id
}

output "project_number" {
  description = "Project number (used in WIF principal names)."
  value       = google_project.this.number
}

output "web_app_config" {
  description = "Firebase web config (not secret). tools/scripts env writes it into apps/web/src/environments."
  value = jsonencode({
    projectId         = google_project.this.project_id
    appId             = google_firebase_web_app.web.app_id
    apiKey            = data.google_firebase_web_app_config.web.api_key
    authDomain        = data.google_firebase_web_app_config.web.auth_domain
    storageBucket     = google_storage_bucket.default.name
    messagingSenderId = data.google_firebase_web_app_config.web.messaging_sender_id
    measurementId     = try(data.google_firebase_web_app_config.web.measurement_id, null)
  })
}

output "wif_provider" {
  description = "Full Workload Identity provider name for google-github-actions/auth."
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "deployer_sa" {
  description = "Deployer service account email for google-github-actions/auth."
  value       = google_service_account.deployer.email
}

output "fn_runtime_sa" {
  description = "Default Cloud Functions runtime service account."
  value       = google_service_account.fn_runtime.email
}

output "jobs_runtime_sa" {
  description = "Cloud Run jobs runtime service account."
  value       = google_service_account.jobs_runtime.email
}

output "buckets" {
  description = "Bucket names by purpose."
  value = {
    files     = google_storage_bucket.default.name
    backups   = google_storage_bucket.backups.name
    migration = google_storage_bucket.migration.name
  }
}
