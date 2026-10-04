# Domain model & Firestore schema

The canonical definitions are the zod schemas in `libs/domain`. This page is the map. Every collection below lives under `orgs/{orgId}` unless marked **global** or **user**.

Common fields, omitted below, are on every document: `createdAt`, `createdBy`, `updatedAt`, `updatedBy`, `schemaVersion`. Soft-deletable documents also have `deletedAt?` and `deletedBy?`.

Types used below: `DateOnly` = `YYYY-MM-DD`; `Cents` = integer AUD cents; `Minutes` = integer.

## Tenancy & people

| Path | Purpose | Key fields |
|---|---|---|
| `orgs/{orgId}` | Firm | `name`, `abn`, `acn?`, `practiceType`, `jurisdictions: ('NSW'\|'VIC'\|'QLD'\|'WA'\|'SA'\|'TAS'\|'ACT'\|'NT')[]`, `primaryJurisdiction`, `timezone` (default `Australia/Melbourne`), `holidayLocality` (e.g. `VIC_GREATER_GEELONG`), `billing: {unitMinutes:6, rounding:'up'\|'nearest', gstRegistered, defaultRateCents, invoicePrefix, paymentTermsDays}`, `matterNumberFormat` (e.g. `M-{YYYY}-{seq:4}`), `fy: {startMonth:7}`, `retentionYears` (default 7), `plan`, `security: {mfaRequired, sessionIdleMinutes}` |
| `orgs/{orgId}/members/{uid}` | Membership | `role: 'owner'\|'admin'\|'lawyer'\|'paralegal'\|'readonly'`, `status: 'active'\|'suspended'\|'removed'`, `displayName`, `initials`, `title`, `admissionNo?`, `defaultRateCents`, `colour`, `budgets: {[fyStartYear]: Cents}`, `supervisorUid?` |
| `orgs/{orgId}/invites/{inviteId}` | Pending invites | `email` (lower-case), `role`, `tokenHash`, `expiresAt`, `status: 'pending'\|'accepted'\|'revoked'\|'expired'`, `invitedBy` |
| `orgs/{orgId}/members/{uid}/tasks/{taskId}` | Personal tasks not tied to a matter (the legacy dashboard checklist). Same shape as matter tasks, without `matterId` |
| `orgs/{orgId}/counters/{name}` | Sequence allocation | `next: number`. Written only in transactions by functions |
| `users/{uid}` (**user**) | Profile and preferences | `email`, `displayName`, `firstName`, `lastName`, `orgIds: string[]`, `activeOrgId`, `prefs: {theme:'system'\|'light'\|'dark', density, shortcuts, notifications:{email, push, digestHour}}`, `legacy?: {uid, migratedAt}` |

## Contacts

`orgs/{orgId}/contacts/{contactId}`:
- `kind: 'person'|'organisation'`
- Person fields: `givenNames`, `familyName`, `preferredName?`, `dateOfBirth?: DateOnly`, `dateOfDeath?: DateOnly`
- Organisation fields: `orgName`, `abn?`
- `emails[]`, `phones[]` (E.164; legacy `04…` becomes `+614…`), `addresses[] {type, line1, line2?, suburb, state, postcode, country:'AU'}`
- `tags[]`, `isReferrer: bool`, `referrerMeta?: {company, industry}`, `notes?`
- `search: string[]` (prefix tokens), `dedupeKey` (normalised name plus DOB)
- `mergedInto?`, used when contacts are merged; it is a tombstone pointer.

## Matters

`orgs/{orgId}/matters/{matterId}`:

**Identity and type**
- `number` (unique per org), `title`.
- `type: 'will'|'poa'|'probate'|'loa'|'admin'|'fp'|'contest'|'trust'` (the `MatterTag` tokens).
- `status: 'lead'|'open'|'on_hold'|'closed'|'archived'`.
- `stageId` (from the matter template), `templateId`, `templateVersion`.
- `jurisdiction`.

**People**
- `responsibleUid`, `teamUids[]`, `clientContactIds[]`.
- `deceased?: {contactId, dateOfDeath: DateOnly, domicile, lastAddress}`.
- `testator?: {contactId}`, for will and POA matters.
- `referrerContactId?`.

