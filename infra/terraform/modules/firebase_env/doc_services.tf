# Document services on Cloud Run (CORE-12a, ADR-028): the ClamAV scan service `clamav` and the
# Office/HEIC preview service `preview`. deploy.yml builds their images into the `services`
# repository and deploys them (private, no unauthenticated access) as these runtime accounts; the
# functions runtime calls them with ID tokens (it already holds roles/run.invoker on the project).
# Neither service needs any project role: they get bytes over HTTP and answer bytes.

resource "google_service_account" "clamav_runtime" {
  project      = google_project.this.project_id
  account_id   = "clamav-runtime"
  display_name = "ClamAV scan service runtime (CORE-12a)"
  depends_on   = [time_sleep.services_ready]
}

resource "google_service_account" "preview_runtime" {
  project      = google_project.this.project_id
  account_id   = "preview-runtime"
  display_name = "Preview service runtime (CORE-12a)"
  depends_on   = [time_sleep.services_ready]
}

# The deployer deploys the services as these accounts, and may act as nothing else new.
resource "google_service_account_iam_member" "deployer_acts_as_doc_services" {
  for_each = {
    clamav  = google_service_account.clamav_runtime.name
    preview = google_service_account.preview_runtime.name
  }
  service_account_id = each.value
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_artifact_registry_repository" "services" {
  #checkov:skip=CKV_GCP_84:Service images contain code and public virus signatures only, no client data; Google-managed encryption is sufficient.
  project       = google_project.this.project_id
  location      = var.region
  repository_id = "services"
  format        = "DOCKER"
  description   = "Cloud Run service images: ClamAV scanner and previews (CORE-12a)"
  labels        = local.labels

  # The scanner is rebuilt daily for fresh signatures: keep the last few images, drop the rest.
  cleanup_policy_dry_run = false
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 5
    }
  }
  cleanup_policies {
    id     = "delete-old"
    action = "DELETE"
    condition {
      tag_state  = "ANY"
      older_than = "1209600s" # 14 days
    }
  }

  depends_on = [time_sleep.services_ready]
}
