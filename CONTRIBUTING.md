# Contributing

Feature work is planned in Linear (workspace `materia-web`, team **Materia**). Read [`AGENTS.md`](AGENTS.md) first; it applies to humans too.

## Branches

- Branch from `main` as `<key-lowercase>-<slug>`, for example `fnd-04-ci-pipeline` or `core-10-deadlines-feature`. Linear's suggested branch name is fine too.
- Automated agent sessions may be given a fixed branch name by their environment; use that.
- Keep branches short-lived. One ticket per branch and per PR.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <summary>

<body: why, not what>

Refs: FND-04
```

Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `build`, `ci`, `perf`. Scopes follow the repo layout (`web`, `functions`, `domain`, `ui`, `deadlines`, `clerk`, `infra`, `design`, `docs`, …). PRs are squash-merged, so the PR title (`[KEY] Title`) becomes the commit on `main`. release-please can't read that title, so the PR body carries the Conventional Commit for the changelog (below).

## Pull requests

- Title: `[KEY] Title`, matching the Linear ticket, for example `[FND-04] CI pipeline in GitHub Actions`.
- Put `Closes MAT-N` (the Linear issue id, not the plan key) in the description, plus the issue link. Linear's GitHub integration links PRs by the `MAT-N` id.
- Fill in every section of the [PR template](.github/pull_request_template.md). The **Acceptance criteria → evidence** table must cover every box on the ticket.
- End the description with the PR's Conventional Commit, which release-please uses for the version bump and the changelog (`release.yml`, [deploy runbook](docs/runbooks/deploy.md)):

  ```
  BEGIN_COMMIT_OVERRIDE
  feat(functions): system ping reports the release
  END_COMMIT_OVERRIDE
  ```

  `feat` releases a minor version, `fix` a patch; other types don't release. Add `BREAKING CHANGE: …` on the next line for breaking changes.

- CI must be green. Never skip, disable or `.only` a test.
- Merge with **squash** only. The branch is deleted on merge.

## Design system

`design/` is the design-system source. After changing anything under `design/system/`, run `python3 design/system/build.py` and commit the regenerated files. Never edit generated files (`design/system/project/`, `design/tokens/`, `design/mockups/`) by hand.

## Data

Use fictional data only. Never put real client names, matters, documents or emails in code, tests, fixtures, screenshots or logs.

## Reporting bugs and security issues

- Bugs: open a GitHub issue with the bug template, or a Linear ticket.
- Security: see [`SECURITY.md`](SECURITY.md). Do not open a public issue.
