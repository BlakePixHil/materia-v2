# Runbook: repository setup

How `BlakePixHil/materia-v2` was set up (FND-01), and the settings that must be applied by the owner in the GitHub UI, because the agent session has no API access to repository settings.

## Done

| Item | State | How |
| -- | -- | -- |
| Repository created | `BlakePixHil/materia-v2`, **private**, default branch `main` | Created by the owner on 2026-10-03 |
| Governance files | `README.md`, `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE`, `.github/*` | FND-01 PR |
| Docs mirror | `docs/00…13`, `docs/adr/` | Copied from legacy `planning/docs/` (branch `claude/dazzling-lovelace-7nln12`, commit `217f62c`), checked against Linear |
| Design system | `design/` | Plain copy from the same legacy commit; see `design/PROVENANCE.md` |

## Owner checklist (GitHub UI)

These are the full FND-01 settings. In **MVP mode** the only branch-protection requirement is "require CI"; the rest can follow.

### Settings → General

- [ ] Pull requests: allow **squash merging** only (untick merge commits and rebase merging).
- [ ] Tick **Automatically delete head branches**.
- [ ] Optionally tick **Allow auto-merge**, so agents can queue a squash-merge that waits for CI.

### Settings → Code security

- [ ] **Dependabot alerts**: enable.
- [ ] **Dependabot security updates**: enable.
- [ ] **Secret scanning**: enable, with **Push protection**.
- [ ] **Private vulnerability reporting**: enable (`SECURITY.md` links to it).

### Settings → Branches → add a ruleset (or classic rule) for `main`

MVP mode (agents squash-merge their own PRs once CI is green):

- [ ] Require a pull request before merging (0 approvals in MVP mode).
- [ ] Require status checks to pass: add **`ci-ok`** (the only required check; it aggregates every CI job, FND-04). Tick "Require branches to be up to date before merging".
- [ ] Require linear history.
- [ ] Block force pushes; restrict deletions.

Full setting (after MVP, or when the owner reviews PRs):

- [ ] Require **1 approving review**; dismiss stale approvals on new commits.
- [ ] Apply the rule to administrators too ("Do not allow bypassing").

To verify, run this from a machine with `gh` authenticated as the owner, and paste the output into the FND-01 ticket:

```sh
gh api repos/BlakePixHil/materia-v2 --jq '{private, allow_squash_merge, allow_merge_commit, allow_rebase_merge, delete_branch_on_merge}'
gh api repos/BlakePixHil/materia-v2/branches/main/protection
```

### Linear ↔ GitHub integration

- [ ] In Linear: **Settings → Integrations → GitHub**, connect the `BlakePixHil` account and give it access to `materia-v2`.
- [ ] Enable linking by issue id in PR titles and descriptions, and the workflow automation (PR opened → In Progress, PR merged → Done) for team **Materia**.

PRs are titled `[KEY] Title`, and their description carries `Closes MAT-N` plus the issue URL. The integration is connected (it saw PR #1), but it links PRs by the `MAT-N` id, not by the `[KEY]` plan key, so `Closes MAT-N` is required.
