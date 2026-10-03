# ADR-013: Search (⌘K)

- **Status:** Accepted
- **Date:** 2026-10-03
- **Source of truth:** [Architecture & ADRs](https://linear.app/materia-web/document/architecture-and-adrs-b15e1eb322dc) (mirrored in [`docs/01-architecture-and-adrs.md`](../01-architecture-and-adrs.md))

## Decision

- Each searchable document carries a denormalised `search` field: lower-cased prefix tokens of its title, number, client and deceased names, maintained by triggers.
- Queries use `array-contains`, capped at 20 results per collection.
- Upgrade path: a dedicated search service, if a later ADR approves one.

## Changing this decision

Write a superseding ADR in `docs/adr/` (copy [`0000-template.md`](0000-template.md)), link it from the Linear doc, and get it approved in review. Do not change this decision inside a feature PR.
