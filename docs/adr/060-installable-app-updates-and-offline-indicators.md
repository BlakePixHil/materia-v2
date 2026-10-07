# ADR-060: The installable app: service worker, updates and offline indicators

- **Status:** Accepted
- **Date:** 2026-10-07
- **Ticket:** [MOB-01](https://linear.app/materia-web/issue/MAT-106)
- **Builds on:** [ADR-020](020-offline-and-pwa.md) (offline and PWA), [ADR-024](024-full-firestore-sdk-in-two-lazy-chunks.md) (Firestore SDK), [ADR-056](056-startup-loads-in-parallel.md) (initial budget)

## Context

ADR-020 chose the Angular service worker for the app shell and Firestore's persistent cache for data, with callables showing "Needs connection" offline. MOB-01 makes that real: Materia installs from Chrome, Edge and Safari, starts with no connection after one visit, never leaves someone on a stale build after a deploy, and says plainly when it's offline or holding changes that haven't synced.

Three details of the Angular service worker shape the design. Its `freshness` navigation strategy has no timeout, so on a slow connection a navigation waits for the network however long it takes. It answers every request in its scope, including cross-origin ones, unless something else answers first. And with `serviceWorker` set, the application builder stops writing `modulepreload` links for the initial chunks, which slows start-up and hides those chunks from `pnpm materia-scripts bundle-size`.

## Decision

**Service worker.** We will register `sw.js` (`apps/web/public/sw.js`), a small wrapper that imports `ngsw-worker.js`:

- Cross-origin requests (Firestore, Functions, Auth, App Check) and Firebase's reserved `/__/` paths go straight to the network: the wrapper's fetch listener stops the Angular worker from seeing them.
- A navigation that hasn't answered in 4 seconds falls back to the cached `index.html` (the `freshness` strategy plus a timeout).
- `ngsw-config.json` prefetches the shell (index, manifest, icons, fonts, `main`, `polyfills`, `styles`) and caches route chunks lazily. It has no `dataGroups`: the service worker never caches an API response. Firestore keeps its own cache (ADR-020).
- Registration waits until the app is stable (30 s at most). Hosting serves the worker scripts with `Cache-Control: no-cache`, so a deploy is seen on the next check.
- The worker installs after the first page has loaded, so it never saw that page's files. Once it takes control, `OfflineCache` fetches them again through it (from the HTTP cache), which makes the second start work offline.
- `index.preloadInitial: true` in `apps/web/project.json` keeps the `modulepreload` links.

**Manifest and icons.** `manifest.webmanifest` names the app "Materia", opens at `/` in a standalone window, and has shortcuts to Today, New time entry (`/today?do=new-time-entry`) and Record (`/record`, which MOB-02 takes over). The icons (192 and 512, plain and maskable) are rendered from `design/assets/logos/square-white-logo.svg`. The `theme-color` metas use `bg-surface` for light and dark, and follow the theme chosen in Materia once the app runs.

**Install.** The browser's install prompt is held, never shown on its own. "Install Materia" appears in the user menu and ⌘K while the browser offers it. On iOS, which has no prompt, it opens the Add to Home Screen steps (a bottom sheet on a phone). There is no banner.

**Updates.**

- When a new version is ready, a toast that stays says "New version available" with Reload. The app checks 60 seconds after start, every 30 minutes while visible, and on return to a tab left for 30 minutes.
- Reload tells the other tabs over the `materia-app-updates` `BroadcastChannel`, activates the new version, waits up to 10 seconds for unsynced changes, then reloads. Every tab moves to the new version together.
- An `unrecoverable` service worker state unregisters the worker and reloads.

**Compatibility version.** `CLIENT_COMPAT_VERSION` in `@materia/domain` is built into both sides. `system-ping` (the API's health check; the web app's `/health` page is the client's) returns it as `minClientVersion`, and the client checks it alongside each update check. A client older than the API asks once, "Reload to keep working", with "Save my work first" leaving a reload toast that stays. Raise the number in the deploy that removes a callable, adds a required input, or changes a result shape an older client reads. Additive changes don't need it.

**Offline indicators.**

- A banner says "You're offline" after 3 seconds offline, or after 10 seconds online with every live listener still on cached data (the server can't be reached). Pages that have their own offline note (Today, Inbox, Matters, Contacts, Team, a matter) mark it with `mtPageOfflineNote`, and the banner stays away so it isn't said twice. Coming back shows "Back online".
- A "Pending sync" chip in the top bar counts documents with `hasPendingWrites` in the live listeners, or this page's unacknowledged writes when that's more. Offline it shows at once; online, only when a change takes more than 2 seconds.
- Callables fail at once offline with "Needs connection" (`offlineError()`), and a retry stops when the connection drops. Buttons whose action is a callable carry `mtNeedsConnection`: offline they read "Needs connection" and are soft-disabled.

**What works offline.** Anything already read on this device opens from the cache. Writes on client-direct paths save on the device and sync on reconnect:

| Works offline | Needs a connection |
| --- | --- |
| Today, matters, tasks, contacts, deadlines and notes already loaded | Opening data never loaded on this device |
| Create, edit and complete tasks | New matters, stage and status changes (callables) |
| Draft and save notes | Deadline recompute and court-rule changes |
| Record time and run the timer | Invoices: issuing, payments, credit notes, voids, PDFs |
| Record disbursements | Clerk, document generation, conflict checks |
| | Exports, invites, integrations and Xero |

Signing out with unsynced changes still warns first (FND-19).

## Consequences

- A deploy reaches open tabs within 30 minutes, or on the next return to the tab. People choose when to reload, unless the API has moved past their build.
- Every deploy writes a new `ngsw.json`, so a changed service worker config is live on the next check. Turning the worker off means serving Angular's `safety-worker.js` as `sw.js`, which unregisters it.
- A deploy that breaks old clients must raise `CLIENT_COMPAT_VERSION` in the same PR. Review is the only check.
- The e2e suite blocks service workers (`playwright.config.mts`) except `pwa.spec.ts`, which runs on the built app and covers installability, an offline start and the update flow.
- WebKit and Firefox don't run `pwa.spec.ts`: the installability check is Chromium's DevTools protocol.

## Alternatives considered

- **A custom Workbox worker.** More control, but it duplicates what `@angular/service-worker` already does with the build's hash table, and it adds a dependency and a build step.
- **Caching API responses in the worker.** Firestore already caches reads with consistency the worker can't give. Caching callables would replay stale results.
- **An install banner.** People find it pushy. The menu item and ⌘K are where they look when they want it.
- **Reloading automatically on a new version.** It would lose unsaved forms. Only an incompatible API forces the question, and even then the person can save first.
