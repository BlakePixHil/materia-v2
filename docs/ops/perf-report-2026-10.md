# Performance report, October 2026 (SEC-07)

Is Materia fast and affordable for a firm of up to 50 users, 10,000 matters, 500,000 documents and 2 million time entries? This report sets out the budgets, what was measured, what was fixed, and the exceptions that remain with their follow-up tickets. Costs are in [cost-model.md](cost-model.md), and the decision record is [ADR-061](../adr/061-performance-budgets.md).

Raw outputs (Lighthouse HTML and JSON, `vitals.json`, `reads.json`, k6 summaries and emulator logs, CPU profiles, the cost script) are in the SEC-07 outputs folder (`sec-07/`) beside this repository's other ticket outputs.

## Summary

| Budget | Target | Result |
| -- | -- | -- |
| Firestore reads, Today (warm) | ≤ 150 | 46: **met**, with one matter read instead of 28, since "Denormalise matter number and title onto deadline and task rows" (SEC-07e). It was 75 before that, and 531 before SEC-07 |
| Firestore reads, a matter | ≤ 100 | 63: **met** |
| Firestore reads, Matters list | set from measurement: 120 since SEC-07d (200 before) | 102 since SEC-07d: met, with no contact read (165 before, 63 of them an N+1 on the page's client contacts) |
| Firestore reads, Deadlines | 200 since SEC-07c (800 before) | 153: **met** since "Window the Deadlines page and denormalise matter fields onto deadlines" (SEC-07c). It was 688 here, and about 1,050 at the target scale |
| LCP ≤ 2.5 s on a mid-tier phone | Today, Matters, matter, Deadlines | **Not met** on the emulators on any screen (8.0–13.2 s simulated, 7.7 s on Today after SEC-07b, 9.3 s on Deadlines after SEC-07c): held at measured ceilings, as the Hosting emulator's HTTP/1.1 sets the floor (see SEC-07b below); the CDN is measured on dev |
| INP ≤ 200 ms | same | **Met** on Today, Matters and a matter (24–80 ms), and on Deadlines since SEC-07c (104–136 ms; it was 2.7–3.2 s) |
| CLS ≤ 0.1 | same | **Met** on Today, Matters and a matter (0–0.04), after fixing a shift on the phone's Matters list. Today is held to 0.1 since SEC-07e: its rows no longer wait for their matters, and its CLS was 0 in seven runs (0–0.225 before, held at 0.25). Deadlines **met** since SEC-07c (0; it was 0.273) |
| Hot callables, p95 < 1 s at 10× peak, no errors | six flows | **Met** for `matters-createMatter` (512 ms), `deadlines-recompute` (397 ms) and `clerk-sendMessage` (322 ms), with no errors. The notification fan-out (1.45 s, no errors), invoicing and search are exceptions: the emulator can't run them at 10× peak, so they move to the perf-project ticket |
| Write hot spots | review | Reviewed: 8 unqueried timestamps exempted from indexing; Clerk metering moved to blind increments; the counters measured (one transaction per org stays) |
| Cost model | published | [cost-model.md](cost-model.md): ≈ US$90 a month for a target-scale firm (≈ US$240 with every document ingested by Clerk), most of it backups, plus Clerk tokens on the firm's own key |

Every exception in the screens' budgets is held at a ceiling in the specs (`READ_BUDGETS`, `VITALS_EXCEPTIONS`), so the morning `perf` job still catches a regression until its ticket lands. The load tests run by hand (`tools/load/run.sh`).

## How it was measured

There is no staging or perf project, and dev and prod must not be seeded or load-tested. Everything ran against the Firebase emulators (project `demo-materia`) on a 4-CPU container shared with other work.

### The large practice (`seed-large`)

`pnpm materia-scripts seed-large --scale <s>` writes a fictional firm, "Ashgrove & Finch Lawyers (Fictional)" (`org-large`). It refuses anything but the emulators and `demo-` projects. The ticket names `tools/scripts/seed-large.ts`; the script lives at `tools/scripts/src/seed-large.ts`, with its generator in `tools/scripts/src/seed/large.ts`, like the other `materia-scripts` commands.

- **Scale 1 is the target:** 50 members, 10,000 matters, 500,000 document records, 2,000,000 time entries, and with them 15,000 contacts, 30,000 parties, 40,000 deadlines, 80,000 tasks, 10,000 events and 20,000 notes. That is 2,715,101 documents (`--dry-run` prints the plan). Records are generated one matter at a time, so the full scale never sits in memory.
- **Scale used: 0.05**, which is 500 matters, 25,000 documents, 100,000 time entries and 136,091 documents written. The emulators took 13–20 s to write it (6,700–10,600 documents a second, depending on what else the machine was doing), and the export is 105 MB.
- **Why 0.05 measures the target.** The firm always has all 50 members. The measured user, the full-load fee earner `lawyer1@large.example`, always carries a full share of matters (357, which is 10,000 ÷ the 28 who run matters) from scale 0.04 up. Every screen is bounded by a page size or a row cap, and scale 0.05 already reaches them: Deadlines' firm-wide list fills its first page of 100 (its full 500 before SEC-07c). So the reads and the rendering are what they would be at scale 1. Before SEC-07c there was one exception: Deadlines read each listed deadline's matter, and its 500 deadlines spanned 136 matters here but up to 500 at scale 1.
- **What scale changes** is server-side query cost. That is indexed in production, so it doesn't depend on collection size. On the emulator, which scans, latency grows with the data. The load tests ran at the same scale for that reason.

### Web Vitals

`apps/web-e2e/src/perf/web-vitals.spec.ts` (Playwright project `chromium-perf`, `E2E_PERF=1`) runs against the e2e build served by the Hosting emulator. It signs in as the full-load fee earner and opens Today, the Matters list, the fee earner's first matter and Deadlines once each to warm the Firestore cache, as a returning user's would be.

For each screen:

- **Lighthouse 13.5** in navigation mode with its mobile defaults: a Moto G Power screen, 4× CPU slowdown, and slow 4G at 150 ms RTT and 1.6 Mbps, simulated. It drives the same Chromium (141) over its debugging port, with the sign-in kept and the HTTP cache cleared, as after a deploy. This gives LCP, CLS, TBT and FCP.
- **INP:** a fresh 412 × 823 tab with the CPU slowed 4×, where Playwright waits for the screen's content (on Deadlines, its rows) and then works it as a person would. INP is the slowest interaction from Event Timing (`durationThreshold` 16 ms), which is how web-vitals reports INP below 50 interactions.
  - Today: j, j, j, k, j through the rows.
  - Matters, the phone list: typing "estate" into the search and clearing it.
  - A matter, the phone Overview: folding and unfolding Key facts, Deadlines and Tasks, then opening Tasks from "More on this matter".
  - Deadlines: "Mine" and "Critical" on and off.

Both screens are 412 px wide, so since MOB-02 they get the phone layouts: the TabBar, Matters as search, recents and a list, and a matter's Overview as folding sections. Deadlines has no phone layout of its own.

The lab is pessimistic in three ways:

- The Hosting emulator serves gzip over HTTP/1.1; production serves Brotli over HTTP/2 or HTTP/3.
- Firestore is a local emulator.
- Lighthouse warns that the page "loaded too slowly to finish": the Firestore listen channel never lets the network go quiet, so each run waits its 20 s limit. The metrics are complete; the warning is expected.

**Field data** comes from Performance Monitoring (FND-21, `apps/web/src/app/core/observability/perf.ts`). It loads three seconds after start-up in deployed builds, so it adds nothing to the initial bundle. Read it in the Firebase console under Performance → Web → page load: LCP, INP and CLS by URL and by device and connection. The custom traces `matter_open`, `palette_search` and `clerk_first_token` are under Custom traces. Compare the 75th percentile on mobile with the budgets below. There is no field data until real people use prod.

### Reads per screen

`libs/data-access/src/lib/firestore/read-counter.ts` wraps the Firestore SDK module the data layer loads, so every read path is counted. It counts what Firestore bills, as the client sees it:

- one read per document returned by a server query, and at least one for an empty result;
- a listener's first answer, then one per document added, changed or removed;
- count queries per 1,000 index entries;
- nothing for answers from the local cache, which are tallied separately as `cached`.

It exists only where `MATERIA_READS_COUNTER` is defined: the development and e2e builds, as `window.__materiaReads`. The production build doesn't contain it, and `materia-scripts bundle-size` fails if `__materiaReads` reaches a production bundle.

`apps/web-e2e/src/perf/reads.spec.ts` opens each screen from the nav with the shell already up, resets the counter, and waits for the screen's first server answer and then until reads have been quiet for 5 s. It also measures Today as a full page load, shell included. It asserts `READ_BUDGETS`.

The counter can't see one cost: security rules that `get()` the member's membership and the matter are billed about 1.5 reads per request. The cost model adds them.

In production, reads are in the ops dashboard's "Firestore reads" chart (`firestore.googleapis.com/document/read_count`, Terraform `infra/terraform/modules/monitoring/dashboards/ops-overview.json`).

### Load tests

`tools/load/` holds k6 scripts against the Functions emulator, which uses the fakes (fake model, mail and push), with emulator ID tokens for the large practice's members.

- **k6 1.8.1**, `k6-v1.8.1-linux-amd64.tar.gz`, SHA-256 `b02cd649a0e391576909502e9b7760d3fb9e1fd14d179e3da18ee4a185f4c583`. That matches `k6-v1.8.1-checksums.txt` from the GitHub release; the binary's SHA-256 is `076bfadd49b3b5e2d29790b86ed8cb18d8ba0fb15be83be94e0c5901dbb86613`. k6 isn't a dependency.
- **Each script ran in a fresh emulator session** with the scale-0.05 practice imported (`--import`), `FUNCTIONS_EMULATOR_MAX_WORKERS=20`. A 2-minute measured step followed a warm-up in `setup()`, so the emulator's per-function cold starts are outside the measurement.
- **Runs:** all six scripts at 10× peak; the Clerk and fan-out scripts again at 10× after their fixes; and invoicing, the fan-out, Clerk and search at 1× peak (`MULTIPLIER=1`), to separate the flows from the emulator's limits.
- **Two signals.** Emulator latency is an upper bound: one JVM scanning unindexed collections, plus up to 20 function workers, all on 4 shared CPUs. For the counters, the signal is the transaction attempts that `matters-createMatter` and `billing-issueInvoice` now log (`"matter created"` and `"invoice issued"`, field `attempts`). The k6 `requestId`s start `aa` in the peak step and `cc` in the contention step, so the logs split by step.

**Peak for a 50-member firm, and 10× it** (`tools/load/lib/peak.js`). Peak is the busiest minute on a month-end morning:

| Flow | Peak a minute | Why | 10× a minute | 10× a second |
| -- | --: | -- | --: | --: |
| `matters-createMatter` | 2 | ≈ 1,250 matters a year, ≈ 5 a working day; two intakes finishing together is busy | 20 | 0.33 |
| `clerk-sendMessage` | 20 | 10 people in a Clerk chat at once, one message every 30 s each | 200 | 3.33 |
| `billing-issueInvoice` (after `billing-saveDraft`) | 9 | month-end: 3 people each issuing an invoice every 20 s | 90 | 1.5 |
| `deadlines-recompute` | 5 | event edits and explicit recomputes across the firm | 50 | 0.83 |
| Notification fan-out (`notes-create` mentioning 10 people) | 5 notes, 50 notifications | a team-wide mention every 12 s | 50 notes, 500 notifications | 0.83 notes |
| Search (the palette's 4 queries) | 50 searches | every member searching once in the minute | 500 searches, 2,000 queries | 8.33 searches |

The counters also ran a contention step at **5 a second for 30 s**, the ticket's bound for matter numbering: 15× the matter peak and 33× the invoice peak.

`tools/load/run.sh` runs the scripts. The environment variables `DURATION`, `MULTIPLIER` (1 runs at peak) and `CONTENTION=0` (skip the contention step) adjust it.

## Results

### Reads per screen (scale 0.05, full-load fee earner, 50 members)

| Screen | Reads | Answered from the local cache | Budget | Where the reads go |
| -- | --: | --: | --: | -- |
| Today, from another screen (warm), before SEC-07e | 75 | 38 | 150 | 28 matters looked up one by one for the rows; 18 tasks; 12 deadlines; 9 recent matters; 5 counts; the org; the deadline changes |
| Today, page load (shell included), before SEC-07e | 78 | 43 | | the same, plus the user's own document |
| Today, from another screen (warm), since SEC-07e | 46 | 36 | 150 | 16 tasks; 12 deadlines; 9 recent matters; the counts, the org, the WIP rollup and the deadline changes; 1 matter, for a task on a privileged matter |
| Today, page load (shell included), since SEC-07e | 49 | 41 | | the same, plus the user's own document and timer |
| Matters list, before SEC-07d | 165 | 29 | 200 | 63 client contacts looked up one by one; 51 matters (one page); the firm's 50 members; the saved views |
| Matters list, since SEC-07d | 102 | 2 | 120 | 51 matters (a page of 50, plus one to know there are more); the firm's 50 members; the saved views |
| A matter | 63 | 1 | 100 | the firm's 50 members; 4 deadlines; 4 tasks; the matter; its activity, notes, Clerk brief (AI-06c) and fact citations |
| Deadlines, before SEC-07c | 688 | 15 | 800 | 501 upcoming deadlines (the 500-row cap plus one); 136 matters looked up one by one; the firm's 50 members; the deadline changes |
| Deadlines, since SEC-07c | 153 | 15 | 200 | 101 upcoming deadlines (a page of 100, plus one to know there are more); the review queue; the firm's 50 members; the deadline changes |

Nothing read while a screen sat open for 3 s afterwards. The 50 member documents are read by three screens: the counter counts each listener as new, but Firestore bills a listener resumed within 30 minutes only for what changed, so a matter opened after the Matters list costs nearer 13.

What changed and why:

- **Today: 531 → 75.** "WIP this month" used to read all of the member's time entries for the month (up to 500) to add them up. It now reads one document, the member's month rollup from INS-01 (`orgs/{org}/metrics/month-YYYY-MM/byMember/{uid}`: `time.recordedCents − time.billedCents`, ADR-048). The rollup is eventually consistent: a second or two behind a write, and a missed trigger is corrected by the nightly recompute. Today's own e2e test proves it reads the rollup.
- **Matters list:** one page of matters plus one `get` per client contact on the page, an N+1 bounded by the page size. Putting the client's display name on the matter takes it to about 100. The existing `matters-denormalise` trigger already reads the parties' names for the search tokens, so it can write the name too. Follow-up: **"Denormalise client names onto matters"**.
  - **Done in SEC-07d: 165 → 102, with no contact read.** Each matter carries its clients' display names, `clientNames`, written by `matters-create` and kept by `matters-denormalise` as it keeps `search`. A contact renamed now also renames the matters that name it, as a client or the deceased (`contacts-onWrite`): before, their search tokens kept the old name until the matter was next edited. `materia-scripts backfill-search-tokens` writes the names onto older matters (deploy runbook, step 6); until it runs, the list looks those matters' clients up as before.
- **Deadlines:** the firm-wide list listens to up to 500 upcoming deadlines, then reads each one's matter (136 matters here; up to 500 at the target scale). Windowing the page (the next 2–4 weeks first, the rest on scroll) and copying the matter's number, title and responsible lawyer onto each deadline (kept current by a trigger, as `matters-denormalise` does for search) takes it to about 200. Follow-up: **"Window the Deadlines page and denormalise matter fields onto deadlines"**.
  - **Done in SEC-07c: 688 → 153.** The list reads 100 deadlines at a time by due date (the overdue ones and the next few weeks first) and loads the next 100 as it scrolls; the calendar reads only the month it shows. Each deadline carries a copy of its matter's number, title, people and jurisdiction (`Deadline.matter`). The writers that read the matter stamp it, `deadlines-onWrite` fills or refreshes it after any other write, and `matters-denormalise` rewrites it when the matter changes. `materia-scripts backfill-deadline-matters` copies it onto older deadlines (deploy runbook, step 6); until it runs, the screen reads those deadlines' matters as before.
- **Today's matter lookups:** Today reads each of its rows' matters individually (28 here). That is within budget, but the same denormalisation would remove it, and with it a source of layout shift (see Web Vitals). Follow-up: **"Denormalise matter number and title onto deadline and task rows (Today lookups)"**.
  - **Done in SEC-07e: 75 → 46, with 1 matter read instead of 28.** Every row Today lists carries a copy of its matter, each saying whether the matter is deleted. Deadlines and pending proposals get SEC-07c's copy. Tasks get the number, title and type, or only `privileged: true` on a privileged matter, since a task's assignee can read it whatever their role (ADR-026). Recent matters get the number, title, type and privileged flag, written when the person opens the matter. `matters-denormalise` rewrites them all when the matter changes. `materia-scripts backfill-matter-copies` (which replaces `backfill-deadline-matters`, deploy runbook step 6) copies them onto older records; until it runs, Today looks those rows' matters up as before. Today still reads the matter of a task on a privileged matter, whose copy names nothing, for someone who can see privileged matters: the 1 read here (the fee earner's task on the one privileged matter among their rows).

### Web Vitals (mid-tier phone, scale 0.05)

Six runs of the CI step on the shared machine, on `main` at `ee6d4e1` with MOB-02's phone layouts: three as the branch stood, then three after the phone Matters fix below. Ranges are lowest to highest. Seven earlier runs, before MOB-02, measured the desktop layout squeezed to a phone; their LCP was 7.1–13.1 s, and their reports are in the SEC-07 outputs folder.

| Screen | LCP, simulated (budget 2.5 s) | Observed LCP | FCP | TBT | CLS (budget 0.1) | INP (budget 200 ms) | Held at until its ticket |
| -- | --: | --: | --: | --: | --: | --: | -- |
| Today | 8.0–9.0 s | 0.8–0.9 s | 4.9–5.0 s | 321–476 ms | 0 | 24–32 ms | LCP 11 s, CLS 0.25 |
| Matters list (phone) | 10.3–10.7 s | 2.1–2.3 s | 4.5–4.7 s | 284–339 ms | 0 (0.286 before the fix) | 40 ms | LCP 12.5 s |
| A matter (phone Overview) | 9.5–9.8 s | 1.0–1.2 s | 5.2–5.3 s | 189–336 ms | 0.04 | 40–80 ms | LCP 12 s |
| Deadlines, before SEC-07c | 13.0–13.2 s | 2.8–3.0 s | 4.7 s | 3.3–3.8 s | 0.273 | 2.7–3.2 s | LCP 15 s, CLS 0.35, INP 4 s |
| Deadlines, since SEC-07c | 9.3 s | 1.7–1.9 s | 4.8–4.9 s | 1.6–1.8 s | 0 | 104–136 ms | LCP 11.5 s |

Two more runs after merging MOB-02b (#300), which draws a phone's Today cards below My tasks only as they scroll into view: Today's LCP was 7.7 s and its FCP 4.6 s. The other screens were close to the figures above (a matter's INP 48–96 ms), all within their ceilings.

The "since SEC-07c" row is two runs of the CI step on that ticket's branch, with Deadlines' INP and CLS exceptions removed.

Seven runs on SEC-07e's branch (on `main` at `43a3d1c`), with Today's CLS exception removed: Today's CLS was 0 in all seven, its LCP 7.3–8.4 s simulated (1.1 s observed), TBT 259–539 ms and INP 24–32 ms. The other screens stayed within their ceilings (Matters LCP 9.9–10.3 s, a matter 9.4–10.0 s with CLS 0.04, Deadlines 7.8–9.2 s).

"Observed LCP" is the unthrottled time on the test machine; Lighthouse's simulated LCP is the budgeted figure.

**LCP fails on every screen, for the same reason.** Before the first signed-in paint:

- **About 750 kB of compressed JavaScript (2.7 MB minified, 49 chunks) loads.** The largest pieces:
  - the Firestore SDK (464 kB minified, with its 172 kB regular-expression engine);
  - Angular core (201 kB);
  - ng-primitives (166 kB);
  - `libphonenumber-js` (156 kB, pulled in by `libs/domain`'s contact schemas);
  - zod plus the domain schemas (185 kB);
  - Firebase Auth (112 kB);
  - the router (96 kB), the WebChannel transport (63 kB), forms (60 kB) and Remote Config (32 kB).
- **Then the guards wait for Auth to restore the session and for the org policy read.**

On slow 4G that is about 4.5–5.3 s to first paint (FCP) and 8–10.7 s to LCP. ADR-056 already made these loads parallel; what remains is their size and the waits. The fix is several pieces of work, so it is a follow-up, **"Trim the signed-in critical path for LCP on mid-tier phones"**:

- keep `libphonenumber-js` and the heavier zod schemas off the start-up path;
- render the shell from the cached session and policy before the network answers;
- re-measure on the production CDN (Brotli, HTTP/2), which alone should take a few hundred kB off.

The budgets are held at 11 s on Today, 12 s on a matter and 12.5 s on Matters (11.5 s on Deadlines since SEC-07c, 15 s before) until then.

**SEC-07b (MAT-177)** did the first two, and the shell is now drawn from the session and org policy this device saw last while Auth and Firestore load (ADR-056's update of the same name); nothing is read until Auth confirms the session. Measured as above on the phone layouts, from `main` at `49eca44`:

| Screen | LCP before | LCP after | Observed LCP | TBT |
| --- | --- | --- | --- | --- |
| Today | 8.5 s | 7.7–7.8 s | 1.0 → 0.9 s | 615 → 404–459 ms |
| Matters list | 10.5 s | 10.7 s | 2.7 → 2.6–2.7 s | 484 → 383–431 ms |
| A matter | 10.0 s | 9.6–10.1 s | 1.5 → 1.2–1.4 s | 657 → 520–591 ms |

The emulator can't show 2.5 s. Before the first paint about 100 requests load (the initial chunks, Firebase's SDKs, and the shell's and the page's chunks), and the Hosting emulator serves them over HTTP/1.1 with gzip, which Lighthouse simulates as six connections on slow 4G: first paint stays at 4.6–5.4 s. The Matters list's and a matter's LCP are their rows and title, so they also wait for their reads. The Web Vitals spec now holds Today at 10 s and the others where they were, as measured ceilings rather than a ticket's exception. The figure for people is the CDN's (HTTP/2, Brotli), measured on dev with `materia-scripts demo-lighthouse`.

**Deadlines** drew up to 500 rows at once before SEC-07c:

- Each row grew when its matter arrived, which was the CLS.
- Toggling a filter re-rendered the whole list, which was the INP. The profile of the "Mine" toggle shows about 630 ms in the Firestore SDK applying the 136 matter reads' events, and 195 ms in ng-primitives' hover measurement. The hover measurement is on hover-capable devices only.
- The Deadlines follow-up above fixes both.

**Fixed in SEC-07c** (`apps/web/src/app/features/deadlines/deadlines-page.ts`): CLS 0.273 → 0 and INP 2.7–3.2 s → 104–136 ms.

- The rows carry their matter's copy, so each is drawn whole and nothing grows after it.
- The list draws one page of 100 and the next as it scrolls into view, and the screen keeps its skeleton until the alerts offer ("Get deadline alerts on this device") knows whether to show: drawn as soon as the list was, it pushed the rows down by its own height (CLS 0.112).
- Filters hide rows rather than redraw the list, and a row whose deadline and matter haven't changed keeps its view model, so a snapshot redraws only what changed.
- Rows off screen skip rendering (`content-visibility: auto`). Rows a filter hides use `content-visibility: hidden` rather than `display: none`: ng-primitives watches the size of every button for its hover state, and each button that went to 0 × 0 ran that watcher, which then read its style: two style reads per hidden row on every toggle. That took INP from 176–192 ms to 104–136 ms.

**Today's CLS depends on timing.** Today draws its sections together once every source has answered, or after 2.5 s at most, so that nothing moves as each answer lands. Its rows wait for their matters (the 28 lookups above). On the emulators those lookups sometimes land just after the 2.5 s, and then each row appears as its matter does and pushes the rest down. On the desktop layout CLS was 0 in four of seven runs and 0.128–0.225 in the others; on the phone it was 0 in all six. A slow phone network could still do the same in the field. The Today lookups follow-up removes the lookups and so the wait; until then Today's CLS is held at 0.25.

- **Fixed in SEC-07e.** Today's rows name their matters from their own copies, so a section is drawn whole when its rows arrive and nothing waits for a lookup. Today's CLS was 0 in seven runs, and it is held to the 0.1 budget again.

**Fixed in SEC-07:**

- **The phone's Matters list** (`apps/web/src/app/features/matters/phone-matters.ts`) drew the view's matters first, then pushed them down when "Recent" landed above them: the recents read a list and then each matter, so they answer later. That is a layout shift of 0.286 in every run. The recents and the view now appear together, with one skeleton until the recents have answered: CLS 0. A spec holds the recents' answer and proves nothing is drawn until it arrives.
- `MtButton` measured its width (`offsetWidth`, a forced layout) when every button was created, so a list of 500 rows forced 500 layouts. It now measures only when a button starts loading (`libs/ui/src/lib/button/button.ts`, with a spec proving no button measures until it loads). Deadlines' toggle went from 590 ms of forced layouts to none: INP 7.1 s → 2.8 s and TBT 10.3 s → 4.2 s.

### Load tests (10× peak, scale 0.05, emulators)

| Flow | Rate at 10× | Calls measured | p95 | Errors | Result |
| -- | --: | --: | --: | --: | -- |
| `matters-createMatter` | 0.33 a second | 41 | 512 ms | 0 | **Met**. Every numbering transaction committed at its first attempt |
| `deadlines-recompute` | 0.83 a second | 100 | 397 ms | 0 | **Met** |
| `clerk-sendMessage` (fake model) | 3.33 a second | 401 | 322 ms | 0 | **Met** (after the metering fix below) |
| Notification fan-out (`notes-create`, 10 mentions each) | 0.83 notes, 8.3 notifications a second | 101 | 1.45 s (p50 279 ms) | 0 | **Not met** on the emulator (1.80 s before the fix below): exception |
| `billing-saveDraft` then `billing-issueInvoice` | 1.5 a second | 118 | 100 s | 72 | **Not measurable** on the emulator: exception |
| Search (the palette's 4 queries) | 8.33 searches, 33 queries a second | 480 queries | 60 s | 446 | **Not measurable** on the emulator: exception |

At a firm's peak itself (`MULTIPLIER=1`), the flows the emulator couldn't run at 10× did this:

| Flow at 1× peak | Calls | p95 | Errors |
| -- | --: | --: | --: |
| `billing-saveDraft` / `billing-issueInvoice` (9 a minute) | 19 each | 963 ms / 1.65 s | 0; every numbering transaction committed at its first attempt |
| Notification fan-out (5 notes a minute) | 10 | 1.52 s (p50 282 ms; 976 ms inside the function) | 0 |
| `clerk-sendMessage` (20 a minute) | 41 | 114 ms | 0; every reply answered and metered |
| Search (50 a minute) | 276 queries | 60 s | 200 queries timed out |

**Fixed in SEC-07:**

- **Clerk metering** (`apps/functions/src/clerk/firestore-store.ts`). Every Clerk call in an org adds its tokens and cost to one document, `metrics/clerk-YYYY-MM`, and the store did it in a transaction that read the document first. At 10× peak those transactions contended: 48 of 234 replies failed to meter, so the org's Clerk budget (AI-02) under-counted, and replies held their queue slots while they retried (p50 3.9 s, p95 19.8 s with the fake model; 89 of 404 answered within the run). The month's document is now created once per instance, as the INS-01 rollups are (ADR-048), and each call adds to it with blind increments. After the fix: no metering failures, replies p50 332 ms and p95 2.2 s, and 388 of 404 answered within the run (the rest seconds later). A spec proves the store meters without a transaction and that concurrent calls all count.
- **The notification fan-out** (`apps/functions/src/notes/shared.ts`). A note notified its mentioned members one after another: each `notify` reads the member's documents and recent count, then queues the delivery. They now run together. `notes-create` at 10× peak went from p50 719 ms and p95 1.80 s to p50 279 ms and p95 1.45 s. A spec proves the members' reads and deliveries overlap.

What the emulator can't run, and why:

- **The notification fan-out's p95.** Every write to a document directly under an org sets off `audit-onOrgWrite`, which then skips the collections it doesn't audit (notifications among them). A team-wide mention sets off about 80 trigger invocations: 45 of those, 22 `activity-onAudit`, 10 deliveries and a few more. In production they run on their own instances; on the emulator they share 4 CPUs with the callable, so a note that lands during the previous one's triggers waits. The p50 (279 ms) is the callable's own cost. Per-collection audit triggers would avoid the skipped invocations, but they would add about 15 functions to every deploy's rebuild, which costs more than the invocations (cost model), so the wildcard trigger stays.
- **Search.** The Firestore emulator has no indexes: it answers each palette query by scanning the collection group (25,000 documents, 4,000 tasks) and checking the rules, so even at peak most queries hit the 60 s limit. In production each query reads at most 20 entries from a composite index: `matters (deletedAt, search, lastActivityAt)`, `contacts (search, updatedAt)`, and the `tasks (orgId, assigneeUid, search, updatedAt)` and `documents (orgId, search, updatedAt)` collection-group indexes are all in `firebase/firestore.indexes.json`.
- **Invoicing and the counters**, below.
- **Clerk replies with a real model.** The fake model answers at once. The reply queue (`clerk-runMessage`) runs at most 10 replies at a time per project, the queue default, and every firm shares it. With a real model's 5–20 s replies that is 0.5–2 replies a second for every firm together, while one firm's peak is 0.33 a second. Follow-up: **"Size the Clerk reply queue for concurrent firms"**.

Counter contention (5 a second for 30 s, the ticket's bound):

| Counter | Calls in 30 s | Succeeded | Attempts of those that succeeded | Time in the function, p50 / p95 |
| -- | --: | --: | -- | --: |
| Matter numbering (`matters-createMatter`) | 87 | 10 | 1 attempt: 4; 2: 2; 4: 1; 8: 2; 9: 1 | 31 s / 52 s |
| Invoice numbering (`billing-saveDraft` then `billing-issueInvoice`) | 85 saves | 0: every pre-bill save timed out before its issue could start | | |

The emulator can't measure the counters under contention, and its results here are not production's:

- The Firestore emulator locks the whole collection a transaction queries, where production locks only the index range. `createMatter`'s numbering transaction checks the number isn't taken (a query on `matters`), and `issueInvoice`'s queries the matter's invoices and credit notes on the org's collections.
- At 5 a second, every transaction on the emulator queues behind every other, and calls time out after 60–120 s.
- At 10× peak (0.33 creates a second), `createMatter` never retried: all 41 numbering transactions committed at the first attempt, p95 501 ms inside the function. That is the realistic load: a 50-member firm opens about five matters a day.
- In production, Firestore's server SDKs take pessimistic locks, and both transactions read the counter last, after their other reads, so the counter is locked only from that read to the commit. One transaction per org stays the design, as the ticket accepts at ≤ 5 a second.
- The log field `attempts` shows the production number from launch: Logs Explorer, `jsonPayload.message="matter created" OR "invoice issued"`.
- Follow-up for a faithful number: **"Load-test numbering, invoicing, search and the notification fan-out on a perf project"**. It covers the matter and invoice counters at 5 a second, and invoicing, search and the fan-out at 10× peak, on a real Firestore database in a throwaway project.

`billing-issueInvoice` at 10× peak overwhelmed the emulator:

- Each iteration saves a pre-bill and issues it, about 40 time-entry lines each. On an idle emulator a save took about 2 s and an issue about 1.5 s.
- At 1.5 a second, the saves and issues queued on the emulator's collection locks until they hit the 60 s deadline.
- At peak itself (9 a minute, `MULTIPLIER=1 CONTENTION=0`), invoicing ran without errors: 19 pre-bills saved and issued, `saveDraft` p95 963 ms and `issueInvoice` p95 1.65 s, every numbering transaction at its first attempt.
- This is the same emulator limit as the counters, not a production measurement, and the perf-project follow-up covers it.

## Write hot spots

Firestore limits writes to an index range that only grows (a timestamp set at write time) to about 500 a second per collection. It also limits a single document to about one sustained write a second. Review of `firebase/firestore.indexes.json` against the target firm:

| Collection | Monotonic field | Queried by it? | Write rate at the target scale | Decision |
| -- | -- | -- | -- | -- |
| `timeEntries` (2 million; per matter) | `createdAt`, `updatedAt` | No (by `date`, `uid`, `status`) | ≈ 20,800 entries a month; migration loads in bursts | **Exempted** from indexing |
| `chunks` (Clerk ingest, up to 2.2 million) | `createdAt`, `updatedAt` | No (vector search by `orgId`, `matterId`, `privileged`) | bursts of hundreds per ingested document | **Exempted** |
| `metrics` ledgers and periods | `createdAt`, `updatedAt` | No (read by id) | one ledger per record write; backfills in bursts | **Exempted** |
| `requests` (idempotency, per org) | `startedAt`; `result` is a whole callable result | No (read by id; `expiresAt` is the TTL, already exempt) | one per write callable | **Exempted** |
| `audit` | `at` | Yes (audit log, newest first) | about half the writes: well under 1 a second | Kept: far below 500 a second |
| `notifications` | `createdAt` | Yes (inbox, newest first; the burst check) | 10 per team mention; 500 a minute at 10× peak | Kept: ≈ 8 a second at 10× peak |
| `documents` | `createdAt` | Yes (a matter's documents, newest first) | ≈ 5,200 a month; a migration keeps the legacy timestamps, so they don't all fall at the end | Kept |
| `activity`, `notes`, `invoices` | `createdAt` / `at` | Yes | low | Kept |

Counters and hot documents:

- **Matter numbering** (`counters/matter-{YYYY}`) and **invoice numbering** (`counters/invoice`) are one transaction each per org. Results are above; the design stays.
- **Clerk metering** (`metrics/clerk-YYYY-MM`, one document per org and month) takes every Clerk call's increments: 0.33 a second at peak and 3.3 at 10×, which is over the one-a-second guideline in bursts. Since SEC-07 they are blind increments, which Firestore applies without the read-and-retry a transaction needs, and at 10× peak none failed. Watch `clerk metering failed` in the logs; shard the document as INS-01 does if it shows up.
- **Metrics (INS-01)** already shard org period documents ten ways once an org has more than 20 active members (ADR-048), so a 50-member firm's org figures are sharded. Member documents are never sharded.
  - The hottest case is issuing an invoice. It marks its time entries billed in one transaction, and each entry's `metrics-onTimeEntry` increments the same member's day, month and FY documents, a burst of about 40 increments.
  - That is a bounded burst, not a sustained rate. Triggers don't retry (`retry: false`): a sync that fails is logged as a dead letter, and the nightly recompute re-syncs any record whose ledger is out of step (`metrics_drift`).
  - Watch `metrics_drift` after month-end billing. Shard member documents only if it shows drift.

The exemptions are proven by `firebase/tests/indexes.spec.ts`. They deploy with the indexes; deploys run indexes before functions.

## Exceptions and follow-up tickets

| Ticket | What it fixes | Budget held at until then |
| -- | -- | -- |
| [SEC-07b](https://linear.app/materia-web/issue/MAT-177): Trim the signed-in critical path for LCP on mid-tier phones | Done: the guards' waits are gone (cached session and policy) and libphonenumber and the heavier schemas are off the start-up path. On the emulators LCP is bounded by HTTP/1.1, so it stays at measured ceilings | LCP ≤ 10 s on Today, 12 s on a matter, 12.5 s on Matters, 11.5 s on Deadlines (measured ceilings) |
| [SEC-07c](https://linear.app/materia-web/issue/MAT-178): Window the Deadlines page and denormalise matter fields onto deadlines | Deadlines reads (688 here and about 1,050 at the target scale → about 200), INP (2.7–3.2 s) and CLS (0.273) | **Done**: reads 153 (budget 200), INP 104–136 ms, CLS 0. Its LCP is SEC-07b's |
| [SEC-07d](https://linear.app/materia-web/issue/MAT-179): Denormalise client names onto matters | Matters list reads (165 → about 100) | **Done**: reads 102 with no contact read (165 and 63 before), budget 120 |
| [SEC-07e](https://linear.app/materia-web/issue/MAT-180): Denormalise matter number and title onto deadline and task rows (Today lookups) | Today's per-row matter reads (28), and its CLS (0–0.225): rows appear as their matters arrive, when that is after Today's 2.5 s limit for drawing its sections together | **Done**: reads 46 with 1 matter read, for a privileged matter's task (75 and 28 before), CLS 0 in seven runs; the 0.25 exception is gone. Its LCP is SEC-07b's |
| [SEC-07f](https://linear.app/materia-web/issue/MAT-181): Load-test numbering, invoicing, search and the notification fan-out on a perf project | What the emulator can't measure: counter contention at 5 a second, and invoicing, search and the note fan-out at 10× peak | `attempts` logged in production |
| [SEC-07g](https://linear.app/materia-web/issue/MAT-182): Size the Clerk reply queue for concurrent firms | `clerk-runMessage` runs at most 10 replies at a time per project (the queue default), shared by every firm: with a real model's 5–20 s replies that is 0.5–2 a second for all firms together, against 0.33 a second for one firm's peak | n/a: with the fake model, replies kept up at 10× peak |
| [SEC-07h](https://linear.app/materia-web/issue/MAT-183): Leave derivable Clerk chunks out of the nightly export and cut the export cadence at scale | The largest cost line at the target scale (cost model) | n/a |

## Reproducing

```sh
pnpm nx build web --configuration=e2e && pnpm nx build functions
# Reads and Web Vitals, as CI's perf job runs them (Auth, Firestore and Hosting emulators):
E2E_PERF=1 BASE_URL=http://127.0.0.1:5000 pnpm exec firebase emulators:exec --only auth,firestore,hosting \
  --project demo-materia --config firebase.json \
  "pnpm -s materia-scripts seed-large --scale 0.05 && pnpm exec playwright test -c apps/web-e2e/playwright.config.mts --project=chromium-perf"
# Load tests: export the seeded practice once, then one fresh emulator session per script:
pnpm exec firebase emulators:exec --only auth,firestore --project demo-materia --config firebase.json \
  --export-on-exit=.perf-data "pnpm -s materia-scripts seed-large --scale 0.05"
FUNCTIONS_EMULATOR_MAX_WORKERS=20 pnpm exec firebase emulators:exec --only auth,firestore,functions,storage \
  --project demo-materia --config firebase.json --import=.perf-data "K6=<path to k6> tools/load/run.sh create-matter"
```

CI runs the first part every morning (job `perf` in `.github/workflows/ci.yml`; reports in the `perf-reports` artifact). The job is non-blocking and should take about 8 minutes: its emulator step (seeding, the reads spec, and four Lighthouse and INP runs) took 4 minutes locally, plus checkout, set-up and the browsers.
