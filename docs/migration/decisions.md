# Migration decision log (MIG-01 to MIG-05)

The mapping choices for migrating **Tristan Burke**'s legacy data (legacy uid `fen5jJdhNHTkGBpgAdsLSKQRvXx2`) into Materia v2. The transform (MIG-03) reads them from the mapping profile [`tools/migration/profiles/tristan-burke.json`](../../tools/migration/profiles/tristan-burke.json). Each decision below names its profile field. The [Legacy migration plan](../08-legacy-migration-plan.md) has the full field map; this log records only the choices someone had to make.

**Evidence:**

- the read-only profile of the prod data taken on 2026-10-04 (counts and names only, kept in project files at `mig-01/tristan-data-profile.md`);
- the legacy code (`BlakePixHil/materia-web-app`);
- the prod audit run on 2026-10-06 with the read-only account (`materia-migrate audit`; the report is in project files at `mig-01/audit/`, never committed). It found 313 cards on the 5 boards in scope, and `check-profile` confirmed the profile maps every board and column.

**Status key:**

- **Decided:** Blake made the call, with the date given.
- **Default:** a drafted choice that stands unless the sign-off changes it.
- **Open:** needs an answer before the transform runs.

## Sign-off

| Role | Name | Date | Note |
| --- | --- | --- | --- |
| User | Tristan Burke | 2026-10-06 | Signed off through Blake in the project thread ("We agree and sign off"). Confirms his consent to migrate, which Blake recorded on 2026-10-04 |
| Product owner | Blake Linnell | 2026-10-06 | Signed off in the project thread |

Signing records the same names and dates in the profile's `signOff`. Changing any decision after sign-off needs both signatures again.

## Decisions

### D-01 Who migrates, and their consent

- **Status:** Decided by Blake on 2026-10-04.
- **Decision:** only Tristan Burke's data migrates.
  - Nothing that belongs to other legacy users is read beyond the profile names of the people his cards mention.
  - He signs in with Google only, so his account moves with the same uid and no password hashes (MIG-04).
  - Blake confirmed Tristan's consent to migrate on 2026-10-04. Tristan's sign-off above records it in his own name.
- **Profile:** `subject`.

### D-02 Which boards migrate

- **Status:** Decided by Blake on 2026-10-04.
- **Decision:** the three boards Tristan owns migrate as matters:
  - Estate planning;
  - Estate admin;
  - Disputes.

  Two more of his boards become personal tasks grouped by their column, because they hold practice development work rather than matters:
  - FY BD & Non-Billable - Track for Promotion;
  - Non-billable.

  Test Workflow is a shared board he doesn't own, so it is excluded.
- **Profile:** `workflows[].mode`.
- **Ticket default this replaces:** include the boards where the user is owner or admin, and list the others.

### D-03 Matter type per board

- **Status:** Default.
- **Decision:**
  - Estate planning → `will`.
  - Estate admin → `probate`, except the "ASP only or probate not needed" column → `admin` (D-04).
  - Disputes → `contest`, except "Part IV" → `fp` (family provision).
- **Why:** the columns of Disputes are kinds of dispute, not steps, so the profile allows a type per column.
- **Profile:** `workflows[].matterType`, `swimlanes[].matterType`.

### D-04 Column → status and stage

- **Status:** Default. The two columns that were open are decided by Blake on 2026-10-06.
- **Rules:**
  - Columns about prospective work become leads.
  - The last column becomes closed.
  - Everything else is open at the stage of the type's system template that matches best.
  - A column that says nothing about progress leaves the stage unset.

| Board | Column (cards on 2026-10-04) | Status | Stage |
| --- | --- | --- | --- |
| Estate planning | Upcoming initial appt / prospective clients (6) | lead | |
| | New files / waiting for quote approved (9) | open | instructions |
| | To draft (9) | open | draft |
| | Drafts sent to clients (37) | open | client_review |
| | **Waiting on SOAs (102)** | open | safe_custody |
| | Close file (42) | closed | closed |
| Estate admin | Waiting for client to approve quote / open file (2) | lead | |
| | General estate advice (non-dispute) (2) | open | instructions |
| | **ASP only or probate not needed (3)** | open (type `admin`) | assets_collected |
| | Stage 1 (pre-filing) (4) | open | documents |
| | Stage 2 (filed) (1) | open | application_filed |
| | Stage 3 & 4 (admin and property) (28) | open | assets_collected |
| | File to be closed (13) | open | closed |
| Disputes | Part IV (3) | open (type `fp`) | |
| | VCAT (3) | open | |
| | Superannuation (1) | open | |
| | Other (5) | open | |
| | Caveat (2) | open | caveat_lodged |
| | Close file (17) | closed | closed |

