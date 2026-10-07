# Architecture & ADRs

This page records the decisions every ticket builds on. To change one, write a superseding ADR in `docs/adr/`, link it here, and get it approved in review. Don't change a decision quietly inside a feature PR.

## System overview

```
Browser (Angular PWA) ──Firebase JS SDK──▶ Firestore (australia-southeast1)
        │                                  ▲ security rules (default deny)
        │ callable / HTTPS (App Check)     │
        ▼                                  │
Cloud Functions v2 (Node 22, australia-southeast1) ──▶ Cloud Tasks / Scheduler / Pub/Sub
        │            │                 │
        │            │                 └──▶ Cloud Run jobs (PDF build, court book, heavy OCR)
        │            └──▶ Clerk gateway ──▶ Claude (claude-opus-5-5) via provider chosen in AI-01
        └──▶ Secret Manager, Cloud Storage (orgs/…), Identity Platform, Vertex AI embeddings
```

## Repository layout (new repo, Nx + pnpm)

```
apps/
  web/                 Angular app (standalone, zoneless, signals)
  functions/           Firebase Functions v2 codebase "core"
  jobs/                Cloud Run jobs (court-book, pdf, ocr) — container images
libs/
  ui/                  Angular component library (mt-* + ng-primitives), Storybook
  domain/              zod schemas, types, enums, pure domain logic (money, time, dates)
  data-access/         Firestore repositories, converters, signal stores (web only)
  deadlines/           pure TS deadline engine + rule sets (shared web/functions)
  clerk/               prompt templates, output schemas, eval fixtures (functions only)
  test-utils/          emulator helpers, factories, fixtures (fictional data only)
tools/
  migration/           legacy → v2 CLI (export/transform/load/verify/rollback)
  scripts/             seed, codegen, ops scripts
infra/
  terraform/           projects, APIs, IAM, buckets, WIF, budgets, alerts
firebase/              firestore.rules, storage.rules, firestore.indexes.json (firebase.json is at the root)
docs/                  mirror of Linear docs + docs/adr/*
```

These module boundaries are enforced by `@nx/enforce-module-boundaries`:

- `domain` and `deadlines` import nothing Angular- or Firebase-specific. They are pure TS, so they run in web, functions and tools.
- `ui` imports no `data-access`. Components are presentational, with inputs and outputs only.
- `apps/web` feature folders talk to `data-access`, never to Firestore directly.

## ADRs

**ADR-001: Nx monorepo with pnpm, TypeScript strict.**
- One version policy.
- `nx affected` drives CI.
- Node 22 LTS everywhere.

**ADR-002: Angular, latest stable (≥ 20).**
- Standalone components, zoneless change detection, signals, OnPush.
- New control flow (`@if`/`@for`), and `inject()` instead of constructor DI.
- Routing is lazy per feature.
- ng-primitives provides behaviour; the `mt-*` CSS from the design system provides the look.
- No Angular Material.

**ADR-003: Firebase as the cloud platform.**
- Services: Firestore (Native), Identity Platform, Functions v2, Storage, Hosting, App Check (reCAPTCHA Enterprise), Remote Config, FCM.
- Region `australia-southeast1` (Sydney) for everything regional.
- Why Firebase: the team knows it, the rules give us client-direct reads with server-enforced tenancy, and the legacy user's data is already on Firebase, so migration is Admin-SDK to Admin-SDK.

**ADR-004: Three environments, three projects.**
- The projects are `materia-v2-dev`, `materia-v2-staging` and `materia-v2-prod`. Final ids are set in FND-03.
- All of them are provisioned with Terraform.
- No manual console changes except where Terraform has no support. Those are recorded in `infra/MANUAL.md`.

**ADR-005: Multi-tenancy by organisation.**
- Data lives under `orgs/{orgId}`.
- Auth custom claims: `{ orgId, role, orgs?: {[orgId]: role} }`, kept in sync by a function.
- Roles: `owner`, `admin`, `lawyer`, `paralegal`, `readonly`. A user may belong to several orgs; the *active* org is in the claim, and switching org refreshes the token.

