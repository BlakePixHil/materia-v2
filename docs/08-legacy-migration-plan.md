# Legacy migration plan (single user)

**Goal:** move one designated user's legacy materia data into Materia v2 with nothing lost, everything reviewable, and the ability to re-run or roll back at any point. **Nothing writes to the legacy project.**

- **Legacy:** repo `BlakePixHil/materia-web-app`. Firebase prod project `matt-r-1fe15`; dev project `materia-dev-26bf0`. Domains `app.materia.au` and `app.mattr.com.au`.
- **Target:** the Materia v2 prod org created for the user, after prod launches. There is no staging, so rehearsals run on dev and are rolled back afterwards ([decision log](migration/decisions.md) D-15).
- **Tooling:** `tools/migration`, a Node CLI. Commands: `audit` and `check-profile` (MIG-01), `export` (MIG-02), `transform` (MIG-03), `auth-import` (MIG-04), `copy-files` (MIG-05), and `load`, `verify`, `delta` and `rollback` (MIG-06) are built; `report` follows.
- **Decisions:** the user's mapping choices are in [`docs/migration/decisions.md`](migration/decisions.md) and the mapping profile `tools/migration/profiles/<user>.json`.

## Legacy model (source facts)

These facts come from a code audit of the legacy repo. MIG-01's `audit` step checks them against real data, and the facts it changed are marked **(MIG-01)**.

- **Timestamps** are ISO-8601 **strings** (`createdOn`, `updatedOn`); there are no Firestore Timestamps. `billable.billingDate` is `YYYY-MM-DD`.
- **Collections:**
  - `profiles/{uid}`, with `integrations/*` and `dashboard-checklist-items/*`;
  - `workspaces/{id}`;
  - `workflows/{id}` (boards, with **swimlanes embedded**), with `cards/{cardId}` (matters, holding **checklists, comments and history embedded**), `cards/{id}/attachments/*` and `checklist-templates/*`;
  - `workflow-invites`, `notifications`, `referrers` (scoped per user through `uids`), `feedback`.
- **Membership** is `workflow.uids[]` plus `workflow.users[uid].roles`. There are no custom claims. **(MIG-01)** The roles map also holds an `owner` flag, which the role enum lacks, and old workflows carry a legacy `owner` field.
- **Linked cards (MIG-01):** `linkedCardIds[]` holds `{cardId, workflowId}` objects, so links can point at other users' boards. Very old cards hold bare card ids.
- **Storage:**
  - `profile-images/{uid}.png`;
  - `workflows/{wf}/cards/{card}/attachments/{attId}{ext}`, with a 25 MB limit. The stored `downloadUrl` is token-bound and must not be reused.
  - **(MIG-01)** `workflows/{wf}/attachments/`, board-level files with no card. The audit lists them; they don't migrate by default.
  - **(MIG-01)** The legacy allow-list is pdf, doc, docx, txt, csv, xlsx, pptx, msg, eml, png, jpg, jpeg, gif, bmp, webp, svg and zip.
- **Rich text** (card descriptions and comments) is **HTML** from ngx-quill (`ql-*` classes). Mentions are `<span class="mention" data-id="{uid}" data-value="Name" data-denotation-char="@">`. History descriptions contain `<strong>` and frozen display names.
- **AI suggestions** were never persisted (only localStorage dismissals). The roadmap was UI state only. Calendar tokens were in localStorage. **None of these migrate.**

## Mapping

