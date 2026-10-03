# Non-secret settings for dev. The billing account and alert emails come from
# TF_VAR_billing_account / TF_VAR_budget_alert_emails or a gitignored *.auto.tfvars.
env                          = "dev"
project_id                   = "materia-v2-dev"
admin_project_id             = "materia-v2-admin"
budget_amount                = 100
restrict_deploys_to_releases = false
enable_migration_runner      = false
deletion_protection          = false