**ADR-006: Reads client-direct; sensitive writes through callables.**
- Simple single-document writes (edit a task title) go client-direct, validated by rules.
- Callables (`onCall`, zod-validated) handle:
  - multi-document invariants: matter numbering, invoice numbering, deadline recompute, accepting a suggestion;
  - anything privileged;
  - anything touching secrets or external APIs.
- Every callable is idempotent, using a client-provided `requestId` stored for 24 h.

**ADR-007: Shared zod schemas in `libs/domain`.**
- These schemas are the single source of truth for every entity.
- Types come from `z.infer`.
- Firestore converters and callable validation both use them.
- Rules mirror the critical constraints, and rules tests prove it.

**ADR-008: Dates, money and time.**
- Legal and calendar dates are stored as `DateOnly` strings `YYYY-MM-DD`.
- Instants are Firestore `Timestamp`.
- Org timezone defaults to `Australia/Melbourne`; day arithmetic uses the Temporal polyfill (`@js-temporal/polyfill`) or `date-fns-tz`, never naive `Date` maths.
- Money is integer cents (AUD).
- Time is integer minutes; billing units are 6 minutes, with the rounding mode set in org settings.

**ADR-009: The deadline engine is pure TS plus versioned rule-set data.**
- See *Deadline engine & legal rules*.
- Rule sets are immutable once published; a new version is a new document.
- Every computed deadline stores `{ruleId, ruleSetVersion, inputs, trace}`.

**ADR-010: Audit log.**
- `orgs/{orgId}/audit/{id}` is append-only and written only by functions (Firestore triggers on matter subtrees plus callables).
- Clients cannot write it.
- Retained 7 years.

