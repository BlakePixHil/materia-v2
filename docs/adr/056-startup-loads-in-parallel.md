# ADR-056: Start-up loads in parallel and the initial budget stays at 300 kB

- **Status:** Accepted
- **Date:** 2026-10-07
- **Ticket:** none (Blake's report that dev feels slow, 2026-10-07)
- **Builds on:** [ADR-002](002-angular-latest-stable-20.md) (lazy features), [ADR-016](016-feature-flags.md) (flags), [ADR-024](024-full-firestore-sdk-in-two-lazy-chunks.md) (Firestore SDK chunks)

## Context

A signed-in reload of `/today` ran nine steps one after another: the initial chunks, the auth chunk, the chunks it imports, Auth restoring the session (an `accounts:lookup` call), the Firestore SDK chunks, the org policy listener the shell's guard waits for, the shell and Today chunks (three levels of imports), the flag source chunk and its Installations chunk, then Today's queries. The router loads a route's chunks only after its guards pass, and the shell's guard was a `canMatch`, so nothing about the page could download until Auth and Firestore had answered. Feature flags waited for a Remote Config fetch (every minute on dev), so flagged navigation and tabs appeared after the shell. Each dev deploy replaces every chunk, so the first visit to each page after a deploy waited for its downloads too.

Auth and Firestore also wait for an App Check token before their first request. Tokens last the default hour, so a page opened after a break waits for a reCAPTCHA Enterprise assessment before Auth can even restore the session.

Measured on a local replica (Hosting, Auth and Firestore emulators, the seeded practice, Chromium with 40 ms latency per request and 50 Mbps), median of five:

| | Before | After |
| --- | --- | --- |
| Reload after a deploy: shell drawn | 913 ms | 707 ms |
| Reload after a deploy: Today's data | 1,282 ms | 1,028 ms |
| Reload, chunks cached: Today's data | 812 ms | 777 ms |
| After a deploy: Today → Matters list | 235 ms | 140 ms |
| After a deploy: Matters → a matter | 298 ms | 164 ms |
| After a deploy: Matters → Contacts | 250 ms | 152 ms |

## Decision

We will:

- start the Firestore SDK download at bootstrap (`FIRESTORE_SDK_LOADER`), in parallel with Auth; Firestore itself still starts on the first read, so the shared-computer cache choice still applies;
- guard the shell with `canActivate` instead of `canMatch`, and on each `GuardsCheckStart` call every `loadComponent` in the target tree (`prefetchPagesDuringGuards`), so a navigation's chunks download while its guards wait. Redirects now run before the shell's guard, so a redirect that reads the session (Settings' landing page) awaits `AuthState.whenReady()`;
- preload every other lazy page in the background, one at a time, from three seconds after a navigation (`DelayedPreloading`), skipped under Save-Data or 2G; a route opts out with `data: { preload: false }`;
- construct `FeatureFlagService` at bootstrap, and apply the Remote Config values this device fetched last at once, with the fetch replacing them when it lands (the very first load still waits for it);
- keep the initial bundle budget at 300 kB: moving Auth (with Firebase app, App Check and Functions, about 41 kB gzip) into the initial bundle saved 40 ms on a cached reload and cost 40 ms after a deploy, which doesn't pay for the budget.

## Consequences

- The first screen arrives about 20% sooner after a deploy, and pages opened later don't wait for chunks. Background preloading downloads the remaining page chunks once per deploy (most of the 1.1 MB of lazy chunks; the PDF viewer and Clerk's heavier pieces load inside their pages and aren't preloaded).
- App Check tokens last 12 hours instead of one, set by hand in the Firebase console (recorded in `infra/MANUAL.md`, since Terraform would need each environment's site key in tfvars, which CI's secret scan rejects). A page opened after a break no longer waits for a reCAPTCHA assessment. A stolen token stays usable for up to 12 hours; App Check is abuse protection, and rules and callables still check the user, role and membership.
- Today's data still waits for its server-only reads (counts, one-shot queries and the matter lookups that follow the deadlines). That is Today's own design (ADR-029) and isn't changed here.
- Callables are separate Cloud Run services (about 130), so the first call to each after it has idled starts a cold instance (estimated 2–3 s). Keeping one warm costs about A$17 a month per function; the owner chose to leave them as they are (2026-10-07).

## Alternatives considered

- **Raise the initial budget and load Auth and the Firestore SDK up front:** measured above for Auth (no net gain); the SDK (about 150 kB gzip) would make the sign-in screens heavier for the same parallelism the bootstrap download already gives.
- **`PreloadAllModules`:** starts every download the moment the first page is up, competing with that page's reads.
- **Keep `canMatch` and match the URL against the route table ourselves:** duplicates the router's matching for the same result.
