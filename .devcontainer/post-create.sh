#!/usr/bin/env bash
# Runs once when the dev container is created (FND-06).
set -euo pipefail

# pnpm at the version pinned in package.json (packageManager).
corepack enable
corepack prepare --activate

pnpm install --frozen-lockfile

# Chromium and its system libraries, for Playwright e2e and the Storybook test runner.
pnpm exec playwright install --with-deps chromium

# firebase-tools is a dev dependency (pnpm exec firebase …); warm the emulator jars so the first
# `pnpm dev` doesn't wait on downloads.
pnpm exec firebase setup:emulators:firestore >/dev/null
pnpm exec firebase setup:emulators:storage >/dev/null
pnpm exec firebase setup:emulators:pubsub >/dev/null
pnpm exec firebase setup:emulators:ui >/dev/null

echo "Ready. Run: pnpm dev"
