output "dashboard_url" {
  description = "The Ops overview dashboard in the Cloud console."
  value       = "https://console.cloud.google.com/monitoring/dashboards/builder/${element(split("/", google_monitoring_dashboard.ops.id), 3)}?project=${var.project_id}"
}

output "sourcemaps_bucket" {
  description = "Private bucket for web sourcemaps (decode with `materia-scripts decode-stack`)."
  value       = google_storage_bucket.sourcemaps.name
}
