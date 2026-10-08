# The app's own address on Hosting (dev.materia.au on dev). Terraform registers it on the default
# site; the owner adds the records in the `custom_domain_dns` output where the domain's DNS is
# hosted, and Hosting issues the certificate once they resolve (infra/MANUAL.md). The web.app and
# firebaseapp.com addresses keep working.
locals {
  app_domains = concat(var.auth_authorized_domains, compact([var.custom_domain]))
}

resource "google_firebase_hosting_custom_domain" "app" {
  count                 = var.custom_domain == "" ? 0 : 1
  provider              = google-beta
  project               = google_firebase_project.this.project
  site_id               = google_firebase_project.this.project
  custom_domain         = var.custom_domain
  wait_dns_verification = false
}
