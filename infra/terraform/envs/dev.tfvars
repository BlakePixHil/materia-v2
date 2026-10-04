# Non-secret settings for dev. The billing account and alert emails come from
# TF_VAR_billing_account / TF_VAR_budget_alert_emails or a gitignored *.auto.tfvars.
env                          = "dev"
project_id                   = "materia-v2-dev"
admin_project_id             = "materia-v2-admin"
budget_amount                = 100
restrict_deploys_to_releases = false
enable_migration_runner      = false
deletion_protection          = false

# Created in the Firebase console (Blaze) before Terraform; adopted by imports.tf.
adopt_existing_project = true
adopt_enabled_services = [
  "billingbudgets.googleapis.com",
  "cloudbilling.googleapis.com",
  "cloudresourcemanager.googleapis.com",
  "firebase.googleapis.com",
  "firebasehosting.googleapis.com",
  "firebaseremoteconfig.googleapis.com",
  "firebaserules.googleapis.com",
  "identitytoolkit.googleapis.com",
  "logging.googleapis.com",
  "monitoring.googleapis.com",
  "pubsub.googleapis.com",
  "serviceusage.googleapis.com",
  "storage.googleapis.com",
]

# The "Firebase Project materia-v2-dev" budget created on the Blaze upgrade.
adopt_budget_id = "53e66047-e408-4d15-b131-58304f5322ca"
