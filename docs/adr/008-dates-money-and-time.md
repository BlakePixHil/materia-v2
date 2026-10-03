# ADR-008: Dates, money and time

- **Status:** Accepted
- **Date:** 2026-10-03
- **Source of truth:** [Architecture & ADRs](https://linear.app/materia-web/document/architecture-and-adrs-b15e1eb322dc) (mirrored in [`docs/01-architecture-and-adrs.md`](../01-architecture-and-adrs.md))

## Decision

- Legal and calendar dates are stored as `DateOnly` strings `YYYY-MM-DD`.
- Instants are Firestore `Timestamp`.
- Org timezone defaults to `Australia/Melbourne`; day arithmetic uses the Temporal polyfill (`@js-temporal/polyfill`) or `date-fns-tz`, never naive `Date` maths.
- Money is integer cents (AUD).
- Time is integer minutes; billing units are 6 minutes, with the rounding mode set in org settings.

## Changing this decision

Write a superseding ADR in `docs/adr/` (copy [`0000-template.md`](0000-template.md)), link it from the Linear doc, and get it approved in review. Do not change this decision inside a feature PR.
