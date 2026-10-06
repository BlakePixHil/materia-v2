# Alert policies (FND-21). All email the budget alert addresses; Slack is descoped (one user, and
# email already reaches them). Thresholds are the ticket's; the runbook says what to do for each.

locals {
  job_runs = "logging_googleapis_com:user_${google_logging_metric.scheduled_job_runs.name}"
  runbook  = "Runbook: docs/runbooks/incident-response.md. Dashboard: Ops overview (${var.env})."
}

resource "google_monitoring_alert_policy" "callable_errors" {
  project      = var.project_id
  display_name = "Callable errors over 2% (${var.env})"
  combiner     = "OR"

  conditions {
    display_name = "Cloud Run 5xx over 2% of requests for 5 minutes"
    condition_threshold {
      filter             = "resource.type=\"cloud_run_revision\" AND metric.type=\"run.googleapis.com/request_count\" AND metric.labels.response_code_class=\"5xx\""
      denominator_filter = "resource.type=\"cloud_run_revision\" AND metric.type=\"run.googleapis.com/request_count\""
      comparison         = "COMPARISON_GT"
      threshold_value    = 0.02
      duration           = "0s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }
      denominator_aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }

  conditions {
    display_name = "INTERNAL callable errors over 2% of calls for 5 minutes"
    condition_threshold {
      filter             = "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.callable_calls.name}\" AND metric.labels.outcome=\"unhandled error\""
      denominator_filter = "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.callable_calls.name}\""
      comparison         = "COMPARISON_GT"
      threshold_value    = 0.02
      duration           = "0s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }
      denominator_aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }

  notification_channels = var.notification_channels
  documentation {
    mime_type = "text/markdown"
    content   = "Requests are failing. Open Error Reporting for the stack (web stacks: decode with `materia-scripts decode-stack`) and the Ops overview for which function. ${local.runbook}"
  }
  user_labels = var.labels
  depends_on  = [time_sleep.metrics_ready]
}

resource "google_monitoring_alert_policy" "callable_latency" {
  project      = var.project_id
  display_name = "Callable p95 latency over 3 s (${var.env})"
  combiner     = "OR"

  conditions {
    display_name = "p95 callable handler time over 3 s for 10 minutes"
    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.callable_latency.name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 3000
      duration        = "600s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_PERCENTILE_95"
      }
    }
  }

  notification_channels = var.notification_channels
  documentation {
    mime_type = "text/markdown"
    content   = "Callables are slow. Check the Ops overview's latency by function, Firestore operations and Cloud Run instance counts (cold starts). ${local.runbook}"
  }
  user_labels = var.labels
  depends_on  = [time_sleep.metrics_ready]
}

resource "google_monitoring_alert_policy" "uptime" {
  project      = var.project_id
  display_name = "Uptime check failing (${var.env})"
  combiner     = "OR"

  dynamic "conditions" {
    for_each = {
      "Hosting /health" = google_monitoring_uptime_check_config.hosting.uptime_check_id
      "system-ping"     = google_monitoring_uptime_check_config.ping.uptime_check_id
    }
    content {
      display_name = "${conditions.key} failing in 2 or more regions"
      condition_threshold {
        filter          = "resource.type=\"uptime_url\" AND metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.labels.check_id=\"${conditions.value}\""
        comparison      = "COMPARISON_GT"
        threshold_value = 1
        duration        = "300s"
        aggregations {
          alignment_period     = "1200s"
          per_series_aligner   = "ALIGN_NEXT_OLDER"
          cross_series_reducer = "REDUCE_COUNT_FALSE"
          group_by_fields      = ["resource.label.*"]
        }
      }
    }
  }

  notification_channels = var.notification_channels
  documentation {
    mime_type = "text/markdown"
    content   = "The site or the functions endpoint is down from several regions. Check https://${var.project_id}.web.app/health, the last deploy (rollback: docs/runbooks/rollback.md) and Google Cloud status. ${local.runbook}"
  }
  user_labels = var.labels
}

