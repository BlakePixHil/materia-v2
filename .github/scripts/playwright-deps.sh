#!/usr/bin/env bash
# Installs the system packages Playwright's browsers need (`playwright install-deps`) from apt, so a
# slow Ubuntu mirror costs a few minutes instead of the job.
#
# The runners fetch packages from the mirrors in /etc/apt/apt-mirrors.txt, Azure's first. On some
# runners Azure's mirror turns down each package after about 5 seconds (apt then fetches them all
# from archive.ubuntu.com) or sends about 50 kB/s. Chromium's and WebKit's 182 packages (115 MB)
# then took 6 to 24 minutes where they usually take 40 seconds; Chromium's 10 (21.5 MB) took up to
# 2 minutes. So each try gets 3 minutes, and a try that fails drops the Azure mirror for the next.
# apt keeps the packages it has already downloaded.
#
# Usage: .github/scripts/playwright-deps.sh chromium [webkit]   (run from the repo root)
set -euo pipefail

mirrors=/etc/apt/apt-mirrors.txt
azure='azure\.archive\.ubuntu\.com'
tries=3

for try in $(seq "$tries"); do
  # Playwright runs as root so apt and dpkg stay in timeout's process group: as the runner user it
  # would start them through sudo, and a try that ran out could leave them running.
  if sudo env "PATH=$PATH" timeout --kill-after=20s 3m node_modules/.bin/playwright install-deps "$@"; then
    exit 0
  fi
  [ "$try" -lt "$tries" ] || break
  echo "::warning::playwright install-deps $* failed or ran out of time (try $try of $tries); trying again."
  # Sets up any package a stopped try left unpacked.
  sudo dpkg --configure -a
  if [ -f "$mirrors" ] && grep -q "$azure" "$mirrors" && grep -qv "$azure" "$mirrors"; then
    sudo sed -i "/$azure/d" "$mirrors"
    echo "Azure's mirror dropped; $mirrors now lists:"
    cat "$mirrors"
  fi
done
echo "::error::playwright install-deps $* failed $tries times."
exit 1
