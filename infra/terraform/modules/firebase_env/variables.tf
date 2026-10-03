variable "env" {
  description = "Environment name: dev, staging or prod."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.env)
    error_message = "env must be dev, staging or prod."
  }
}

variable "project_id" {
  description = "GCP project id, normally materia-v2-<env>. Add a suffix if the id is taken globally."
  type        = string
}

variable "billing_account" {
  description = "Billing account id linked to the project."
  type        = string
}

variable "org_id" {
  description = "Organisation id, or null for a no-org setup."
  type        = string
  default     = null
}

variable "folder_id" {
  description = "Folder id; takes precedence over org_id when set."
  type        = string
  default     = null
}

variable "region" {
  description = "Primary region for every regional resource (ADR-003)."
  type        = string
  default     = "australia-southeast1"
}

variable "backup_region" {
  description = "Region for backups (Security, privacy & compliance)."
  type        = string
  default     = "australia-southeast2"
}

variable "github_repository" {
  description = "owner/repo allowed to deploy through Workload Identity Federation."
  type        = string
  default     = "BlakePixHil/materia-v2"
}

variable "github_repository_id" {
  description = "Immutable numeric id of github_repository. Matching ids rather than names means a deleted-and-recreated repo or renamed owner can't inherit access."
  type        = string
  default     = "1403644575"
}

variable "github_repository_owner_id" {
  description = "Immutable numeric id of the repository owner."
  type        = string
  default     = "19206943"
}

variable "restrict_deploys_to_releases" {
  description = "When true (prod), only v* tags or the GitHub `production` environment can assume the deployer."
  type        = bool
  default     = false
}

variable "enable_migration_runner" {
  description = "Create the migration-runner service account (staging and prod only)."
  type        = bool
  default     = false
}

variable "budget_amount" {
  description = "Monthly budget in budget_currency whole units."
  type        = number
}

variable "budget_currency" {
  description = "Must match the billing account's currency."
  type        = string
  default     = "AUD"
}

variable "budget_alert_emails" {
  description = "Email addresses that receive budget alerts at 50, 90 and 100%."
  type        = list(string)
}

variable "deletion_protection" {
  description = "Protect the project and Firestore database from deletion (prod)."
  type        = bool
  default     = false
}

variable "pitr_enabled" {
  description = "Firestore point-in-time recovery."
  type        = bool
  default     = true
}

variable "backup_daily_retention_days" {
  description = "Days to keep objects under daily/ in the backups bucket."
  type        = number
  default     = 35
}

variable "backup_monthly_retention_days" {
  description = "Days to keep objects under monthly/ in the backups bucket."
  type        = number
  default     = 400
}

variable "migration_retention_days" {
  description = "Days to keep objects in the migration bucket."
  type        = number
  default     = 90
}

# FND-16 configures these; they are declared now so the environment files stay stable.
variable "auth_mfa_state" {
  description = "Identity Platform MFA state (DISABLED, ENABLED or MANDATORY). Set by FND-16."
  type        = string
  default     = "DISABLED"
}

variable "auth_authorized_domains" {
  description = "Extra authorized domains for Auth (custom domains). localhost and the Firebase domains are added automatically."
  type        = list(string)
  default     = []
}
