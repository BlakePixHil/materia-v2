# Log-based metrics (FND-21) from the structured logs of the FND-15 logger. Every line carries
# `fn`; callables also carry `requestId` and log "ok", "rejected", "replayed" or "unhandled error".

locals {
  run_logs = "resource.type=\"cloud_run_revision\""
}

resource "google_logging_metric" "callable_calls" {
  project = var.project_id
  name    = "callable_calls"
  filter  = "${local.run_logs} AND jsonPayload.requestId:* AND jsonPayload.message=(\"ok\" OR \"rejected\" OR \"replayed\" OR \"unhandled error\")"

  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "INT64"
    unit         = "1"
    display_name = "Callable calls by function and outcome"
    labels {
      key        = "fn"
      value_type = "STRING"
    }
    labels {
      key         = "outcome"
      value_type  = "STRING"
      description = "ok, rejected (an expected DomainError), replayed or unhandled error (INTERNAL)."
    }
  }

  label_extractors = {
    fn      = "EXTRACT(jsonPayload.fn)"
    outcome = "EXTRACT(jsonPayload.message)"
  }
}

resource "google_logging_metric" "callable_latency" {
  project = var.project_id
  name    = "callable_latency"
  filter  = "${local.run_logs} AND jsonPayload.requestId:* AND jsonPayload.message=(\"ok\" OR \"rejected\" OR \"unhandled error\")"

  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "DISTRIBUTION"
    unit         = "ms"
    display_name = "Callable handler latency"
    labels {
      key        = "fn"
      value_type = "STRING"
    }
  }

  value_extractor = "EXTRACT(jsonPayload.durationMs)"
  label_extractors = {
    fn = "EXTRACT(jsonPayload.fn)"
  }

  bucket_options {
    exponential_buckets {
      num_finite_buckets = 32
      growth_factor      = 1.5
      scale              = 5
    }
  }
}

resource "google_logging_metric" "clerk_errors" {
  project = var.project_id
  name    = "clerk_errors"
  filter  = "${local.run_logs} AND jsonPayload.message=(\"clerk provider rejected the call\" OR \"clerk provider error\" OR \"clerk stream failed\" OR \"clerk metering failed\")"

  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "INT64"
    unit         = "1"
    display_name = "Clerk errors by code"
    labels {
      key         = "code"
      value_type  = "STRING"
      description = "The provider error kind (overloaded, rate_limited, timeout…); empty for metering."
    }
  }

  label_extractors = {
    code = "EXTRACT(jsonPayload.kind)"
  }
}

resource "google_logging_metric" "clerk_tokens" {
  project = var.project_id
  name    = "clerk_tokens"
  filter  = "${local.run_logs} AND jsonPayload.message=\"clerk metered\""

  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "DISTRIBUTION"
    unit         = "1"
    display_name = "Clerk tokens per call"
    labels {
      key        = "feature"
      value_type = "STRING"
    }
  }

  value_extractor  = "EXTRACT(jsonPayload.tokens)"
  label_extractors = { feature = "EXTRACT(jsonPayload.feature)" }

  bucket_options {
    exponential_buckets {
      num_finite_buckets = 24
      growth_factor      = 2
      scale              = 16
    }
  }
}

resource "google_logging_metric" "clerk_cost" {
  project = var.project_id
  name    = "clerk_cost_micros"
  filter  = "${local.run_logs} AND jsonPayload.message=\"clerk metered\""

  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "DISTRIBUTION"
    unit         = "1"
    display_name = "Clerk spend per call (micro-dollars)"
    labels {
      key        = "feature"
      value_type = "STRING"
    }
  }

  value_extractor  = "EXTRACT(jsonPayload.costMicros)"
  label_extractors = { feature = "EXTRACT(jsonPayload.feature)" }

  bucket_options {
    exponential_buckets {
      num_finite_buckets = 24
      growth_factor      = 2
      scale              = 100
    }
  }
}

resource "google_logging_metric" "notification_delivery_failures" {
  project = var.project_id
  name    = "notification_delivery_failures"
  filter  = "${local.run_logs} AND ((jsonPayload.message=\"notification delivery\" AND jsonPayload.status=\"failed\") OR jsonPayload.message=\"notification delivery not queued\")"

  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "INT64"
    unit         = "1"
    display_name = "Notification delivery failures"
    labels {
      key        = "channel"
      value_type = "STRING"
    }
  }

  label_extractors = { channel = "EXTRACT(jsonPayload.channel)" }
}

# Firestore trigger dead letters (defineTrigger); the audit triggers are fn="audit-…".
resource "google_logging_metric" "trigger_failures" {
  project = var.project_id
  name    = "trigger_failures"
  filter  = "${local.run_logs} AND jsonPayload.message=\"dead-letter\""

  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "INT64"
    unit         = "1"
    display_name = "Trigger failures (dead letters) by function"
    labels {
      key        = "fn"
      value_type = "STRING"
    }
  }

  label_extractors = { fn = "EXTRACT(jsonPayload.fn)" }
}

resource "google_logging_metric" "scheduled_job_runs" {
  project = var.project_id
  name    = "scheduled_job_runs"
  filter  = "${local.run_logs} AND jsonPayload.message=\"ok\" AND jsonPayload.fn=(${join(" OR ", [for name in keys(var.scheduled_jobs) : "\"${name}\""])})"

  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "INT64"
    unit         = "1"
    display_name = "Scheduled job runs"
    labels {
      key        = "fn"
      value_type = "STRING"
    }
  }

  label_extractors = { fn = "EXTRACT(jsonPayload.fn)" }
}

resource "google_logging_metric" "client_errors" {
  project = var.project_id
  name    = "client_errors"
  filter  = "${local.run_logs} AND jsonPayload.clientError=true"

  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "INT64"
    unit         = "1"
    display_name = "Web client errors by release"
    labels {
      key        = "version"
      value_type = "STRING"
    }
  }

  label_extractors = { version = "EXTRACT(jsonPayload.version)" }
}

# New log-based metrics take a minute or two before alert policies can use them ("metric not
# found" on a fresh environment), so the policies wait for this.
resource "time_sleep" "metrics_ready" {
  create_duration = "90s"
  triggers = {
    metrics = join(",", [
      google_logging_metric.callable_calls.id,
      google_logging_metric.callable_latency.id,
      google_logging_metric.scheduled_job_runs.id,
    ])
  }
}
