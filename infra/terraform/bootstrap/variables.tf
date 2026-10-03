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
