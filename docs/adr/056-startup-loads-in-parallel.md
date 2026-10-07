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

## Update: side-effect-free libraries (MOB-02, 2026-10-07)

`libs/ui` and `libs/data-access` now carry a `package.json` with `"sideEffects": false`, as `libs/domain` has since CORE-01. Without it the bundler kept every module a barrel re-exports, because importing a module might have run code: the whole UI library (543 kB raw) sat in the initial chunks, and the repository barrel pulled every collection's schemas into Today's first load. With it, a page gets only the components and repositories it uses: the initial JS fell from 264 kB to 121 kB gzip, and building Zod schemas at start-up from about 470 ms to 270 ms of main-thread time on a 4× slower CPU. None of the three libraries runs code at import time; a new library with a barrel gets the same `package.json`, and a module that must run on import doesn't belong in one.

## Update: less start-up work on a phone's Today (MOB-02b, 2026-10-07)

Mobile Lighthouse scored Today 79 locally (median of 7, emulators, simulated 4× CPU), held down by total blocking time (777 ms). A profile showed Zod schemas built as modules loaded, and the shell and Today loading code for pages they don't show: the sidebar's pinned matters came from the Matters list's file, which brought matter filters, intake, contacts (with libphonenumber's metadata) and the org records; Today's deadline and task actions loaded every dialog; and the event kind labels came from the matter page's file.

We now:

- build each entity's schemas on first use: `withMeta` takes the field shape as a function, and `schema`, `create` and `update` are built separately, so a page that only reads never builds the write schemas. A module that needs a field's schema reads `X.schema.shape`, which builds that entity's stored schema then;
- keep modules a page imports small: the pinned matters repository has its own file, the migration run, notification and task template entities have their own schema files, `BILLING_CALLABLES` and the financial year helpers moved next to their users, and a feature's dialogs load when one opens (`await import()`), as the checklist dialogs already did;
- skip ng-primitives' hover tracking when nothing on the device can hover (`(any-hover: none)`): it gave every button a ResizeObserver and a style read as it rendered;
- on a phone, draw Today's cards below My tasks (the numbers, Due today and this week, Recent matters) as they scroll into view (`@defer (on viewport)`). They are the page's last cards, so nothing below them moves when they arrive. On a larger screen they're drawn with the rest.

Code loaded for the shell and Today fell from 1,284 kB to 1,022 kB raw, and libphonenumber is off the start-up path. Locally the median rose from 79 to 82, with total blocking time 643–660 ms over three sets of seven runs (±3 points between sets on this machine). What remains is Angular's first render, the Firestore SDK and its cache, and Zod schemas for the collections Today reads.

## Update: Google's scripts off a phone's start-up (MOB-02b, 2026-10-07)

The first measurement on dev (`materia-scripts demo-lighthouse`, five runs as the demo owner, before the deploy carrying the change above) scored Today 61: total blocking time 1,032 ms, LCP 3.6 s. Two pieces of Google code the emulators never load were the largest costs the app controls:

- **reCAPTCHA Enterprise**, loaded and run by App Check's provider as App Check starts, even when the token saved last time is still valid: 1.6 s of main-thread time on the simulated phone, and six long tasks (about 480 ms of the blocking time).
- **Firebase Auth's pop-up helper** (Google's gapi script and a frame from the auth domain). On phones and in Safari, Auth loads it as it starts, so the Google pop-up can open the moment it's tapped, and restores the session only once the frame is ready: each signed-in start-up waited for two more sites before the shell could draw.

We now:

- give App Check a provider that loads reCAPTCHA when App Check asks it for a new token (`OnDemandReCaptchaEnterpriseProvider`). App Check asks only when it has no valid saved token, or when renewing one (tokens last 12 hours and renew after about 6), exactly when the SDK's provider would have run reCAPTCHA. Tokens, their checks and enforcement are unchanged;
- create Auth with the same persistence and helper as `getAuth`, but with the helper's start-up loading turned off (`onDemandPopups`). On phones and in Safari it loads when a screen that offers Google shows: when the session is signed out (the sign-in screen is next), and when a Google account is asked to sign in again (the confirm-it's-you dialog and two-step setup). Desktop Chrome and Firefox load it on first use, as before.

Both rely on members the Firebase SDK marks internal (`initialize` and `getToken` on App Check providers, `_shouldInitProactively` and `_initialize` on the pop-up helper). A unit test fails if App Check's are renamed. If the pop-up helper's are, Auth either loads the helper as it starts again (slower) or loads it when Google is tapped, where a phone may fall back to the redirect sign-in.

## Alternatives considered

- **Raise the initial budget and load Auth and the Firestore SDK up front:** measured above for Auth (no net gain); the SDK (about 150 kB gzip) would make the sign-in screens heavier for the same parallelism the bootstrap download already gives.
- **`PreloadAllModules`:** starts every download the moment the first page is up, competing with that page's reads.
- **Keep `canMatch` and match the URL against the route table ourselves:** duplicates the router's matching for the same result.