- **Decided by Blake on 2026-10-06:**
  - **Waiting on SOAs** holds 102 of the 205 estate planning cards. SOA reads as statement of account: the will is signed and the file waits on the bill, so the stage is `safe_custody`.
  - **ASP only or probate not needed:** an estate wound up without a grant (assets released on a statutory declaration), so the type is `admin` at `assets_collected`.
- **Also:**
  - "File to be closed" stays **open** at the closed stage. Tristan closes those matters in v2, where closing runs the CORE-19 checks.
  - Cards in a column the board no longer has import as open, and are flagged for review.
- **Profile:** `workflows[].swimlanes[]`.

### D-05 Labels

- **Status:** Default.
- **Decision:** every label keeps its name, and its colour maps to the nearest v2 tag tone.
- Label ids a card holds that the board no longer defines are dropped and reported.
- **Profile:** `labels` (default `keep`, no renames).

### D-06 Fees

- **Status:** Default.
- **Decision:**
  - Legacy amounts are **dollars**: the legacy fee form accepts dollars with up to 2 decimal places and shows "$" + value. They convert with cents = round(value × 100). The audit report's money section checks that the real values fit this reading before the transform runs.
  - The billing type maps as follows:
    - fixed → fixed;
    - hourly → hourly;
    - nowin → conditional;
    - **folio → hourly**, with a note keeping "folio";
    - an empty type leaves the fee unset, flagged for review.
  - Legacy billing (`billable.*`) stays read-only history on the matter. It is never turned into v2 invoices, which would break gapless numbering. `applyTrust` is kept only as history: Materia is never a trust ledger (ADR-035).
- **Profile:** `fees`.

### D-07 Cards assigned to someone else

- **Status:** Default.
- **Decision:** Tristan becomes responsible for the matter. A note names the original assignee, from their legacy profile name, or "a former colleague" when that profile no longer exists.
- Other people the cards mention become contacts tagged `legacy-collaborator`. They are never invited.
- **Profile:** `foreignAssignees: reassign_with_note`.

### D-08 Matter numbers

- **Status:** Default.
- **Decision:** v2 allocates new matter numbers. The legacy `matterReference` becomes the matter's **external reference**, which search finds, so an old file number still leads to the matter.
- **Why:** references are free text, and some may repeat, so adopting them would need a review of the data first.
- **Profile:** `matterNumbers: allocate`.

### D-09 Org name, time zone and jurisdiction

- **Status:** Default.
- **Decision:**
  - The org takes the legacy profile's company name. Tristan confirms it at cutover (MIG-07).
  - **Prod audit (2026-10-06):** the company name is "Materia Technologies", which is the app's name rather than his practice's. MIG-07 must ask Tristan for the real name rather than offer this one.
  - Dates use Australia/Melbourne: due dates stored as UTC instants convert to the Melbourne day.
  - Matters are Victorian.
- **Profile:** `org` (no `name` set, so the company name is used).

### D-10 Client contact (new)

- **Status:** Default.
- **Decision:** a v2 matter needs at least one client contact, and legacy cards have only a title. Each matter gets a client contact named from the card title, flagged for review so Tristan can merge or rename it.
- **Alternative:** one "Client (imported)" placeholder per matter (`placeholder`).
- **Profile:** `matterDefaults.clientContact: from_title`.

### D-11 Conflict check and costs disclosure (new)

- **Status:** Default.
- **Decision:**
  - **Conflict check:** open and closed matters were opened before Materia, so they import as `clear` with the reason "Opened before Materia (imported)". Leads import as `pending`, so the check still runs before they open.
  - **Costs disclosure:** leads and open matters import as `required`, so Tristan confirms whether disclosure was given. Closed matters import as `not_required`.
- **Profile:** `matterDefaults.conflictCheck`, `matterDefaults.costsDisclosure`.

### D-12 Closed matters and retention (new)

- **Status:** Default.
- **Decision:** closed matters import without a CORE-19 closing record, so no destruction date is set. Tristan reviews them in the review queue (MIG-08) before any retention date applies.

### D-13 Attachments (new)

- **Status:** Default.
- **Decision:**
  - Every attachment migrates, including types v2 uploads don't accept: the one SVG (also GIF and BMP, if the audit finds them).
  - Those files are served as downloads only, never shown inline, since an SVG can carry script.
  - The 7 attachments with no content type take their type from the file extension.
  - The audit also lists files stored at board level (`workflows/{wf}/attachments/`) with no card. These are reported for Tristan to decide on, not migrated by default.

