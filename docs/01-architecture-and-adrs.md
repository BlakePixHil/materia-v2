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
firebase/              firestore.rules, storage.rules, firestore.indexes.json, firebase.json
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
- Claude `claude-opus-5-5` sits behind `ClerkGateway` (in functions only).
- The provider is chosen by the AI-01 spike. Order of preference: Claude on Vertex AI in an Australian region → Claude Platform/Bedrock in Sydney → Anthropic API with zero data retention, but only with an explicit privacy sign-off.
- Clerk outputs structured proposals with citations, never direct writes.
- See the Clerk doc.
- **Provider: see [ADR-011a](adr/ADR-011a-clerk-provider.md)** (accepted for the MVP): the **Anthropic API**, with the key in Secret Manager. The owner accepted processing outside Australia for the MVP. Bedrock's `AU` profile is the documented path if Australian processing is needed later.

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

**ADR-015: Email.**
- Transactional email goes through Postmark via a function, with templates in the repo.
- Inbound email-to-matter uses Postmark inbound webhooks.
- The provider is swappable behind `MailPort`.

**ADR-016: Feature flags.**
- Remote Config, read through `FeatureFlagService`.
- Every incomplete or practitioner-review feature ships dark.

**ADR-017: Testing stack.**
- Vitest for unit tests in libs and functions.
- Angular testing with Vitest.
- `@firebase/rules-unit-testing` against the emulator.
- Playwright e2e against emulators plus the built app.
- axe-core in e2e.
- Storybook for `libs/ui`, with interaction tests.

**ADR-018: Observability.**
- Structured JSON logs (`logger` from `firebase-functions`), with a `requestId`, `orgId`, `uid` and `feature` on every line.
- Error Reporting.
- Client errors go to a `logClientError` callable, with PII scrubbed.
- Cloud Monitoring alerts are defined in Terraform.

**ADR-019: Integrations.**
- OAuth runs server-side.
- Refresh tokens are encrypted with Cloud KMS and stored in `orgs/{orgId}/integrations/{uid}_{provider}`, which clients cannot read.
- Unlike legacy, nothing is stored in `localStorage`.

**ADR-020: Offline and PWA.**
- Firestore `persistentLocalCache` with a multi-tab manager, plus the Angular service worker for the shell.
- Offline writes are allowed only for client-direct write paths. Callables show "needs connection".

## Cross-cutting conventions

- **IDs:** Firestore auto-ids for documents. Human-friendly numbers are allocated by a transaction on `orgs/{orgId}/counters/{name}`:
  - matter `M-2026-0142`;
  - invoice `INV-000123`, gapless.
- **Every document** carries `createdAt`, `createdBy`, `updatedAt`, `updatedBy`, `schemaVersion`, and soft-delete `deletedAt?`/`deletedBy?` where the entity is deletable.
- **Schema evolution:** `schemaVersion` integer, plus lazy upgrade in converters and backfill scripts in `tools/scripts/backfills/` for breaking changes.
- **Functions naming:** `<domain>-<verb><Noun>`, for example `matters-createMatter` or `billing-issueInvoice`, grouped by codebase export.
- **Errors:** functions throw `HttpsError` with stable `details.code` strings (`MATTER_NUMBER_CONFLICT`, …), and the UI maps codes to copy.