**Fees and conflicts**
- `fee: {arrangement: 'hourly'|'fixed'|'capped'|'conditional'|'pro_bono', amountCents?, capCents?, estimateCents?, rateOverrideCents?}`.
- `costsDisclosure: {status: 'not_required'|'required'|'sent'|'updated'|'waived', sentOn?: DateOnly, estimateCents?, documentId?}`.
- `conflictCheck: {status: 'pending'|'clear'|'potential'|'conflict', checkedAt, checkedBy, resultId}`.

**Estate and dispute summaries**
- `estate?: {grossValueCents?, netValueCents?, grantType?: 'probate'|'loa'|'loa_with_will'|'reseal', grantDate?: DateOnly, grantNo?}`.
- `dispute?: {kind: 'family_provision'|'will_contest'|'construction'|'executor_removal'|'other', proceedingIds[]}`.

**Housekeeping and denormalised fields**
- `privileged: bool`, `priority: 'none'|'urgent'|'high'|'medium'|'low'`.
- `externalRef?` (the matter's number in another system), `boardOrder?: number`.
- `labels[]`, `relatedMatterIds[]`.
- `closedAt?`, `closeReason?`, `destroyAfter?: DateOnly`.
- `search[]`.
- Denormalised for lists: `nextDeadline?: {id, dueDate, title, critical}`, `openTaskCount`, `wipCents`, `lastActivityAt`.

### Matter subcollections

| Subcollection | Key fields |
|---|---|
| `parties/{partyId}` | `contactId`, `role: 'client'\|'testator'\|'deceased'\|'executor'\|'administrator'\|'beneficiary'\|'attorney'\|'guardian'\|'trustee'\|'plaintiff'\|'defendant'\|'witness'\|'other_side_solicitor'\|'counsel'\|'interested_person'`, `share?`, `notes?`, `addedFrom?: 'manual'\|'clerk'\|'migration'` |
| `tasks/{taskId}` | `title`, `descriptionMd?`, `status: 'todo'\|'in_progress'\|'blocked'\|'done'\|'cancelled'`, `priority: 'none'\|'urgent'\|'high'\|'medium'\|'low'` (PriorityIcon levels), `assigneeUid?`, `dueDate?: DateOnly`, `deadlineId?`, `group?` (heading for grouping tasks, e.g. an imported checklist title), `checklist[] {id, text, done}`, `order: number` (fractional), `source: 'manual'\|'template'\|'clerk'\|'migration'`, `completedAt?` |
| `events/{eventId}` | Key facts that drive deadlines. `kind: 'date_of_death'\|'will_located'\|'notice_published'\|'probate_filed'\|'grant_issued'\|'statutory_notice_published'\|'caveat_lodged'\|'grant_served'\|'fp_claim_filed'\|'hearing'\|'order_made'\|'offer_made'\|'custom'`, `date: DateOnly`, `time?`, `meta`, `sourceDocumentId?` |
| `deadlines/{deadlineId}` | `title`, `dueDate: DateOnly`, `dueTime?`, `kind: 'statutory'\|'court'\|'contractual'\|'internal'`, `critical: bool`, `status: 'upcoming'\|'done'\|'missed'\|'waived'\|'superseded'`, `computed?: {ruleId, ruleSetId, ruleSetVersion, anchorEventId, inputs, trace[]}`, `override?: {dueDate, reason, by, at}`, `reminders[] {offsetDays, sentAt?}`, `assigneeUid`, `calendar?: {[uid]: {provider, eventId, etag}}` |
| `documents/{docId}` | `name`, `storagePath` (`orgs/{orgId}/matters/{matterId}/documents/{docId}/v{n}`), `mime`, `sizeBytes`, `sha256`, `version`, `category: 'will'\|'codicil'\|'death_certificate'\|'grant'\|'affidavit'\|'correspondence'\|'court_document'\|'order'\|'financial'\|'id'\|'other'`, `privileged`, `scan: {status:'pending'\|'clean'\|'infected'\|'error'}`, `ingest: {status:'pending'\|'done'\|'failed'\|'skipped', pages?, ocr?: bool, error?}`, `source: 'upload'\|'email'\|'clerk_draft'\|'migration'\|'camera'`, `pageCount?` |
| `documents/{docId}/chunks/{n}` | `text`, `page`, `embedding: Vector(768)`, `orgId`, `matterId`. Written by functions only |
| `notes/{noteId}` | `bodyMd` (Markdown with mention tokens `@[uid]` and `#[matterId]`), `mentions: {uids[], matterIds[]}`, `pinned`, `source: 'manual'\|'clerk'\|'migration'\|'voice'` |
| `activity/{id}` | Read-model for the feed, written by triggers from audit and notes: `kind`, `summary`, `actorUid`, `at`, `refs` |
| `timeEntries/{id}` | `uid`, `date: DateOnly`, `minutes`, `units`, `rateCents`, `amountCents`, `narrative`, `billable`, `status: 'draft'\|'final'\|'billed'\|'written_off'`, `invoiceId?`, `source: 'manual'\|'timer'\|'voice'\|'clerk'\|'migration'`, `taskId?` |
| `disbursements/{id}` | `date`, `description`, `amountExGstCents`, `gstCents`, `gstTreatment: 'taxable'\|'gst_free'\|'input_taxed'`, `payee`, `receiptDocumentId?`, `status`, `invoiceId?` |
| `assets/{id}` | Estate register. `class: 'real_property'\|'bank'\|'shares'\|'superannuation'\|'insurance'\|'vehicle'\|'personal'\|'business'\|'debt_owed_to_estate'\|'other'`, `description`, `valueAtDeathCents`, `valuationSource`, `jointlyHeld`, `passesOutsideEstate: bool` (super, joint tenancy, nominated policies), `status: 'identified'\|'valued'\|'realised'\|'transferred'`, `realisedCents?` |
| `liabilities/{id}` | `class`, `creditor`, `amountCents`, `status: 'notified'\|'paid'\|'disputed'` |
| `distributions/{id}` | `beneficiaryPartyId`, `kind: 'specific'\|'pecuniary'\|'residuary'`, `amountCents?`, `assetId?`, `status`, `paidOn?` |
| `suggestions/{id}` | Clerk proposals. `kind: 'task'\|'deadline'\|'event'\|'party'\|'time_entry'\|'note'\|'key_fact'\|'chronology'\|'order'`, `payload` (zod-validated per kind), `citations[] {documentId, version?, page, quote}`, `status: 'proposed'\|'accepted'\|'edited'\|'dismissed'\|'expired'`, `promptId`, `promptVersion` (semver, so `promptId@promptVersion` names the template), `model`, `confidence?`, `resolvedBy?`, `resolvedAt?`, `resultRef?` |
| `clerkThreads/{threadId}` and `/messages/{msgId}` | `role`, `content` (blocks), `citations[]`, `status: 'streaming'\|'done'\|'error'\|'stopped'\|'refused'\|'truncated'\|'invalid_output'`, `usage: {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}`, `promptId` (`id@version`), `model`, `fallbackUsed`, `stopRequested` (the only client-writable field), `toolCalls[]`. The verbatim assistant turn is in the server-only `messages/{msgId}/private/raw` (AI-02) |

### Litigation subcollections (on `contest`/`fp` matters)

| Subcollection | Key fields |
|---|---|
| `proceedings/{id}` | `court: 'VSC'\|'VCC'\|...` (Supreme or County Court of Victoria), `list` (court list name, verify), `location`, `fileNumber`, `judicialOfficer?`, `stage` (from LIT_STAGES), `filedOn`, `ourRole: 'plaintiff'\|'defendant'\|'executor'\|'interested'` |
| `courtEvents/{id}` | `proceedingId`, `kind: 'directions'\|'mediation'\|'hearing'\|'judgment'\|'callover'\|'other'`, `date`, `time?`, `location`, `outcome?`, `ordersDocumentId?` |
| `orders/{id}` | `courtEventId`, `orderNo`, `text`, `requiresAction: bool`, `dueDate?`, `deadlineId?`, `responsiblePartyRole`, `status: 'pending'\|'complied'\|'varied'` |
| `chronology/{id}` | `date: DateOnly`, `datePrecision: 'day'\|'month'\|'year'\|'approx'`, `title`, `detail`, `sources[] {documentId, page, quote}`, `disputed: bool`, `issueIds[]` |
| `issues/{id}` | `title`, `elements[]`, `ourPosition`, `internalAssessment` (lawyer-only, never client-facing) |
| `evidence/{id}` | `documentId?`, `witnessPartyId?`, `issueIds[]`, `supports: 'us'\|'them'\|'neutral'`, `strength: 1..3`, `admissibilityNote?` |
| `subpoenas/{id}` | `issuedTo`, `issuedOn`, `returnDate`, `status`, `accessOrderMade`, `materialDocumentIds[]` |
| `offers/{id}` | `kind: 'calderbank'\|'offer_of_compromise'\|'without_prejudice'\|'open'`, `by: 'us'\|'them'`, `madeOn`, `expiresOn?`, `amountCents?`, `termsMd`, `status: 'open'\|'accepted'\|'rejected'\|'lapsed'\|'withdrawn'`, `deadlineId?`, `privileged: true` |
| `courtBooks/{id}` | `title`, `tabs[] {title, entries[] {documentId, version, pageFrom?, pageTo?}}`, `status: 'draft'\|'building'\|'built'\|'failed'`, `outputDocumentId?`, `builtFromHash` |

Migrated documents also carry `migration: {runId, legacyPath, loadedAt}`, `needsReview?: string[]` and, on matters, `legacyBilling?` (read-only). See the *Legacy migration plan*.

## Org-level collections

| Path | Key fields |
|---|---|
| `invoices/{id}` | `number` (gapless), `matterId`, `issueDate`, `dueDate`, `lines[]`, `subtotalCents`, `gstCents`, `totalCents`, `status: 'draft'\|'issued'\|'part_paid'\|'paid'\|'void'`, `pdfDocumentId`, `xero?: {invoiceId, syncedAt, error?}`, `payments[]` |
| `creditNotes/{id}` | Reverses issued invoices. Invoices are never edited after issue |
| `templates/{id}` | Matter templates: `matterType`, `version`, `stages[]`, `tasks[] {title, stageId, offsetFromEvent?}`, `deadlineRuleIds[]`, `published`, `source: 'system'\|'org'` |
| `docTemplates/{id}` | docx templates with merge fields |
| `metrics/{period}` | Rollups. `period` is `day-2026-10-03`, `month-2026-10` or `fy-2027`, or `clerk-2026-10` for Clerk metering (tokens and cost, per feature and per user; AI-02) |
| `audit/{id}` | Append-only. `at`, `actor {uid\|'system'\|'clerk'}`, `action`, `entity {path}`, `before?`, `after?` (diffed, redacted), `requestId`, `source` |
| `notifications/{id}` | `recipientUid`, `kind`, `title`, `body`, `link`, `readAt?`, `channel: ['inapp','email','push']` |
| `integrations/{uid_provider}` | **Server-only.** `provider: 'microsoft'\|'google'\|'xero'`, `status`, `scopes`, `encryptedRefreshToken`, `kmsKeyVersion`, `lastSyncAt`, `error?` |
| `safeCustody/{id}` | Will packets. `testatorContactId`, `documentIds[]`, `packetNo`, `location`, `receivedOn`, `movements[] {at, by, kind:'in'\|'out'\|'returned'\|'released', to?, authorityDocId?}`, `status` |
| `migrations/{runId}` | Migration run reports (see the migration doc) |

## Global (read-only to clients)

| Path | Purpose |
|---|---|
| `ruleSets/{ruleSetId}/versions/{version}` | Deadline rules (see the deadline doc) |
| `calendars/{jurisdiction}-{year}` | Public holidays and court/registry closures |
| `systemTemplates/{id}` | Default matter templates |

## Invariants (enforced in rules, callables and tests)

1. `members/{uid}` exists and is `active` ⇔ the user's claim includes the org. Claims are synced by the trigger `auth-syncClaims`.
2. Matter `number` is unique per org. It is allocated only by `matters-createMatter` in a transaction.
3. An invoice `number` is gapless and is never reused. A voided invoice keeps its number.
4. A deadline's `dueDate` is never changed silently by a recompute. A recompute writes a *proposal* when the date would move; an `override` always wins.
5. A `timeEntry` with status `billed` is immutable except through a credit-note flow.
6. `audit` and `chunks` cannot be written by clients.
7. `privileged` documents and offers are never readable by `readonly`, and are excluded from exports unless `includePrivileged` is set by owner or admin.
8. Deleting a matter is a soft delete. Hard deletes happen only through retention jobs after `destroyAfter`.

## Indexes (initial)

- `matters`: (status, updatedAt desc), (responsibleUid, status), (type, status), (search array-contains, updatedAt desc).
- Collection group `tasks`: (assigneeUid, status, dueDate), (orgId, status, dueDate). Collection-group docs carry a denormalised `orgId` and `matterId`.
- Collection group `deadlines`: (orgId, status, dueDate), (assigneeUid, status, dueDate).
- Collection group `timeEntries`: (orgId, uid, date), (orgId, status, date).
- Collection group `chunks`: a vector index on `embedding` with `orgId` and `matterId` pre-filters.

**Rule:** every collection-group-queried document stores `orgId` and `matterId`, and the rules check `resource.data.orgId == claimOrg()`.

## Supporting collections (added while ticketing; owners in brackets)

| Path | Purpose |
|---|---|
| `users/{uid}.claimsVersion` | Incremented by `auth-syncClaims`. The client refreshes its token when this changes (FND-17) |
| `users/{uid}/devices/{deviceId}` | `{token, platform, lastSeenAt}` FCM registry (FND-20, MOB-04) |
| `users/{uid}/views/{id}`, `users/{uid}/recent`, `users/{uid}/drafts/{id}` | Saved list views (CORE-03), recents (CORE-14/15), intake drafts with 30-day TTL (CORE-05) |
| `users/{uid}/timer/current` | The single running timer (BILL-02) |
| `users/{uid}/briefs/{date}` | Clerk daily brief (AI-09) |
| `users/{uid}/private/recovery` | **Server-only.** Hashed MFA recovery codes (FND-16) |
| `orgs/{orgId}/requests/{requestId}` | **Server-only.** Callable idempotency records, 24 h TTL (FND-15) |
| `orgs/{orgId}/conflictChecks/{id}` | Conflict-check runs and hits (CORE-02) |
| `orgs/{orgId}/jobs/{jobId}` | Cloud Run job status and progress (FND-24) |
| `orgs/{orgId}/exports/{id}` | Export records, files with a 7-day TTL (INS-03, SEC-05) |
| `orgs/{orgId}/destructionQueue/{id}` | Matters due for destruction awaiting approval (CORE-19) |
| `orgs/{orgId}/settings/{doc}` | Misc org settings documents, e.g. `disbursementPresets` (BILL-04) |
| `orgs/{orgId}/integrationStatus/{uid_provider}` | Client-readable, non-secret mirror of `integrations` (INT-01) |
| `orgs/{orgId}/unfiledEmails/{id}` | Inbound emails awaiting filing (INT-05) |
| `orgs/{orgId}/voiceNotes/{id}` | Voice capture transcripts and status; audio in Storage `orgs/{orgId}/voice/{uid}/` (MOB-03) |
| `orgs/{orgId}/feedback/{id}` | In-app help and feedback (SEC-08) |
| `orgs/{orgId}/matters/{id}/deadlineChanges/{id}` | Recompute proposals awaiting a decision (CORE-10) |
| `ops/heartbeats/{job}` (**global, server-only**) | Scheduled-job heartbeats for alerting (FND-21) |

### Additional fields

- **members:**
  - `rates[] {effectiveFrom: DateOnly, rateCents}` (BILL-01);
  - `supervisorUid` (CORE-11 escalation).
- **matters:**
  - `legalHold {on, reason, by, at}` (CORE-19);
  - `budget {recordedCents, billedCents, basisCents, pct}` (BILL-05);
  - `referralSource` (CORE-18);
  - `litigationSummary` (LIT-02);
  - `recomputeVersion` (CORE-10);
  - `emailToken` (INT-05);
  - `fee.history[]`, `fee.conditional` (BILL-05).
- **deadlines:**
  - `nextReminderAt`, `ackBy`, `ackAt` (CORE-11);
  - `pastOnCreation`;
  - a `blocked` status with `blockedReason` (CORE-10);
  - `kind: 'court_watch'` (LIT-04).
- **timeEntries:** `writeDown {originalUnits, originalAmountCents, by, reason}` (BILL-03).
- **documents:**
  - `encrypted` (CORE-12);
  - `accessRestricted` (LIT-08);
  - `source` adds `'generated'` and `'camera'`;
  - `renditions.previewPdf` (CORE-12).
- **suggestions:**
  - kinds add `document_meta` (AI-04) and `evidence` (LIT-07);
  - status adds `stale` (AI-07);
  - adds `basis` and `dedupeKey`.
- **notes:** `revisions/{id}` subcollection (CORE-13), and `privileged` per note.
- **org:**
  - `settings.clerk` (AI-13), `security` (SEC-04), `flags` (FND-23);
  - `legalHold`, `deletionScheduledAt` (SEC-05);
  - `termsAcceptedVersion` (SEC-01).