### D-14 What doesn't migrate

- **Status:** Decided in the plan; confirmed here.
- **Decision:** none of the following migrate:
  - calendar connections (Tristan reconnects, and legacy events stay in his calendar);
  - AI suggestion dismissals;
  - notifications, invites and feedback;
  - links to cards on boards that don't migrate (dropped and reported);
  - `hoursEstimate`, `actualHours` and the card-level `dueDate`, which legacy never used.

### D-15 Where and when it loads

- **Status:** Decided by Blake on 2026-10-05 (prod after launch). The rehearsal rule is a default.
- **Decision:** the migration loads into **prod after prod launches**. There is no staging, so rehearsals run on dev. Each rehearsal is rolled back afterwards, so real client data doesn't stay on dev.

### D-16 Auth import (new)

- **Status:** Default, from MIG-04 on 2026-10-06. It follows from D-01 and D-15 and changes nothing they decided, so the sign-off above stands.
- **Decision:**
  - Tristan's account moves with the same uid and his Google identity, keeping Google's id for him, so his first Google sign-in in prod lands on the imported account. The [runbook](../runbooks/migration-auth-import.md) has the steps.
  - He has no password, so the ticket's human steps are descoped for him: no hash parameters in Secret Manager and no `auth:export`. The tool still supports both for a user with a password.
  - **Microsoft:** deferred (FND-16, MVP mode). Tristan doesn't use it, so there is no tenant to verify. The import stops on any provider the target project hasn't turned on.
  - **Not imported:**
    - legacy custom claims, since v2 sets its own at the load (MIG-06);
    - the legacy last sign-in time, so v2's starts empty;
    - second factors. The import stops on these instead, and Tristan has none.
  - **Rehearsal:**
    - On dev, with made-up accounts (D-15): a Google one, and a password one with a made-up scrypt key whose real password sign-in on dev returned the same uid.
    - His real account was only dry-run against dev, which read it and planned a clean import.
    - The ticket's "signs in on staging, then prod" check becomes his first Google sign-in in prod at cutover (MIG-07). The emulator test proves that a Google credential for the imported identity signs in to the same uid.
  - **When:** at cutover, before the load, which keys everything on the uid.

### D-17 Export (new)

- **Status:** Default, from MIG-02 on 2026-10-06. It follows from D-13 to D-15 and changes nothing they decided, so the sign-off above stands.
- **Decision:**
  - **Where:** `gs://materia-v2-<env>-migration/runs/{runId}/`, on dev for rehearsals and on prod at cutover. The ticket's `--env staging|prod` becomes `dev|prod`, since there is no staging (D-15). The [runbook](../runbooks/migration-export.md) has the steps.
  - **Who writes:** prod's `migration-runner` account, impersonated. Dev has no runner account, so a rehearsal is written by the operator's own gcloud account.
  - **What:** the ticket's scope, narrowed by the mapping profile.
    - Boards the profile excludes (Test Workflow) are left out with their cards.
    - Other users keep their names only (`displayName`, `firstName`, `lastName`), in `people.jsonl`, apart from Tristan's own profile.
    - Notifications are counted, not exported (D-14).
    - **Auth:** providers, email, whether it is verified, and the account's dates. Never a password hash, salt or provider id: the auth import reads those itself (D-16).
    - **Storage:** objects are listed, not copied (MIG-05 copies them). The list covers everything under the exported boards, board-level files included (D-13 decides those), plus his profile photo. Each object keeps its size, type, MD5, CRC32C and generation.
  - **Download tokens:** Firebase download URLs carry a token that lets anyone holding the link read the file. Every attachment's `downloadUrl` has one, and descriptions can embed them. The export takes the token out and keeps the rest of the URL. Nothing downstream needs it, since MIG-05 copies objects by name.
  - **One snapshot:** every Firestore read is at one `readTime`, taken from the server at the start. Storage and Auth have no snapshot, so they are read just after it.
  - **Delta (`--since`):**
    - Only cards and attachments are filtered. A record goes in when its `updatedOn` or `createdOn` is after `--since`, or when neither date can be read. Every attachment of a changed card goes in too.
    - Everything else goes in full, because it is small, and editing a board's columns may not change its `updatedOn`.
    - `paths.jsonl` lists every card and attachment in scope, changed or not, so the load can see what was deleted.
  - **Resume:** possible within 55 minutes, because Firestore can't read further back than an hour. It reads again at the same `readTime`, checks that each finished Firestore file reads back with the same sha256, and writes the rest.
  - **Evidence:**
    - The prod dry run on 2026-10-06 with the read-only account wrote nothing. Every in-scope count matched the audit: 5 boards, 313 cards, 71 attachments, 4 checklist templates, 30 referrers, 3 integrations, 1 workspace and no dashboard items. It also found 71 download tokens to take out.
    - A dev rehearsal with made-up data was deleted the same day.

