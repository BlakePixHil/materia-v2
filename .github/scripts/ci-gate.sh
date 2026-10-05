#!/usr/bin/env bash
# CI's gate job (ci.yml): decides how much of CI this run needs, to keep Actions minutes down.
# Writes `mode` (full | main | docs | skip) and `base` (Nx base for the morning run) to
# $GITHUB_OUTPUT. The modes are described at the top of ci.yml.
#
# Env: GH_TOKEN, EVENT, PR (pull_request), BEFORE (push), plus the runner's GITHUB_* variables.
set -euo pipefail

repo="$GITHUB_REPOSITORY"
head="$GITHUB_SHA"

# Quiet hours: 22:00-07:30 in Melbourne (daylight saving handled by the tz database).
hhmm="${CI_GATE_NOW:-$(TZ=Australia/Melbourne date +%H%M)}" # CI_GATE_NOW=HHMM to test
now=$((10#$hhmm))
quiet=false
if [ "$now" -ge 2200 ] || [ "$now" -lt 730 ]; then quiet=true; fi

# Files that can't change the app, its tests or its build. Markdown under apps/ and libs/ can
# (Clerk prompts are compiled from libs/clerk/prompts/*.md), so only top-level Markdown, READMEs
# and these folders count. Lint (Prettier) still checks them.
docs_pattern='^(docs/|\.claude/|\.github/ISSUE_TEMPLATE/|\.github/pull_request_template\.md$|\.github/CODEOWNERS$|LICENSE$|[^/]+\.md$)|(^|/)README\.md$'

# Prints the changed files, one per line; prints nothing when they can't be listed (run everything).
compare_files() {
  local from="$1" to="$2" out
  if [ -z "$from" ] || [ "$from" = "0000000000000000000000000000000000000000" ]; then return 0; fi
  # The compare API lists at most 300 files; beyond that, treat the change as code.
  out="$(gh api "repos/$repo/compare/$from...$to" --jq 'if (.files | length) < 300 then .files[].filename else empty end' 2>/dev/null)" || return 0
  printf '%s\n' "$out"
}

pr_files() {
  gh api --paginate "repos/$repo/pulls/$PR/files?per_page=100" --jq '.[].filename' 2>/dev/null || true
}

is_docs_only() {
  local files="$1"
  [ -n "$files" ] && ! printf '%s\n' "$files" | grep -Ev "$docs_pattern" >/dev/null
}

# The newest commit that deploy-dev deployed successfully (its run name is "deploy-dev <sha>").
# A green run whose deploy job was skipped (nothing to deploy) doesn't count.
last_deployed() {
  local id title
  gh run list --repo "$repo" --workflow deploy-dev.yml --status success --limit 20 \
    --json databaseId,displayTitle --jq '.[] | "\(.databaseId) \(.displayTitle)"' 2>/dev/null |
    while read -r id title; do
      if gh api "repos/$repo/actions/runs/$id/jobs?per_page=100" \
        --jq '.jobs[] | select(.name | startswith("deploy /")) | .conclusion' 2>/dev/null | grep -x success >/dev/null; then
        echo "${title##* }"
        return 0
      fi
    done
}

mode=full
base=""
reason=""
case "$EVENT" in
  pull_request)
    if is_docs_only "$(pr_files)"; then mode=docs; reason="docs-only change"; fi
    ;;
  push)
    files="$(compare_files "${BEFORE:-}" "$head")"
    if [ "$quiet" = true ] && ! printf '%s\n' "$files" | grep -x '\.release-please-manifest\.json' >/dev/null; then
      mode=skip
      reason="quiet hours ($hhmm in Melbourne): the morning run tests and deploys this"
    elif is_docs_only "$files"; then
      mode=docs
      reason="docs-only change"
    else
      mode=main
      reason="push to main: e2e, Storybook, containers, Terraform and security ran on the PR"
    fi
    ;;
  schedule)
    if [ "$now" -lt 600 ] || [ "$now" -ge 715 ]; then
      mode=skip
      reason="this cron is the other time zone's ($hhmm in Melbourne)"
    else
      deployed="$(last_deployed || true)"
      if [ "$deployed" = "$head" ]; then
        mode=skip
        reason="main is already deployed to dev"
      elif [ -n "$deployed" ] && is_docs_only "$(compare_files "$deployed" "$head")"; then
        mode=skip
        reason="only docs changed since the last dev deploy"
      else
        base="$deployed"
        reason="morning run: everything merged since ${deployed:-the start} (last dev deploy)"
      fi
    fi
    ;;
  workflow_dispatch)
    base="$(last_deployed || true)"
    reason="manual run: everything since ${base:-the start} (last dev deploy)"
    ;;
esac

echo "mode=$mode" >> "$GITHUB_OUTPUT"
echo "base=$base" >> "$GITHUB_OUTPUT"
echo "CI mode: $mode${reason:+ ($reason)}"
echo "CI mode: **$mode**${reason:+ ($reason)}" >> "$GITHUB_STEP_SUMMARY"
if [ "$mode" = skip ]; then echo "::notice::CI skipped: $reason"; fi
