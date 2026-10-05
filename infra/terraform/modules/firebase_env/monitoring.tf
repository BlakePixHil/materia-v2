# "Reminders not running" (CORE-11). reminders-dispatch runs every 15 minutes, logs "ok" after each
# run and writes heartbeats/reminders-dispatch. When no run has logged "ok" for an hour, this opens
# an incident and emails the budget alert addresses. FND-21 brings the rest of the ops alerting.

resource "google_logging_metric" "reminders_dispatch_ok" {
  project = google_project.this.project_id
  name    = "reminders_dispatch_ok"
  filter  = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"reminders-dispatch\" AND jsonPayload.message=\"ok\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }

  depends_on = [time_sleep.services_ready]
}

resource "google_monitoring_alert_policy" "reminders_not_running" {
  project      = google_project.this.project_id
  display_name = "Reminders not running (${var.env})"
  combiner     = "OR"

  conditions {
    display_name = "No reminders-dispatch run for an hour"
    condition_absent {
      filter   = "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.reminders_dispatch_ok.name}\""
      duration = "3600s"
      aggregations {
        alignment_period   = "900s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }

  notification_channels = [for c in google_monitoring_notification_channel.budget_email : c.id]

  documentation {
    mime_type = "text/markdown"
    content   = "reminders-dispatch hasn't finished a run for an hour, so deadline reminders and escalations aren't going out. Check its logs in Cloud Run and `heartbeats/reminders-dispatch` in Firestore (lastRunAt, lastOkAt, failed). When it runs again it catches up: each missed reminder goes out once, marked late."
  }

  user_labels = local.labels
}