| Legacy | v2 | Notes |
|---|---|---|
| Auth user | Identity Platform user, **same uid** | `auth:export` → filter to the one uid → `auth:import` with the legacy scrypt hash params (a human fetches them from the console). Google and Microsoft providerData are preserved. MFA enrolment is prompted on first sign-in if the org requires it |
| `profiles/{U}` | `users/{U}` + `orgs/{O}` (new) + `orgs/{O}/members/{U}` (role `owner`) | Org name: `companyName`, else "{displayName}'s practice". The user confirms it in MIG-07 |
| profile budgets (`currentFinancialYearBudget`, `budgetFinancialYear`, `previous*`) | `members/{U}.budgets[fyStartYear] = cents` | Dollars, possibly with cents (MIG-01): cents = round(value × 100). Apply the legacy rollover rule at transform time |
| `profile-images/{U}.png` | `users/{U}/avatar.png` (Storage) | Optional |
| `profiles/{U}/integrations/*` | not migrated | The user reconnects. The report lists the providers that were connected |
| `profiles/{U}/dashboard-checklist-items/*` | `orgs/{O}/members/{U}/tasks/*` (personal tasks) | Priority map: 0→none, 1→high, 2→medium, 3→low. `dueDate` ISO → `DateOnly` in Australia/Melbourne. `checked` → status `done`, with `completedAt` from `doneOnDate` |
| `workspaces/{id}` (prime) | merged into the org | Non-prime workspaces: list them in the report (none expected) |
| `workflows/{id}` (where `uids` contains U, or legacy `owner == U`) | Matter label `board:{name}`, plus a per-workflow **mapping profile** | The mapping profile sets each workflow's mode (`matters`, `personal_tasks` or `exclude`), its default `matterType`, and each swimlane → `{status, stageId?, matterType?}`. A swimlane can override the type when the columns are kinds of matter. `isDoneSwimlane` → `closed`. The user signs the mapping off in MIG-01 |
| `workflow.labels[]` | matter `labels[]` (by name) | Colours are CSS vars (`var(--mr-label-N-rgb)`). v2 labels have no colour, so they don't migrate (D-19). Cosmetic |
| `cards/{cardId}` | `orgs/{O}/matters/{M}` | See the next table |
| `cards/*/attachments/*` | `matters/{M}/documents/{D}` + an object copy to `orgs/{O}/matters/{M}/documents/{D}/v1` | sha256 is verified after the copy. `source: 'migration'`, `category: 'other'`; Clerk reads and reclassifies them after the load, once an owner approves the cost (MIG-09, D-21) |
| `workflows/*/checklist-templates/*` | `orgs/{O}/checklistTemplates/*` (CORE-08d: a named list of items applied to a task, as legacy applied it to a card; D-19) | The doc id is authoritative (the legacy `id` field is wrong) |
| `referrers/*` (where `uids` contains U) | `contacts` with `isReferrer: true` | A referrer with a `name` is a person (`company` → `referrerMeta.company`); one with only a `company` is an organisation. `industry` (free text) → `referrerMeta.industry` through `referrerIndustryFromText` (unrecognised → `other`, empty → unset). Phones normalised to E.164. Dedupe against other imported contacts (an existing client who is also a referrer keeps one contact, `isReferrer: true`) |
| other users referenced (workflow members, assignees, comment authors, mention targets) | contacts tagged `legacy-collaborator` | Their profile names are read from legacy `profiles` (read-only). They are not members, and they are not invited automatically |
| `notifications`, `workflow-invites`, `feedback`, `workflows/*/invites` | not migrated | Counted in the report |

### Card → matter

| Card field | Matter field | Rule |
|---|---|---|
| `title` | `title` | trim; empty → "Untitled matter (imported)" + needsReview |
| `matterReference` | `externalRef` | `null` / `''` → none. A v2 `number` is always allocated (D-08); `externalRef` is searchable |
| — | `clientContactIds` | v2 needs at least one client and legacy cards have none: a contact named from the card title, needsReview (D-10) |
| — | `conflictCheck`, `costsDisclosure` | Open and closed matters: conflict `clear` with the reason "Opened before Materia (imported)"; leads `pending`. Disclosure `required` unless closed (D-11) |
| `description` (HTML) | pinned note "Description (imported)" | sanitise → Markdown (turndown). Mentions → `@[uid]`, or plain `@Name` for non-members. `<p></p>` / `''` → no note |
| `priority` 0–3 | `priority` | 0→none, 1→high, 2→medium, 3→low |
| `assignee` (`''` / null / uid) | `responsibleUid` | U → U. Another uid → U, with an `originalAssignee` note. Empty → U |
| `swimlaneId` | `status` + `stageId` | through the mapping profile. An unknown swimlane id → status `open`, needsReview |
| `archived: true` | `status: 'archived'` | `closedAt` = `updatedOn`. No CORE-19 closing record is created, so no destruction date is set until the user reviews it (D-12) |
| `labelIds[]` | `labels[]` | resolved through `workflow.labels`. Unknown ids are dropped and reported |
| `referrerId` (`''` = none) | `referrerContactId` | through the referrer id map. A missing referrer → reported. `referralSource` stays unset (legacy has none). The CORE-18 thank-you task is never created for migrated matters (it fires only in `matters-createMatter` and `matters-changeStatus`) |
| `linkedCardIds[]` | `relatedMatterIds[]` | only if the target was migrated. Otherwise dropped and reported |
| `checklists[].items[]` | `tasks` (`group` = checklist title) | `name`→`title`, `checked`→`done`, `dueDate` ISO → `DateOnly` (Melbourne), `doneOnDate`→`completedAt`, priority 1→high and 0→none |
| `checklistItem.calendarSyncByUser` | `tasks.legacyCalendar` (informational) | The report warns that legacy calendar events still exist in the user's calendar, to avoid duplicates after INT-02 |
| `comments[]` | `notes` (`source: 'migration'`) | author → uid or `legacyAuthor {name}`. `date`→`createdAt`. `edited`/`editDate` preserved |
| `history[]` | `activity` (`source: 'migration'`) | HTML stripped. Display names kept as text |
| `fee {billingType, value, billedFees, splitFees, ownershipPercentage}` | `fee` | fixed→fixed, hourly→hourly, nowin→conditional, folio→hourly + note (D-06), ''→unset + needsReview. `value` dollars → cents. Also kept raw in `legacy.fee` |
| `billable {status, billingText, billingTotal, applyTrust, postType, paymentTerms, billingDate, notes}` | `legacyBilling` (read-only on the matter) | **Not turned into v2 invoices**, which would break gapless numbering. Insights can include `billingTotal` by `billingDate` as historical billed |
| `dueDate` (always `''`), `hoursEstimate`, `actualHours` | dropped | Unused in legacy |
| `createdOn` / `updatedOn` | `createdAt` / `updatedAt` | ISO → Timestamp. Invalid → load time + a warning |
| — | `migration: {runId, legacyPath}`, `needsReview?: string[]` | on every migrated document. The person works through `needsReview` in Settings → Import from materia, and each code moves to `reviewed` (MIG-08, D-22) |

