# ADR-004: Three environments, three projects

- **Status:** Accepted
- **Date:** 2026-10-03
- **Source of truth:** [Architecture & ADRs](https://linear.app/materia-web/document/architecture-and-adrs-b15e1eb322dc) (mirrored in [`docs/01-architecture-and-adrs.md`](../01-architecture-and-adrs.md))

## Decision

- The projects are `materia-v2-dev`, `materia-v2-staging` and `materia-v2-prod`. Final ids are set in FND-03.
- All of them are provisioned with Terraform.
- No manual console changes except where Terraform has no support. Those are recorded in `infra/MANUAL.md`.

## Changing this decision

Write a superseding ADR in `docs/adr/` (copy [`0000-template.md`](0000-template.md)), link it from the Linear doc, and get it approved in review. Do not change this decision inside a feature PR.
