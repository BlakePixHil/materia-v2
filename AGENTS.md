# AGENTS.md

Instructions for any agent, human or AI, working in this repository. This is a condensed version of the [Agent handbook](docs/00-agent-handbook.md). **If this file, `docs/` and Linear disagree, Linear wins**; fix the repo copy in your PR.

## What this is

Materia v2: a practice tool for Australian Wills & Estates lawyers (launching in Victoria), with Clerk, an AI assistant that proposes and never commits. Stack and decisions: [Architecture & ADRs](docs/01-architecture-and-adrs.md) and [`docs/adr/`](docs/adr/). Don't re-litigate an ADR inside a feature PR; write a superseding ADR instead.

## Read before you start

| Always                                                  | When relevant                                                                                                                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Agent handbook](docs/00-agent-handbook.md)             | [Domain model](docs/02-domain-model.md): data, rules, functions                                                                                                                |
| [Architecture & ADRs](docs/01-architecture-and-adrs.md) | [Design system & UI](docs/03-design-system-and-ui.md): anything visual                                                                                                         |
| [Testing strategy](docs/05-testing-strategy.md)         | [Environments, CI/CD](docs/04-environments-cicd-release.md): infra, deploys, secrets                                                                                           |
| [Edge-case register](docs/10-edge-case-register.md)     | [Deadline engine](docs/06-deadline-engine.md), [Clerk](docs/07-clerk-ai.md), [Migration](docs/08-legacy-migration-plan.md), [Security](docs/09-security-privacy-compliance.md) |

## Ticket workflow

1. Tickets live in Linear (team **Materia**). Each title starts with a stable key such as `[FND-04]`, and the body is a runnable prompt with acceptance criteria.
2. Only pick a ticket whose **blocked by** tickets are all Done. Move it to **In Progress** and assign it to yourself.
3. Branch from `main` as `<key-lowercase>-<slug>` (for example `core-10-deadlines-feature`), or the branch name your session or Linear gives you.
4. Reuse before you build: grep for the entities and components the ticket mentions.
5. A decision not covered by the ticket or an ADR gets a short ADR in `docs/adr/` (from [`0000-template.md`](docs/adr/0000-template.md)) in the same PR.
6. Open a PR titled `[KEY] Title` whose description says `Closes MAT-N` (Linear links PRs by that id) and links the issue. Fill in the [PR template](.github/pull_request_template.md): map **every** acceptance criterion to evidence.
7. Keep CI green. **Never** skip, disable or `.only` a test.
8. Squash-merge, then move the ticket to **Done**. Follow-ups become new Linear tickets in the same format; don't widen your PR.

## Non-negotiables

- **Tenancy:** everything lives under `orgs/{orgId}/…` (except `users/{uid}` and global reference data). Every query is org-scoped; every function checks the org claim.
- **No secrets** in code or Firestore. Use Secret Manager via `defineSecret`.
- **Legal dates** are `DateOnly` strings (`YYYY-MM-DD`) in the org timezone (default `Australia/Melbourne`). Never a JS `Date` at midnight UTC.
- **Money** is integer cents (AUD). **Time** is integer minutes, shown as 6-minute units.
- **Clerk never writes domain data.** It creates `suggestions` that a human accepts.
- **Privileged material** (`privileged: true`) is never exported, emailed or sent to an integration without an explicit human action, and never shown to read-only roles.
- **Accessibility:** WCAG 2.2 AA, keyboard-first; every chart has a table view.
- **Data residency:** `australia-southeast1` (backups `australia-southeast2`).
- **No PII in logs.** Log ids, not names, emails or document text.
- **No real client data** in code, tests, fixtures or logs. Fictional data only.
- **Legal rules** carry the `Practitioner review` label, store the rule citation and rule-set version with every computed deadline, and ship behind a feature flag until signed off.

## Commands

