# Project, APIs, Firebase and the web app registration.

terraform {
  required_version = ">= 1.9"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 8.5"
      # google.billing sets a quota project, which the Billing Budgets API requires.
      configuration_aliases = [google.billing]
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = ">= 8.5"
    }
    time = {
      source  = "hashicorp/time"
      version = ">= 0.14"
    }
  }
}

locals {
  labels = {
    app = "materia"
    env = var.env
  }

  services = [
    "firestore.googleapis.com",
    "firebasestorage.googleapis.com",
    "identitytoolkit.googleapis.com",
    "cloudfunctions.googleapis.com",
    "run.googleapis.com",
    "cloudbuild.googleapis.com",
    "artifactregistry.googleapis.com",
    "eventarc.googleapis.com",
    "pubsub.googleapis.com",
    "cloudtasks.googleapis.com",
    "cloudscheduler.googleapis.com",
    "secretmanager.googleapis.com",
    "cloudkms.googleapis.com",
    "firebaseappcheck.googleapis.com",
    "recaptchaenterprise.googleapis.com",
    "firebasehosting.googleapis.com",
    "firebaseremoteconfig.googleapis.com",
    "aiplatform.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
    # Required by the resources in this module.
    "firebase.googleapis.com",
    "firebaserules.googleapis.com",
    "serviceusage.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "iam.googleapis.com",
    "storage.googleapis.com",
    "cloudbilling.googleapis.com",
    "billingbudgets.googleapis.com",
  ]
}

resource "google_project" "this" {
  project_id      = var.project_id
  name            = "Materia v2 ${var.env}"
  billing_account = var.billing_account
  org_id          = var.folder_id == null ? var.org_id : null
  folder_id       = var.folder_id
  labels          = local.labels
  # Serverless only (Functions, Run, Firestore): no default VPC network.
  auto_create_network = false
  # Prod is never destroyed by Terraform; dev can be torn down.
  deletion_policy = var.deletion_protection ? "ABANDON" : "DELETE"
}

resource "google_project_service" "this" {
  for_each = toset(local.services)

  project            = google_project.this.project_id
  service            = each.value
  disable_on_destroy = false
}

# Some APIs take minutes to become usable after enablement.
resource "time_sleep" "services_ready" {
  create_duration = "90s"
  depends_on      = [google_project_service.this]
}

# Cloud Audit Logs: admin and data access for every service. Client data is confidential and
# privileged, so reads and writes to Firestore and Storage are attributable (Security doc).
resource "google_project_iam_audit_config" "all" {
  project = google_project.this.project_id
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

resource "google_firebase_project" "this" {
  provider   = google-beta
  project    = google_project.this.project_id
  depends_on = [time_sleep.services_ready]
}

resource "google_firebase_web_app" "web" {
  provider        = google-beta
  project         = google_firebase_project.this.project
  display_name    = "Materia web (${var.env})"
  deletion_policy = var.deletion_protection ? "ABANDON" : "DELETE"
}

data "google_firebase_web_app_config" "web" {
  provider   = google-beta
  project    = google_firebase_project.this.project
  web_app_id = google_firebase_web_app.web.app_id
}
