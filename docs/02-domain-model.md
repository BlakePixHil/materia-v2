# Domain model & Firestore schema

The canonical definitions are the zod schemas in `libs/domain`. This page is the map. Every collection below lives under `orgs/{orgId}` unless marked **global** or **user**.

Common fields, omitted below, are on every document: `createdAt`, `createdBy`, `updatedAt`, `updatedBy`, `schemaVersion`. Soft-deletable documents also have `deletedAt?` and `deletedBy?` (`null` means live, like a missing field; live matters always store `deletedAt: null` so lists can filter on it).

Types used below: `DateOnly` = `YYYY-MM-DD`; `Cents` = integer AUD cents; `Minutes` = integer.

## Tenancy & people

| Path | Purpose | Key fields |
|---|---|---|
| `orgs/{orgId}` | Firm | `name`, `abn`, `acn?`, `practiceType`, `jurisdictions: ('NSW'\|'VIC'\|'QLD'\|'WA'\|'SA'\|'TAS'\|'ACT'\|'NT')[]`, `primaryJurisdiction`, `timezone` (default `Australia/Melbourne`), `holidayLocality` (e.g. `VIC_GREATER_GEELONG`), `billing: {unitMinutes:6, rounding:'up'\|'nearest', gstRegistered, defaultRateCents, invoicePrefix, paymentTermsDays}`, `matterNumberFormat` (e.g. `M-{YYYY}-{seq:4}`; tokens `{YYYY}`, `{YY}`, `{TYPE}`, `{seq}`/`{seq:N}`), `matterTypeCodes?` (`{TYPE}` overrides per matter type, CORE-21a), `fy: {startMonth:7}`, `retentionYears` (default 7), `plan`, `security: {mfaRequired, sessionIdleMinutes}` |
| `orgs/{orgId}/members/{uid}` | Membership | `role: 'owner'\|'admin'\|'lawyer'\|'paralegal'\|'readonly'`, `status: 'active'\|'suspended'\|'removed'` (both server-owned: only the orgs callables change them), `email` (lower-case, to tell apart same names), `displayName`, `initials`, `title`, `admissionNo?`, `defaultRateCents`, `colour`, `budgets: {[fyStartYear]: Cents}`, `supervisorUid?` |
| `orgs/{orgId}/invites/{inviteId}` | Pending invites | `email` (lower-case), `role`, `tokenHash`, `expiresAt`, `status: 'pending'\|'accepted'\|'revoked'\|'expired'`, `invitedBy`, `acceptedBy?`, `acceptedAt?`. The token is sent in the link and only its SHA-256 is stored |
| `orgs/{orgId}/members/{uid}/tasks/{taskId}` | Personal tasks not tied to a matter (the legacy dashboard checklist). Same shape as matter tasks, with `matterId: null` and `assigneeUid` always the owner; only the owner reads or writes them (CORE-08) |
| `orgs/{orgId}/counters/{name}` | Sequence allocation | `next: number`. Written only in transactions by functions. Matter numbers use `matter-{YYYY}` (CORE-03) |
| `users/{uid}` (**user**) | Profile and preferences | `email`, `displayName`, `firstName`, `lastName`, `orgIds: string[]`, `activeOrgId`, `memberships: {[orgId]: {role, name}}` (all three server-owned, mirrored by `auth-syncClaims`), `prefs: {theme:'system'\|'light'\|'dark', density, shortcuts, notifications:{email, push, digestHour}}`, `legacy?: {uid, migratedAt}` |

## Contacts

`orgs/{orgId}/contacts/{contactId}`:
- `kind: 'person'|'organisation'`
- Person fields: `givenNames`, `familyName`, `preferredName?`, `dateOfBirth?: DateOnly`, `dateOfDeath?: DateOnly`
- Organisation fields: `orgName`, `abn?`
- `emails[]`, `phones[]` (E.164; legacy `04…` becomes `+614…`), `addresses[] {type, line1, line2?, suburb, state, postcode, country:'AU'}`
- `tags[]`, `isReferrer: bool`, `referrerMeta?: {company, industry}`, `notes?`
- `search: string[]` (prefix tokens), `dedupeKey` (normalised name plus DOB), `sortName` (lower-cased display name, for `orderBy`): server-owned, kept current by the `contacts-onWrite` trigger
- `mergedInto?`, used when contacts are merged; it is a tombstone pointer. A tombstone is also soft-deleted and the rules freeze it.

Functions (CORE-01): `contacts-create` (`contact.edit`; creates are callable-only), `contacts-findDuplicates` (`contact.edit`; best five live contacts at or above `DUPLICATE_THRESHOLD`), `contacts-merge` (`contact.merge`; folds one contact into another, re-points parties, matter client/referrer/deceased/testator ids and safe custody packets, 200 in the call and the rest through the `contacts-continueMerge` queue; audited as `contact.merged`) and `contacts-delete` (`contact.delete`; soft delete, refused with `FAILED_PRECONDITION`, `details.reason: 'contact_referenced'` and `details.references: ContactReference[]` while anything references the contact).

