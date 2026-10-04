# ADR-024: The full Firestore SDK loads lazily in two chunks

- **Status:** Proposed
- **Date:** 2026-10-04
- **Ticket:** [FND-19](https://linear.app/materia-web/issue/MAT-27)
- **Supersedes:** none (updates the client detail of ADR-021)

## Context

FND-19 brings in the full Firestore SDK: snapshot listeners, the persistent multi-tab cache (ADR-020) and offline writes. CI fails any lazy chunk over 150 kB gzip, and the ticket says to load the SDK outside the initial bundle and, if it still doesn't fit, propose a budget change or a chunking approach rather than raise the budget quietly.

Built with only the functions the data layer uses, the SDK chunk was 153.4 kB gzip. About 43 kB of it is `re2js`, a regular-expression engine Firestore bundles for pipeline `regexMatch` functions, which Materia doesn't use but the bundler can't drop because the SDK's shared module imports it.

## Decision

We will load the SDK as two lazy chunks fetched in parallel:

- `libs/data-access/src/lib/firestore/sdk.ts` re-exports only the Firestore functions the data layer calls; `loadFirestoreSdk()` imports it together with `re2js` (`Promise.all([import('./sdk'), import('re2js')])`).
- `re2js` is a direct dependency pinned to the same version Firestore uses, so pnpm resolves one copy and the bundler gives it its own chunk.
- The result, measured with `pnpm materia-scripts bundle-size`: Firestore 109.7 kB and `re2js` 43.0 kB gzip, both under 150 kB, loaded only once the first query runs (never on the sign-in screens). The initial bundle went from 285.4 kB to 286.9 kB; the repository code sits behind the `@materia/data-access/repository` entry point so it stays out of `main`.

Because the full SDK is now loaded, `users/{uid}` and job progress use snapshot listeners instead of the 30-second Firestore Lite re-read ADR-021 described, and they're tracked by the `ListenerRegistry` like every other listener.

## Consequences

- No budget change. The two chunks download in parallel, so first-query latency is about the same as one 153 kB chunk.
- `re2js` must stay on the version Firestore depends on. If Firestore moves to another version, pnpm installs two copies, the split stops working, and the bundle-size check fails, which is the signal to bump the pin.
- If a later SDK release grows past 150 kB again, the next step is the budget change below, proposed in its own ADR.

## Alternatives considered

- **Raise the lazy-chunk budget to 160 kB:** simplest, but the ticket asks not to, and it would hide future growth in every other chunk too.
- **Stay on Firestore Lite with polling:** no listeners, no offline cache and no persistent multi-tab cache, which ADR-020 and FND-19 require.
- **A bundler plugin that stubs `re2js`:** would save 43 kB outright but breaks if any code path ever reaches pipeline regex functions, and patches the SDK in a way an upgrade could silently undo.
