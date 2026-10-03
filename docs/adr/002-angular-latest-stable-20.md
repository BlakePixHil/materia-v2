# ADR-002: Angular, latest stable (≥ 20)

- **Status:** Accepted
- **Date:** 2026-10-03
- **Source of truth:** [Architecture & ADRs](https://linear.app/materia-web/document/architecture-and-adrs-b15e1eb322dc) (mirrored in [`docs/01-architecture-and-adrs.md`](../01-architecture-and-adrs.md))

## Decision

- Standalone components, zoneless change detection, signals, OnPush.
- New control flow (`@if`/`@for`), and `inject()` instead of constructor DI.
- Routing is lazy per feature.
- ng-primitives provides behaviour; the `mt-*` CSS from the design system provides the look.
- No Angular Material.

## Changing this decision

Write a superseding ADR in `docs/adr/` (copy [`0000-template.md`](0000-template.md)), link it from the Linear doc, and get it approved in review. Do not change this decision inside a feature PR.
