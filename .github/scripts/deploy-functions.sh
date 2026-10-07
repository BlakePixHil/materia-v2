#!/usr/bin/env bash
# Deploys the `core` functions codebase, then retries only the functions that failed. A full deploy
# updates every function at once, and on dev some new revisions fail their health check on the
# regional Cloud Run CPU quota ("Quota exceeded for total allowable CPU per project per region")
# while the old revisions are still up. Those failures are transient, so the failed functions get
# up to two more attempts, a minute apart. Anything else (a build error, no function list) fails
# straight away.
# Usage: deploy-functions.sh <project>
set -uo pipefail

project="$1"
log="$(mktemp)"
only="functions:core"

for attempt in 1 2 3; do
  if pnpm exec firebase deploy --only "$only" --project "$project" --config firebase.json --non-interactive 2>&1 | tee "$log"; then
    exit 0
  fi
  # The CLI ends with "Functions deploy had errors with the following functions:" and one
  # "\tcore:<id>(<region>)" line per failed function.
  failed="$(sed 's/\x1b\[[0-9;]*m//g' "$log" \
    | sed -n '/Functions deploy had errors with the following functions:/,/^[^[:space:]]/p' \
    | sed -n 's/^[[:space:]]\{1,\}core:\([A-Za-z0-9_-]\{1,\}\)(.*$/\1/p' | sort -u)"
  if [ -z "$failed" ]; then
    echo "::error::The functions deploy failed before any function was updated; not retrying."
    exit 1
  fi
  if [ "$attempt" = 3 ]; then
    echo "::error::These functions still failed after three attempts: $(echo "$failed" | paste -sd' ')"
    exit 1
  fi
  echo "::warning::Functions deploy attempt $attempt failed for: $(echo "$failed" | paste -sd' '). Retrying just those in a minute."
  only="$(echo "$failed" | sed 's/^/functions:core:/' | paste -sd,)"
  sleep 60
done
