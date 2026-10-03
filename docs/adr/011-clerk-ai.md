# ADR-011: Clerk (AI)

- **Status:** Accepted
- **Date:** 2026-10-03
- **Source of truth:** [Architecture & ADRs](https://linear.app/materia-web/document/architecture-and-adrs-b15e1eb322dc) (mirrored in [`docs/01-architecture-and-adrs.md`](../01-architecture-and-adrs.md))

## Decision

- Claude `claude-opus-5-5` sits behind `ClerkGateway` (in functions only).
- The provider is chosen by the AI-01 spike. Order of preference: Claude on Vertex AI in an Australian region → Claude Platform/Bedrock in Sydney → Anthropic API with zero data retention, but only with an explicit privacy sign-off.
- Clerk outputs structured proposals with citations, never direct writes.
- See the Clerk doc.

## Refinements

- [ADR-011a: Clerk provider and Australian data residency](ADR-011a-clerk-provider.md) (accepted for the MVP: Anthropic API).

## Changing this decision

Write a superseding ADR in `docs/adr/` (copy [`0000-template.md`](0000-template.md)), link it from the Linear doc, and get it approved in review. Do not change this decision inside a feature PR.
