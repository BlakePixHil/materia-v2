# Prod: applied by the owner. Only v* tags or the GitHub `production` environment can deploy.
env                          = "prod"
project_id                   = "materia-v2-prod"
admin_project_id             = "materia-v2-admin"
budget_amount                = 1000
restrict_deploys_to_releases = true
enable_migration_runner      = true
deletion_protection          = true

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
