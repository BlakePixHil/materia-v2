# ADR-017: Testing stack

- **Status:** Accepted
- **Date:** 2026-10-03
- **Source of truth:** [Architecture & ADRs](https://linear.app/materia-web/document/architecture-and-adrs-b15e1eb322dc) (mirrored in [`docs/01-architecture-and-adrs.md`](../01-architecture-and-adrs.md))

## Decision

- Vitest for unit tests in libs and functions.
- Angular testing with Vitest.
- `@firebase/rules-unit-testing` against the emulator.
- Playwright e2e against emulators plus the built app.
- axe-core in e2e.
- Storybook for `libs/ui`, with interaction tests.

## Changing this decision

Write a superseding ADR in `docs/adr/` (copy [`0000-template.md`](0000-template.md)), link it from the Linear doc, and get it approved in review. Do not change this decision inside a feature PR.
