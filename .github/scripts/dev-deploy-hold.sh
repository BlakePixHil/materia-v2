#!/usr/bin/env bash
# Dev deploy hold, for deploy-dev.yml and ci-gate.sh. While an open issue carries the label
# `dev-deploy-hold` (for example during a migration rehearsal on dev), nothing deploys to dev:
# not merges, not catch-up or morning runs, not a manual dispatch of deploy-dev. Prints
# "#<number> <title>" of that issue and exits 0 when held; prints nothing and exits 1 when not.
# Close the issue to lift the hold, then dispatch deploy-dev to bring dev up to main.
# If GitHub can't be asked, it warns and doesn't hold.
# Env: GH_TOKEN, GITHUB_REPOSITORY.
set -euo pipefail

if ! hold="$(gh api "repos/$GITHUB_REPOSITORY/issues?labels=dev-deploy-hold&state=open&per_page=1" \
  --jq '.[] | "#\(.number) \(.title)"' 2>/dev/null)"; then
  echo "::warning::Couldn't check for a dev deploy hold (issues labelled dev-deploy-hold); not holding." >&2
  exit 1
fi
[ -n "$hold" ] || exit 1
echo "$hold"
