variable "env" {
  description = "Environment name (dev, staging, prod)."
  type        = string
}

variable "project_id" {
  description = "The environment's GCP/Firebase project id."
  type        = string
}

variable "region" {
  description = "Functions region (the system-ping uptime check calls it)."
  type        = string
}

variable "notification_channels" {
  description = "Monitoring notification channel ids every alert notifies (the budget alert emails)."
  type        = list(string)
}

variable "deployer_sa" {
  description = "Deployer service account email; it uploads each release's sourcemaps."
  type        = string
}

variable "deletion_protection" {
  description = "Keep the sourcemaps bucket when Terraform destroys the environment."
  type        = bool
}

variable "labels" {
  description = "Labels for buckets and alert policies."
  type        = map(string)
}

variable "sourcemap_retention_days" {
  description = "How long release sourcemaps are kept."
  type        = number
  default     = 180
}

variable "scheduled_jobs" {
  description = "Scheduled functions (name => period in seconds) that alert when they haven't logged \"ok\" for twice their period. reminders-dispatch has its own alert (firebase_env/monitoring.tf). tools/scripts/src/scheduled-jobs.spec.ts checks every scheduled function is listed."
  type        = map(number)
  default = {
    "notifications-digest"      = 900
    "time-flagForgottenTimers"  = 1800
    "documents-sweepPending"    = 3600
    "suggestions-expire"        = 3600
    "deadlines-upgradeRuleSets" = 3600
    "deadlines-flagMissed"      = 86400
    "backups-exportFirestore"   = 86400
    "matters-archiveClosed"     = 86400
    "jobs-sweepExports"         = 86400
    "billing-debtorsNightly"    = 86400
    "metrics-recompute"         = 86400
    "costs-disclosureNightly"   = 86400
    "matters-queueDestruction"  = 2678400 # monthly: alerts when a run fails, not when one is missed
  }
}