### D-18 Attachment copy (new)

- **Status:** Default, from MIG-05 on 2026-10-06. It follows from D-13, D-15 and D-17 and changes nothing they decided, so the sign-off above stands.
- **Decision:**
  - **How:** `materia-migrate copy-files` copies each attachment server to server (GCS `rewrite`), exactly the generation the export listed, so a file changed since the export is reported rather than copied. The [runbook](../runbooks/migration-copy-files.md) has the steps.
  - **Quarantine first:** every copy lands in `migration-quarantine/{runId}/` in the files bucket, which no client can read. It is checked against the export's size, MD5 and CRC32C, read back for its sha256, and scanned. Only a clean copy moves to its document path (`documents/{D}/v1`) or `users/{uid}/avatar.png`.
  - **Scanning:** the tool calls the ClamAV service that scans uploads (CORE-12a) directly, the ticket's second option. The upload pipeline's `pending/` path would create the documents itself, but the load (MIG-06) owns them with deterministic ids. The results are the same: clean files load with `scan.status: 'clean'`; infected ones stay in quarantine and load with `scan.status: 'infected'` and no version, so nobody can read them, as CORE-12 records an infected upload.
  - **sha256:** computed by reading each copy back in the tool's memory, never on disk, rather than in a Cloud Run job. 71 attachments of at most 25 MB don't need a job. It runs in Cloud Shell, so the bytes stay in Google Cloud.
  - **Types:** a file keeps the type the export or its extension gave it (D-13). A file whose bytes aren't what its extension says is kept and flagged in the report, since it is the client's record. svg, gif and bmp copies are stored as attachments, and v2 never previews them.
  - **Profile photo:** copied only when it really is a PNG, JPEG or WebP. Any signed-in member can read avatars, so it reaches its path only after a clean scan.
  - **Orphans:** legacy objects no document names, board-level files included, are listed in the report for Tristan to decide on (D-13). They aren't imported as "Unlinked legacy file" documents unless the profile is changed to say so; the transform would then plan them like any other attachment.
  - **Who copies:** prod's `migration-runner` account, which gets object admin on the files bucket from Terraform and, for the cutover only, read on the legacy bucket, granted in `matt-r-1fe15` and removed afterwards. On dev, the operator's own account, as for the export (D-17).
  - **Re-runs:** a file already at its document path with the same legacy content, scanned clean, is skipped, so a re-run finishes an interrupted one. The tool deletes nothing outside its quarantine.
  - **Evidence:** the emulator test copies, verifies, scans and reports made-up files, keeps an EICAR file in quarantine and copies nothing on a re-run. The ticket's staging rehearsal becomes the dev rehearsal in MIG-07 (D-15), which needs the transform (MIG-03) first.

### D-19 Transform (new)

