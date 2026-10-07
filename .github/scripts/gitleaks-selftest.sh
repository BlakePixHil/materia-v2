#!/usr/bin/env bash
# Proves each custom rule in .gitleaks.toml still fires (SEC-02). It writes fake secrets, made up
# at run time so nothing secret-shaped is ever committed, to a temporary directory, scans it with
# the repo's config and fails unless every expected rule reports a finding.
#
# Usage: .github/scripts/gitleaks-selftest.sh   (needs gitleaks on PATH; run from the repo root)
set -euo pipefail

config="$(pwd)/.gitleaks.toml"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

rand() { LC_ALL=C tr -dc "$1" < /dev/urandom | head -c "$2" || true; }
alnum='A-Za-z0-9'

# Each fake is assembled from pieces so this file itself never matches a rule.
anthropic="sk-""ant-""api03-$(rand "${alnum}_-" 93)AA"
resend="re""_$(rand "$alnum" 8)_$(rand "$alnum" 24)"
key_id="$(rand 'a-f0-9' 40)"
service_account="$(printf '{\n  "type": "service_%s",\n  "project_id": "demo-selftest",\n  "private_key_id": "%s",\n  "client_email": "selftest@demo-selftest.iam.gserviceaccount.com"\n}\n' account "$key_id")"

printf 'export const KEY = "%s";\n' "$anthropic" > "$work/anthropic.ts"
printf 'RESEND_API_KEY=%s\n' "$resend" > "$work/resend.env"
printf '%s' "$service_account" > "$work/service-account.json"
printf '%s' "$service_account" | base64 -w0 > "$work/service-account.b64"

report="$work/report.json"
# gitleaks exits 1 when it finds leaks, which is the point here.
gitleaks dir --no-banner --config "$config" --report-format json --report-path "$report" "$work" > /dev/null 2>&1 || true

expected=(anthropic-api-key resend-api-key gcp-service-account-key-id gcp-service-account-key-base64)
found="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).map((f) => f.RuleID).join("\n"))' "$report")"
missing=0
for rule in "${expected[@]}"; do
  if grep -qx "$rule" <<< "$found"; then
    echo "ok: $rule fires"
  else
    echo "MISSING: $rule did not fire on its fake secret" >&2
    missing=1
  fi
done
exit "$missing"