## Matters

`orgs/{orgId}/matters/{matterId}`:

**Identity and type**
- `number` (unique per org), `title`.
- `type: 'will'|'poa'|'probate'|'loa'|'admin'|'fp'|'contest'|'trust'` (the `MatterTag` tokens).
- `status: 'lead'|'open'|'on_hold'|'closed'|'archived'`.
- `stageId` (from the matter template), `stageEnteredOn?: DateOnly` (server-owned; the day, org time zone, the matter entered the stage; template task due dates count from it, CORE-07), `templateId` (`system-{type}` or an org template id), `templateVersion` (the published version the matter follows; it never changes under the matter, CORE-07).
- `jurisdiction`.

**People**
- `responsibleUid`, `teamUids[]`, `clientContactIds[]`.
- `deceased?: {contactId, dateOfDeath?: DateOnly, domicile, lastAddress}`. `dateOfDeath` is absent while unknown (CORE-05): no `date_of_death` event, template tasks anchored on it show "due date pending", and intake creates a death certificate task; recording it later (key facts) makes the event known.
- `testator?: {contactId}`, for will and POA matters (for a POA, the principal).
- `facts?: {willDate?: DateOnly, courtFileNo?, trustName?}`: key facts not held elsewhere (CORE-06; `trustName` for trust matters, CORE-05).
- `referrerContactId?`.

**Fees and conflicts**
- `fee: {arrangement: 'hourly'|'fixed'|'capped'|'conditional'|'pro_bono', amountCents?, capCents?, estimateCents?, rateOverrideCents?, conditional?: {upliftPct (≤ 25), condition}, history[]}`. `FeeInput` (CORE-05) checks the arrangement: fixed needs `amountCents`, capped `capCents` (and an estimate within it), conditional `conditional`, pro bono no amounts.
- `costsDisclosure: {status: 'not_required'|'required'|'sent'|'updated'|'waived', sentOn?: DateOnly, estimateCents?, documentId?}`. At intake the status comes from the fee's estimate (`feeEstimateCents`: the estimate, else the fixed fee or cap, 0 for pro bono) through `costsDisclosureRequirement`, a **placeholder** single threshold (`COSTS_DISCLOSURE_PLACEHOLDER_THRESHOLD_CENTS`, $750) until BILL-06 replaces it; an unknown estimate needs a disclosure.
- `conflictCheck: {status: 'pending'|'clear'|'potential'|'conflict', checkedAt, checkedBy, resultId, reason?}`. `resultId` names the `conflictChecks` run the determination was made on; `reason` is required for `potential` and `conflict` (CORE-02).
- `conflictAlert?: {checkId, contactId, partyId?, at, adverse}`: server-owned, set by `conflicts-onPartyAdded` when a party added to an open or on-hold matter is on other matters; cleared by `conflicts-determine` on the same check. It never blocks anything (CORE-02).

**Estate and dispute summaries**
- `estate?: {grossValueCents?, netValueCents?, grantType?: 'probate'|'loa'|'loa_with_will'|'reseal', grantDate?: DateOnly, grantNo?}`.
- `dispute?: {kind: 'family_provision'|'will_contest'|'construction'|'executor_removal'|'other', proceedingIds[]}`.