- **Status:** Default, from MIG-03 on 2026-10-06. It carries out D-02 to D-14 and decides only what v2 needs that legacy doesn't have, so the sign-off above stands. The label colours (D-05) are the one thing it can't carry, since v2 labels have none.
- **Decision:**
  - **How:** `materia-migrate transform` reads the export's `raw/*.jsonl`, checked against the manifest's sha256s, and maps them with pure functions, one module per entity (`tools/migration/src/transform/`). Every record is validated against its `libs/domain` schema. It writes `transformed/{entity}.jsonl`, `idmap.jsonl` and `report.json` to the same run. It reads and writes only the run: the load is MIG-06. The [runbook](../runbooks/migration-transform.md) has the steps.
  - **Same output every time:** ids are `deterministicId('mig', legacyPath)`, and a record derived from another adds a `#part` to its path (`…/cards/C#client`). The reference time is the export's `readTime`, not the clock: it stands in for missing dates and is each record's `migration.loadedAt`, which the load restamps. Keys and lines are sorted, so the same run and profile give byte-identical files.
  - **Rich text:** an allow-list, not a library. jsdom parses the HTML the way a browser does, with no scripts and no loads; only the elements v2's Markdown renders turn into Markdown, and scripts, styles and frames are dropped with their content. A mention of the user becomes `@[uid]`, anyone else `@Name (imported)`. Quill's `ql-*` classes go, and an empty paragraph makes no note.
  - **Embedded images:** each base64 image in a description becomes a document on its matter, with the bytes and their sha256 in the copy plan. `copy-files` uploads them through the same quarantine, checks and scan as attachments (D-18). Images loaded from the web are dropped (tracking pixels).
  - **Dates:** instants become Timestamps. Due dates become the Melbourne day. A date that can't be read is reported (`MIG_W_DATE_INVALID`): an instant then takes the reference time, and a due date stays unset.
  - **Fees (D-06):** v2 needs a fee arrangement on every matter, so the "unset" fee of an empty billing type is hourly with no rate or estimate, flagged `fee_type_missing`. Disbursements recorded on a legacy fee stay in the matter's `legacy.fee`, flagged `fee_disbursements`. They never become disbursement records, which would enter WIP and could be billed twice.
  - **Labels (D-05):** each label keeps its name, and every matter also gets `board:{board name}`. v2 labels have no colour, so the colours don't migrate.
  - **Matter numbers (D-08):** under `allocate`, every matter gets `M-{YYYY}-{seq}` by the year it opened, in the order the cards were created. `adopt_reference_when_unique` (which the profile doesn't use) would adopt a unique, valid reference. The transform also writes what `createMatter` keeps beside a number: a reservation per number and each year's counter, so matters created in v2 continue the sequence. A delta (`--base-run`) keeps the numbers its base run gave.
  - **Checklist templates:** they go to the org's checklist templates (`orgs/{O}/checklistTemplates`, CORE-08d), not the matter templates the plan's field map named. A legacy template was a named list applied to a card, which is what a checklist template is; a matter template has stages and deadline rules. v2 holds up to 30 items: longer ones are cut and empty ones skipped, both reported.
  - **Personal-task boards:** cards become personal tasks grouped by column, as Blake decided on 2026-10-04. The description and comments become the task's description, and the checklists its checklist. A personal task has no matter, so a card's attachments can't migrate and are reported (`MIG_W_ATTACHMENT_NOT_MIGRATED`). The prod audit found none on those boards.
  - **Contacts:** each matter gets its own client from its title (D-10), never merged, so Tristan merges duplicates in review. The client also gets the matter's client party row, as a matter created in v2 does. Referrers and other legacy users are one contact each. A legacy user who is also a referrer keeps the referrer contact, tagged `legacy-collaborator`.
  - **Org and member:** a new org's id comes from the user's uid, so a re-run targets the same org. Its name is the profile's `org.name`, or the legacy company name flagged `org_name_unconfirmed` (D-09). Budgets come from the legacy profile, flagged `budgets_imported`. The legacy `budgetFinancialYear` is read as the year the financial year starts (2025 means 2025–26), which the review confirms. Budgets keep their own years. When the latest is before the current year, it is reported (`MIG_W_BUDGET_ROLLED_OVER`): this year has no budget, as when legacy rolled over.
  - **Records that weren't migratable:** activity entries and checklist templates gain the `migration` fields, so a rollback finds them. Matter-number reservations and counters can't carry them, so the rollback deletes those by path (MIG-06).
  - **Rejects:** a record that fails its schema is rejected with everything under it, and with its matter's number reservation. The run then writes only `report.json`, listing the rejects with an empty `files` list, and exits 5, unless `--allow-rejects`.
  - **Report:** counts in and out, every warning code with its count and legacy paths, review totals by code, rejects, and the files to copy with the orphans (D-13). It never holds a name, title or value, so the summary it logs is safe. A real run's report stays in the migration bucket and project files, never the repo.
  - **Costs disclosure reminders:** open matters import with disclosure `required` (D-11). Once `billing.costsDisclosure` is on, the nightly job reminds the lawyer of every one that has been required for 7 days, which on the first night is every open matter. Tristan settles them in review (MIG-08) before that flag goes on in prod.
  - **Evidence:** the fixture run is committed as a golden snapshot (`tools/migration/fixtures/golden/`), validates with no rejects and is byte-identical on a re-run, whatever order the records arrive in. Every mapper and hazard has a unit test.

## Descoped

- **No staging rehearsals.** The plan's staging rehearsals move to dev (D-15).
- **Shared boards.** Only Test Workflow is shared, and it is excluded (D-02).
- **Password hash import for Tristan.** He has no password, so no hash parameters or export are needed (D-16).
- **A staging export.** `--env` takes dev or prod (D-17).
- **A Cloud Run job for attachment hashes.** The copy reads each file back itself (D-18).
- **Label colours.** v2 labels are names only (D-19).
