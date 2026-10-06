# ADR-046: Payments are recorded on the invoice; aged debtors roll up nightly; reminders wait for a person

- **Status:** Accepted
- **Date:** 2026-10-06
- **Ticket:** [BILL-08](https://linear.app/materia-web/issue/MAT-51)
- **Builds on:** [ADR-045: Invoicing](045-invoicing.md), [ADR-035: Trust accounting](035-trust-accounting.md)

## Context

Issued invoices (BILL-07) need payments recorded against them, so the firm knows what each client still owes, how old the debt is, and when to chase it. Payments sometimes go wrong: a cheque bounces, or one is keyed twice. Clients sometimes pay too much. An estate's executor often pays rather than the client. Chasing a debt is sensitive work for a law firm, so nothing may be sent to a client without a lawyer reading it first. Materia is never a trust ledger (ADR-035) and moves no money.

## Decision

- **Payments live on the invoice.** `invoices/{id}.payments[]` holds `{id, kind: 'payment'|'refund', date, amountCents, method, reference?, payer?, credit?, recordedAt, recordedBy}`, AUD inc GST. They're written only by callables, in a transaction on the invoice. The rules keep invoices read-only to clients.
  - What's owing is the total, less credit notes, less payments, plus refunds (`owingCents`). Reversed entries don't count. The status follows the money (`paymentStatus`): `issued` until something is paid, then `part_paid`, then `paid` when nothing is owing.
  - `billing-recordPayment` (`billing.issue`) records a payment. A payment over what's owing is refused unless `credit` is set, which holds the extra as the client's credit (owing goes negative). A date before the invoice is allowed with a `before_issue` warning; a future date isn't. The payer is free text.
  - A refund (`kind: 'refund'`, `billing.void`) only pays back credit the client holds, for example after a credit note on a paid invoice. Materia records that the refund happened; it doesn't move money.
  - `billing-reversePayment` (`billing.void`, with a reason) marks a payment or refund `reversedAt/By` and `reversalReason`. It stays on the invoice and stops counting. A payment that a refund came from needs the refund reversed first.
  - Voiding needs no live payments (reversed ones aside). After a part payment, the firm issues a credit note and, if money goes back, records a refund. A credit note now also updates the status, so crediting the rest of a part-paid invoice makes it `paid`.
  - Each is audited (`invoice.payment_recorded`, `invoice.refund_recorded`, `invoice.payment_reversed`) with the amount, method and date, never the payer.
- **The matter shows what's outstanding.** `billing-outstandingOnInvoice` recomputes `matter.outstandingCents` from the matter's issued invoices on any invoice write that changes the money (status, total, credits, payments). Credit held on one invoice doesn't offset another's debt. It never writes a destroyed matter's tombstone (CORE-19). The matter header shows "Outstanding $X" to billing roles while it isn't zero.
- **Aged debtors are a nightly rollup.** `billing-debtorsNightly` (01:30 Melbourne) runs per org while `billing.invoicing` is on, and writes `metrics/debtors-{YYYY-MM-DD}`.
  - Each invoice's outstanding amount goes in a bucket by whole days past its due date: not yet due (0 or less), 1–30, 31–60, 61–90, over 90 (`agedBucket`).
  - The doc's `values` hold the bucket totals, the total, and the invoice and matter counts. `debtors.rows` holds one row per matter: client name as invoiced, matter, responsible lawyer, buckets, total and oldest due date. The doc holds up to 2,000 matters; the totals always count every one.
  - Clerk's metrics scope reads only month and year rollups, so client names in this doc never reach it.
  - `/billing/debtors` (billing.view) shows the latest report grouped by client and matter, with "My matters" and CSV export (formula-safe cells). When the latest report isn't today's, it asks `billing-refreshDebtors` to work today's out now.
- **Reminders are queued, never sent.** The same nightly run queues `invoiceReminders/{invoiceId}-{threshold}` (`pending`) when an invoice with something owing reaches 7, 30 or 60 days past due. Each one is queued once, for the matter's responsible lawyer, with the clients' email addresses.
  - A pending reminder is `cancelled` when the invoice no longer owes anything or reaches a later threshold.
  - The responsible lawyer (or an owner or admin) reviews a drafted message (`reminderMessage`), edits it and sends it with `billing-sendReminder`. That emails the `invoice_reminder` template with the PDF attached when it's ready, and marks the reminder `sent`. They can also dismiss it with `billing-dismissReminder`.
  - Nothing else sends a reminder.
- **Flag.** Everything is behind `billing.invoicing`: no new flag. The reminder wording and the aged-debtors report are added to the invoicing sign-off ticket (BILL-07a).

## Consequences

- A payment is a fact recorded by a person, so there's no bank feed or reconciliation. Xero sync (a later ticket) can read `payments[]`.
- Payments can be recorded on closed and archived matters: debts outlive the work.
- Reminders queue only from the nightly run (or a refresh of the report). An invoice that becomes overdue during the day is picked up that night.
- Old `metrics/debtors-*` docs stay as a history of the debtor book by day.
