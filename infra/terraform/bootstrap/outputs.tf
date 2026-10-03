output "admin_project_id" {
  description = "Project holding Terraform state; also the quota project for billing budgets."
  value       = google_project.admin.project_id
}

output "state_bucket" {
  description = "Use as the gcs backend bucket in envs/<env>.backend.hcl."
  value       = google_storage_bucket.tfstate.name
}
