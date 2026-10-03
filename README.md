# Materia v2

[![ci](https://github.com/BlakePixHil/materia-v2/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/BlakePixHil/materia-v2/actions/workflows/ci.yml)

Materia is an AI-native practice tool for **Wills & Estates lawyers in Australia**, launching in Victoria. It covers matters (wills, powers of attorney and enduring guardianship, probate, letters of administration, estate administration, family provision claims, will disputes and testamentary trusts), deadlines computed from legal rules, tasks, documents, time and billing, litigation support for contested estates, and **Clerk**, an assistant on Claude that proposes changes and never commits them.

v2 replaces the legacy app (`BlakePixHil/materia-web-app`).

- **Repository:** `BlakePixHil/materia-v2` (private, default branch `main`). The plan suggested `BlakePixHil/materia`; the owner chose `materia-v2`.
- **Plan and tickets:** Linear, workspace [`materia-web`](https://linear.app/materia-web), team **Materia**. Linear is the source of truth.
- **Start here:** [`AGENTS.md`](AGENTS.md) (agents and humans), then [`docs/00-agent-handbook.md`](docs/00-agent-handbook.md).

## Repository layout

| Path        | What                                                                                                     |
| ----------- | -------------------------------------------------------------------------------------------------------- |
| `docs/`     | Mirror of the Linear reference documents, plus `docs/adr/` (architecture decisions) and `docs/runbooks/` |
| `design/`   | The design system source (tokens, components, screens). Rebuild with `python3 design/system/build.py`    |
| `apps/`     | `web` (Angular), `web-e2e` (Playwright), `functions` (Firebase Functions v2), `jobs` (Cloud Run jobs)    |
| `libs/`     | `ui`, `data-access`, `domain`, `deadlines`, `clerk`, `test-utils`                                        |
| `tools/`    | `scripts` and `migration` CLIs                                                                           |
| `firebase/` | `firebase.json`, rules, indexes and project aliases                                                      |
| `infra/`    | Terraform (FND-03) and `MANUAL.md`                                                                       |

## Quickstart

Requirements: Node 22 (see `.nvmrc`), pnpm 10, Java 21+ (Firebase emulators), Python 3 (design build only).

```sh
pnpm install
pnpm nx run-many -t lint,typecheck,test,build   # everything CI checks
pnpm dev                                         # web app on http://localhost:4200/health
pnpm nx run functions:serve                      # Functions emulator with the platform-ping callable
pnpm storybook                                   # libs/ui Storybook on http://localhost:4400
```

All commands are listed in [`AGENTS.md`](AGENTS.md#commands). FND-06 adds the full emulator suite and seed data.

## Branch protection and CI

- Merges go through pull requests into `main`, squash-only.
- CI (`.github/workflows/ci.yml`, FND-04) gates every PR. **`ci-ok` is the only required status check** on `main`: it passes when every job succeeded or was skipped. The owner applies the setting (FND-01a); see [`docs/runbooks/repo-setup.md`](docs/runbooks/repo-setup.md).

## Licence

Proprietary. All rights reserved. See [`LICENSE`](LICENSE).
