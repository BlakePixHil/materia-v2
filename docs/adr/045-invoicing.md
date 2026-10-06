# ADR-045: Invoices are built and frozen on the server, numbered in the issuing transaction

- **Status:** Accepted
- **Date:** 2026-10-06
- **Ticket:** [BILL-07](https://linear.app/materia-web/issue/MAT-49)
- **Refines:** [ADR-035: Trust accounting](035-trust-accounting.md)

## Context

A firm bills a matter's approved time and disbursements on an Australian tax invoice. Invoice numbers must have no gaps and no repeats, even when people issue at once. An issued invoice is a tax record: it can't change, only be voided (when unpaid) or credited. The fee arrangement (BILL-05) can cap professional fees. Every write has to be safe against a client that edits Firestore directly.

## Decision

- **Every invoice write goes through callables.** The rules make `invoices` and `creditNotes` read-only (`billing.view`). The callables are `billing-saveDraft`, `-deleteDraft`, `-issueInvoice`, `-sendInvoice`, `-voidInvoice`, `-createCreditNote` and `-retryPdf`, all idempotent. Issuing and sending need `billing.issue`, which is now lawyers and above. Voiding and credit notes need `billing.void` (owners and admins).
- **A pre-bill is a draft invoice.** It stores the choices: the date range, the entries and disbursements left out, the grouping (itemised, or one "Professional fees" line with a schedule), fixed fees and discounts (negative adjustments), notes and payment terms.
  - The lines are built by `buildInvoice` in `libs/domain`. The browser runs it for the live preview; the server runs it on save and again inside the issuing transaction.
  - A pre-bill saved before its time or disbursements changed is "changed since added" (`draftChanges`). Issuing refuses a stale pre-bill (`stale_draft`), so what was reviewed is what is issued; the app saves it again first.
- **Numbering.** `orgs/{orgId}/counters/invoice` and `counters/credit-note` hold the next number.
  - The issuing transaction reads the counter last, after every check that can fail, and writes it with the invoice. A failed issue never uses a number, and concurrent issues queue on the counter (up to 25 attempts). The integration test issues 20 at once and gets 1 to 20.
  - Numbers are the org's prefix (`INV-` by default) and six digits. Credit notes are `CN-` and six digits.
- **Issuing freezes the invoice** in the same transaction: the number, issue date (the org's day), due date (payment terms), the supplier (name, ABN) and buyer (the clients, joint ones joined; the first ABN; a postal address first), `status: issued`. Each entry and disbursement on it becomes `billed` with the `invoiceId`, and the matter gets `lastInvoicedOn`.
- **GST.** GST is worked out per line, half up to the cent, then added up; the totals are the sums of the lines. GST-free lines are marked. A firm not registered for GST issues an "Invoice" without GST and passes disbursements on at their GST-inclusive cost.
- **Fee caps apply to professional fees only.** Disbursements are at cost. When fees billed so far (live invoices, less credit notes) plus this invoice's fees pass the cap, a negative "Fee cap" line brings them back to it.
- **Void and credit.**
  - Void is for an issued invoice with no payments and no credit notes. It keeps its number; its time goes back to `final` and its disbursements to `unbilled`, so they return to WIP.
  - A credit note credits all that's left or chosen lines (in full or by an amount). A whole line credits its remaining GST; part of a line gets GST on that part. The work stays billed. `fees-budgetOnCreditNote` recomputes the matter budget, whose `billedCents` subtracts credit notes.
- **The PDF is a matter document.** After issuing (and after a credit note) a `pdf.render` job renders the `invoice` template into a matter document (category `financial`). The job's data names the invoice (`documentRef`); `billing-onPdfJob` marks it `ready` with the document id, or `failed`. A failed render leaves the invoice issued, and the app offers a retry.
- **Sending is never automatic.** `billing-sendInvoice` emails the PDF as an attachment (a new MailPort attachment field, sent by Postmark) to the addresses chosen, the clients' by default, and records `sentAt`, `sentBy` and `sentTo`. A client with no email address can't be emailed; the app offers the PDF to print.
- **Paid from trust is a payment method only** (ADR-035): Materia records that a payment came from trust; it never moves trust money.
- **Flag.** Everything is behind `billing.invoicing` (server-enforced), on in dev and off in prod until a lawyer signs the invoice off.

## Consequences

- Payments, part-paid and paid statuses, and Xero sync come with later BILL tickets; the fields exist.
- One invoice bills up to 400 entries; a larger pre-bill asks for narrower dates.
- The invoice list reads up to 200 at a time, newest first, with "Show more".
