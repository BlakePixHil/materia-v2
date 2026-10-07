#!/usr/bin/env bash
# Runs the SEC-07 k6 load scripts (tools/load/*.js) against the Firebase emulators holding the
# large practice, one after another, and keeps each summary. Never against a real project: the
# scripts refuse a project id that doesn't start with demo-.
#
#   K6=/path/to/k6 tools/load/run.sh [create-matter issue-invoice ...]
#
# Start the emulators with the large practice and Functions first, for example:
#
#   pnpm nx build functions
#   firebase emulators:exec --only auth,firestore,functions,storage --project demo-materia \
#     --import=.perf-data "K6=$HOME/bin/k6 tools/load/run.sh"
#
# Knobs (environment): DURATION (the peak step, default 2m), MULTIPLIER (default 10; 1 runs at peak),
# CONTENTION=0 (the counters' scripts skip their 5-a-second step), LOAD_OUT (default dist/load).
#
# k6 isn't a dependency: download a release from github.com/grafana/k6/releases and check its
# SHA-256 against the release's checksums file (docs/ops/perf-report-2026-10.md).
set -euo pipefail
K6=${K6:-k6}
OUT=${LOAD_OUT:-dist/load}
mkdir -p "$OUT"
if [ "$#" -eq 0 ]; then
  set -- create-matter issue-invoice deadlines-recompute notification-fanout clerk-send-message search
fi
status=0
for script in "$@"; do
  echo "== $script"
  if ! "$K6" run --no-color --summary-export "$OUT/$script.json" "tools/load/$script.js" >"$OUT/$script.txt" 2>&1; then
    status=1
  fi
  tail -n 60 "$OUT/$script.txt"
done
exit "$status"
