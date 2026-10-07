# ADR-015: Email

- **Status:** Accepted; the provider superseded by [ADR-057](057-resend-email.md) (Resend, 2026-10-07)
- **Date:** 2026-10-03
- **Source of truth:** [Architecture & ADRs](https://linear.app/materia-web/document/architecture-and-adrs-b15e1eb322dc) (mirrored in [`docs/01-architecture-and-adrs.md`](../01-architecture-and-adrs.md))

## Decision

- Transactional email goes through Postmark via a function, with templates in the repo.
- Inbound email-to-matter uses Postmark inbound webhooks.
- The provider is swappable behind `MailPort`.

## Changing this decision

Write a superseding ADR in `docs/adr/` (copy [`0000-template.md`](0000-template.md)), link it from the Linear doc, and get it approved in review. Do not change this decision inside a feature PR.
