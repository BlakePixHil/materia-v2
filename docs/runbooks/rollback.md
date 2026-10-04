# Runbook: rollback

What to do when a release breaks dev or prod (FND-05). Prefer the full rollback, which redeploys an earlier release through the pipeline. The hosting-only rollback is faster but leaves the web app and functions on different versions.

First, find the last good release: the [GitHub releases](https://github.com/BlakePixHil/materia-v2/releases) list, or the version and SHA that `/health` showed before the incident.

## Prod: full rollback (redeploy the previous tag)

1. **Actions → deploy-prod → Run workflow**. Enter the last good tag, for example `v0.3.1`, and run from `main`.
2. Approve the `production` deployment. The run promotes that tag's original build (artifact `release-<sha>`): indexes, rules, functions, then hosting, followed by the smoke tests.
3. Check `/health` shows the old version and SHA.
4. Fix forward on `main`, then release a new patch version. Do not delete or move tags.

Caveats:

- **Artifacts expire after 90 days.** Older releases can't be promoted. Use the hosting-only rollback below and fix forward.
- **Functions the old release doesn't have.** If the bad release added a function, the old source no longer contains it and the CLI refuses to delete it (non-interactive, never `--force`), so the run fails at "Deploy functions" after indexes and rules are already rolled back. Check that nothing still needs the function, delete it by hand (`pnpm exec firebase functions:delete <name> --region australia-southeast1 --project materia-v2-prod`, owner credentials), then **Re-run failed jobs**.
- **Indexes are never rolled back.** `firebase deploy --only firestore:indexes` adds missing indexes but never deletes them, so the newer indexes stay. That's harmless: extra indexes cost storage and write time, nothing else. Deleting an index is a separate, manual change. If the old release needs an index that was removed, it is rebuilt, and queries that need it fail until the build finishes (minutes, see Firestore → Indexes).
- **Rules go back with the code.** Data written under the newer rules stays. If the old rules reject it, documents may become unreadable to clients until the fix ships. Check the rules diff between the two tags first.
- **Data is not rolled back.** For bad writes, Firestore point-in-time recovery (7 days) is a separate procedure (Security, privacy & compliance doc). Never roll back data without the owner.

## Prod: hosting-only rollback (fastest, web only)

Use this when only the web app is broken, or while a full rollback waits for approval.

1. Firebase console → `materia-v2-prod` → Hosting → **Release history**. Each release's message is `<version> <sha>`.
2. On the last good release, choose **⋮ → Rollback**.
3. Check `/health`. The web app now runs the old version against the new functions, rules and indexes. That's fine while the change is backwards compatible. Otherwise follow with the full rollback.

## Dev

Revert the bad PR on `main` (GitHub's **Revert** button opens the PR). When it merges, `deploy-dev` deploys the result. To redeploy the current `main` without a change, use **Actions → deploy-dev → Run workflow**. Dev functions that the revert removes need the same manual delete as in prod.

## Afterwards

- Note the incident on the Linear ticket of the change that broke, with the versions involved.
- If the smoke tests didn't catch it, add a `@smoke` test (read-only, so it can run against prod) or an e2e test.
