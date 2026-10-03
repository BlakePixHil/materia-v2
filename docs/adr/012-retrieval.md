# ADR-012: Retrieval

- **Status:** Accepted
- **Date:** 2026-10-03
- **Source of truth:** [Architecture & ADRs](https://linear.app/materia-web/document/architecture-and-adrs-b15e1eb322dc) (mirrored in [`docs/01-architecture-and-adrs.md`](../01-architecture-and-adrs.md))

## Decision

- Document text is chunked into `orgs/{orgId}/matters/{matterId}/documents/{docId}/chunks/{n}`, with embeddings from Vertex AI text embeddings in `australia-southeast1`.
- Retrieval uses Firestore vector search (`findNearest`), pre-filtered by `orgId` and `matterId`.
- No third-party search SaaS in v1 (data residency).

## Changing this decision

Write a superseding ADR in `docs/adr/` (copy [`0000-template.md`](0000-template.md)), link it from the Linear doc, and get it approved in review. Do not change this decision inside a feature PR.
