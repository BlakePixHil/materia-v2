# The "Ops overview" dashboard (FND-21): errors, latency, invocations, Firestore operations, Clerk
# tokens and spend, client errors, notification and trigger failures, uptime. Linked from the
# incident-response runbook.
resource "google_monitoring_dashboard" "ops" {
  project        = var.project_id
  dashboard_json = templatefile("${path.module}/dashboards/ops-overview.json", { env = var.env })

}
