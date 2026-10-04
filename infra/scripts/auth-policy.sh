#!/usr/bin/env bash
# Sets the Identity Platform settings the Terraform provider can't (FND-16):
#   - password policy: at least 12 characters, enforced at sign-up and password change;
#   - email-enumeration protection (improved email privacy).
# Run once per environment by someone with Identity Platform Admin on the project:
#   infra/scripts/auth-policy.sh materia-v2-dev
# Idempotent: it PATCHes only these two settings. Record the run in infra/MANUAL.md.
set -euo pipefail

project="${1:?usage: auth-policy.sh <project-id>}"
token="$(gcloud auth print-access-token)"

curl -fsS -X PATCH \
  "https://identitytoolkit.googleapis.com/admin/v2/projects/${project}/config?updateMask=passwordPolicyConfig,emailPrivacyConfig" \
  -H "Authorization: Bearer ${token}" \
  -H "x-goog-user-project: ${project}" \
  -H 'Content-Type: application/json' \
  -d '{
    "passwordPolicyConfig": {
      "passwordPolicyEnforcementState": "ENFORCE",
      "forceUpgradeOnSignin": false,
      "passwordPolicyVersions": [{ "customStrengthOptions": { "minPasswordLength": 12 } }]
    },
    "emailPrivacyConfig": { "enableImprovedEmailPrivacy": true }
  }' >/dev/null

echo "Identity Platform password policy and email privacy set for ${project}."
