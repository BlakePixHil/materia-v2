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

variable "container_scanning" {
  description = "Automatic vulnerability scanning of pushed images (billed per image, function images included)."
  type        = bool
  default     = true
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

# Adoption of pre-existing resources (imports.tf).
variable "adopt_existing_project" {
  description = "Import the project and its Firebase project instead of creating them (created in the Firebase console)."
  type        = bool
  default     = false
}

variable "adopt_enabled_services" {
  description = "APIs already enabled on an adopted project to import into google_project_service. Each must also be in the module's service list."
  type        = list(string)
  default     = []
}

variable "adopt_budget_id" {
  description = "Id (the last path segment) of an existing budget for this project, such as the one Firebase creates on a Blaze upgrade, to import as the monthly budget."
  type        = string
  default     = null
}

variable "custom_domain" {
  description = "The app's own address on Hosting, such as dev.materia.au. Empty: the Firebase domains only."
  type        = string
  default     = ""
}
