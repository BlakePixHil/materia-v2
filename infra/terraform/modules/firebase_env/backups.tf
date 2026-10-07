# Backups and disaster recovery (SEC-03; restore steps in docs/runbooks/restore.md).
#
# Firestore has three independent layers:
#   1. point-in-time recovery, 7 days at one-minute granularity (data.tf, FND-03);
#   2. managed backups, in the database's region: daily for 7 days and weekly (Sunday) for 14 weeks,
#      the longest Firestore allows for each;
#   3. a nightly export (the functions' scheduled backups-exportFirestore) to the exports bucket in
#      the database's region (Firestore exports only there), which Storage Transfer copies into the
#      backups bucket in var.backup_region: daily/ kept 35 days and, on the 1st of each month,
#      monthly/ kept 400.
# Storage: the files bucket keeps soft-deleted objects 30 days and non-current versions 90 (data.tf),
# and Storage Transfer copies it nightly into the backups bucket under files/.

resource "google_firestore_backup_schedule" "daily" {
  project   = google_project.this.project_id
  database  = google_firestore_database.default.name
  retention = "${var.firestore_daily_backup_retention_days * 86400}s"

  daily_recurrence {}
}

resource "google_firestore_backup_schedule" "weekly" {
  project   = google_project.this.project_id
  database  = google_firestore_database.default.name
  retention = "${var.firestore_weekly_backup_retention_weeks * 7 * 86400}s"

  weekly_recurrence {
    day = "SUNDAY"
  }
}

# The export runs as fn-runtime (roles/datastore.importExportAdmin in iam.tf). Firestore's own
# service agent writes the files; it can reach a bucket in its own project without a grant. The
# caller needs to read the bucket and create objects, never delete them.
resource "google_storage_bucket_iam_member" "fn_runtime_exports" {
  for_each = toset(["roles/storage.legacyBucketReader", "roles/storage.objectCreator"])

  bucket = google_storage_bucket.exports.name
  role   = each.value
  member = "serviceAccount:${google_service_account.fn_runtime.email}"
}

# Nightly copy of the files bucket (document bytes) into the backup region, as Coldline. It mirrors
# deletions, so a destroyed matter's documents leave the copy too; what it removes or overwrites
# stays restorable as a non-current version for var.backup_daily_retention_days (data.tf).
# Storage Transfer is enabled by this ticket, after services_ready first ran: give the new API time
# to propagate before asking it for its service agent (which also creates the agent).
resource "time_sleep" "storagetransfer_ready" {
  create_duration = "60s"
  depends_on      = [google_project_service.this["storagetransfer.googleapis.com"]]
}

data "google_storage_transfer_project_service_account" "sts" {
  project    = google_project.this.project_id
  depends_on = [time_sleep.storagetransfer_ready]
}

resource "google_storage_bucket_iam_member" "sts_files" {
  for_each = toset(["roles/storage.objectViewer", "roles/storage.legacyBucketReader"])

  bucket = google_storage_bucket.default.name
  role   = each.value
  member = "serviceAccount:${data.google_storage_transfer_project_service_account.sts.email}"
}

resource "google_storage_bucket_iam_member" "sts_exports" {
  for_each = toset(["roles/storage.objectViewer", "roles/storage.legacyBucketReader"])

  bucket = google_storage_bucket.exports.name
  role   = each.value
  member = "serviceAccount:${data.google_storage_transfer_project_service_account.sts.email}"
}

resource "google_storage_bucket_iam_member" "sts_backups" {
  for_each = toset(["roles/storage.objectViewer", "roles/storage.legacyBucketWriter"])

  bucket = google_storage_bucket.backups.name
  role   = each.value
  member = "serviceAccount:${data.google_storage_transfer_project_service_account.sts.email}"
}

