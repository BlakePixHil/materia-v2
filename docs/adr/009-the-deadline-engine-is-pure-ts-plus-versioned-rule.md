# ADR-009: The deadline engine is pure TS plus versioned rule-set data

- **Status:** Accepted
- **Date:** 2026-10-03
- **Source of truth:** [Architecture & ADRs](https://linear.app/materia-web/document/architecture-and-adrs-b15e1eb322dc) (mirrored in [`docs/01-architecture-and-adrs.md`](../01-architecture-and-adrs.md))

## Decision

- See *Deadline engine & legal rules*.
- Rule sets are immutable once published; a new version is a new document.
- Every computed deadline stores `{ruleId, ruleSetVersion, inputs, trace}`.

## Changing this decision

Write a superseding ADR in `docs/adr/` (copy [`0000-template.md`](0000-template.md)), link it from the Linear doc, and get it approved in review. Do not change this decision inside a feature PR.
