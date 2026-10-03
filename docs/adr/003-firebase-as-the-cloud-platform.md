# ADR-003: Firebase as the cloud platform

- **Status:** Accepted
- **Date:** 2026-10-03
- **Source of truth:** [Architecture & ADRs](https://linear.app/materia-web/document/architecture-and-adrs-b15e1eb322dc) (mirrored in [`docs/01-architecture-and-adrs.md`](../01-architecture-and-adrs.md))

## Decision

- Services: Firestore (Native), Identity Platform, Functions v2, Storage, Hosting, App Check (reCAPTCHA Enterprise), Remote Config, FCM.
- Region `australia-southeast1` (Sydney) for everything regional.
- Why Firebase: the team knows it, the rules give us client-direct reads with server-enforced tenancy, and the legacy user's data is already on Firebase, so migration is Admin-SDK to Admin-SDK.

## Changing this decision

Write a superseding ADR in `docs/adr/` (copy [`0000-template.md`](0000-template.md)), link it from the Linear doc, and get it approved in review. Do not change this decision inside a feature PR.