**Housekeeping and denormalised fields**
- `privileged: bool`, `priority: 'none'|'urgent'|'high'|'medium'|'low'`.
- `externalRef?` (the matter's number in another system), `externalUrl?` (a link to the matter elsewhere, e.g. 3E: an absolute http(s) URL, client-updatable, CORE-21a), `boardOrder?: number`.
- `labels[]`, `relatedMatterIds[]`.
- `closedAt?`, `closeReason?`, `destroyAfter?: DateOnly`.
- `search[]`.
- Denormalised for lists: `nextDeadline?: {id, dueDate, title, critical}`, `openTaskCount`, `wipCents`, `lastActivityAt`.

Clients update only `title`, `responsibleUid`, `teamUids`, `labels`, `priority`, `externalRef`, `estate`, `deceased`, `facts` and `privileged` (the flag also needs `privileged.view`), and soft delete (`matter.delete`). Everything else goes through functions (CORE-03, CORE-06):

- `matters-createMatter` (`matter.create`, idempotent): allocates the number in a transaction from `counters/matter-{YYYY}` (the year in the org's time zone, so 1 January in Melbourne) and `matterNumberFormat` (default `M-{YYYY}-{seq:4}`), skipping any number already reserved in `matterNumbers/{matterNumberKey(number)}` or held by an existing matter, so a format change mid-year or a migrated matter can't cause a duplicate. Writes the counter, the reservation, the matter (`lead`, or `open` when `conflictCheck.status` is `clear` or `potential`), `parties` rows for the clients, deceased and testator, and a `matter.created` audit entry. With the `templates.system` flag on (CORE-07) the same transaction gives the matter a template version (the input's `templateId`/`templateVersion` when given, else the org's most recently published template of the type, else the type's system template), its first stage (or the input's stage when the template has it) and that stage's template tasks plus later ones whose anchor is known (see Matter templates); with it off, `templateId` is only stored. A migrated matter keeps `externalRef` and gets a new number. A `conflictCheck.status` other than `pending` is a determination at intake (CORE-02): it needs `conflict.determine` (`PERMISSION_DENIED`, `details.reason: 'conflict_determine_required'`), a reason for `potential` and `conflict`, and a `resultId` (when given) naming a check run for a new matter; the server stamps `checkedAt` and `checkedBy` and audits `matter.conflict_determined`.
- `matters-renumber` (`matter.renumber`: lawyer and above, idempotent, CORE-21a): gives a live matter a typed number (at most 40 characters). Refuses a number another matter has reserved or holds, case-insensitively (`ALREADY_EXISTS`); moves the `matterNumbers` reservation (the old one is released, so createMatter can reuse it) and updates `number` and `search` in one transaction. Audited as `matter.renumbered`. `{TYPE}` in the format comes from `org.matterTypeCodes`, else the defaults (`WIL`, `POA`, `PRB`, `LOA`, `ADM`, `FP`, `CON`, `TRU`).
  - **Intake (CORE-05).** The input also takes, all optional and backward compatible: `parties: [{contactId, role, share?, notes?}]` (≤ 100), `events: [{kind, date, label?}]` (≤ 20), `fee` (`FeeInput`, wins over `matter.fee`; one of the two is required), `costsDisclosure: {status: 'required'|'not_required'|'waived', estimateCents?}` (wins over `matter.costsDisclosure`; computed from the fee when neither is given; a `not_required` the estimate doesn't allow is `INVALID_ARGUMENT` on `costsDisclosure.status`) and `conflictCheckId` (stored as `conflictCheck.resultId`; it must agree with `matter.conflictCheck.resultId` when both are given). `matter.fee` and `matter.costsDisclosure` became optional in the input. In the same transaction as the matter it writes every party row (`initialParties` plus `parties`, one per `partyDocId(role, contactId)`, so duplicates collapse and a testator who is also an executor is two rows), the events (deduplicated, plus a `date_of_death` event from `deceased.dateOfDeath` when known; a listed one must match it), the template's stage and tasks (seeing those events as anchors), and, when the deceased's date of death is unknown, exactly one death certificate task at `tasks/tpl-obtain_death_certificate` (`templateTaskKey: obtain_death_certificate`): the probate and LOA templates already have it, otherwise it is added (`source: 'manual'`), and a later template apply never adds a second. `planIntakeDeadlines` is the empty hook CORE-10 fills. A known date of death after the org's today, or before the deceased contact's `dateOfBirth`, is `INVALID_ARGUMENT` on `matter.deceased.dateOfDeath`. Party contacts are read in the transaction; a missing, deleted or merged one is `INVALID_ARGUMENT` on `parties.{i}.contactId` and nothing is written (counter, reservation, matter, rows). A `conflict` determination creates a lead. The `matter.created` audit adds `parties`, `events` and `deathCertificateTask`.
  - **Step schemas** (`libs/domain/src/lib/intake.ts`), shared by the New matter form and the tests: `IntakeTypeStep` (`type`, `jurisdiction` = VIC), `IntakeClientsStep` (`clientContactIds`, ≥ 1, unique; new contacts go through `contacts-create` first), `IntakeDetailsStep`/`intakeDetailsStep({today})` (by type: will `testatorContactId`; poa `principalContactId`; probate/loa/admin `deceasedContactId`, `deceasedDateOfBirth?` (checked against only), `dateOfDeath: DateOnly|'unknown'`, `domicile`, `lastAddress?`, `willExists`, `willDate?`; fp/contest the deceased, `domicile?`, `ourRole: 'plaintiff'|'defendant'|'executor'` and `otherSideContactIds` (≥ 1, put in `OTHER_SIDE_ROLE`); trust `trustName`, `trusteeContactIds`), `IntakePartiesStep` (`parties`, no repeated role and contact), `IntakeFeesStep` (`fee`, `costsDisclosureWaived`), `IntakeConflictStep` (`checkId`, `status`, `reason` for potential and conflict) and `IntakeReviewStep` (`title`, `responsibleUid`, `teamUids`, `labels`, `priority`, `privileged`). `intakeFormSchema({today})` checks the whole form (details for the chosen type, no client on the other side) and `intakeToCreateMatterInput(form, requestId)` builds the callable input. Date checks: a date of death in the future or before the date of birth, a date of birth in the future, a will dated in the future or after the death, a will date without a will, and probate without a will are errors. The form's "Prefill from email or notes" button stays disabled behind the `clerk.features.intakePrefill` flag (default off, client-only for now).
- `matters-changeStatus` (`matter.status`): `MATTER_TRANSITIONS` (lead → open; open → on hold or closed; on hold → open; closed → open or archived), else `MATTER_INVALID_TRANSITION`. Lead → open needs a conflict determination of `clear` or `potential` (`CONFLICT_OPENABLE`); `pending` and `conflict` are `FAILED_PRECONDITION` with `details.reason: 'conflict_check_not_clear'` and `details.conflictStatus` (CORE-02); closed → open needs a `reason` (`INVALID_ARGUMENT`). Closing sets `closedAt` and `closeReason`; reopening clears them. Audited as `matter.status_changed`.
- `matters-changeStage` (`matter.edit`, idempotent; CORE-06, CORE-07): moves a live, visible matter that is not closed or archived (`FAILED_PRECONDITION`, `details.reason: 'matter_closed'`) to one of its stages: its template version's (the system bundle, `templates/{templateId}/versions/{templateVersion}`, else `templates/{templateId}.stages`) when it has one, else the type's defaults (`matterStages`). An unknown stage is `INVALID_ARGUMENT` on `stageId`; the same stage is a no-op. With `templates.system` off it is CORE-06: a forward move needs the key facts every stage passed into requires, else `MATTER_STAGE_REQUIREMENTS` with `details.requirements` (key fact ids), and moving back is always allowed. With it on, a forward move (skips included) needs, for every stage passed into, its key facts (`entryRequires.facts` plus those of the CORE-06 default stage with the same id), known events (`entryRequires.events`) and done template tasks (`entryRequires.tasksDone`), else `MATTER_STAGE_REQUIREMENTS` with `details.requirements` (key fact ids, as before), `details.events` (event kinds) and `details.tasks` (template task keys). Moving back needs `matter.status` (`PERMISSION_DENIED`, `details.reason: 'stage_back_requires_lawyer'`) and a `reason` (`INVALID_ARGUMENT` on `reason`); later stages' tasks stay. Entering a stage creates its template tasks and sets `stageEnteredOn`; the result lists `createdTaskIds`. Audited as `matter.stage_changed` (`from`, `to`, and `direction: 'back'` with the `reason` going back).
- `matters-upgradeTemplate` (`matter.edit`, idempotent, flag `templates.system`; CORE-07): `{matterId, version}` moves a live, open matter to that (same or later) published version of its template. It adds only the missing template tasks of the current stage (plus later ones whose anchor is known); earlier stages never get new tasks and nothing is deleted; future stages get the new version's tasks when entered. A stage the new version dropped follows the versions' `stageMapping`, else `FAILED_PRECONDITION` (`details.reason: 'stage_unmapped'`). No template: `FAILED_PRECONDITION` (`'no_template'`); an earlier version: `INVALID_ARGUMENT` on `version`; an unknown one: `NOT_FOUND`. Audited as `matter.template_upgraded`.
- `matters-upsertParty` and `matters-removeParty` (`matter.edit`, idempotent, privileged matters for `privileged.view` roles only; CORE-06): party rows live at `parties/{partyDocId(role, contactId)}`. Upsert without `partyId` adds a live, unmerged contact (else `INVALID_ARGUMENT` on `contactId`) in a role: a new row, a revived soft-deleted row, or an edit of the live one; with `partyId` it edits that row, and a changed role or contact soft-deletes it and creates or revives the row at the new id. `share` and `notes` are the row's full state. Remove soft-deletes the row. Both recompute the matter's `clientContactIds` from the live client rows (`clientContactIdsFrom`; a listed client with no client row at all, from before CORE-06, is kept) and refuse an empty result with `LAST_CLIENT`; `matters-denormalise` then refreshes `search`. Audited as `matter.party_added`, `matter.party_updated` and `matter.party_removed` (ids and roles only). Clients edit a row's `share` and `notes` directly, nothing else.
- `matters-restore` (`matter.restore`: owner, admin): restores a soft-deleted matter within 30 days of its delete, else `FAILED_PRECONDITION` (`details.reason: 'restore_window_passed'`). The rules freeze a deleted matter and never let a client restore it.
- `conflicts-run` (`conflict.run`: paralegal and above, idempotent): scores each subject (`ConflictSubject`) against the org's contacts with the CORE-01 duplicate scorer (field-mask scan), skipping deleted contacts and reporting a hit on a merge tombstone as the contact it was merged into (`viaMergedContactId`). The subject's own `contactId` is reported as `self` (score 1) when it is on other matters. For each hit, the `parties` collection group lists every matter it is on, closed, archived and deleted ones included (`deleted: true`), `excludeMatterId` left out; privileged matters show `PRIVILEGED_MATTER_TITLE`. With the `conflicts.enforced` flag on, a role adverse to the subject's (`ADVERSE_ROLE_PAIRS`) carries `adverse` (the pair's label). Stored as `conflictChecks/{id}`; never changes a matter.
- `conflicts-determine` (`conflict.determine`: lawyer and above, idempotent): writes `matter.conflictCheck = {status, checkedAt, checkedBy, resultId, reason}` from a check run for that matter (or before it existed), clears a `conflictAlert` from the same check, and audits `matter.conflict_determined` with the reason. A check for another matter is `FAILED_PRECONDITION` (`details.reason: 'check_for_another_matter'`).
- `conflicts-onPartyAdded` (trigger on `parties` create) and `conflicts-onPartyRevived` (on update, for a soft-deleted row made live again, CORE-06): for an open or on-hold matter (not leads, and not the rows `matters-createMatter` writes with the matter), re-checks the party's contact in its role, stores the run, and when it is on other matters sets `conflictAlert` and sends the responsible lawyer a high-priority `conflict_alert` notification linking to `/matters/{id}`.
- `matters-denormalise` (trigger): keeps `search` (number, title, client and deceased names, external reference), `lastActivityAt` (moved forward on any change outside the denormalised fields) and `deletedAt: null` current, writing only stale fields so it never loops. `openTaskCount` is kept by `tasks-onWrite` (CORE-08, see Tasks); `nextDeadline` and `wipCents` hook in there in later tickets.

#### Matters list queries

The list queries `orgs/{orgId}/matters` with `deletedAt == null`, plus `privileged == false` for roles without `privileged.view`, the filters below, and cursor pagination of 50. `MATTER_INDEXED_QUERIES` in `libs/domain` (with `isIndexedMatterQuery`) is the same list; any other combination, or a sort on client, responsible, stage, next deadline or WIP, should query the closest indexed subset and filter or sort the rest client-side. `status` and `type` take `==` or `in` (the product of `in` list sizes is at most 30); `labels` and `search` take `array-contains` (one per query). Each row is indexed with and without `privileged`; `firebase/tests/indexes.spec.ts` checks the file matches.

| Filters | Order |
|---|---|
| none | `lastActivityAt` desc; `number` asc/desc; `title` asc/desc |
| `status` | `lastActivityAt` desc; `number` asc/desc; `title` asc/desc |
| `status`, `responsibleUid` | `lastActivityAt` desc |
| `status`, `type` | `lastActivityAt` desc |
| `status`, `responsibleUid`, `type` | `lastActivityAt` desc |
| `status`, `labels` | `lastActivityAt` desc |
| `status`, `jurisdiction` | `lastActivityAt` desc |
| `status`, `search` | `lastActivityAt` desc |
| `responsibleUid` | `lastActivityAt` desc |
| `type` | `lastActivityAt` desc |
| `labels` | `lastActivityAt` desc |
| `jurisdiction` | `lastActivityAt` desc |
| `search` | `lastActivityAt` desc |

### Matter subcollections

| Subcollection | Key fields |
|---|---|
| `parties/{partyId}` | `contactId`, `role: 'client'\|'testator'\|'deceased'\|'executor'\|'administrator'\|'beneficiary'\|'attorney'\|'guardian'\|'trustee'\|'plaintiff'\|'defendant'\|'witness'\|'other_side_solicitor'\|'counsel'\|'interested_person'`, `share?`, `notes?`, `addedFrom?: 'manual'\|'clerk'\|'migration'` |
| `tasks/{taskId}` | `title`, `descriptionMd?`, `status: 'todo'\|'in_progress'\|'blocked'\|'done'\|'cancelled'`, `priority: 'none'\|'urgent'\|'high'\|'medium'\|'low'` (PriorityIcon levels), `assigneeUid?`, `dueDate?: DateOnly`, `deadlineId?`, `group?` (heading for grouping tasks, e.g. an imported checklist title), `checklist[] {id, text, done}`, `order: number` (fractional), `source: 'manual'\|'template'\|'clerk'\|'migration'`, `completedAt?` (server-owned), `countedOpen?` (server-owned, CORE-08: whether `openTaskCount` includes it). Template tasks (CORE-07) have the id `tpl-{templateTaskKey}` (one per matter and template task, so generating them is idempotent), a server-owned `templateTaskKey`, the stage's name as `group`, and, while their anchor event is unknown, no `dueDate` and a server-owned `duePending: EventKind` ("Due date pending: date of death unknown") |
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

### Matter templates (CORE-07)

A template is a matter type's stages, the tasks each stage creates and the deadline rules that apply (`libs/domain/src/lib/templates.ts`). It sits behind the `templates.system` flag (server-enforced, off by default, on for the demo org): with it off, matters behave as in CORE-06 (default stages, no tasks) and `templates-*` and `matters-upgradeTemplate` return `FEATURE_DISABLED`.

- **Shape.** `stages[] {id, name, order, criteria?, entryRequires? {facts?: KeyFactId[], events?: EventKind[], tasksDone?: taskKey[]}, terminal?}` in increasing `order`; the first stage has no requirements, and `tasksDone` names tasks of earlier stages. `tasks[] {key, title, stageId, assignTo: 'responsible'\|'role:paralegal'\|null, due?: {fromEvent: EventKind, offsetDays} \| {fromStageEntry: days}, priority, checklist?: string[]}`. `deadlineRuleIds[]` names CORE-09 rules (`vic-v1`); statutory deadlines are never template tasks. `TemplateContentSchema` validates a template, and `templateProblems` lists what's wrong.
- **System templates** ship with the code, one per matter type (`libs/domain/templates/system/{type}.json`, id `system-{type}`, version 1), and a unit test validates them against the schema and the rule set. They are not seeded into Firestore. Practitioner sign-off is CORE-07a.
- **Org templates.** `templates-clone` copies a system template or an org template's version into a new draft, `templates-save` edits the draft, and `templates-publish` copies it to `versions/{n + 1}`. Dropping a stage that a live matter on the template is in needs a `stageMapping` (`TEMPLATE_STAGE_MAPPING_REQUIRED` otherwise). A new matter takes the org's most recently published template of its type, else the system one.
- **Tasks.** Applying a template (at create, `templates-apply`, an upgrade) creates the current stage's tasks plus later ones whose anchor event is known; entering a stage creates that stage's. Task ids are `tpl-{key}`, so a retry never duplicates a task and a deleted one is never recreated. `responsible` goes to `matter.responsibleUid`; `role:paralegal` to the first active paralegal (by uid), else the responsible person; `null` stays unassigned. Each created task adds to `openTaskCount`.
- **Due dates** use DateOnly maths. `fromEvent` counts from the earliest live matter event of that kind, else from the key fact standing for it (`date_of_death` ← `deceased.dateOfDeath`, `grant_issued` ← `estate.grantDate`); an unknown anchor leaves `dueDate` unset and sets `duePending` to the event kind. `fromStageEntry` counts from `stageEnteredOn` (today in the org time zone when the stage is entered). A pending due date is not yet filled in when its anchor is recorded later.
- **Screens.** Settings → Templates (`/settings/templates`, owners and admins, behind the flag) lists the system templates (Customise clones one) and the org's templates with their published version; the editor (`/settings/templates/{id}`) edits the draft, checks it with `templateProblems` before `templates-save`, shows server field errors at their paths, and publishes, asking for a stage mapping on `TEMPLATE_STAGE_MAPPING_REQUIRED`. On the matter screen, a refused move lists missing key facts, events and template tasks by name; moving back asks for a reason and is locked for roles without `matter.status`; the "…" menu offers "Upgrade matter to vN" when the org has a newer published version; and open tasks with `duePending` say "Due date pending: <event> unknown".

### Tasks (CORE-08)

Matter tasks (`matters/{matterId}/tasks`) and personal tasks (`members/{uid}/tasks`) share one shape (`Task`, `PersonalTask`) and the `tasks` collection group; personal tasks have `matterId: null` and are always assigned to their owner. Helpers live in `libs/domain/src/lib/tasks.ts`; the quick-add parser is the separate entry point `@materia/domain/quick-add` (it brings chrono-node, so only lazily loaded routes import it).

- **Client-direct writes.** Clients create manual tasks (`MatterTaskCreateInput`: `orgId` and `matterId` matching the path, `source: 'manual'`, `countedOpen: false`, title ≤ 500 characters, checklist ≤ 100 items, group ≤ 120), edit the whitelist (`title`, `status`, `priority`, `assigneeUid`, `dueDate`, `checklist`, `order`, `group`; the rules check the values) and soft delete or restore. `descriptionMd`, `deadlineId` and `source` are set at create; `completedAt`, `countedOpen`, `templateTaskKey` and `duePending` are server-owned. Matter tasks follow the matter's access: `task.edit` roles on a live matter they can read (a privileged matter needs `privileged.view`). Personal tasks are readable and writable only by their owner (not admins). Through the collection group a member reads the tasks assigned to them; only `privileged.view` roles read other matter tasks there (ADR-026).
- **Quick add.** `parseQuickAdd(input, {members, now, timeZone})`: `@name` (a current member, by name, word or initials prefix; ambiguous or unknown mentions stay in the title and are reported), `!urgent|!high|!medium|!low|!none` (and short forms; the last wins) and `due <date>` (chrono-node day-month English, from today's date in the org time zone; a day and month already past is next year's). It returns the title, the fields and the recognised spans.
- **Order.** `order` is fractional: `orderBetween` gives the midpoint of the neighbours (1024 past either end), `planMove` moves one or several tasks with one write each, or rebalances the whole list (1024 apart) when the gap is below 1e-6 or orders tie; `chunkWrites` splits the writes into batches.
- **My tasks.** The group query `orgId == active org, assigneeUid == me, status in open` (no order: undated tasks must come too) returns matter and personal tasks; `sectionMyTasks(tasks, today(org.timezone))` sorts them into Overdue, Today, This week (to Sunday), Later and No date, each by due date, priority and order.
- **Former members.** `assigneeState(uid, members)` flags an assignee who was removed (or has no member document) as `former_member`: the task stays and shows "Unassigned (former member)" (`FORMER_MEMBER_LABEL`).
- **`tasks-onWrite`** (trigger on matter tasks): in a transaction on the task, reconciles `countedOpen` (whether it is counted) with its open state (live and `todo`, `in_progress` or `blocked`), adding ±1 to the matter's `openTaskCount`; sets `completedAt` when the status becomes `done` and removes it when reopened. It reads the current state, so concurrent and out-of-order events leave the count exact. Writers that count a task themselves (template tasks, the death certificate task, the seed) write `countedOpen: true`; a task without the field predates CORE-08 and counts as it was before the event. It also writes a `task_assigned` in-app notification to a new assignee of a live open task (not self-assignment; not template or migrated tasks at creation; only active members), and the matter's activity (`task.created`, `task.completed`, `task.reopened`, `task.assigned`, `task.unassigned`, `task.deleted`, `task.restored`) with `lastActivityAt`. `tasks-onPersonalWrite` keeps a personal task's `completedAt`.
- **`tasks-bulkUpdate`** (callable, idempotent): `{tasks: [{matterId \| null, taskId}] (≤ 500, unique), change: {op: 'status'\|'assignee'\|'dueDate'\|'priority'\|'delete', …}}` for selections over `TASK_CLIENT_BATCH_MAX` (50). Matter tasks need `task.edit` (`PERMISSION_DENIED`) and a live matter the caller can read; `matterId: null` is the caller's own personal task. A new assignee must be an active member (`INVALID_ARGUMENT` on `change.assigneeUid`); `null` unassigns or clears the date. Writes in batches of 250 with `_requestId`; returns `{updated, skipped: [{matterId, taskId, reason}]}` (`not_found`, `deleted`, `matter_unavailable`, `personal_assignee`, `unchanged`).

## Org-level collections

| Path | Key fields |
|---|---|
| `invoices/{id}` | `number` (gapless), `matterId`, `issueDate`, `dueDate`, `lines[]`, `subtotalCents`, `gstCents`, `totalCents`, `status: 'draft'\|'issued'\|'part_paid'\|'paid'\|'void'`, `pdfDocumentId`, `xero?: {invoiceId, syncedAt, error?}`, `payments[]` |
| `creditNotes/{id}` | Reverses issued invoices. Invoices are never edited after issue |
| `templates/{id}` | An org's matter template (CORE-07): the editable draft (`matterType`, `name`, `stages[]`, `tasks[]`, `deadlineRuleIds[]`; see Matter templates) plus `version` (the latest published, 0 before the first publish), `published`, `publishedAt?`, `publishedBy?`, `source: 'org'` and `basedOn? {templateId, version}`. Members read it; only the `templates-*` callables write |
| `templates/{id}/versions/{n}` | A published version, immutable: the draft's content at publish time plus `templateId`, `version`, `publishedAt`, `publishedBy`, `basedOn?` and `stageMapping?` (removed stage id → a stage of this version, used by upgrades). Matters point at one with `templateId` + `templateVersion` |
| `docTemplates/{id}` | docx templates with merge fields |
| `metrics/{period}` | Rollups. `period` is `day-2026-10-03`, `month-2026-10` or `fy-2027`, or `clerk-2026-10` for Clerk metering (tokens and cost, per feature and per user; AI-02) |
| `audit/{id}` | Append-only. `at`, `actor {uid\|'system'\|'clerk'}`, `action`, `entity {path}`, `before?`, `after?` (diffed, redacted), `requestId`, `source` |
| `notifications/{id}` | `recipientUid`, `kind`, `title`, `body`, `link`, `readAt?`, `channel: ['inapp','email','push']`, `priority?: 'normal'\|'high'` (kind `conflict_alert` carries `matterId`, `checkId`, `contactId`, CORE-02) |
| `integrations/{uid_provider}` | **Server-only.** `provider: 'microsoft'\|'google'\|'xero'`, `status`, `scopes`, `encryptedRefreshToken`, `kmsKeyVersion`, `lastSyncAt`, `error?` |
| `safeCustody/{id}` | Will packets. `testatorContactId`, `documentIds[]`, `packetNo`, `location`, `receivedOn`, `movements[] {at, by, kind:'in'\|'out'\|'returned'\|'released', to?, authorityDocId?}`, `status` |
| `migrations/{runId}` | Migration run reports (see the migration doc) |

## Global (read-only to clients)

| Path | Purpose |
|---|---|
| `ruleSets/{ruleSetId}/versions/{version}` | Deadline rules (see the deadline doc) |
| `calendars/{jurisdiction}-{year}` | Public holidays and court/registry closures |
| `systemTemplates/{id}` | Reserved for default matter templates. Unused: the system templates ship with the code (`libs/domain/templates/system/{type}.json`, CORE-07) |

## Invariants (enforced in rules, callables and tests)

1. `members/{uid}` exists and is `active` ⇔ the user's claim includes the org. Claims are synced by the trigger `auth-syncClaims`.
2. Matter `number` is unique per org (case-insensitively). It is allocated only by `matters-createMatter` in a transaction, which also writes its `matterNumbers` reservation.
3. An invoice `number` is gapless and is never reused. A voided invoice keeps its number.
4. A deadline's `dueDate` is never changed silently by a recompute. A recompute writes a *proposal* when the date would move; an `override` always wins.
5. A `timeEntry` with status `billed` is immutable except through a credit-note flow.
6. `audit` and `chunks` cannot be written by clients.
7. `privileged` documents and offers are never readable by `readonly`, and are excluded from exports unless `includePrivileged` is set by owner or admin.
8. Deleting a matter is a soft delete. Hard deletes happen only through retention jobs after `destroyAfter`.

## Indexes (initial)

- `matters`: the list queries in *Matters list queries* above, each led by `deletedAt` (and `privileged`).
- Collection group `tasks`: (assigneeUid, status, dueDate), (orgId, status, dueDate), and for My tasks (CORE-08) (orgId, assigneeUid, status), (orgId, assigneeUid, status, dueDate), (orgId, assigneeUid, dueDate). Collection-group docs carry a denormalised `orgId` and `matterId` (`null` for personal tasks).
- Collection group `deadlines`: (orgId, status, dueDate), (assigneeUid, status, dueDate).
- Collection group `timeEntries`: (orgId, uid, date), (orgId, status, date).
- Collection group `chunks`: a vector index on `embedding` with `orgId` and `matterId` pre-filters.

**Rule:** every collection-group-queried document stores `orgId` and `matterId`, and the rules check `resource.data.orgId == claimOrg()`.

## Supporting collections (added while ticketing; owners in brackets)

| Path | Purpose |
|---|---|
| `users/{uid}.claimsVersion` | Incremented by `auth-syncClaims`. The client refreshes its token when this changes (FND-17) |
| `users/{uid}/devices/{deviceId}` | `{token, platform, lastSeenAt}` FCM registry (FND-20, MOB-04) |
| `users/{uid}/views/{id}`, `users/{uid}/recent`, `users/{uid}/drafts/{id}` | Saved list views (CORE-03: `SavedView`, the user's own, written by the client with `orgId` = their current org), recents (CORE-14/15), intake drafts (CORE-05: `IntakeDraft` at `drafts/intake-{id}`, `{orgId, kind: 'intake', step: IntakeStepId, stateJson, expireAt}` + meta; written by the client directly, read, written and deleted only by their user in their current org; `stateJson` is the partial form state as JSON text of at most 100,000 characters (`encodeIntakeDraftState`/`decodeIntakeDraftState`) so the rules can bound it; `expireAt` = save + 30 days (`intakeDraftExpireAt`; the rules accept 29–31 days from the request time) and the `drafts` collection group has a Firestore TTL on `expireAt` in `firebase/firestore.indexes.json`) |
| `users/{uid}/timer/current` | The single running timer (BILL-02) |
| `users/{uid}/briefs/{date}` | Clerk daily brief (AI-09) |
| `users/{uid}/private/recovery` | **Server-only.** Hashed MFA recovery codes (FND-16) |
| `users/{uid}/requests/{requestId}` | **Server-only.** Idempotency records for person-level callables (onboarding, accepting an invite, switching org), 24 h TTL (FND-17) |
| `emulatorOutbox/{id}` | **Emulator only.** Emails the Functions emulator would have sent (invite links for e2e and local testing) |
| `orgs/{orgId}/matterNumbers/{key}` | **Server-only.** Matter number reservations `{number, matterId, year}`, written with the matter (CORE-03) |
| `emulatorClock/{orgId}` | **Emulator only.** `{now}` pins the clock of date-sensitive callables for integration tests (CORE-03) |
| `orgs/{orgId}/requests/{requestId}` | **Server-only.** Callable idempotency records, 24 h TTL (FND-15) |
| `orgs/{orgId}/conflictChecks/{id}` | Conflict-check runs and hits (CORE-02: `ConflictCheck`, written by `conflicts-run` and `conflicts-onPartyAdded`, read by `conflict.run` roles) |
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
