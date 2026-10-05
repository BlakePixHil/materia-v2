# Uptime checks (FND-21): the site's /health route and the system-ping callable, every 5 minutes
# from every checker region. The uptime alert fires when two or more regions fail.

resource "google_monitoring_uptime_check_config" "hosting" {
  project      = var.project_id
  display_name = "Hosting /health (${var.env})"
  timeout      = "10s"
  period       = "300s"

  http_check {
    path         = "/health"
    port         = 443
    use_ssl      = true
    validate_ssl = true
    accepted_response_status_codes {
      status_class = "STATUS_CLASS_2XX"
    }
  }

  # The app shell: a 200 from anything else (a parked domain, an error page) fails the check.
  content_matchers {
    content = "<mt-root"
    matcher = "CONTAINS_STRING"
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = "${var.project_id}.web.app"
    }
  }
}

resource "google_monitoring_uptime_check_config" "ping" {
  project      = var.project_id
  display_name = "system-ping callable (${var.env})"
  timeout      = "10s"
  period       = "300s"

  http_check {
    request_method      = "POST"
    path                = "/system-ping"
    port                = 443
    use_ssl             = true
    validate_ssl        = true
    content_type        = "USER_PROVIDED"
    custom_content_type = "application/json"
    body                = base64encode("{\"data\":{}}")
    accepted_response_status_codes {
      status_class = "STATUS_CLASS_2XX"
    }
  }

  content_matchers {
    content = "\"ok\":true"
    matcher = "CONTAINS_STRING"
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = "${var.region}-${var.project_id}.cloudfunctions.net"
    }
  }
}
