# ADR-023: Single-user MVP drops owner-only gates

- **Status:** Accepted
- **Date:** 2026-10-04
- **Ticket:** [FND-16](https://linear.app/materia-web/issue/MAT-21), [CORE-09](https://linear.app/materia-web/issue/MAT-39), [AI-01b](https://linear.app/materia-web/issue/MAT-120), [FND-01a](https://linear.app/materia-web/issue/MAT-119)

## Context

Several tickets were parked as "Blocked on human" on owner steps sized for a multi-user launch: console checks, acceptance
recordings, repository settings, a provider benchmark and a practitioner sign-off before the deadline engine counted as
done. The MVP has one user, the owner, who asked on 2026-10-04 for agents to do everything they can and to drop process that
only pays off at scale. The deploy pipeline (FND-05) is out of scope here; it is being handled separately.

## Decision

We will treat these owner steps as follows:

- **Identity Platform (FND-16).** Agents run `infra/scripts/auth-policy.sh` with the `terraform-agent` identity (done for dev
  and prod). The email action URL stays on Firebase's default handler until the app is deployed. Prod sign-up stays
  invite-only; the owner's account arrives through MIG-04. The scripted acceptance run is replaced by the owner's first real
  use of dev. Google sign-in stays an optional console click (the OAuth client has no API).
- **Deadline engine (CORE-09).** The engine is done. Practitioner sign-off of rule set v1 and the court closure dates moves to
  CORE-09a, which blocks nothing. The rules stay behind their feature flag until CORE-09a is done. Agents checked the public
  holiday calendars against the statutory rules.
- **Clerk hello call (AI-01b).** Canceled: BYOK (AI-02a) replaces the platform key, and its first real call proves the route.
- **Repository settings (FND-01a).** Canceled: agents merge only when `ci-ok` is green. Branch protection remains optional.

## Consequences

Nothing in the MVP critical path waits on the owner except the optional Google sign-in click. Before a second user or firm is
onboarded, revisit: branch protection, a scripted auth acceptance run, the custom email action URL, and the practitioner
sign-off (CORE-09a).

## Alternatives considered

- Keep the gates and batch them for the owner: rejected, the owner asked for the minimum human work.
- Open prod sign-up: rejected, invite-only costs nothing for one user and keeps strangers out of prod.
