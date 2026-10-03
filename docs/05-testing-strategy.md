# Testing & quality strategy

## Pyramid

| Layer | Tool | What | Where |
|---|---|---|---|
| Unit (pure) | Vitest | domain schemas, money/time/date utils, the deadline engine (with property tests through `fast-check`), migration transforms | `libs/*/src/**/*.spec.ts`, `tools/migration/**/*.spec.ts` |
| Component | Vitest + Angular Testing Library | `libs/ui` components: states, a11y roles, keyboard | `libs/ui/**/*.spec.ts` |
| Visual/interaction | Storybook + test-runner | every `libs/ui` component has stories for all states in light and dark | `libs/ui/**/*.stories.ts` |
| Rules | `@firebase/rules-unit-testing` | for every collection, an allow and a deny case per role, cross-org denial, field validation | `firebase/tests/*.rules.spec.ts` |
| Functions integration | Vitest + emulators | callables and triggers against emulated Firestore, Auth and Storage; external APIs faked behind ports | `apps/functions/**/*.int.spec.ts` |
| E2E | Playwright + emulators | user flows, axe scan per page, mobile viewport for MOB tickets | `apps/web-e2e/` |
| AI evals | custom runner (`libs/clerk/evals`) | golden sets, graded per the Clerk doc. Nightly, plus on prompt changes | `libs/clerk/evals/**` |
| Load | k6 | hot callables, plus collection-group queries at 10× expected volume | `tools/load/` |

## Rules

- **Fictional data only** in fixtures and seeds. Never copy legacy or production data into tests.
  - Seed personas: "Margaret Doyle (deceased)", "Nguyen v Nguyen" and so on, as in the mocks.
- **Time is injectable.** Use a `Clock` port, and never call `Date.now()` in domain code. Tests pin `Australia/Melbourne` and cover DST transitions on the first Sunday in October and in April.
- **External services sit behind ports:**
  - `ClerkModelPort`, `MailPort`, `CalendarPort`, `XeroPort`, `TranscriptionPort`, `EmbeddingPort`, `MalwareScanPort`.
  - Tests use in-memory fakes.
  - Contract tests against real sandboxes run only in a nightly job with secrets.
- **Every bug fix** adds a failing test first.
- **Flaky tests are bugs.** Fix the cause; never retry-to-green, and never use `test.skip` to merge.
- **E2E selectors:** use roles and labels (`getByRole`). Add `data-testid` only where no accessible handle exists.
- **Accessibility:** every e2e page visit runs `checkA11y()`. Serious and critical violations fail the run.
- **Rules coverage:** the emulator rules coverage report is uploaded in CI. New `match` blocks need tests.

## Test data factories

`libs/test-utils` exports `makeOrg()`, `makeMember(role)`, `makeMatter(type)`, `makeDeadline()`, `makeDocument()` and so on. Each one is built from the zod schemas, so a factory can't produce an invalid entity.

## Quality gates (CI)

- Coverage: `domain` and `deadlines` ≥ 90% lines, functions ≥ 75%, web ≥ 60%.
- Bundle: initial JS ≤ 300 kB gzip, and each lazy route ≤ 150 kB.
- Lighthouse CI on the preview: performance ≥ 85 (mobile), accessibility = 100 on the key screens.
- Zero high or critical findings from `pnpm audit` or CodeQL.
