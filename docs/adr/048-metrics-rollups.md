# ADR-048: Practice metrics roll up incrementally per record, and a nightly recompute keeps them honest

- **Status:** Accepted
- **Date:** 2026-10-06
- **Ticket:** [INS-01](https://linear.app/materia-web/issue/MAT-86)
- **Builds on:** [ADR-035: Trust accounting](035-trust-accounting.md), [ADR-039: Matter closing, retention and destruction](039-matter-closing-retention-and-destruction.md), [ADR-045: Invoicing](045-invoicing.md)

## Context

The insights pages (INS-02) and Clerk's metrics scope need a practice's figures by day, month and financial year: time recorded and billed by member and matter type, invoiced and collected, WIP, written off, matters opened and closed by type and referrer, probate cycle times and stage durations, deadline outcomes, Clerk usage, referrals and imported legacy billing. Adding them up from the records on every page view would read every record of the period. Triggers fire at least once and in any order, records are edited back-dated, matters change type and referrer after the fact, and the org's time zone or FY start can change. A busy firm writes the same day's figures many times a minute.

## Decision

- **Periods.** Figures live in `orgs/{orgId}/metrics/{period}`: `day-YYYY-MM-DD`, `month-YYYY-MM` and `fy-YYYY` (the year the FY starts, July by default, `fy.startMonth`). The day is always one of the record's own dates in the org's time zone (the work date, the issue or payment date, the due date, a matter's creation or closing day), never the write time. `values` is a flat map of integer counters (cents for money). Member figures go to `metrics/{period}/byMember/{uid}`.
- **One definition of every number.** `libs/domain/src/lib/metrics.ts` gives each record kind (matter, time entry, disbursement, deadline, invoice, credit note) a pure *contribution*: what it adds, by cell (`2026-10-06`, or `2026-10-06|{uid}` for member figures). The triggers, the nightly recompute, the backfill and the tests all use it.
- **Incremental sync with a ledger.** `metrics-onTimeEntry`, `-onDisbursement`, `-onDeadline`, `-onMatter`, `-onInvoice`, `-onCreditNote` and `-onContact` call `syncMetrics` for the record. In one transaction it reads the record and its ledger (`orgs/{orgId}/matters/{matterId}/metrics/{kind}-{id}`: what was counted, by cell), works out the contribution now, and writes only the difference as `FieldValue.increment`s to the day, month and FY documents (and member documents), then stores the new ledger. A replayed or out-of-order trigger finds the ledger already current and writes nothing, so the figures don't depend on trigger order or retries. Deletes, voids and soft deletes reverse what was counted.
  - Hot period documents are never read in the transaction: they are created once (outside it, cached per instance) and only incremented.
  - A matter's type or referrer change re-syncs its time entries or invoices; a referrer's industry change re-syncs the matters they referred. A matter's stage history (for stage durations) lives on its ledger.
  - Writes never send an empty `values` map: with `merge`, an empty map replaces the document's figures.
- **Sharding.** An org with more than 20 active members writes org figures to one of ten shards (`metrics/{period}/shards/{0-9}`, chosen at random per sync) to stay under Firestore's write rate per document; readers add the shards to the document. Member documents are never sharded. The nightly recompute folds shards back into their documents.
- **Snapshots.** WIP (`wip.`), active matters (`active.`), overdue deadlines (`overdue.`), aged debtors (`debtors.`, from BILL-08's `debtors-` documents) and Clerk's metering (`clerk.`, from AI-02's `clerk-` documents) describe a moment, not a flow. Only the nightly recompute and the backfill set them, with `snapshotOn`, on the day, month and FY documents. Utilisation and the cycle-time medians are worked out on read (`utilisationPct`, `medianDays`); cycle times and stage stays are day histograms (`d{n}` keys).
- **Nightly recompute.** `metrics-recompute` runs at 02:00 Melbourne time for every org. It re-syncs any record whose ledger is out of step (a missed trigger), then recomputes yesterday and the current month (and their FY) from the records and overwrites any figure that differs, with increments so concurrent syncs aren't lost. A document written during the run is left for the next night. FY documents are checked against the sum of their months. It logs `metrics drift corrected` with the number of documents corrected, which the `metrics_drift` log metric counts, and logs `ok` for the scheduled-job alert.
- **Backfill.** `materia-scripts backfill-metrics --project <id> --from YYYY-MM [--org <orgId>] [--dry-run]` restates everything from the start of the FY containing `--from`, from the records: ledgers, period and member documents, snapshots as at each period's end (WIP only for yesterday), and zeroed shards. It is idempotent, and has no `--down` because every figure is derived from the records (running it again is the undo). Run it after a migration, and after an org changes its time zone or FY start (old figures stay on the old days until restated).
- **Who reads what.** Every active member reads the day, month and FY documents and their shards, by path. Each member reads their own figures. Everyone's figures follow `settings.insights.memberVisibility`: `lawyers` (the default: owners, admins and lawyers), `admins` (owners and admins) or `everyone` (`MEMBER_METRICS_READERS`; role lists in the rules rather than a new action, since each action in the generated `perm()` map costs every `can()` and Clerk's message lists are at the 1000-expression limit). Clerk's metering (`clerk-`) and aged debtors (`debtors-`, which names clients) stay `billing.view`. Ledgers are server-only. Only functions write any of it.
- **Destroyed matters** (ADR-039): figures already counted stay, since they are aggregates with no matter id; the sync, recompute and backfill skip a destroyed matter's records, and destruction deletes its ledgers with the matter.

## Consequences

- Each record write costs a trigger, a transaction (two reads) and up to six document increments per day it touches. The figures are eventually consistent: a page can lag a write by a second or two, and a missed trigger by a night.
- A back-dated record changes past periods immediately, through the same increments.
- Clerk's metrics scope adds the shards to the month documents, as the Insights screen does ([ADR-054](054-insights-narratives.md)), so its figures match the screen's.
- A list query can't prove a document id's prefix, so members who lack `billing.view` read the rollups by id (INS-02 knows the ids of the periods it shows). Listing a period's member figures needs to see everyone's.
- The backfill overwrites documents whole, so a sync that lands mid-backfill can be lost until the next nightly recompute corrects it.
- The insights pages (INS-02) and the settings switch for `memberVisibility` come later.

## Alternatives considered

- **Aggregate on read** (count queries or summing records per page view): reads every record of the period on every view, and some figures (stage durations, cycle times, referral industry) need joins Firestore can't do.
- **Recompute only (nightly or on a timer):** figures a day stale, and a full rewrite of the period documents for every org every run.
- **Increment from the trigger's before/after alone, without a ledger:** wrong under retries and out-of-order delivery, and can't follow a matter's type or referrer changing after its time was recorded.
- **Distributed counters for every org:** ten reads per document for the many small firms that never need them.
