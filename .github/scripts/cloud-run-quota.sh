#!/usr/bin/env bash
# Cloud Run quota check for cloud-run-quota.yml. Prints the CPU and memory allocation limits of
# run.googleapis.com in $REGION, the peak allocation over the last $DAYS days, and how often the
# quota was exceeded. With PREFERRED_VALUE set (dev only), it also files a quota increase request
# for the CPU allocation quota through the Cloud Quotas API (value in the quota's own unit, as
# printed by the read).
#
# Env: TOKEN (OAuth access token), PROJECT, REGION, DAYS, PREFERRED_VALUE (optional),
# CONTACT_EMAIL (needed with PREFERRED_VALUE), GITHUB_STEP_SUMMARY.
set -euo pipefail

api() { curl -fsS -H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: $PROJECT" "$@"; }
summary() { printf '%s\n' "$*" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"; }

summary "### Cloud Run quota: $PROJECT ($REGION)"
summary ""
summary "**Limits** (run.googleapis.com, effective / default, in the quota's unit):"
summary ""
api "https://serviceusage.googleapis.com/v1beta1/projects/$PROJECT/services/run.googleapis.com/consumerQuotaMetrics?view=FULL" |
  jq -r --arg region "$REGION" '
    .metrics[]? | select(.metric | test("cpu|mem"; "i")) as $m
    | $m.consumerQuotaLimits[]? as $l
    | ($l.quotaBuckets[]? | select(.dimensions == null or .dimensions.region == $region)) as $b
    | "- `\($m.metric)` (\($m.displayName), \($b.dimensions.region // "any region")): \($b.effectiveLimit) / \($b.defaultLimit // "-") \($l.unit)"' |
  tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"

start="$(date -u -d "-${DAYS} days" +%Y-%m-%dT%H:%M:%SZ)"
end="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
series() {
  local metric="$1" aligner="$2"
  api -G "https://monitoring.googleapis.com/v3/projects/$PROJECT/timeSeries" \
    --data-urlencode "filter=metric.type=\"$metric\" AND resource.type=\"consumer_quota\" AND resource.labels.service=\"run.googleapis.com\"" \
    --data-urlencode "interval.startTime=$start" --data-urlencode "interval.endTime=$end" \
    --data-urlencode "aggregation.alignmentPeriod=3600s" --data-urlencode "aggregation.perSeriesAligner=$aligner"
}

summary ""
summary "**Peak allocation, last $DAYS days** (hourly max, top 5 hours per metric):"
summary ""
series serviceruntime.googleapis.com/quota/allocation/usage ALIGN_MAX |
  jq -r --arg region "$REGION" '
    .timeSeries[]? | select(.resource.labels.location == $region)
    | (.metric.labels.quota_metric) as $q
    | [.points[] | {t: .interval.endTime, v: (.value.int64Value // .value.doubleValue | tonumber)}]
    | (map(.v) | max) as $max
    | "- `\($q)`: max \($max); busiest hours: " + ([sort_by(-.v)[:5][] | "\(.t) \(.v)"] | join(", "))' |
  tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"

summary ""
summary "**Quota exceeded, last $DAYS days** (hours with at least one rejection):"
summary ""
series serviceruntime.googleapis.com/quota/exceeded ALIGN_COUNT_TRUE |
  jq -r '
    .timeSeries[]? | (.metric.labels.quota_metric) as $q | (.resource.labels.location) as $loc
    | [.points[] | select((.value.int64Value // "0" | tonumber) > 0) | .interval.endTime]
    | "- `\($q)` in \($loc): \(length) hours" + (if length > 0 then " (latest \(.[0]))" else "" end)' |
  tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"

if [ -z "${PREFERRED_VALUE:-}" ]; then exit 0; fi

if [ -z "${CONTACT_EMAIL:-}" ]; then
  echo "::error::A quota increase request needs a contact email (the first budget alert email)."
  exit 1
fi

# The Cloud Quotas API files increase requests; it's off by default.
api -X POST -H 'Content-Type: application/json' -d '{}' \
  "https://serviceusage.googleapis.com/v1/projects/$PROJECT/services/cloudquotas.googleapis.com:enable" >/dev/null
quota_infos='{}'
for _ in 1 2 3 4 5 6; do
  if quota_infos="$(api "https://cloudquotas.googleapis.com/v1/projects/$PROJECT/locations/global/services/run.googleapis.com/quotaInfos?pageSize=200" 2>/dev/null)"; then break; fi
  sleep 20
done
quota_id="$(jq -r '[.quotaInfos[]? | select((.metric | test("cpu_allocation"; "i")) and ((.dimensions // []) | index("region")))][0].quotaId // empty' <<< "$quota_infos")"
if [ -z "$quota_id" ]; then
  echo "::error::No Cloud Run CPU allocation quota with a region dimension found in the Cloud Quotas API."
  jq -r '.quotaInfos[]? | "\(.quotaId) \(.metric) \(.dimensions)"' <<< "$quota_infos"
  exit 1
fi

body="$(jq -n --arg id "$quota_id" --arg v "$PREFERRED_VALUE" --arg region "$REGION" --arg email "$CONTACT_EMAIL" '{
  service: "run.googleapis.com",
  quotaId: $id,
  quotaConfig: { preferredValue: $v },
  dimensions: { region: $region },
  contactEmail: $email,
  justification: "Dev deploys roll about 160 Cloud Functions (2nd gen) at once; new revisions fail their health checks on the regional CPU allocation quota."
}')"
pref_id="run-cpu-allocation-$REGION"
summary ""
summary "**Increase request:** \`$quota_id\` in $REGION to $PREFERRED_VALUE"
if ! api -X PATCH -H 'Content-Type: application/json' -d "$body" \
  "https://cloudquotas.googleapis.com/v1/projects/$PROJECT/locations/global/quotaPreferences/$pref_id?allowMissing=true" |
  jq -r '"- state: \(.reconciling // false | if . then "being reviewed" else "applied or decided" end); granted: \(.quotaConfig.grantedValue // "not yet"); trace: \(.quotaConfig.traceId // "-")"' |
  tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"; then
  echo "::error::The quota preference request failed."
  exit 1
fi
