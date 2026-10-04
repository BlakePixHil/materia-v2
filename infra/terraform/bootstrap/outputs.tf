output "admin_project_id" {
  description = "Project holding Terraform state; also the quota project for billing budgets."
  value       = google_project.admin.project_id
}

output "state_bucket" {
  description = "Use as the gcs backend bucket in envs/<env>.backend.hcl."
  value       = google_storage_bucket.tfstate.name
}

output "terraform_wif_provider" {
  description = "Set as the TF_WIF_PROVIDER repository variable (infra.yml)."
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "terraform_service_account" {
  description = "Set as the TF_SERVICE_ACCOUNT repository variable (infra.yml)."
  value       = var.terraform_service_account_email
}
