# Service accounts and least-privilege IAM (Environments, CI/CD & release).

resource "google_service_account" "deployer" {
  project      = google_project.this.project_id
  account_id   = "deployer"
  display_name = "GitHub deployer (Workload Identity Federation)"
  depends_on   = [time_sleep.services_ready]
}

resource "google_service_account" "fn_runtime" {
  project      = google_project.this.project_id
  account_id   = "fn-runtime"
  display_name = "Cloud Functions runtime"
  depends_on   = [time_sleep.services_ready]
}

resource "google_service_account" "jobs_runtime" {
  project      = google_project.this.project_id
  account_id   = "jobs-runtime"
  display_name = "Cloud Run jobs runtime"
  depends_on   = [time_sleep.services_ready]
}

resource "google_service_account" "migration_runner" {
  count        = var.enable_migration_runner ? 1 : 0
  project      = google_project.this.project_id
  account_id   = "migration-runner"
  display_name = "Legacy migration runner (MIG-*)"
  depends_on   = [time_sleep.services_ready]
}

locals {
  # Deploys hosting, functions, rules and indexes. Firebase Admin is deliberately not granted;
  # FND-05 adds narrowly-scoped roles if a deploy step needs more.
  deployer_roles = [
    "roles/cloudfunctions.developer",
    "roles/run.developer",
    "roles/firebasehosting.admin",
    "roles/datastore.indexAdmin",
    "roles/firebaserules.admin",
    "roles/eventarc.developer",
    "roles/cloudscheduler.admin",
    "roles/secretmanager.viewer",
    "roles/serviceusage.serviceUsageConsumer",
    "roles/artifactregistry.writer",
  ]

  fn_runtime_roles = [
    "roles/datastore.user",
    "roles/firebaseauth.admin", # custom-claims sync (FND-17)
    "roles/cloudtasks.enqueuer",
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
    "roles/aiplatform.user", # embeddings (ADR-012)
    "roles/eventarc.eventReceiver", # trigger service account for Firestore and Auth event functions
  ]

  jobs_runtime_roles = [
    "roles/datastore.user",
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
  ]
}

resource "google_project_iam_member" "deployer" {
  for_each = toset(local.deployer_roles)
  project  = google_project.this.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_project_iam_member" "fn_runtime" {
  for_each = toset(local.fn_runtime_roles)
  project  = google_project.this.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.fn_runtime.email}"
}

resource "google_project_iam_member" "jobs_runtime" {
  for_each = toset(local.jobs_runtime_roles)
  project  = google_project.this.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.jobs_runtime.email}"
}

# The deployer may act as the runtime service accounts, and only those.
resource "google_service_account_iam_member" "deployer_acts_as" {
  for_each = {
    fn   = google_service_account.fn_runtime.name
    jobs = google_service_account.jobs_runtime.name
  }
  service_account_id = each.value
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer.email}"
}

# firebase-tools checks actAs on the App Engine default account before every functions deploy, even
# though all functions run as fn-runtime (apps/functions/src/global-options.ts). The account holds
# no roles in our projects (the Editor role Google grants it is removed, see ADR-021 and
# infra/MANUAL.md), so this lets the deploy proceed without giving the deployer any extra reach.
resource "google_service_account_iam_member" "deployer_acts_as_app_engine_default" {
  service_account_id = "projects/${google_project.this.project_id}/serviceAccounts/${google_project.this.project_id}@appspot.gserviceaccount.com"
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer.email}"
  depends_on         = [google_firebase_project.this]
}

# Gen2 functions are built by Cloud Build as the Compute default account, and the Functions API
# requires the caller to act as it when creating a function. firebase-tools (15.x) has no option for
# a different build account. Google grants that account roles/editor, so the Editor role is removed
# (ADR-022, infra/MANUAL.md) and it keeps only what a build needs.
locals {
  compute_default_sa = "${google_project.this.number}-compute@developer.gserviceaccount.com"
}

resource "google_service_account_iam_member" "deployer_acts_as_compute_default" {
  service_account_id = "projects/${google_project.this.project_id}/serviceAccounts/${local.compute_default_sa}"
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer.email}"
  depends_on         = [time_sleep.services_ready]
}

resource "google_project_iam_member" "compute_default_builder" {
  #checkov:skip=CKV_GCP_46:Gen2 function builds run as the Compute default account and firebase-tools cannot choose another; it is cut down from Editor to this one role (ADR-022).
  #checkov:skip=CKV_GCP_49:cloudbuild.builds.builder is the minimum role for those builds; the deployer can act as this account only, which is why Editor was removed.
  project    = google_project.this.project_id
  role       = "roles/cloudbuild.builds.builder"
  member     = "serviceAccount:${local.compute_default_sa}"
  depends_on = [time_sleep.services_ready]
}

# Functions sign download URLs as themselves (CORE-12).
resource "google_service_account_iam_member" "fn_runtime_sign_self" {
  service_account_id = google_service_account.fn_runtime.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.fn_runtime.email}"
}

resource "google_storage_bucket_iam_member" "fn_runtime_files" {
  bucket = google_storage_bucket.default.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.fn_runtime.email}"
}

resource "google_storage_bucket_iam_member" "jobs_runtime_files" {
  bucket = google_storage_bucket.default.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.jobs_runtime.email}"
}

resource "google_kms_crypto_key_iam_member" "fn_runtime_oauth_tokens" {
  crypto_key_id = google_kms_crypto_key.oauth_tokens.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${google_service_account.fn_runtime.email}"
}

resource "google_secret_manager_secret_iam_member" "fn_runtime" {
  for_each  = google_secret_manager_secret.this
  project   = google_project.this.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.fn_runtime.email}"
}

# migration-runner: Firestore writes and the migration bucket, nothing else.
resource "google_project_iam_member" "migration_runner_firestore" {
  count   = var.enable_migration_runner ? 1 : 0
  project = google_project.this.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.migration_runner[0].email}"
}

resource "google_storage_bucket_iam_member" "migration_runner_bucket" {
  count  = var.enable_migration_runner ? 1 : 0
  bucket = google_storage_bucket.migration.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.migration_runner[0].email}"
}

resource "google_kms_crypto_key_iam_member" "migration_runner_key" {
  count         = var.enable_migration_runner ? 1 : 0
  crypto_key_id = google_kms_crypto_key.migration.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${google_service_account.migration_runner[0].email}"
}
