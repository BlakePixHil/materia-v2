# ADR-040: The estate register is client-written, with trigger-kept totals

- **Status:** Accepted
- **Date:** 2026-10-05
- **Ticket:** [CORE-16](https://linear.app/materia-web/issue/MAT-56)

## Context

CORE-16 adds an estate register to probate, administration and trust matters: assets, liabilities and distributions, a summary, the residue left for distribution, and an inventory export. The register has to:

- stay exact in integer cents, with assets passing outside the estate kept out of gross;
- keep the matter's `estate.grossValueCents` and `estate.netValueCents` in step, because deadline rule sets and BILL-05 costs estimates may read them;
- show totals for registers too large to read in full (500 or more rows);
- export the same figures as CSV and PDF, the PDF through `pdf.render` (FND-24, ADR-014);
- wait for a practitioner's review of the asset classes and the summary wording (CORE-16a) before it is on in production.

## Decision

**Client-direct writes under the rules.** `assets`, `liabilities` and `distributions` are written by `matter.edit` roles directly (create, edit the whitelisted fields, soft delete), like key facts. The rules check every amount is an integer of 0 or more, the enums, the text limits and the matter's visibility. A typed row in the Estate tab saves at once, without a callable round trip.

**Exact totals from a transaction.** `estate-onWrite` (assets) and `estate-onLiabilityWrite` re-read every live asset and liability in a transaction and write `matter.estateRegister` plus `estate.grossValueCents` and `estate.netValueCents`, but only when something changed. Concurrent and out-of-order events converge, and a register of any size shows exact totals from one document. The tab shows its own sum while every row is loaded (so a new row counts at once) and the stored totals once the register outgrows a page.

**The maths lives in `libs/domain`.** `estateTotals`, `residueCalculation` and the inventory builders are shared by the trigger, the export callable, the CSV the browser makes and the tests. An asset counts at `shareBps` of its value at the date of death, rounded half up. Joint tenants pass outside the estate by default; tenants in common don't. A foreign asset keeps its original currency and amount as metadata, with no live exchange rates.

**Distributions are shown, not enforced.** The residue is net estate less specific and pecuniary gifts and `estate.reservedCents`. Nothing stops a gift exceeding it, and an insolvent estate (net below zero) shows a warning and disables recording distributions. When an asset's value changes, the trigger sets `needsValueReview` on the live distributions recorded before the change that depend on it: residuary gifts, and specific gifts of that asset without a fixed amount. A person clears the flag; the rules let clients clear it but never set it. The field isn't called `needsReview`, because that name belongs to the legacy migration's metadata (`MigrationMetaShape`).

**Estate value hooks.** When gross or net changes, the trigger recomputes the matter's deadlines only if its rule set's conditions or offsets read `estate.grossValueCents` or `estate.netValueCents` (vic-v1 doesn't yet). BILL-05 adds its costs-estimate notification at the same seam.

**Exports.** The CSV is built in the browser from the live rows (RFC 4180, CRLF line ends, formulas defused, plain dollar amounts). `estate-exportInventory` builds the same schedule on the server from the live register, never from the caller's data, and queues `pdf.render` with the `estate-inventory` template. The PDF is saved as a matter document (category financial), privileged when the matter is. Both are deterministic for the same register and date, and both say they are a working draft, not a court form.

**Behind a flag.** The tab, the export and the seeded data sit behind `estate.register` (server-enforced, default off, on in the emulator seed) until CORE-16a records the practitioner's sign-off.

## Consequences

- Turning the register on for an org changes nothing until someone adds a row; the first row makes the trigger the owner of the gross and net values.
- Large registers read one page (200 rows) at a time. The summary comes from `estateRegister`, and the exports load every page first.
- The register's history comes from the audit log (`matters/{matterId}/{sub}/{docId}` writes), not from its own revision documents.