## Hazards (must be handled and tested)

- **Type inconsistencies:**
  - `assignee` can be `''`, `null` or a uid; `referrerId` can be `''`; `matterReference` can be null or `''`; `fee.billingType` can be `''`; `fee.value` can be 0.
  - Checklist priority is 0/1 only, while card priority is 0–3.
- **Old field names:** `fee.realisedFees` (→ `billedFees`), `fee.hasDisbursements` and `fee.disbursements` (→ disbursement records, needsReview), a single `checklistItem.calendarSync`, `workflows.owner`.
- **Missing fields:** workflows may lack `order`, `labels`, `swimlanes` or `users`. Referrers lack timestamps.
- **Dates:**
  - `dueDate` values are full ISO datetimes, often local midnight stored as UTC. Convert to `DateOnly` **in Australia/Melbourne**: `2025-03-13T13:00:00.000Z` → `2025-03-14`.
  - All-day calendar dates are normalised differently.
- **Ids:**
  - Card ids are Firestore auto-ids; everything else uses UUIDs.
  - Checklist-template doc id ≠ `id` field.
  - `templateExists` may be persisted inside card checklists, so drop it.
- **Membership drift:** `uids` can have duplicates and differ from `users`. De-duplicate, and treat the union as "referenced users".
- **Orphans:**
  - attachments whose Storage object is missing, which are reported, not fatal;
  - Storage objects with no Firestore doc, which are listed;
  - `linkedCardIds` pointing at deleted workflows.
- **Sanitisation:** HTML must be sanitised before conversion, against script and style injection and tracking pixels.
- **Size:** attachments up to 25 MB, so copy with streaming and verify the hash.
- **Version drift:** profiles from before commit `64b3316` lack FY budget fields.

### Found in MIG-01

- **v2 rules legacy data can't satisfy:** every matter needs a client contact, a conflict check status and a costs disclosure status (D-10, D-11). Closed matters have no CORE-19 closing record (D-12).
- **Columns that aren't stages:** the Disputes board's columns are kinds of dispute, so the profile can set a matter type per column. Columns such as "File to be closed" stay open at the closed stage, so closing runs in v2.
- **Upload types:** v2 uploads don't accept svg, gif or bmp, which legacy did. Those files migrate as download-only documents, since an SVG can carry script (D-13).
- **Untyped attachments:** some attachment documents have no content type, so the type comes from the extension.
- **Dates:** V8 parses impossible days (`2025-02-30`) as real dates, so the transform must check the day exists, as the audit does.
- **Sign-in:** the user signs in with Google only, so MIG-04 needs no password-hash parameters for them. `materia-migrate auth-import` moves the account with the same uid and Google identity at cutover, before the load ([runbook](runbooks/migration-auth-import.md), D-16).
- **Prod audit (2026-10-06):**
  - The profile's `companyName` holds the app's name ("Materia Technologies"), not the practice's, so the org name must come from the user at cutover (D-09).
  - Legacy marks "File to be closed" and "Close file" as done lanes. The profile keeps "File to be closed" open at the closed stage (D-04).
  - 2 descriptions carry inline base64 images (152 KB) and 46 carry inline styles, so the transform extracts or drops the images and strips the styles.
  - Only `fixed` and empty billing types occur. Amounts are dollars, and 8 have cents.
  - Due dates are all Melbourne midnight stored as UTC, so every one would land a day early with a naive UTC slice.
  - 7 attachments have no content type, and 7 are Outlook `.msg` files (probably the same ones), so the type comes from the extension.

## Process

