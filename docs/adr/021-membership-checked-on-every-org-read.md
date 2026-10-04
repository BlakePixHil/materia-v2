# ADR-021: Membership is checked on every org read, and claims follow the member documents

- **Status:** Accepted
- **Date:** 2026-10-04
- **Ticket:** [FND-17](https://linear.app/materia-web/issue/MAT-24)
- **Supersedes:** none (extends ADR-005)

## Context

ADR-005 puts the active org and role in custom claims. An ID token lives for up to an hour, and Firestore rules don't check token revocation, so a claim alone would let a removed or suspended member keep reading for up to an hour. FND-17 needs removed members to lose access on their next request, and a role change to apply within a minute without signing out. Some people (onboarding, invitees, org switchers) also have no claim for the org they are acting on, so `defineCallable`, which requires one, can't serve them.

## Decision

- **Rules:** `inOrg(orgId)` checks the claim *and* that `orgs/{orgId}/members/{uid}` is `active` (one `get()`, cached for the request). The collection-group rules do the same for the claimed org.
- **Claims:** the member documents are the source of truth. `syncClaims` (`apps/functions/src/orgs/claims.ts`) computes `{orgId, role, orgName, orgs}` from them, keeps other claims (`platformAdmin`), and mirrors `orgIds`, `memberships` and `activeOrgId` on `users/{uid}`. `claimsVersion` goes up only when the claims change, after they are set. The orgs callables call it directly (so the caller's next token is right) and the `auth-syncClaims` trigger calls it on every member write (console edits, migrations).
- **Client:** (FND-19 replaced this with a snapshot listener, see ADR-024.) The web app re-reads `users/{uid}` every 30 seconds (and when the tab becomes visible) with the Firestore Lite SDK, and refreshes the ID token when `claimsVersion` changes. A snapshot listener would need the full SDK, whose chunk is over the 150 kB lazy budget.
- **Callables without an org claim** (`orgs-createOrg`, `orgs-acceptInvite`, `orgs-switchActiveOrg`) are person-level `defineUserCallable`s with `idempotent: true`, keyed per person in `users/{uid}/requests/{requestId}`.
- **Member role and status, `users/{uid}.activeOrgId`** are server-owned: only the callables change them, so the last-owner invariant and the claims stay in step.

## Consequences

- Every org read costs one extra document read (cached within a request and within a listener's start). This is the price of immediate revocation.
- The callable wrapper still caches membership for 60 seconds per instance (FND-15), so a removed member's callables can run for up to a minute on a warm instance; their Firestore reads stop at once, and their refresh tokens are revoked when the org was their active one.
- With more than 20 orgs, the `orgs` claim carries only the active org; the rules don't use `orgs`, so nothing breaks, but code that wants the full list reads `users/{uid}.memberships`.
- FND-19 may replace the 30-second re-read with a listener if the data layer brings in the full Firestore SDK.

## Alternatives considered

- **Claims only, with token revocation:** revocation doesn't reach Firestore rules, so a removed member reads for up to an hour.
- **A `revoked/{uid}` marker checked with `exists()`:** the same per-read cost as checking the member document, and one more thing to keep in sync.
- **A full-SDK listener on `users/{uid}`:** exceeds the lazy-chunk budget today.