resource "google_storage_transfer_job" "files_backup" {
  project     = google_project.this.project_id
  description = "Nightly copy of ${google_storage_bucket.default.name} to ${google_storage_bucket.backups.name}/files (SEC-03)"

  transfer_spec {
    gcs_data_source {
      bucket_name = google_storage_bucket.default.name
    }
    gcs_data_sink {
      bucket_name = google_storage_bucket.backups.name
      path        = "files/"
    }
    transfer_options {
      overwrite_when                = "DIFFERENT"
      delete_objects_unique_in_sink = true
      metadata_options {
        storage_class = "STORAGE_CLASS_COLDLINE"
      }
    }
  }

  # 15:30 UTC: 02:30 in Melbourne in summer, 01:30 in winter, after the 02:00 Firestore export.
  schedule {
    schedule_start_date {
      year  = 2026
      month = 10
      day   = 6
    }
    start_time_of_day {
      hours   = 15
      minutes = 30
      seconds = 0
      nanos   = 0
    }
    repeat_interval = "86400s"
  }

  logging_config {
    log_actions       = ["COPY", "DELETE"]
    log_action_states = ["FAILED"]
  }

  depends_on = [google_storage_bucket_iam_member.sts_files, google_storage_bucket_iam_member.sts_backups]
}

# Nightly copy of the Firestore exports into the backup region. The export starts at 15:00 UTC and
# takes minutes; an export still being written is skipped by the age condition and copied the next
# night. It never deletes from the backups bucket, whose lifecycle rules expire daily/ and monthly/.
resource "google_storage_transfer_job" "exports_backup" {
  project     = google_project.this.project_id
  description = "Nightly copy of ${google_storage_bucket.exports.name} to ${google_storage_bucket.backups.name} (SEC-03)"

  transfer_spec {
    gcs_data_source {
      bucket_name = google_storage_bucket.exports.name
    }
    gcs_data_sink {
      bucket_name = google_storage_bucket.backups.name
    }
    object_conditions {
      include_prefixes                         = ["daily/", "monthly/"]
      min_time_elapsed_since_last_modification = "1800s"
    }
    transfer_options {
      overwrite_when = "DIFFERENT"
    }
  }

  # 16:00 UTC: an hour after the export starts.
  schedule {
    schedule_start_date {
      year  = 2026
      month = 10
      day   = 7
    }
    start_time_of_day {
      hours   = 16
      minutes = 0
      seconds = 0
      nanos   = 0
    }
    repeat_interval = "86400s"
  }

  logging_config {
    log_actions       = ["COPY"]
    log_action_states = ["FAILED"]
  }

  depends_on = [google_storage_bucket_iam_member.sts_exports, google_storage_bucket_iam_member.sts_backups]
}

# A failed copy or delete in either nightly copy (FND-21 email channel). The Firestore export
# alerts through the monitoring module's scheduled-job check (backups-exportFirestore).
resource "google_monitoring_alert_policy" "files_backup_failed" {
  project      = google_project.this.project_id
  display_name = "Backup copy failed (${var.env})"
  combiner     = "OR"

  conditions {
    display_name = "Storage Transfer logged a failed action"
    condition_matched_log {
      filter = "resource.type=\"storage_transfer_job\" AND severity>=ERROR"
    }
  }

  alert_strategy {
    notification_rate_limit {
      period = "3600s"
    }
    auto_close = "86400s"
  }

  notification_channels = [for c in google_monitoring_notification_channel.budget_email : c.id]

  documentation {
    mime_type = "text/markdown"
    content   = "A nightly copy into the backups bucket (Storage Transfer job `${google_storage_transfer_job.files_backup.name}` for the files bucket, or `${google_storage_transfer_job.exports_backup.name}` for the Firestore exports) failed on some objects. Open the job in the console (Data transfer → Storage Transfer Service) for the operation's errors, fix the cause (usually IAM on either bucket) and run the job again. Runbook: docs/runbooks/restore.md."
  }

  user_labels = local.labels
}
