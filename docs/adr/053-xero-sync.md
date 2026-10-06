# ADR-053: Xero sync sends each issued document through a rate-limited queue and brings payments back hourly

- **Status:** Accepted
- **Date:** 2026-10-06
- **Ticket:** [BILL-09](https://linear.app/materia-web/issue/MAT-52)
- **Builds on:** ADR-019 (Integrations), [ADR-051](051-oauth-token-vault.md) (token vault), [ADR-045](045-invoicing.md) (invoicing), [ADR-046](046-payments-and-aged-debtors.md) (payments)

## Context

Many small Australian firms keep their office (general) accounts in Xero. BILL-09 sends Materia's issued invoices, credit notes and voids to Xero as receivables, and brings payments made in Xero back as BILL-08 payments. The ticket asks for idempotent pushes, errors people can see and retry, and payments deduplicated by Xero's payment id.

Xero constrains the design:

- Each organisation (tenant) allows 60 calls a minute and 5,000 a day. A 429 carries `Retry-After`.
- Contact names must be unique among active contacts. Invoice numbers are checked for duplicates.
- Apps created after 2 March 2026 must ask for granular scopes. The ticket's `accounting.transactions` is no longer offered to them, so the vault asks for `accounting.invoices`, `accounting.payments`, `accounting.contacts`, `accounting.settings.read` and `offline_access`.
- Refresh tokens rotate on every refresh and expire after 60 days unused. The vault (ADR-051) handles both.

## Decision

- **One connection per practice, chosen once.** Xero connects through the vault as the practice's connection (`integrations/xero`). Settings → Integrations saves `orgs/{orgId}.xero`: the tenant (and its name), the account codes for fees and for disbursements, whether to send as things happen (`autoPush`), and `sendFrom`, the first issue date to send. `xero-saveSettings` checks that the tenant is one the connection reaches and that both accounts are active in it. Only owners and admins can save. The settings stay when Xero is disconnected, so reconnecting needs no setup.
- **Sending goes through one Cloud Tasks queue.** `xero-onInvoice` queues an invoice when it is issued (draft to issued) or voided. `xero-onCreditNote` queues a new credit note. Both act only when the flag is on, sending on issue is on and the connection is live or needs reconnecting. They skip documents issued before `sendFrom`. "Send to Xero" and "Try again" (`xero-send`) queue one document; "Send unsent to Xero" queues up to 200 from `sendFrom` on. The `xero-push` queue runs one task at a time, at most one a second, so Xero's limit is never approached. It tries 5 times with backoff from 60 seconds to an hour. A `RATE_LIMITED` error from the vault reschedules the task for when Xero says, without using a try. The ticket's `xero-pushInvoice` became `xero-push` because it also sends credit notes and voids.
- **Sending twice never makes two.** Each create carries an `Idempotency-Key` derived from the org, tenant and document. Before creating, the sync looks for the number in Xero. A sales document with the same type, total and reference is adopted: it is an earlier send that stopped before Materia recorded it. Anything else under that number was entered by hand. It is reported as a conflict (`number_taken`) and never overwritten. Supplier bills (ACCPAY) don't count, since their numbers are the supplier's.
- **Contacts are matched by id, then email, never by name.** `xeroContacts/{tenantId}_{hash of the client ids}` (server-only) links a matter's client set to its Xero contact. Without a link, a single client is matched by email only when exactly one active Xero contact has that address. Otherwise a contact is created from the invoice's buyer, with its email, ABN and address. If Xero says the name belongs to another contact, the new one is named with the client's Materia reference in brackets.
- **Lines keep Materia's amounts.** Disbursements go to the disbursements account and everything else (time, fixed fees, adjustments) to the fees account. For a GST-registered firm, lines are tax-exclusive with tax type `OUTPUT` (GST on Income) or `EXEMPTOUTPUT` (GST Free Income), and they carry Materia's own GST amount, so Xero's GST and totals equal the tax invoice. A firm not registered for GST sends `LineAmountTypes: NoTax` (the ticket's "tax type NONE"). Hours at a rate stay that way only when they multiply out to the line amount exactly; any other line is one unit of its amount, so Xero's rounding can't move a cent. Each document uses the GST registration it was issued with. An invoice's reference is its matter number; a credit note's is its invoice number.
- **Credit notes are allocated, voids are voided once.** A credit note is sent as `ACCRECCREDIT` after its invoice (which is sent first if Xero doesn't have it). It is then allocated against the invoice in Xero. If the invoice was already paid in Xero, Xero refuses the allocation. The note is then marked failed with Xero's reason, for the firm to refund or allocate in Xero. A void is sent once and recorded as `voidedAt`. Xero refuses to void an invoice with payments, and that is recorded the same way.
- **Payments come back hourly.** `xero-pullPayments` asks Xero for receivable payments changed since its cursor. The first run looks back 180 days, and a run reads up to 20 pages of 100. The cursor lives on `integrationStatus/xero.sync`, so reconnecting starts again from 180 days, which is harmless because payments are deduplicated. Payments are matched to invoices by Xero's InvoiceID; invoices Materia didn't send are ignored. Each is recorded once as `xero-{PaymentID}` with method `xero`, through BILL-08's own checks. A payment deleted in Xero reverses the one recorded from it. A payment Materia can't record (it would overpay, or the invoice is void here) is kept in `xero.unrecordedPayments` with the reason, and the owners and admins are told once per payment. A payment recorded by hand for the same amount within 7 days is linked as `possibleDuplicateOf`, so the invoice can show "Possible duplicate". Sending an invoice again also brings across any payments Xero already holds.
- **Each document shows where it stands.** `xero` on an invoice or credit note holds `status` (`queued`, `synced`, `failed`, `conflict`), the tenant, Xero's id and contact id, `syncedAt`, `voidedAt`, `allocatedAt`, and `error {code, message, at}`. The codes are `not_connected`, `rejected` (Xero's validation message), `number_taken` and `unavailable`. On the last try, a failure tells the owners and admins with an `integration_error`, unless the document had already failed for the same reason. A connection that needs reconnecting tells no one again, because the vault already has. Sync writes are made as `system`, so the audit trail records payments recorded or reversed; `xero` itself is bookkeeping and isn't audited.
- **Behind a flag.** `integrations.xero` is server-enforced and off by default. It stays off in prod until BILL-09a: a person registers the Xero app, sets its secrets and runs issue, push, pay in Xero and pull end to end on a Xero demo company.

## Consequences

- A firm's Xero shows the same invoice numbers, totals, GST and references as Materia. Payments made in Xero appear in Materia within the hour. Payments recorded in Materia are not sent to Xero; the firm records those in Xero as it always has.
- Nothing calls Xero from a callable except the settings page's lookups. Every send is a task, so an outage, rate limit or revoked token never fails an issue or a void.
- Changing the Xero organisation sends nothing again. Documents already in the old one count as unsent in the new one, for "Send unsent to Xero" to send.
- Tracking categories aren't mapped (optional in the ticket). The optional nightly live sandbox test isn't built; the client's contract tests use responses shaped like Xero's, and BILL-09a checks the real thing once.

## Alternatives considered

- **Calling Xero from `billing-issue`:** an issue would fail, or slow down, whenever Xero did, and rate limits would surface to the person issuing.
- **Xero webhooks for payments:** they need a public endpoint with signature checks and don't remove the need to catch up after an outage. Polling hourly with `If-Modified-Since` costs one call per org when nothing changed.
- **Keeping the settings in the server-only `integrations/xero` document:** the settings page couldn't read them, and disconnecting would lose them. They hold nothing secret.
- **Matching contacts by name:** two clients with the same name would share a Xero contact, and the debts of one would show against the other.
