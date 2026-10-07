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
- **Accessibility:**
  - Every e2e page visit runs `expectNoA11yViolations(page)` (axe, WCAG 2.2 A and AA tags); `expectNoA11yViolationsInThemes(page)` scans the light and the dark theme.
  - `a11y.spec.ts` runs the scripted WCAG checks on every PR: keyboard walks with visible, unobscured focus (also in forced colours), landmarks and headings, reflow at 320 px and 640 px, reduced motion, paste and autocomplete on sign-in, live regions, dragging alternatives, consistent help and phone target sizes.
  - `a11y-audit.spec.ts` (tagged `@audit`) scans every route, matter tab, settings page and key dialog in both themes, plus a phone pass. It takes 7 to 9 minutes of test time, so PRs skip it (`--grep-invert @audit`) and the morning run covers it. A new route belongs in its list.
  - The audit report and the screen reader checklist are in `docs/accessibility/` (SEC-06).
- **Rules coverage:** the emulator rules coverage report is uploaded in CI. New `match` blocks need tests.

## Test data factories

`libs/test-utils` exports `makeOrg()`, `makeMember(role)`, `makeMatter(type)`, `makeDeadline()`, `makeDocument()` and so on. Each one is built from the zod schemas, so a factory can't produce an invalid entity.

## Quality gates (CI)

- Coverage: `domain` and `deadlines` ≥ 90% lines, functions ≥ 75%, web ≥ 60%.
- Bundle: initial JS ≤ 300 kB gzip, and each lazy route ≤ 150 kB.
- Lighthouse CI on the preview: performance ≥ 85 (mobile), accessibility = 100 on the key screens.
- Zero high or critical findings from `pnpm audit` or CodeQL.
