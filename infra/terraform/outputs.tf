output "project_id" {
  description = "GCP/Firebase project id."
  value       = module.env.project_id
}

output "web_app_config" {
  description = "Firebase web config JSON (not secret)."
  value       = module.env.web_app_config
}

output "wif_provider" {
  description = "Workload Identity provider for GitHub Actions."
  value       = module.env.wif_provider
}

output "deployer_sa" {
  description = "Deployer service account email."
  value       = module.env.deployer_sa
}

output "fn_runtime_sa" {
  description = "Functions runtime service account."
  value       = module.env.fn_runtime_sa
}

output "buckets" {
  description = "Bucket names by purpose."
  value       = module.env.buckets
}

output "ops_dashboard_url" {
  description = "The Ops overview dashboard (FND-21)."
  value       = module.monitoring.dashboard_url
}

output "sourcemaps_bucket" {
  description = "Private bucket for web sourcemaps (FND-21)."
  value       = module.monitoring.sourcemaps_bucket
}
