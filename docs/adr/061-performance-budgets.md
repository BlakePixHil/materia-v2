# ADR-061: Performance budgets, measured on the emulators

- **Status:** Accepted
- **Date:** 2026-10-07
- **Ticket:** [SEC-07](https://linear.app/materia-web/issue/MAT-117)
- **Builds on:** [ADR-029](029-today-screen-reads.md) (Today's reads), [ADR-048](048-metrics-rollups.md) (metrics rollups), [ADR-056](056-startup-loads-in-parallel.md) (start-up loads in parallel)

## Context

SEC-07 asks us to prove Materia is fast and affordable for firms of up to 50 users, 10,000 matters, 500,000 documents and 2 million time entries: Web Vitals budgets on the key screens, a Firestore read budget per screen, load tests of the hot callables, a review of write hot spots, and a cost model.

There is no staging or performance project, and dev and prod must not be seeded or load-tested. Every measurement therefore runs against the Firebase emulators. The emulators differ from production in ways that matter here:

- the Firestore emulator has no indexes, so it scans collections;
- it settles transaction contention far more slowly than production;
- the Hosting emulator serves gzip over HTTP/1.1, while production serves Brotli over HTTP/2 and HTTP/3.

## Decision

We will keep four budgets and check them in code:

1. **Web Vitals on a mid-tier phone**: LCP ≤ 2.5 s, INP ≤ 200 ms and CLS ≤ 0.1 for Today, the Matters list, a matter and Deadlines.
   - `apps/web-e2e/src/perf/web-vitals.spec.ts` uses Lighthouse's mobile profile in navigation mode for LCP, CLS and TBT. That profile is a Moto G Power-class screen, 4× CPU slowdown, and a slow 4G link at 150 ms RTT and 1.6 Mbps.
   - INP is measured from Event Timing in Playwright, with the CPU slowed 4×, over a fixed script of real interactions per screen.
   - A screen that misses a budget is listed in `VITALS_EXCEPTIONS` with the follow-up ticket that removes it. Anything worse than its exception fails.
2. **Firestore reads per screen load**: Today ≤ 150 (warm) and a matter ≤ 100.
   - The Matters list and Deadlines are set from measurement with headroom, in `READ_BUDGETS` (`apps/web-e2e/src/perf/reads.spec.ts`).
   - Reads are counted by a wrapper around the Firestore SDK module (`libs/data-access` `read-counter.ts`), which follows Firestore's billing rules as the client sees them.
   - The wrapper exists only in development and e2e builds: the `MATERIA_READS_COUNTER` define is false in production, and `materia-scripts bundle-size` fails if `__materiaReads` reaches a production bundle.
   - In production, reads are read from the ops dashboard's "Firestore reads" chart (`firestore.googleapis.com/document/read_count`).
3. **Hot callables at 10× a 50-user firm's busiest minute**: p95 < 1 s with no errors. The k6 scripts in `tools/load/` run against the Functions emulator with the fakes.
   - The peak per flow and the 10× arithmetic live in `tools/load/lib/peak.js`.
   - Emulator latency is an upper bound. For the counters (matter and invoice numbering), the signal is the transaction attempts that `matters-createMatter` and `billing-issueInvoice` now log.
4. **No write hot spots at the target scale**:
   - We exempt from indexing the monotonically increasing timestamps on high-volume collections that nothing orders or filters by. These are `timeEntries`, `chunks`, `metrics` and `requests` (`fieldOverrides`, proven by `firebase/tests/indexes.spec.ts`).
   - Timestamps that are queried stay indexed. A 50-user firm writes them far below 500 a second.
   - Matter and invoice numbering stay one transaction per org on one counter document.

The budgets run in a `perf` job in `.github/workflows/ci.yml`. It runs only in the morning run and on manual dispatch, like CodeQL. It is not part of `ci-ok`, so a failure shows red without holding the dev deploy, like WebKit.

The job seeds the large practice (`materia-scripts seed-large --scale 0.05`) into the Auth, Firestore and Hosting emulators and runs the `chromium-perf` Playwright project (`E2E_PERF=1`). The reports are uploaded as `perf-reports`.

Screens that read too much are fixed with small denormalisations onto documents the screen already reads. The first one: Today's "WIP this month" now reads the member's month rollup (ADR-048), where it used to read up to 500 time entries. Larger fixes become tickets, listed in `docs/ops/perf-report-2026-10.md`.

## Consequences

- Each budget is checked every morning against the same seeded practice, so a regression shows up the day after it merges, not when a firm complains.
- The full-load fee earner (`lg-lawyer-1`) carries a full share of matters (357) at any scale from 0.04. Screens are bounded by their page sizes and 500-row caps, which scale 0.05 already reaches. So the read counts at 0.05 are the counts at the target scale, except where a screen looks up one document per row: Deadlines' 500 rows span 136 matters at 0.05 and up to 500 at scale 1, which its follow-up removes. What grows with scale is server work (indexed in production) and storage, which the cost model prices.
- Lab Web Vitals on the emulators are pessimistic (no Brotli, no HTTP/2, a local Firestore that scans). Field data comes from Performance Monitoring (FND-21): Firebase console → Performance → Web, page-load metrics by URL. The SDK loads three seconds after start-up in deployed builds and reads the buffered LCP and CLS entries.
- The perf job adds about 8 minutes of Actions time to each morning run (the emulator step took 4.3 minutes locally: seeding, the reads spec and four Lighthouse and INP runs).
- Counter contention can't be measured faithfully on the emulator: it settles contended transactions orders of magnitude more slowly than production. The attempts log fields make the production number visible: Logs Explorer, `jsonPayload.message="matter created"` or `"invoice issued"`, field `attempts`.
- `docs/ops/cost-model.md` prices a target-scale firm per month and must be refreshed when prices or the usage model change.

## Alternatives considered

- **A dedicated perf project**: the faithful option for latency and contention, but it costs a project to keep and someone to own it. It is the follow-up for the counter measurement.
- **Lighthouse CI (`@lhci/cli`) with its own server**: it adds a second runner and config for what one Playwright spec does with the same browser and the signed-in session.
- **Counting reads from Cloud Monitoring only**: production totals can't be split by screen, and there is no data before launch.
- **Sharding the counters**: numbering must be gap-free and ordered per org, which a sharded counter can't give. At ≤ 5 creates a second, one transaction per org is the ticket's accepted design.