# A cost guard: the last hour's Firestore rate against the 24-hour average, with a floor so a quiet
# project doesn't alert on a handful of extra reads. PromQL policies with a retest window (duration)
# can't look back more than 1d1h, so the baseline is a day, not a week.
resource "google_monitoring_alert_policy" "firestore_spike" {
  # A PromQL policy takes one condition, so reads and writes are separate policies.
  for_each = { read = 2, write = 0.5 }

  project      = var.project_id
  display_name = "Firestore ${each.key}s over 3x the 24-hour baseline (${var.env})"
  combiner     = "OR"

  conditions {
    display_name = "Document ${each.key}s over 3x the 24-hour average (and over ${each.value}/s)"
    condition_prometheus_query_language {
      query               = <<-EOT
        sum(rate(firestore_googleapis_com:document_${each.key}_count{monitored_resource="firestore_instance"}[1h]))
          > 3 * sum(rate(firestore_googleapis_com:document_${each.key}_count{monitored_resource="firestore_instance"}[1d]))
        and sum(rate(firestore_googleapis_com:document_${each.key}_count{monitored_resource="firestore_instance"}[1h])) > ${each.value}
      EOT
      duration            = "900s"
      evaluation_interval = "300s"
    }
  }

  notification_channels = var.notification_channels
  documentation {
    mime_type = "text/markdown"
    content   = "Firestore usage jumped (cost guard). Look for a listener loop or a runaway trigger: Ops overview (Firestore and invocations by function), then the function's logs. ${local.runbook}"
  }
  user_labels = var.labels
  depends_on  = [time_sleep.metrics_ready]
}

# The Clerk gateway logs "clerk budget threshold" once a month per org, when metering crosses 80%
# of the org's monthly token budget (ADR-011a's planning volumes).
resource "google_monitoring_alert_policy" "clerk_budget" {
  project      = var.project_id
  display_name = "Clerk monthly budget at 80% (${var.env})"
  combiner     = "OR"

  conditions {
    display_name = "Clerk metering passed 80% of an org's monthly budget"
    condition_matched_log {
      filter = "resource.type=\"cloud_run_revision\" AND jsonPayload.message=\"clerk budget threshold\""
      label_extractors = {
        orgId  = "EXTRACT(jsonPayload.orgId)"
        period = "EXTRACT(jsonPayload.period)"
      }
    }
  }

  alert_strategy {
    notification_rate_limit {
      period = "3600s"
    }
    auto_close = "604800s"
  }

  notification_channels = var.notification_channels
  documentation {
    mime_type = "text/markdown"
    content   = "Clerk has used 80% of an org's monthly token budget; at 100% it refuses calls (CLERK_BUDGET_EXCEEDED) until next month. Raise `monthlyTokenBudget` in the org's Clerk settings or check the usage in `orgs/{orgId}/metrics/clerk-YYYY-MM`. ${local.runbook}"
  }
  user_labels = var.labels
}

# A Firestore trigger gave up and dead-lettered its event (defineTrigger logs "dead-letter"); the
# audit triggers among them (fn "audit-…") mean a mutation is missing from the audit log (FND-18).
resource "google_monitoring_alert_policy" "trigger_failures" {
  project      = var.project_id
  display_name = "Trigger dead-lettered an event (${var.env})"
  combiner     = "OR"

  conditions {
    display_name = "A Firestore trigger logged dead-letter"
    condition_matched_log {
      filter = "resource.type=\"cloud_run_revision\" AND jsonPayload.message=\"dead-letter\""
      label_extractors = {
        fn = "EXTRACT(jsonPayload.fn)"
      }
    }
  }

  alert_strategy {
    notification_rate_limit {
      period = "3600s"
    }
    auto_close = "86400s"
  }

  notification_channels = var.notification_channels
  documentation {
    mime_type = "text/markdown"
    content   = "A Firestore trigger failed after its retries and dead-lettered the event; the `fn` label says which. For `audit-…` the change is missing from the audit log: find the dead-letter entry (it carries the document path and stack) and replay or record it. Error Reporting has the stack. ${local.runbook}"
  }
  user_labels = var.labels
}

