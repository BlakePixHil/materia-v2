# Materia v2

Materia is an AI-native practice tool for **Wills & Estates lawyers in Australia**, launching in Victoria. It covers matters (wills, powers of attorney and enduring guardianship, probate, letters of administration, estate administration, family provision claims, will disputes and testamentary trusts), deadlines computed from legal rules, tasks, documents, time and billing, litigation support for contested estates, and **Clerk**, an assistant on Claude that proposes changes and never commits them.

v2 replaces the legacy app (`BlakePixHil/materia-web-app`).

- **Repository:** `BlakePixHil/materia-v2` (private, default branch `main`). The plan suggested `BlakePixHil/materia`; the owner chose `materia-v2`.
- **Plan and tickets:** Linear, workspace [`materia-web`](https://linear.app/materia-web), team **Materia**. Linear is the source of truth.
- **Start here:** [`AGENTS.md`](AGENTS.md) (agents and humans), then [`docs/00-agent-handbook.md`](docs/00-agent-handbook.md).

## Repository layout

| Path | What |
| -- | -- |
| `docs/` | Mirror of the Linear reference documents, plus `docs/adr/` (architecture decisions) and `docs/runbooks/` |
| `design/` | The design system source (tokens, components, screens). Rebuild with `python3 design/system/build.py` |
| `apps/`, `libs/`, `tools/`, `infra/`, `firebase/` | Added by later tickets (FND-02 onwards). See [`docs/01-architecture-and-adrs.md`](docs/01-architecture-and-adrs.md) |

## Quickstart

> Placeholder. FND-02 scaffolds the Nx monorepo and FND-06 adds the local emulator environment; this section is filled in then.

Requirements: Node 22 (see `.nvmrc`), pnpm, Python 3 (design build only).

```sh
# Regenerate the design system output (should leave git status clean)
python3 design/system/build.py
```

## Branch protection and CI

- Merges go through pull requests into `main`, squash-only.
- **TODO (FND-04):** add the CI workflow's jobs as required status checks on `main`. See [`docs/runbooks/repo-setup.md`](docs/runbooks/repo-setup.md).

## Licence

Proprietary. All rights reserved. See [`LICENSE`](LICENSE).
