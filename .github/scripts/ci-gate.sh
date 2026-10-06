#!/usr/bin/env bash
# CI's gate job (ci.yml): decides how much of CI this run needs, to keep Actions minutes down.
# Writes `mode` (full | main | docs | skip) and `base` (Nx base for the morning run) to
# $GITHUB_OUTPUT. The modes are described at the top of ci.yml.
#
# Env: GH_TOKEN, EVENT, PR (pull_request), BEFORE (push), MORNING (workflow_dispatch: "true" for
# the morning run), CATCHUP (workflow_dispatch: "true" for a catch-up run), plus the runner's
# GITHUB_* variables.
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

# The newest successful dev deploy: "<sha> <minutes ago> <due|recent>" (last-dev-deploy.sh).
last_deploy="$("$(dirname "${BASH_SOURCE[0]}")/last-dev-deploy.sh" 2>/dev/null || true)"
read -r deployed deployed_mins deploy_state <<< "$last_deploy" || true

# The morning run (the Claude routine's dispatch, or a cron that fired): test and deploy whatever
# merged since the last dev deploy. Crons arrive hours late, so any time from 06:00 to 22:00 works.
# A catch-up run (the routine's hourly daytime dispatch) deploys what the two-hour limit held back
# (see last-dev-deploy.sh), with the fast checks only: everything else ran on the PRs.
deploy_run() {
  local kind="$1" others
  # Another run that builds this commit (a morning run, or a daytime push) will deploy it. A
  # catch-up ignores pushes: a push inside the two-hour limit builds but doesn't deploy.
  others="$(gh run list --repo "$repo" --workflow ci.yml --commit "$head" --limit 20 \
    --json databaseId,event,status --jq "[.[] | select(.databaseId != $GITHUB_RUN_ID and .status != \"completed\" and (.event != \"push\" or ($quiet == false and \"$kind\" == \"morning\")))] | length" 2>/dev/null || echo 0)"
  if [ "$kind" = morning ] && { [ "$now" -lt 600 ] || [ "$now" -ge 2200 ]; }; then
    mode=skip
    reason="night time ($hhmm in Melbourne): the morning run starts at 06:30"
  elif [ "$kind" = catchup ] && [ "$quiet" = true ]; then
    mode=skip
    reason="quiet hours ($hhmm in Melbourne): the morning run deploys this"
  elif [ "${others:-0}" != 0 ]; then
    mode=skip
    reason="another run is already building this commit"
  elif [ "${deployed:-}" = "$head" ]; then
    mode=skip
    reason="main is already deployed to dev"
  elif [ -n "${deployed:-}" ] && is_docs_only "$(compare_files "$deployed" "$head")"; then
    mode=skip
    reason="only docs changed since the last dev deploy"
  elif [ "$kind" = catchup ] && [ "${deploy_state:-}" = recent ]; then
    mode=skip
    reason="dev deployed ${deployed_mins} min ago; dev deploys at most once every two hours"
  else
    local label="morning run"
    if [ "$kind" = catchup ]; then mode=main; label="catch-up run"; fi
    base="${deployed:-}"
    reason="$label: everything merged since ${deployed:-the start} (last dev deploy)"
  fi
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
    deploy_run morning
    ;;
  workflow_dispatch)
    if [ "${MORNING:-}" = true ]; then
      deploy_run morning
    elif [ "${CATCHUP:-}" = true ]; then
      deploy_run catchup
    else
      base="${deployed:-}"
      reason="manual run: everything since ${base:-the start} (last dev deploy)"
    fi
    ;;
esac

echo "mode=$mode" >> "$GITHUB_OUTPUT"
echo "base=$base" >> "$GITHUB_OUTPUT"
echo "CI mode: $mode${reason:+ ($reason)}"
echo "CI mode: **$mode**${reason:+ ($reason)}" >> "$GITHUB_STEP_SUMMARY"
if [ "$mode" = skip ]; then echo "::notice::CI skipped: $reason"; fi