**ADR-011: Clerk (AI).**
- Claude (Sonnet 5.5 by default, Opus 5.5 opt-in; ADR-011b) sits behind `ClerkGateway` (in functions only).
- The provider is chosen by the AI-01 spike. Order of preference: Claude on Vertex AI in an Australian region → Claude Platform/Bedrock in Sydney → Anthropic API with zero data retention, but only with an explicit privacy sign-off.
- Clerk outputs structured proposals with citations, never direct writes.
- See the Clerk doc.
- **Provider: see [ADR-011a](adr/ADR-011a-clerk-provider.md)** (accepted for the MVP): the **Anthropic API**. The owner accepted processing outside Australia for the MVP. Bedrock's `AU` profile is the documented path if Australian processing is needed later.
- **Credentials and model: see [ADR-011b](adr/ADR-011b-clerk-byok.md)** (supersedes ADR-011a's credentials and default model): each firm brings its own Anthropic API key, KMS-encrypted in `orgs/{orgId}/integrations/anthropic`, and Clerk runs on Claude Sonnet 5.5 by default with Opus 5.5 as an admin opt-in.

**ADR-012: Retrieval.**
- Document text is chunked into `orgs/{orgId}/matters/{matterId}/documents/{docId}/chunks/{n}`, with embeddings from Vertex AI text embeddings in `australia-southeast1`.
- Retrieval uses Firestore vector search (`findNearest`), pre-filtered by `orgId` and `matterId`.
- No third-party search SaaS in v1 (data residency).

**ADR-013: Search (⌘K).**
- Each searchable document carries a denormalised `search` field: lower-cased prefix tokens of its title, number, client and deceased names, maintained by triggers.
- Queries use `array-contains`, capped at 20 results per collection.
- Upgrade path: a dedicated search service, if a later ADR approves one.

**ADR-014: Heavy work goes to Cloud Run jobs or Cloud Tasks.**
- Anything over 60 s or 1 GiB (PDF compile, court book, bulk OCR, migration) runs as a Cloud Run job or a Cloud Tasks-driven function with checkpointing.
- No long work in triggers.
- [ADR-055](adr/055-csv-exports-weekly-report.md) (INS-03): list exports are `csv.export` jobs from one callable, `exports-create`, written in the callable up to 5,000 rows and streamed by the `exports-run` queue beyond. Access is re-checked at the end, privileged matters go in only when a lawyer or above asks, and every export is audited. The weekly practice report is an opt-in Monday 07:00 (org time) email of figures and matter numbers only.
- [ADR-058](adr/058-org-export-and-deletion.md) (SEC-05): the owner's full export is an `org.export` job on the `exports-runOrgFull` queue, written as self-contained zips of at most 10 GB (JSON Lines per collection with generated JSON Schemas, the files, a README and a SHA-256 manifest), checkpointed per part. Deleting a practice makes it read-only for 30 days (an allow-list in the callable wrapper and `validMeta()` in the rules), then `orgs-purge` takes it apart a stage per task behind a server-only tombstone that makes triggers and tasks skip it, verifies nothing is left and emails a certificate. A legal hold or a running export blocks it.

**ADR-015: Email.**
- Transactional email goes through Resend via a function, with templates in the repo.
- Inbound email-to-matter uses Resend's inbound webhook (`email.received`).
- The provider is swappable behind `MailPort`.
- [ADR-057](adr/057-resend-email.md) (FND-20b): Resend replaces Postmark (Blake, 2026-10-07): cheaper, and simpler to set up. Mail goes through Resend's HTTP API with no SDK, and its Svix-signed webhook (`notifications-resendWebhook`) marks hard-bounced, suppressed and complaining addresses undeliverable. The key and signing secret are `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET`.

**ADR-016: Feature flags.**
- Remote Config, read through `FeatureFlagService`.
- Every incomplete or practitioner-review feature ships dark.
- How it works (FND-23):
  - **Registry.** `FLAGS` in `libs/domain/src/lib/flags.ts` is the only list. Each flag has a key, description, owning ticket, type, default and `serverEnforced`. Unknown keys fail typecheck on the web and in functions.
  - **Never authorisation.** Flags hide or reveal features. Roles and rules decide who may do what. A `serverEnforced` flag is also checked by its callables with `requireFlag(ctx, key)`, which throws `FEATURE_DISABLED`.
  - **Precedence:** local override (dev builds only, `materia.flags.local` in localStorage, edited at `/__dev/flags`) > org override (`orgs/{orgId}.flags`) > Remote Config > registry default.
  - **Remote Config keys** can't contain dots: `clerk.features.brief` is the parameter `clerk_features_brief` (`remoteConfigKey`). Create parameters in the dev or prod console only when a flag must differ from its default for everyone. The client fetches at most hourly in prod and each minute in dev; functions cache the server template for 60 s.
  - **Dev values from CI (FND-23a):** the `remote-config` workflow prints every flag as the dev client and server templates have it, and what the app ends up with. Dev flags agents change go in `infra/remote-config/dev.json`: merging a change publishes the listed flags to both dev templates (`null` removes one, unlisted flags are left alone). Prod flags stay a person's change in the console.
  - **Org overrides** are written only by the `flags-setOrgOverride` callable, which requires the `platformAdmin` claim. Grant it with `pnpm materia-scripts platform-admin --project <id> --uid <uid>` (add `--revoke` to remove). Each change writes a `flag.override_set` or `flag.override_cleared` audit entry in that org.
  - **Web:** `FeatureFlagService.flag(key)` gives a signal, `*mtFlag="key"` renders while on, `flagGuard(key)` keeps a route behind its flag, and nav items carry `flag`.
  - **Removal.** When a flag is fully on everywhere, set `fullyOnSince`. The CI flag report (`pnpm materia-scripts flags-report`) warns once that is over 90 days, and the owning ticket removes the flag.

**ADR-017: Testing stack.**
- Vitest for unit tests in libs and functions.
- Angular testing with Vitest.
- `@firebase/rules-unit-testing` against the emulator.
- Playwright e2e against emulators plus the built app.
- axe-core in e2e.
- Storybook for `libs/ui`, with interaction tests.
- [ADR-061](adr/061-performance-budgets.md) (SEC-07): key screens are held to Web Vitals budgets (LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1 on a mid-tier phone) and Firestore read budgets (Today ≤ 150, a matter ≤ 100), measured every morning by the non-blocking `perf` CI job against `seed-large` on the emulators with a reads counter built only into e2e builds. A screen that misses one is held at a ceiling in `VITALS_EXCEPTIONS` or `READ_BUDGETS` until its follow-up ticket lands. Hot callables are load-tested by hand with k6 (`tools/load/`) to p95 < 1 s at 10× peak. Write hot spots get single-field index exemptions; numbering keeps one counter transaction per org.

**ADR-018: Observability.**
- Structured JSON logs (`logger` from `firebase-functions`), with a `requestId`, `orgId`, `uid` and `feature` on every line.
- Error Reporting.
- Client errors go to a `logClientError` callable, with PII scrubbed.
- Cloud Monitoring alerts are defined in Terraform.

**ADR-019: Integrations.**
- OAuth runs server-side.
- Refresh tokens are encrypted with Cloud KMS and stored in `orgs/{orgId}/integrations/{uid}_{provider}` (or `{provider}` for a practice-wide connection such as Xero), which clients cannot read.
- Unlike legacy, nothing is stored in `localStorage`.
- [ADR-051](adr/051-oauth-token-vault.md) (INT-01): the provider redirects to an app route, which finishes the connect through `integrations-complete` as the signed-in person who started it. Each attempt (PKCE verifier, who, where to return) is a single-use, 10-minute record under the hash of a random `state`. Clients read only the `integrationStatus` mirror. A refused refresh token marks the connection `reconnect_required` and notifies once, with no retries.
- [ADR-053](adr/053-xero-sync.md) (BILL-09): issued invoices, credit notes and voids go to Xero through the rate-limited `xero-push` queue, never from a callable. Creates carry an idempotency key, and a number Xero already holds is adopted only when it is the same document, else reported and never overwritten. Contacts are matched by a stored link, then a unique email, never by name. Payments made in Xero come back hourly as BILL-08 payments, once each by Xero's payment id. Behind `integrations.xero`.
- [ADR-064](adr/064-claude-connector.md) (INT-07): a person connects their own Claude (or Claude Code) to Materia over MCP. `connector-api` serves a stateless JSON MCP endpoint at `/mcp` and Materia's own OAuth 2.1 server (PKCE, refresh rotation with reuse detection, RFC 8707 resource binding) on the app's origin; the consent page is the app route `/connect/claude`. Claude's clients are pinned, never registered or fetched. Tokens are opaque and stored as hashes, and every call re-checks the member, role, session, MFA and the practice's switch. Read tools leave out privileged matters and document text; write tools only create suggestion cards. Every call is audited. Behind `integrations.claudeConnector` and the practice's switch in Settings → Claude connector.
- [ADR-054](adr/054-insights-narratives.md) (INS-04): Clerk explains an Insights selection from the two periods' figures, given as display text with the changes already worked out, so it copies numbers and never calculates them. Every number in a paragraph must match a figure the paragraph cites, or the paragraph is dropped. The checked explanation is kept for 24 hours per (period, comparison) for the whole practice and refreshed at most every 10 minutes. Chips pick out the cited figure on screen. Behind `clerk.features.insightsNarrative` and the practice's "Explain Insights" toggle.
- [ADR-059](adr/059-matter-brief.md) (AI-06c): each matter has one shared brief on its Overview, built from facts every reader of the matter may see (deadlines, tasks, the feed and documents added, open suggestions; privileged records only on a privileged matter, never document text). Clerk writes up to five items that must cite those records, and every number and date is checked against them. A template brief from the same facts shows when Clerk is off, can't be used or fails. The callable rebuilds it when its facts or the day change or it is 24 hours old; Refresh is 3 a day per matter. Behind `clerk.features.matterBrief` and the practice's "Matter brief" toggle.

**ADR-020: Offline and PWA.**
- Firestore `persistentLocalCache` with a multi-tab manager, plus the Angular service worker for the shell.
- Offline writes are allowed only for client-direct write paths. Callables show "needs connection".
- [ADR-060](adr/060-installable-app-updates-and-offline-indicators.md) (MOB-01): `sw.js` wraps the Angular service worker, sends API and `/__/` requests straight to the network and gives navigations a 4-second timeout. No API response is cached by the worker. A new version offers a Reload toast and reloads every tab together; `system-ping` returns `minClientVersion`, and a client older than `CLIENT_COMPAT_VERSION` asks to reload, with a chance to save first. A banner shows offline, a "Pending sync" chip counts unsynced documents, and callable buttons read "Needs connection" offline.
- [ADR-063](adr/063-scanning-paper-on-a-phone.md) (MOB-05): a phone scan finds and straightens each page in the browser (the largest bright region's corners, then a homography), with no library, and writes the PDF itself. Corners can be dragged when the page isn't found. Every scan is kept in IndexedDB (`materia-scans`) until its upload is sent, so one saved offline uploads on reconnect; signing out warns and deletes the queue. Uploads carry `source: 'camera'`.
- [ADR-065](adr/065-web-push-on-devices.md) (MOB-04): web push uses `sw.js` and FCM's default VAPID key, with no Firebase messaging worker. Each browser keeps a device id in IndexedDB and registers `users/{uid}/devices/{deviceId}`, refreshed daily and deleted on sign-out. Alerts are offered on the first critical deadline or in Settings, never on sign-in, and never asked again once blocked; iOS Safari is sent to install first. A push carries the title and a fixed body, never the notification's text, and a tap opens `/open`, which keeps links inside Materia and asks before switching practice. Devices unseen for 60 days are pruned.

**ADR-035: Trust money is shown, never kept** ([ADR-035](adr/035-trust-accounting.md), BILL-10).
- Materia never keeps trust records: no receipts, payments, transfers, running balance or "available" amount. The trust ledger stays in the firm's trust software.
- At most a matter shows a trust balance snapshot copied from those records (amount, as-at date, source system), labelled "Not the trust ledger", behind `billing.trustDisplay` (BILL-11). A later read-only integration may fill it.
- "Paid from trust" is a `trust_transfer` payment recorded after the withdrawal (BILL-12); distributions (CORE-16) never move money.

**ADR-036: The will safe custody register is written only through callables** ([ADR-036](adr/036-will-safe-custody-register.md), CORE-17).
- Packets are read by members and written only by the `safeCustody-*` callables, so the chain of custody can only grow.
- A release or destruction needs a lawyer or above, a sign-in within 5 minutes and an authority document from a matter. A destruction also needs a second lawyer's confirmation.
- Probate matters link through the testator's party rows, not a packet field.

**ADR-039: Matter closing, retention and destruction** ([ADR-039](adr/039-matter-closing-retention-and-destruction.md), CORE-19).
- Matters close only through `matters-close` and its checklist; `destroyAfter` is stored and only ever moves later; matters archive (read-only) 90 days after closing.
- Destruction is queued monthly, approved per matter by an admin (typed number, fresh sign-in), and run as a resumable Cloud Tasks job that leaves a tombstone, the audit trail and a certificate. Gated by `matters.destruction` until CORE-19a's practitioner sign-off.

## Cross-cutting conventions

- **IDs:** Firestore auto-ids for documents. Human-friendly numbers are allocated by a transaction on `orgs/{orgId}/counters/{name}`:
  - matter `M-2026-0142`;
  - invoice `INV-000123`, gapless.
- **Every document** carries `createdAt`, `createdBy`, `updatedAt`, `updatedBy`, `schemaVersion`, and soft-delete `deletedAt?`/`deletedBy?` where the entity is deletable.
- **Schema evolution:** `schemaVersion` integer, plus lazy upgrade in converters and backfill scripts in `tools/scripts/backfills/` for breaking changes.
- **Functions naming:** `<domain>-<verb><Noun>`, for example `matters-createMatter` or `billing-issueInvoice`, grouped by codebase export.
- **Errors:** functions throw `HttpsError` with stable `details.code` strings (`MATTER_NUMBER_CONFLICT`, …), and the UI maps codes to copy.
