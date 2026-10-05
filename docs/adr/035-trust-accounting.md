# ADR-035: Trust money is shown, never kept: the trust ledger stays in the firm's trust software

- **Status:** Proposed (owner decisions pending on [BILL-10](https://linear.app/materia-web/issue/MAT-55))
- **Date:** 2026-10-05
- **Ticket:** [BILL-10](https://linear.app/materia-web/issue/MAT-55)

The ticket asks for `ADR-021-trust-accounting.md`; numbers 021 to 034 were taken by feature PRs first, so this is ADR-035.

## Context

Estates work involves a lot of trust money. Executors' solicitors collect estate funds (closed bank accounts, sale proceeds) and hold them
until distribution, and clients pay money on account of costs and disbursements (probate filing fees, advertising). Lawyers want to see
what is held for a matter next to its WIP, invoices and estate register.

A trust ledger, though, is a regulated record, and the law practice is liable for it. Victoria applies the Legal Profession Uniform Law
(Schedule 1 to the _Legal Profession Uniform Law Application Act 2014_ (Vic)) and the _Legal Profession Uniform General Rules 2015_.
The regulator is the Victorian Legal Services Board and Commissioner (VLSB+C). Section and rule numbers are the same in every Uniform Law
jurisdiction.

| Topic                    | Requirement                                                                                                                                                                                                                                                       | Source                                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| What it is               | Money entrusted to a law practice in connection with legal services, including money on account of costs in advance, controlled money, transit money and money subject to a power                                                                               | Uniform Law s 129                            |
| Who may receive it       | A law practice with a principal whose practising certificate authorises receipt of trust money, using a general trust account at an ADI approved by the Board                                                                                                    | VLSB+C Grant of Trust Authorisation policy   |
| Receipts and deposits    | Deposit into the general trust account as soon as practicable, unless there is a written direction (controlled money); make out a receipt as soon as practicable, or on notice of a direct deposit; keep deposit records                                       | s 137, s 139; rr 37, 41                      |
| Holding and paying out   | Hold exclusively for the person, pay out only on their direction, no intermixing with other money; withdrawals by cheque or EFT only (no cash or ATM)                                                                                                            | s 138, s 146; r 43                           |
| Withdrawing for costs    | Either give a bill that refers to the proposed withdrawal and wait 7 business days without objection, or act on the person's authority and send a request for payment or notice of withdrawal first                                                             | r 42(3), r 42(4)                             |
| Records                  | Permanent form, showing the true position at all times, examinable; receipts and payments cash books (payments entered within 5 working days), transfer journal (only when entitled to withdraw), a trust ledger account per person and matter | s 147; rr 44–47                       |
| Electronic records       | Month-end copies of the cash books, reconciliations and ledger list kept in printed form, or in readable and printable form that cannot be modified afterwards                                                                                                  | r 38                                         |
| Retention                | 7 years after the last transaction entry or the finalisation of the matter, whichever is later                                                                                                                                                                    | s 147                                        |
| Monthly reconciliation   | Reconcile the ADI statement with the cash book, and the trust ledger trial balance with the cash book, within 15 working days of each month end                                                                                                                  | r 48                                         |
| Irregularities           | Written notice to the regulator as soon as practicable after becoming aware of one; failure is a civil penalty                                                                                                                                                    | s 154                                        |
| External examination     | Annual examination by an approved external examiner. Victoria's trust year is 1 April to 31 March; the practice lodges Parts A and B through LSB Online by 30 April and the examiner reports by 31 May                                                          | ss 155–156; VLSB+C "Completing an external examination" |

These citations were gathered from the Law Society of NSW _Legal Accounting Handbook: Trust money and trust records_ (2024), AustLII
section headings and VLSB+C pages, because this work's sandbox couldn't open legislation.vic.gov.au. A practitioner checks them against the
primary sources (BILL-10a).

What else frames the decision:

- The handbook puts trust out of MVP scope, and the security page says "Trust money: out of scope for v1".
- The MVP has one user, migrated from the legacy app, which kept no trust records (its billing has only an `applyTrust` flag, migrated read-only
  into `legacyBilling`). That user's firm already keeps its trust records somewhere: practice software (LEAP, Smokeball, Actionstep) or a
  standalone package run by a bookkeeper.
- The schema already allows an invoice payment with `method: 'trust_transfer'` (`libs/domain/src/lib/schemas/org-records.ts`).

## Decision

We will never make Materia a trust record. At most it shows a balance copied from the firm's own trust records (option A), and later
that balance can be read from the firm's software instead of typed in (option B). Trust stays out of the MVP.

1. **No ledger, anywhere.** Materia never records trust receipts, payments, transfers or a running trust balance. Nothing is called or labelled
   a ledger, and nothing computes an amount "available" to withdraw.
2. **Snapshots, not transactions.** A matter may carry the latest trust balance snapshot: `trustSnapshot?: {amountCents, asAt: DateOnly,
source: 'manual' | <vendor>, recordedBy, recordedAt}`, with integer cents ≥ 0 and `asAt` not in the future. Each change writes an audit-log
   entry (ADR-010), which is the history. Only roles with `billing.view` see it.
3. **Always labelled.** Every place a snapshot appears shows its as-at date, its source system ("from Smokeball") and the words "Not the trust
   ledger". A snapshot older than the org's threshold shows as out of date. Snapshots are never printed on invoices, client exports or
   emails.
4. **Behind a flag.** The display ships behind `billing.trustDisplay`, off by default (ADR-016), and turns on per org in Settings → Trust.
5. **"Paid from trust" is recorded after the fact.** The withdrawal happens in the firm's trust software. Materia records it as a payment with
   `method: 'trust_transfer'` and a reference, and never starts or authorises it. When an invoice is marked "to be paid from trust", its PDF
   may carry the r 42(3) notice of intended withdrawal, in practitioner-reviewed wording. Recording the payment doesn't change the snapshot;
   the UI prompts the user to update it.
6. **Distributions don't move money.** CORE-16 records the planned and paid distributions, with a paid-on date and an optional payment
   reference from the trust software. A trust balance is never derived from distributions, assets or invoices.
7. **Integration is read-only.** If the firm's software has an API for it, a later ticket may fill the snapshot from it (`source: <vendor>`),
   through the integrations pattern (ADR-019). Materia never writes to a trust system.
8. **Clerk** may read the snapshot and must quote its as-at date and say it isn't the trust ledger. It never suggests a withdrawal or transfer.

## Consequences

- No trust-accounting compliance burden lands on Materia or on the practitioner's use of it; the firm's existing records and external
  examination are unchanged.
- A lawyer can still see roughly what's held for a matter, at the cost of copying it in. A stale or mistyped snapshot is the main risk, which
  the labels, the as-at date and the out-of-date chip address; the trust software stays the only basis for paying money out.
- Follow-ups (Linear, project 02, M2.2, all after the MVP):
  - **BILL-11** Trust balance snapshots on matters (display only), behind `billing.trustDisplay`. Blocked by CORE-06 and CORE-21.
  - **BILL-12** "Paid from trust" on invoices and payments (r 42 notice, `trust_transfer` payments, prompt to update the snapshot).
    Blocked by BILL-07, BILL-08 and BILL-11.
  - **BILL-10a** Practitioner review of this ADR's citations and the r 42 notice wording. Blocks nothing; BILL-12's notice stays off until
    it's done.
- A read-only integration ticket is written only if the firm's software turns out to have a usable API and the owner wants it.

### Settings → Trust (input for DES-01)

- Owner and admin only. A switch, "Show trust balances on matters".
- "Your trust records are kept in": LEAP, Smokeball, Actionstep, Other (free text). This names the source on every snapshot.
- "Mark a balance out of date after": a number of days, default 30.
- Fixed text, not editable: "Materia shows a trust balance you copy from your trust records. It is not the trust ledger. Always check your
  trust records before paying money out."
- On the matter: a "Held in trust" stat with the amount, "as at 3 Oct 2026 · from Smokeball", an amber "Out of date" chip past the threshold,
  and an Update dialog (amount, as-at date defaulting to today, optional note). No deposit, withdraw or transfer actions anywhere.

## Alternatives considered

- **B. Integrate as the main approach.** Smokeball and Actionstep publish REST APIs that cover trust balances; LEAP's API needs a partner
  application. Each vendor is its own OAuth app, matter mapping and sync job, for one firm, and the firm then keeps matters in two systems.
  Kept as a later upgrade of A's data source, not built now.
- **C. Build a compliant ledger.** It would need everything in the table above: numbered receipts, both cash books, the transfer journal,
  controlled-money accounts, bank feeds and monthly three-way reconciliation, records that can't be changed for 7 years, r 42 workflows,
  irregularity reporting, external examiner exports, and in practice certification from the Law Society of NSW, as Smokeball and Clio
  hold. A mistake puts the practitioner's trust authorisation at risk, and the firm already has a ledger, so two would disagree. Rejected.
- **Nothing at all.** Cheapest, but lawyers would keep balances in matter notes with no as-at date or warning. A labelled snapshot is safer.
