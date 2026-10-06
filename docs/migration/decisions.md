# Migration decision log (MIG-01, MIG-04)

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

## Descoped

- **No staging rehearsals.** The plan's staging rehearsals move to dev (D-15).
- **Shared boards.** Only Test Workflow is shared, and it is excluded (D-02).
- **Password hash import for Tristan.** He has no password, so no hash parameters or export are needed (D-16).
