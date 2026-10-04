#!/usr/bin/env bash
# Sets up App Check for the web app (FND-22): a reCAPTCHA Enterprise score key for the Hosting
# domains, registered as the web app's App Check provider. Callables enforce App Check, so the web
# app sends a token from this key with every call.
# Run once per environment by someone with Owner (or reCAPTCHA Enterprise Admin and Firebase App
# Check Admin) on the project:
#   infra/scripts/app-check.sh materia-v2-dev
# Idempotent: it reuses the key named "Materia web App Check". Prints the site key, which goes in
# APP_CHECK_SITE_KEYS (tools/scripts/src/env.ts). Record the run in infra/MANUAL.md.
set -euo pipefail

project="${1:?usage: app-check.sh <project-id>}"
name='Materia web App Check'
token="$(gcloud auth print-access-token)"
api() { curl -fsS -H "Authorization: Bearer ${token}" -H "x-goog-user-project: ${project}" "$@"; }

site_key="$(gcloud recaptcha keys list --project="${project}" --filter="displayName=\"${name}\"" \
  --format='value(name.basename())' | head -n 1)"
if [ -z "${site_key}" ]; then
  site_key="$(gcloud recaptcha keys create --project="${project}" --display-name="${name}" --web \
    --integration-type=score --domains="${project}.web.app,${project}.firebaseapp.com" \
    --format='value(name.basename())')"
fi

app_id="$(api "https://firebase.googleapis.com/v1beta1/projects/${project}/webApps" |
  python3 -c 'import json, sys; print(json.load(sys.stdin)["apps"][0]["appId"])')"

api -X PATCH \
  "https://firebaseappcheck.googleapis.com/v1/projects/${project}/apps/${app_id}/recaptchaEnterpriseConfig?updateMask=siteKey" \
  -H 'Content-Type: application/json' -d "{\"siteKey\": \"${site_key}\"}" >/dev/null

echo "App Check for ${project}: web app ${app_id} uses reCAPTCHA Enterprise site key ${site_key}."
