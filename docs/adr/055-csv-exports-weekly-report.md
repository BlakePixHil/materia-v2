# ADR-055: List exports are server-written CSV export jobs, and the weekly practice report is an opt-in Monday email

- **Status:** Accepted
- **Date:** 2026-10-06
- **Ticket:** [INS-03](https://linear.app/materia-web/issue/MAT-89)
- **Builds on:** ADR-014 (heavy work), ADR-015 (email), [ADR-048](048-metrics-rollups.md) (metrics rollups), FND-24 (jobs), CORE-12b (export files and their sweep), FND-20 (notifications)

## Context

Firms want their lists in a spreadsheet: matters, contacts, time entries, invoices and deadlines, filtered as the screen shows them. INS-03 asks for one callable, `exports-create({kind, filters})`, that respects the list's filters and the person's permissions, runs as a job beyond 5,000 rows, keeps the file for 7 days, notifies `export_ready`, downloads through a signed URL, re-authenticates for contacts, and leaves privileged matters out unless a lawyer or above asks. Every export is audited. The CSV must be safe to open in Excel: UTF-8 with a BOM, formula injection defused, ISO dates, money in decimal dollars and leading zeros kept.

The same ticket adds a weekly practice report for owners and admins: Monday at 07:00 in the practice's time zone, six figures, the five matters with the most WIP, and a count of critical deadlines due, with no client names.

Before this, the WIP tab built a time-entry CSV in the browser from `time-exportCsv`'s response. That meant no audit record, no job for large exports and nothing for privileged matters.

## Decision

- **One callable for every list.** `exports-create` takes `{kind, filters, includePrivileged}`. Each kind has its own filter schema, mirroring the screen's filters (`MatterExportFilters`, `ContactExportFilters`, `TimeExportFilters` with a required date range, `InvoiceExportFilters`, `DeadlineExportFilters`). Filters a list doesn't have are refused. The Matters and Contacts screens' own filter predicates moved into `libs/domain` (`matterPassesFilters`, `contactPassesFilters`), so the file and the screen can't disagree.
- **Who may export what.** `EXPORT_ROLES`: matters, contacts and deadlines for everyone but read-only members; time entries and invoices for lawyers and above (the roles that see them). Privileged matters, and the time, invoices and deadlines on them, are in the file only when the person is a lawyer or above **and** asks (`exportIncludesPrivileged`). This narrows invariant 7, which said "owner or admin", to follow the ticket.
- **Every export re-authenticates.** The ticket asks for it on contacts. `exports-create` carries `recentLoginMinutes` for every kind because one callable serves them all, and a bulk copy of matters or time is no less sensitive. The client's callable wrapper shows "Confirm it's you" and retries.
- **A CSV export is an FND-24 job.** Each call creates `jobs/{jobId}` with type `csv.export`, the request as `input` and the row count as `progress.total`, and audits `export.created` with the kind, the filter *names* (never values) and whether privileged rows were asked for. At up to 5,000 rows (`EXPORT_INLINE_MAX_ROWS`) the callable writes the file itself and returns a 5-minute signed URL. Over that it queues `exports-run` (Cloud Tasks, deduplicated by job id) and returns `queued`. Exports stop at 250,000 rows (`EXPORT_MAX_ROWS`).
- **The file is streamed.** Rows are read 500 at a time (`startAfter` the last snapshot) in the list's order, built into CSV lines and written as 64 KB chunks through one `createWriteStream` (`ifGenerationMatch: 0`). The whole file is never held in memory, which is what makes 100,000 rows safe in 512 MiB. The file is `orgs/{orgId}/exports/{jobId}.csv`, `text/csv; charset=utf-8`, served as an attachment. The 7-day TTL is CORE-12b's `jobs-sweepExports`, which now matches `.csv` too.
- **Access is checked again at the end.** `exports-run` checks that the member is still active and still allowed the kind (and the privileged rows) before and after writing. If they lost it while the export ran, the file is deleted and the job fails with `PERMISSION_DENIED`. Otherwise the job succeeds and `export_ready` goes to the person who asked, with a link to `/exports/{jobId}`. That page asks `jobs-getExportUrl` for a fresh link, which only the job's creator can get.
- **CSV hygiene lives in the domain.** `exportLine` quotes as RFC 4180 needs and prefixes `'` to any cell starting with `=`, `+`, `-` or `@`. Numbers Materia formats itself (money as `1234.56`, hours, rates) skip that prefix, so a negative balance stays a number. Identifiers that look numeric (matter and invoice numbers, phone numbers, postcodes) are always quoted text (`csvTextCell`). Dates are ISO `YYYY-MM-DD`. Lines end in CRLF and the file starts with a BOM.
- **The weekly report runs every 15 minutes, like the daily digest.** `notifications-weeklyReport` finds, per org, whether it is Monday at or after 07:00 in the org's time zone (`weeklyReportDue`). It sends to each active owner and admin with `prefs.notifications.weeklyReport: true`. A `digests/weekly-{uid}-{monday}` record is created first, so a week's report goes once. A transient mail failure deletes the record to try again on the next run. Without Postmark the outcome is `skipped: not_configured`.
- **The report holds figures and matter numbers only.** Last Monday to Sunday's billed, collected, billable hours, matters opened and deadlines met on time come from the INS-01 day rollups (with their shards). WIP now and the top five matters by WIP (time plus disbursements, numbers only) come from the matters. The count of critical upcoming deadlines due this week has no titles. It links to Insights, Deadlines and the preference itself. The opt-in is a switch in Settings → Preferences, shown to owners and admins. The rules check it is a boolean.

## Consequences

- The WIP tab's "Export" now goes through `exports-create` (kind `time`, the unbilled entries the tab shows). It is audited and can include privileged matters on request. `time-exportCsv` stays for now but nothing in the web app calls it.
- A background export is announced by `export_ready` (in-app by default, email if the person turned it on). A small export downloads at once and sends no notification, because the person is already looking at it.
- Live email delivery of the report waits on Postmark, like every other email. Until then each send is recorded `skipped: not_configured`.
- Contacts are ordered by `sortName`, which a trigger writes. A contact created a moment before an export may be missing from it.

## Alternatives considered

- **Building the CSV in the browser from the list's loaded rows:** the list holds one page, it can't be audited or limited by role, and a 100,000-row export would exhaust a phone.
- **A Cloud Run job for every export:** heavier than needed. Most exports are a few hundred rows and finish inside the callable. Cloud Tasks gives retries and deduplication for the rest.
- **Scheduling the weekly report with one Cloud Scheduler job per org:** each org's time zone would need its own job, created and kept in step. A 15-minute check that usually reads only the org list matches the daily digest and costs little.
