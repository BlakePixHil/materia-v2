variable "env" {
  description = "dev, staging or prod."
  type        = string
}

variable "project_id" {
  description = "Project id for this environment (materia-v2-<env>, plus a suffix if taken)."
  type        = string
}

variable "billing_account" {
  description = "Billing account id. Pass via TF_VAR_billing_account or a gitignored *.auto.tfvars; never commit it."
  type        = string
}

variable "org_id" {
  description = "Organisation id, or null for a no-org setup."
  type        = string
  default     = null
}

variable "folder_id" {
  description = "Folder id, or null."
  type        = string
  default     = null
}

variable "admin_project_id" {
  description = "Bootstrap admin project (quota project for the Billing Budgets API)."
  type        = string
}

variable "region" {
  description = "Primary region."
  type        = string
  default     = "australia-southeast1"
}

variable "backup_region" {
  description = "Backup region."
  type        = string
  default     = "australia-southeast2"
}

variable "github_repository" {
  description = "owner/repo allowed to deploy through WIF."
  type        = string
  default     = "BlakePixHil/materia-v2"
}

variable "restrict_deploys_to_releases" {
  description = "Prod: only v* tags or the production environment may deploy."
  type        = bool
  default     = false
}

variable "enable_migration_runner" {
  description = "Create the migration-runner service account."
  type        = bool
  default     = false
}

variable "deletion_protection" {
  description = "Protect the project and Firestore from deletion."
  type        = bool
  default     = false
}

variable "budget_amount" {
  description = "Monthly budget (whole units of budget_currency)."
  type        = number
}

variable "budget_currency" {
  description = "Must match the billing account currency."
  type        = string
  default     = "AUD"
}

variable "budget_alert_emails" {
  description = "Recipients of budget alerts. Pass via TF_VAR_budget_alert_emails or a gitignored *.auto.tfvars."
  type        = list(string)
}
