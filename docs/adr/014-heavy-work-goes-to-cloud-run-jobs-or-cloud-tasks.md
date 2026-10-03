# ADR-014: Heavy work goes to Cloud Run jobs or Cloud Tasks

- **Status:** Accepted
- **Date:** 2026-10-03
- **Source of truth:** [Architecture & ADRs](https://linear.app/materia-web/document/architecture-and-adrs-b15e1eb322dc) (mirrored in [`docs/01-architecture-and-adrs.md`](../01-architecture-and-adrs.md))

## Decision

- Anything over 60 s or 1 GiB (PDF compile, court book, bulk OCR, migration) runs as a Cloud Run job or a Cloud Tasks-driven function with checkpointing.
- No long work in triggers.

## Changing this decision

Write a superseding ADR in `docs/adr/` (copy [`0000-template.md`](0000-template.md)), link it from the Linear doc, and get it approved in review. Do not change this decision inside a feature PR.