| Command                                             | What                                                                                                                                                                                                                    |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install`                                      | Install dependencies (Node 22, pnpm 10). Also installs the husky git hooks                                                                                                                                              |
| `pnpm nx run-many -t lint,typecheck,test,build`     | Everything CI checks (FND-04 runs it with `nx affected`)                                                                                                                                                                |
| `pnpm nx affected -t lint,typecheck,test,build`     | The same, for projects changed against `main`                                                                                                                                                                           |
| `pnpm nx test <project>` / `pnpm nx lint <project>` | One project. Projects: `web`, `web-e2e`, `functions`, `jobs`, `doc-services`, `ui`, `data-access`, `domain`, `deadlines`, `clerk`, `test-utils`, `scripts`, `migration`                                                 |
| `pnpm dev`                                          | The whole local stack: emulators, fictional seed data and the web app at http://localhost:4200 (see Run locally)                                                                                                        |
| `pnpm e2e`                                          | Playwright e2e against the dev server. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to use a pre-installed Chromium                                                                                                        |
| `pnpm nx run functions:serve`                       | Build Functions and run them in the emulator (project `demo-materia`)                                                                                                                                                   |
| `pnpm emulators`                                    | All Firebase emulators on their own, without the seed or the web app                                                                                                                                                    |
| `pnpm materia-scripts seed`                         | Wipe the emulators and reseed (`--minimal`, `--scenario=empty`, `--scenario=load`, `--verify`); refuses anything but emulators and `demo-` projects                                                                     |
| `pnpm storybook`                                    | Storybook for `libs/ui` at http://localhost:4400                                                                                                                                                                        |
| `pnpm materia-scripts sync-design`                  | Regenerate `libs/ui/src/generated` and the web fonts from `design/` (needs Python 3.11+; `--check` for CI)                                                                                                              |
| `pnpm materia-scripts rules-sync`                   | Regenerate the role lists and field whitelists in `firebase/*.rules` from `libs/domain` (`--check` for CI)                                                                                                              |
| `pnpm format` / `pnpm format:check`                 | Prettier (skips `docs/` and `design/`)                                                                                                                                                                                  |
| `pnpm nx run clerk:eval --feature=<suite>`          | Clerk evals on the real gateway (`--subset`, `--model=…`, `--provider=fake` for no tokens; needs `CLERK_EVALS_API_KEY` live). See `libs/clerk/evals/README.md`                                                          |
| `pnpm materia-scripts make-fixtures`                | Render the Clerk eval fixture PDFs, typed and scanned (`--check` for CI)                                                                                                                                                |
| `pnpm materia-scripts <command>`                    | Ops scripts (`clerk-bench`, …)                                                                                                                                                                                          |
| `pnpm materia-scripts restore-matter …`             | Restore one matter from a PITR time or a restored database (dry run unless `--apply`); `backup-drill` restores a backup into a scratch database and checks counts (SEC-03; [restore runbook](docs/runbooks/restore.md)) |
| `pnpm materia-scripts decode-stack --maps <dir>`    | Deobfuscate a minified web stack from Error Reporting with a release's private sourcemaps (FND-21; [incident response](docs/runbooks/incident-response.md))                                                             |
| `pnpm materia-migrate <step>`                       | Legacy migration CLI: `audit` (read-only, refuses write-capable credentials) and `check-profile` (MIG-01), `auth-import` (MIG-04); export onwards from MIG-02. See `tools/migration/README.md`                          |
| `python3 design/system/build.py`                    | Regenerate the design system output. `git status` must stay clean afterwards                                                                                                                                            |

### CI jobs locally

CI (`.github/workflows/ci.yml`) runs every job with `nx affected`; `ci-ok` is the single required check. To save Actions minutes its `gate` job trims runs: pushes to `main` run only the fast checks, docs-only changes only lint, and nothing runs on merges in quiet hours (22:00–07:30 Melbourne) until the morning run (a Claude routine dispatches it at 06:31 and 07:31 Melbourne, because GitHub fires this repo's crons hours late), which tests and deploys everything merged overnight. Dispatch `ci` or `deploy-dev` on `main` to deploy overnight. To reproduce a job, run its command (drop `--base/--head` to run everything):

| Job | Local command |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `lint` | `pnpm exec prettier --check . && pnpm nx affected -t lint --base=origin/main && pnpm materia-scripts sync-design --check` |
| `typecheck` | `pnpm nx affected -t typecheck --base=origin/main` |
| `unit` | `pnpm nx affected -t test --base=origin/main --coverage` (thresholds: `domain` and `deadlines` 90%, everything else 70%) |
| `rules` | `pnpm nx run firebase:test-rules` (needs Java; starts the Firestore and Storage emulators; fails below 90% rules coverage, report in `dist/rules-coverage/`). Behind an HTTPS proxy, run it as `env -u HTTPS_PROXY -u https_proxy pnpm nx run firebase:test-rules`: firebase-tools sends even local emulator calls through the proxy, which breaks Storage rules that read Firestore. `pnpm materia-scripts rules-sync --check` checks the generated role lists and whitelists (also a unit test) |
| `integration` | `pnpm nx run functions:test-integration` (builds functions, then runs `apps/functions/tests/integration` against the auth, firestore and functions emulators; needs Java). Behind an HTTPS proxy, prefix `env -u HTTPS_PROXY -u https_proxy`. Then `pnpm nx run scripts:test-seed` (seeds the auth, firestore and storage emulators and validates every document against its schema) |
| `jobs container` | `pnpm nx run jobs:test-container` (builds the jobs bundle, then runs `apps/jobs/tests/integration` with the host's `qpdf` and `CHROMIUM_PATH`). CI builds the image (`docker build -f apps/jobs/Dockerfile -t materia-jobs:ci dist/apps/jobs`) and runs the same tests in it with `JOBS_IMAGE=materia-jobs:ci` |
| `doc-services container` | `pnpm nx run doc-services:test-container` with `SCANNER_IMAGE` and `PREVIEW_IMAGE` set to images built with `docker build -f dist/apps/doc-services/docker/<scanner                                                                                                                                                                                                                                                                                                                                         | preview>.Dockerfile dist/apps/doc-services`(CI builds both after`pnpm nx build doc-services`). Without the variables the suites skip |
| `build` | `pnpm nx affected -t build --base=origin/main --configuration=production && pnpm materia-scripts bundle-size` (gzip budgets: initial ≤ 300 kB, lazy chunk ≤ 150 kB) |
| `e2e` | `pnpm nx build web --configuration=e2e && pnpm nx build functions`, then `BASE_URL=http://127.0.0.1:5000 pnpm exec firebase emulators:exec --only auth,firestore,functions,storage,hosting --project demo-materia --config firebase.json "pnpm exec playwright test -c apps/web-e2e/playwright.config.mts"`. Every page test also calls `expectNoA11yViolations(page)` from `@materia/test-utils/e2e` (axe, WCAG 2.2 AA). PR CI sets `E2E_CHROMIUM_ONLY=1` (no WebKit); the morning run tests both browsers |
| `storybook` | `pnpm nx run ui:build-storybook`, serve `dist/storybook/ui` (for example `python3 -m http.server 6006 -d dist/storybook/ui`), then `pnpm exec test-storybook -c libs/ui/.storybook --url http://127.0.0.1:6006` (play functions and a11y; set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to use a pre-installed Chromium) |
| `terraform` | `terraform -chdir=infra/terraform fmt -check -recursive`, `init -backend=false && validate` (in `infra/terraform` and `bootstrap/`), `tflint --chdir=infra/terraform --recursive`, `checkov -d infra/terraform` |
| `security` | `pnpm audit --prod --audit-level=high` and `gitleaks git --log-opts="origin/main..HEAD" .`. CodeQL runs in CI only, once a day in the morning run (not on PRs or pushes); high-severity (≥ 7.0) findings fail the job |
| `summary` | `pnpm materia-scripts ci-summary --coverage coverage` (the PR comment with coverage and bundle deltas) |

### Workspace rules

- **Path aliases:** `@materia/ui`, `@materia/data-access`, `@materia/domain`, `@materia/deadlines`, `@materia/clerk`, `@materia/test-utils` (in `tsconfig.base.json`). Never import across projects with relative paths.
- **Module boundaries** are enforced by `@nx/enforce-module-boundaries` (root `eslint.config.mjs`). Tags: `type:app|ui|data-access|domain|util` and `scope:web|functions|shared|tools`. `ui` can't import `data-access`; `domain`/`deadlines` can't import Angular, Firebase or RxJS; `apps/web` can't import `firebase/firestore` directly. `tools/scripts/src/module-boundaries.spec.ts` proves it.
- **One version policy:** all dependencies live in the root `package.json`. `tools/*` are pnpm workspace packages only to expose their bins.
- **Zoneless Angular:** the app uses `provideZonelessChangeDetection()` and doesn't ship `zone.js`. Don't add libraries that need zone.js.
- **Functions deploy artefact:** `nx build functions` bundles workspace libs into `dist/apps/functions/main.js` and writes a `package.json` with external dependencies only (no `workspace:` deps). Rules and indexes live in `firebase/`; `firebase.json` and `.firebaserc` are at the root (`--config firebase.json`).
- **Deploys (FND-05)** run only in GitHub Actions: merges to `main` deploy to dev (`deploy-dev.yml`), release tags promote the same build to prod after approval (`deploy-prod.yml`). Never deploy from a session or a laptop. Runbooks: [deploy](docs/runbooks/deploy.md), [rollback](docs/runbooks/rollback.md), [hotfix](docs/runbooks/hotfix.md). Keep `@smoke` e2e tests read-only: they run against prod.
- **firebase-tools is patched** (`patches/firebase-tools@15.32.1.patch`, pnpm `patchedDependencies`): with `FUNCTIONS_EMULATOR_MAX_WORKERS` set, the Functions emulator stops the workers idle longest beyond that many (each is a ~150 MB process; unpatched it keeps one per function ever called). CI's e2e sets 20. Upgrading firebase-tools fails `pnpm install` until the patch is redone with `pnpm patch firebase-tools@<version>`.
- **TypeScript is pinned to 6.0.x** (Angular 22's supported range). Don't upgrade to TypeScript 7 until Angular and Nx support it.

### How to add a callable

Callables live in `apps/functions/src/<domain>/` and are built with `defineCallable` (FND-15). The wrapper checks the auth claims, the role, an active membership (cached 60 s) and the zod input; it adds structured, redacted logging, optional idempotency and error mapping:

```ts
// apps/functions/src/matters/archive.ts
import { z } from 'zod';
import { DomainError, PERMISSIONS } from '@materia/domain';
import { defineCallable } from '../core/callable';

export const archive = defineCallable({
  name: 'matters-archive',
  input: z.object({ requestId: z.uuid(), matterId: z.string().min(1) }),
  roles: PERMISSIONS['matter.close'],
  idempotent: true, // a repeat call with the same requestId returns the stored result
  handler: async ({ input, orgId, uid, db, clock, log }) => {
    const ref = db.doc(`orgs/${orgId}/matters/${input.matterId}`);
    const matter = await ref.get();
    if (!matter.exists) throw new DomainError('NOT_FOUND', 'Matter not found', { matterId: input.matterId });
    await ref.update({ status: 'archived', updatedAt: clock.now(), updatedBy: uid });
    log.info('archived', { matterId: input.matterId }); // ids only; data is redacted anyway
    return { matterId: input.matterId };
  },
});
```

Export it from the group's `index.ts` and the group from `main.ts` (`export * as matters from './matters/index'`), so it deploys as `matters-archive`. Then:

- Throw `DomainError(code, message, details)` for expected failures. Codes live in `libs/domain/src/lib/errors.ts`, and every code needs user copy in `apps/web/src/app/core/error-copy.ts`.
- Unit-test the handler through `runCallable(definition, request, deps)` with fakes (see `system/echo.spec.ts`). Add an emulator test in `apps/functions/tests/integration/` when the wrapper behaviour matters (`pnpm nx run functions:test-integration`).
- Secrets: declare them in `core/secrets.ts`, pass `secrets: [...]`, read `.value()` in the handler. Never read `process.env` for secrets.
- External services go through `ports()` (`apps/functions/src/ports`). Fakes are used in the emulator and with `MATERIA_FAKES=1`.
- Background work: `defineQueue` (with retry config) plus `enqueue(name, payload, { dedupeKey })`. Firestore triggers: `defineTrigger`, which has no retries, an event-id guard and a dead-letter log.
- Never use `console.*` in functions (lint error). Log through `ctx.log`.
- Someone acting before they have a claim for the org (onboarding, accepting an invite, switching org) uses `defineUserCallable` instead, with `idempotent: true` (records in `users/{uid}/requests`). Member roles and statuses change only through the `orgs-*` callables, which keep at least one active owner and resync the claims (FND-17, [ADR-021](docs/adr/021-membership-checked-on-every-org-read.md)). In the emulator, emails land in the server-only `emulatorOutbox` collection (`latestInviteLink` in `@materia/test-utils/e2e` reads invite links from it).

## Run locally

`pnpm i && pnpm dev` starts everything (FND-06): it checks the ports are free, builds functions, starts the Firebase emulators (project `demo-materia`, UI at http://127.0.0.1:4000), seeds the fictional practice if the emulators are empty, and serves the web app with HMR at http://localhost:4200 (`apps/web/src/environments/environment.ts` points at the emulators).

- Emulator data is exported to `.emulator-data/` (gitignored) when you stop with Ctrl+C and imported next time. `pnpm dev --fresh` starts empty, and `pnpm materia-scripts seed` resets to the seed at any time (with the emulators running).
- The seed is **Harbour & Vine Legal**, a fictional wills and estates firm in Geelong (VIC, `Australia/Melbourne`). It has 28 contacts (a few near-duplicates, for CORE-01) and 12 matters covering every matter type and status, plus the CORE-02 conflict-check scenarios (10 more contacts and 6 matters with `c-cf-`/`m-cf-` ids, 5 adverse and 5 benign checks, `conflicts.enforced` on for the org), `templates.system` on with every demo matter on its type's system template (CORE-07), with parties, events, tasks, deadlines (the Doyle estate's computed by the engine with `deadlines.ruleset.vic.v1` on, CORE-10; the rest static), an estate register on the Doyle estate (`estate.register` on for the org, CORE-16: assets including a foreign holding, super and a joint tenancy passing outside the estate, liabilities and two distributions to Thomas), notes, time entries and sample PDFs from `libs/test-utils/fixtures/pdfs/`. Dates are relative to the day you seed, so something is always due today. Everything is invented; never add real client data. `--minimal` (2 matters) and `--scenario=empty` (org and accounts only) are smaller; `--scenario=load` adds 500 generated matters for list performance (CORE-03).
- The dev container (`.devcontainer/`) has Node 22, pnpm, Java 21, Playwright's Chromium, gcloud and Terraform; run `pnpm dev` inside it.

Test accounts (emulator only; password `materia-local-dev` for all). Sign in at http://localhost:4200/auth/sign-in. Sign-up in the emulator is invitation-only, as in prod (FND-16), so use these accounts:

| Role      | Email                           | Name         |
| --------- | ------------------------------- | ------------ |
| owner     | `owner@harbourvine.example`     | Priya Shah   |
| lawyer    | `lawyer@harbourvine.example`    | Jordan Price |
| paralegal | `paralegal@harbourvine.example` | Daniel Kim   |
| readonly  | `readonly@harbourvine.example`  | Sam Lee      |

Each account carries the `orgId` and `role` custom claims, and the rules also check its active member document (FND-17). The sign-in screen arrives with the auth tickets; until then, sign in from the Emulator UI or the Auth emulator REST API.

## Definition of done

- [ ] Acceptance criteria met, with evidence in the PR.
- [ ] Unit tests added; rules tests if rules changed; e2e tests if a user flow changed.
- [ ] Lint, typecheck, tests, build and the bundle budget pass in CI.
- [ ] No new axe violations; keyboard operable.
- [ ] Docs updated (`docs/`, plus the Linear doc if a contract changed).
- [ ] Feature-flagged if incomplete for users or awaiting practitioner review.
- [ ] Audit-log entry written for any new mutation of matter data.

## Labels

`Blocked on human` (waiting on a must-do human item; checklist in the ticket's latest comment), `Needs human` (a step an agent can't do), `Practitioner review` (legal logic needing lawyer sign-off).