1. **Access (human):**
   - Create a read-only service account in `matt-r-1fe15` with `roles/datastore.viewer`, `roles/storage.objectViewer` and `roles/firebaseauth.viewer`.
   - Grant it to the migration runner identity through WIF or short-lived impersonation. No keys on laptops.
   - Fetch the password-hash parameters (not needed for a Google-only user, such as this one: D-16).
   - **Done for MIG-01:** `legacy-migration-reader@matt-r-1fe15.iam.gserviceaccount.com`, impersonated with short-lived tokens. `materia-migrate audit` refuses any credentials that can write.
2. **Export:** query by uid, then write JSONL to `gs://<v2-env>-migration/runs/{runId}/raw/` (australia-southeast1, CMEK, uniform access, 90-day lifecycle after cutover), with a `manifest.json` of counts and sha256s.
   - **Built in MIG-02:** `materia-migrate export` reads one Firestore snapshot (a single `readTime`) through the read-only account. It writes to the dev bucket for rehearsals and the prod bucket at cutover. The [runbook](runbooks/migration-export.md) and decision D-17 have the details.
3. **Transform:**
   - Pure functions (`tools/migration/src/transform/*`) produce v2 entities validated by the `libs/domain` zod schemas.
   - Deterministic v2 ids: `base62(sha256(namespace + legacyPath))[0..20]`.
   - Outputs: `transformed/*.jsonl` and `report.json` (warnings per item, with stable codes such as `MIG_W_ASSIGNEE_FOREIGN`).
   - **Built in MIG-03:** `materia-migrate transform` writes `transformed/{entity}.jsonl`, `idmap.jsonl` (`{legacyPath, v2Path}`) and `report.json` to the run. The same run and profile always give the same bytes. A record that fails its schema stops the run (exit 5) unless `--allow-rejects` ([runbook](runbooks/migration-transform.md), D-19).
   - **Attachments (built in MIG-05):** `materia-migrate copy-files` then copies every planned attachment and the profile photo into the v2 files bucket, server to server, through a quarantine: verified against the export's checksums, hashed (sha256) and scanned before it reaches its document path. It writes `files/documents.jsonl` with version 1 filled in, which the load reads ([runbook](runbooks/migration-copy-files.md), D-18).
4. **Load:**
   - BulkWriter with upserts by deterministic id.
   - A document is skipped and reported if the v2 doc's `updatedAt` is later than its `migration.loadedAt` (the user edited it after load).
   - `--dry-run` writes nothing and prints the plan.
   - **Built in MIG-06:** `materia-migrate load` writes the run in dependency order, syncs the member's claims and records the run once in the audit log; the triggers skip notifications and ingestion for its writes. The [runbook](runbooks/migration-load.md) and decision D-20 have the details.
5. **Verify:**
   - counts per entity, legacy versus v2;
   - attachment hashes;
   - 20 random cards diffed field by field;
   - a rules check that the user can read everything as themselves;
   - deadline recompute proposals generated into a review queue (MIG-09).
   - **Built in MIG-09:** once an owner approves the estimate, Clerk reads the migrated documents and proposes each open estate matter's key dates as suggestions with citations; accepting one recomputes its deadlines. `backfill-metrics --from earliest` restates Insights from the earliest migrated month ([runbook](runbooks/migration-enrichment.md), D-21).
   - **Built in MIG-06:** `materia-migrate verify` compares every loaded record, not 20 random cards, and writes `verify-report.md` (D-20).
6. **Delta:** re-export items with `updatedOn > lastRunAt`, then transform and load. The run is idempotent. `export --since <last run's readTime>` filters cards and attachments, writes everything else in full, and lists every path in scope so the load can see deletions (D-17). `materia-migrate delta` loads the delta run and deletes what legacy deleted only with `--apply-deletes` (D-20).
7. **Rollback:** `rollback --run {runId}` deletes every v2 document with `migration.runId == runId`, plus the Storage prefix. It refuses on prod without `--confirm-prod`, and writes an audit entry. Built in MIG-06 (D-20).

## Rehearsal & cutover

- **Rehearsal:** at least 2 full rehearsals on **dev** (there is no staging) using a fresh export, each rolled back afterwards. The user reviews the result on dev through the MIG-08 review screen.
- **Cutover runbook (MIG-07):**
  1. Agree a date with the user.
  2. The user stops editing in legacy. Optionally, a human deploys read-only rules to legacy.
  3. Final delta.
  4. Verify.
  5. Switch the user's bookmark or domain.
  6. The user signs in to v2 and works through the review queue (Today's "Check your import" card, or Settings → Import from materia; D-22).
- **After cutover:**
  - Legacy stays readable for 90 days. The bucket export is then archived to coldline for the retention period, and the legacy project is decommissioned by a separate human-approved ticket.
  - The user reconnects their calendar. Legacy calendar events are listed so they can delete them or let v2 adopt them.
