#!/usr/bin/env bash
# The newest successful dev deploy, for ci-gate.sh and deploy-dev.yml. Prints
# "<sha> <minutes since its deploy job started> <due|recent>", or nothing when there is none.
# "recent" means dev deployed less than DEV_DEPLOY_EVERY_MINUTES ago: daytime merges are then
# left for the next catch-up run, so dev deploys at most once every two hours (each deploy
# rebuilds every function, which is most of the Google Cloud bill).
# deploy-dev's run name is "deploy-dev <sha>"; a green run whose deploy job was skipped doesn't count,
# nor does a hosting-only one ("deploy-dev hosting-only <sha>"), which leaves the functions behind.
# Env: GH_TOKEN, GITHUB_REPOSITORY.
set -euo pipefail

every="${DEV_DEPLOY_EVERY_MINUTES:-120}"
repo="$GITHUB_REPOSITORY"

gh run list --repo "$repo" --workflow deploy-dev.yml --status success --limit 20 \
  --json databaseId,displayTitle --jq '.[] | "\(.databaseId) \(.displayTitle)"' 2>/dev/null |
  while read -r id title; do
    case "$title" in *hosting-only*) continue ;; esac
    started="$(gh api "repos/$repo/actions/runs/$id/jobs?per_page=100" \
      --jq '[.jobs[] | select((.name | startswith("deploy /")) and .conclusion == "success") | .started_at][0] // empty' 2>/dev/null || true)"
    if [ -n "$started" ]; then
      age=$((($(date +%s) - $(date -d "$started" +%s)) / 60))
      if [ "$age" -lt "$every" ]; then state=recent; else state=due; fi
      echo "${title##* } $age $state"
      exit 0
    fi
  done
