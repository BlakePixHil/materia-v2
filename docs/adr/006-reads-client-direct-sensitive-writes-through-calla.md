# ADR-006: Reads client-direct; sensitive writes through callables

- **Status:** Accepted
- **Date:** 2026-10-03
- **Source of truth:** [Architecture & ADRs](https://linear.app/materia-web/document/architecture-and-adrs-b15e1eb322dc) (mirrored in [`docs/01-architecture-and-adrs.md`](../01-architecture-and-adrs.md))

## Decision

- Simple single-document writes (edit a task title) go client-direct, validated by rules.
- Callables (`onCall`, zod-validated) handle:
  - multi-document invariants: matter numbering, invoice numbering, deadline recompute, accepting a suggestion;
  - anything privileged;
  - anything touching secrets or external APIs.
- Every callable is idempotent, using a client-provided `requestId` stored for 24 h.

## Changing this decision

Write a superseding ADR in `docs/adr/` (copy [`0000-template.md`](0000-template.md)), link it from the Linear doc, and get it approved in review. Do not change this decision inside a feature PR.