# The deadline engine needed a calendar year that isn't loaded (CORE-10), so that matter's
# deadlines are blocked until the calendar data ships.
resource "google_monitoring_alert_policy" "deadline_calendar_missing" {
  project      = var.project_id
  display_name = "Deadline calendar data missing (${var.env})"
  combiner     = "OR"

  conditions {
    display_name = "Recompute logged deadline_calendar_missing"
    condition_matched_log {
      filter = "resource.type=\"cloud_run_revision\" AND jsonPayload.alert=\"deadline_calendar_missing\""
    }
  }

  alert_strategy {
    notification_rate_limit {
      period = "86400s"
    }
    auto_close = "604800s"
  }

  notification_channels = var.notification_channels
  documentation {
    mime_type = "text/markdown"
    content   = "A deadline recompute needed a court or locality calendar year that `libs/deadlines` doesn't have (the log lists `calendars` and `ruleIds`), so those deadlines show as blocked. Add the year's calendar data (docs/06-deadline-engine.md) and redeploy; the next recompute clears them. ${local.runbook}"
  }
  user_labels = var.labels
}

# A scheduled job that hasn't logged "ok" for twice its period, capped at 24.5 hours: a PromQL query
# that reads a log-based metric can't look back more than 1d1h anywhere in it (and condition_absent
# stops at 23.5 hours), so a daily job alerts after one missed run plus half an hour.
#
# The guard keeps a new environment, or a job not deployed yet, from alerting on day one:
# - jobs that run at least twice a day: the job logged a run in the last day, so a stopped job
#   (paused scheduler included) alerts for a day before the guard goes quiet;
# - daily jobs: Cloud Run served the job a request in the last day, so a job that's invoked but
#   fails alerts (a paused daily scheduler stays silent).
resource "google_monitoring_alert_policy" "scheduled_job" {
  for_each = var.scheduled_jobs

  project      = var.project_id
  display_name = "Scheduled job ${each.key} not running (${var.env})"
  combiner     = "OR"

  conditions {
    display_name = "No ${each.key} run in ${min(each.value * 2, 88200) / 60} minutes"
    condition_prometheus_query_language {
      query = join(" and on() ", [
        "absent_over_time(${local.job_runs}{monitored_resource=\"cloud_run_revision\",fn=\"${each.key}\"}[${min(each.value * 2, 88200)}s])",
        each.value * 2 <= 86400
        ? "(sum(count_over_time(${local.job_runs}{monitored_resource=\"cloud_run_revision\",fn=\"${each.key}\"}[1d])) > 0)"
        : "(sum(increase(run_googleapis_com:request_count{monitored_resource=\"cloud_run_revision\",service_name=\"${lower(each.key)}\"}[1d])) > 0)",
      ])
      duration            = "0s"
      evaluation_interval = "300s"
    }
  }

  notification_channels = var.notification_channels
  documentation {
    mime_type = "text/markdown"
    content   = "${each.key} hasn't finished a run in twice its period (at most 24.5 hours). Check its logs in Cloud Run and Cloud Scheduler (paused job, failed deploy). ${local.runbook}"
  }
  user_labels = var.labels
  depends_on  = [time_sleep.metrics_ready]
}

# The test alert: `gcloud logging write materia-alert-test "test alert" --project <project>`
# fires it (the runbook's monthly check that alert email still arrives).
resource "google_monitoring_alert_policy" "test" {
  project      = var.project_id
  display_name = "Test alert (${var.env})"
  combiner     = "OR"

  conditions {
    display_name = "A materia-alert-test log entry"
    condition_matched_log {
      filter = "logName=\"projects/${var.project_id}/logs/materia-alert-test\""
    }
  }

  alert_strategy {
    notification_rate_limit {
      period = "300s"
    }
    auto_close = "1800s"
  }

  notification_channels = var.notification_channels
  documentation {
    mime_type = "text/markdown"
    content   = "A test of alert delivery; nothing is wrong. ${local.runbook}"
  }
  user_labels = var.labels
}
