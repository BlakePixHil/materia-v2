variable "billing_account" {
  description = "Billing account id (XXXXXX-XXXXXX-XXXXXX). Provided by the owner."
  type        = string
}

variable "org_id" {
  description = "Organisation id. Leave null for a no-org setup (personal account)."
  type        = string
  default     = null
}

variable "folder_id" {
  description = "Folder id to create projects in. Takes precedence over org_id when set."
  type        = string
  default     = null
}

variable "admin_project_id" {
  description = "Project that holds Terraform state. Must be globally unique."
  type        = string
  default     = "materia-v2-admin"
}

variable "state_bucket_suffix" {
  description = "Suffix for the state bucket name materia-tfstate-<suffix>. Must make the name globally unique."
  type        = string
}

variable "region" {
  description = "Region for the state bucket."
  type        = string
  default     = "australia-southeast1"
}

variable "terraform_service_account_email" {
  description = "Service account infra.yml runs Terraform as (created by hand, infra/MANUAL.md)."
  type        = string
  default     = "terraform-agent@materia-v2-admin.iam.gserviceaccount.com"
}

variable "github_repository_id" {
  description = "Immutable numeric id of the repository allowed to run Terraform (BlakePixHil/materia-v2)."
  type        = string
  default     = "1403644575"
}

variable "github_repository_owner_id" {
  description = "Immutable numeric id of the repository owner."
  type        = string
  default     = "19206943"
}
