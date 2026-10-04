# Identity Platform, KMS and Secret Manager.

resource "google_identity_platform_config" "this" {
  project = google_project.this.project_id

  sign_in {
    allow_duplicate_emails = false

    email {
      enabled           = true
      password_required = true
    }

    # Declared because the API returns it; otherwise every plan shows a diff.
    phone_number {
      enabled = false
    }
  }

  # TOTP authenticator apps only (FND-16): SMS stays off for cost and SIM-swap reasons. Orgs that
  # require MFA enforce it in the app (SEC-04), so the project-wide state is ENABLED, not MANDATORY.
  mfa {
    state = var.auth_mfa_state

    provider_configs {
      state = "ENABLED"

      totp_provider_config {
        adjacent_intervals = 1
      }
    }
  }

  authorized_domains = concat(
    ["localhost", "${var.project_id}.firebaseapp.com", "${var.project_id}.web.app"],
    var.auth_authorized_domains,
  )

  # The Firebase CLI registers the blocking functions (auth-beforeCreate, auth-beforeSignIn) when it
  # deploys them, and Google sign-in is enabled in the console (it creates the OAuth client), so
  # Terraform leaves both alone. The password policy and email-enumeration protection aren't in the
  # provider: infra/scripts/auth-policy.sh sets them (infra/MANUAL.md, FND-16).
  lifecycle {
    ignore_changes = [blocking_functions]
  }

  depends_on = [google_firebase_project.this]
}

resource "google_kms_key_ring" "materia" {
  project    = google_project.this.project_id
  name       = "materia"
  location   = var.region
  depends_on = [time_sleep.services_ready]
}

# OAuth refresh tokens for integrations (ADR-019, INT-01).
resource "google_kms_crypto_key" "oauth_tokens" {
  name            = "oauth-tokens"
  key_ring        = google_kms_key_ring.materia.id
  rotation_period = "7776000s" # 90 days
  labels          = local.labels

  lifecycle {
    prevent_destroy = true
  }
}

# Migration bucket CMEK (MIG-02).
resource "google_kms_crypto_key" "migration" {
  name            = "migration"
  key_ring        = google_kms_key_ring.materia.id
  rotation_period = "7776000s" # 90 days
  labels          = local.labels

  lifecycle {
    prevent_destroy = true
  }
}

# Secret containers only. Values are added by the owner (`gcloud secrets versions add`) and never
# appear in Terraform state or code. Replicated only in Australia.
resource "google_secret_manager_secret" "this" {
  for_each = toset(["ANTHROPIC_API_KEY"])

  project   = google_project.this.project_id
  secret_id = each.value
  labels    = local.labels

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [time_sleep.services_ready]
}
