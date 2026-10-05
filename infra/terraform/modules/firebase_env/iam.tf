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
    "roles/firebaseauth.admin", # registers the auth blocking functions (Identity Toolkit config) on deploy
    "roles/eventarc.developer",
    "roles/cloudtasks.queueAdmin", # task queue functions: firebase-tools creates and updates their queues
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
    "roles/aiplatform.user",              # embeddings (ADR-012)
    "roles/eventarc.eventReceiver",       # trigger service account for Firestore and Auth event functions
    "roles/run.invoker",                  # starts Cloud Run job executions with overrides (FND-24)
    "roles/firebasecloudmessaging.admin", # sends push notifications (FND-20)
    "roles/datastore.importExportAdmin",  # the nightly Firestore export, backups-exportFirestore (SEC-03)
  ]

  jobs_runtime_roles = [
    "roles/datastore.user",
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
  ]
}

# firebase-tools sets the invoker policy on each function's Cloud Run service (public for blocking
# functions, the runtime account for others). roles/run.developer can read that policy but not set it,
# and roles/run.admin grants far more, so this custom role holds only the missing permissions (ADR-023).
# Before creating a new HTTPS function the CLI also checks cloudfunctions.functions.setIamPolicy on the
# project and stops without it (roles/cloudfunctions.developer lacks it).
resource "google_project_iam_custom_role" "deployer_run_invoker" {
  project     = google_project.this.project_id
  role_id     = "deployerRunInvoker"
  title       = "Deployer: set Cloud Run invoker policy"
  description = "Lets the deployer set the invoker IAM policy on Cloud Run services created for functions."
  permissions = ["run.services.setIamPolicy", "cloudfunctions.functions.setIamPolicy"]
  depends_on  = [time_sleep.services_ready]
}

resource "google_project_iam_member" "deployer_run_invoker" {
  project = google_project.this.project_id
  role    = google_project_iam_custom_role.deployer_run_invoker.id
  member  = "serviceAccount:${google_service_account.deployer.email}"
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

# Functions enqueue Cloud Tasks for their own task-queue functions (documents-rescan,
# documents-render, notifications-deliver, …). The Admin SDK puts an OIDC token for the runtime
# account on each task, and Cloud Tasks only accepts that from a caller who may act as it.
resource "google_service_account_iam_member" "fn_runtime_act_as_self" {
  service_account_id = google_service_account.fn_runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.fn_runtime.email}"
}

# documents-onUpload is a Cloud Storage trigger (CORE-12): Eventarc receives the bucket's
# notifications through Pub/Sub, so the Cloud Storage service agent must be able to publish.
resource "google_project_iam_member" "gcs_eventarc_publisher" {
  project = google_project.this.project_id
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${data.google_storage_project_service_account.gcs.email_address}"
}

# firebase-tools reads the files bucket's location when it deploys the documents-onUpload Storage
# trigger ("Can't find the storage bucket region" otherwise). No predefined role holds only
# storage.buckets.get, so this custom role grants just that, on the files bucket only.
resource "google_project_iam_custom_role" "deployer_bucket_reader" {
  project     = google_project.this.project_id
  role_id     = "deployerBucketReader"
  title       = "Deployer: read bucket metadata"
  description = "Lets the deployer read the files bucket's location when deploying Storage-triggered functions."
  permissions = ["storage.buckets.get"]
  depends_on  = [time_sleep.services_ready]
}

# Cloud Storage rejects a custom role created seconds earlier ("does not exist in the resource's
# hierarchy"), so the binding waits for the new role to propagate.
resource "time_sleep" "deployer_bucket_reader_ready" {
  create_duration = "60s"
  depends_on      = [google_project_iam_custom_role.deployer_bucket_reader]
}

resource "google_storage_bucket_iam_member" "deployer_files_bucket_reader" {
  bucket     = google_storage_bucket.default.name
  role       = google_project_iam_custom_role.deployer_bucket_reader.id
  member     = "serviceAccount:${google_service_account.deployer.email}"
  depends_on = [time_sleep.deployer_bucket_reader_ready]
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

# Clerk evals (AI-12): the clerk-evals workflow reads the eval-only Anthropic key from
# ANTHROPIC_API_KEY as the deployer, on dev only. This secret and no other.
resource "google_secret_manager_secret_iam_member" "deployer_clerk_evals_key" {
  count     = var.env == "dev" ? 1 : 0
  project   = google_project.this.project_id
  secret_id = google_secret_manager_secret.this["ANTHROPIC_API_KEY"].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.deployer.email}"
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
