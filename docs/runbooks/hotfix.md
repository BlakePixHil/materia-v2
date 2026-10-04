# Runbook: hotfix

Shipping an urgent fix to prod (FND-05). In MVP mode, every hotfix goes through `main`. Only a commit that has deployed to dev and passed its smoke tests can be tagged and promoted, and `deploy-dev` only builds `main`. There are no release branches.

## Steps

1. **Stop the bleeding first.** If prod is broken now, roll back ([`rollback.md`](rollback.md)) while the fix is prepared.
2. **Branch from `main` and fix.** Add a test that fails without the fix. Open the PR as usual (`[KEY] <title>`), with a `fix:` Conventional Commit in the body:

   ```
   BEGIN_COMMIT_OVERRIDE
   fix(deadlines): count the court's closure days
   END_COMMIT_OVERRIDE
   ```

3. **Merge once `ci-ok` is green.** Never skip or disable tests to go faster.
4. **Wait for `deploy-dev`** to finish green, then check <https://materia-v2-dev.web.app/health> shows the fix's SHA and that the fix works on dev.
5. **Merge the release PR.** release-please has updated it to a patch version (`chore(main): release X.Y.Z+1`).
6. **Approve the `production` deployment** in Actions → deploy-prod, and check prod `/health`.

## When `main` holds changes that must not ship yet

The release would include everything merged since the last tag. Either:

- revert those changes on `main` first (one PR per revert), release the hotfix, then re-land them; or
- if that's not workable, stop and ask the owner. A release-branch flow (deploy-dev from `release/*` branches) doesn't exist yet. It would be a follow-up change to `deploy-dev.yml` and `release.yml`.

## Afterwards

Record on the Linear ticket what broke, the hotfix PR and the release tag. Add a smoke or e2e test if the existing ones missed it.
