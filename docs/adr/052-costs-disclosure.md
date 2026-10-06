# ADR-052: Costs disclosure follows versioned rules per jurisdiction and the matter's estimate

- **Status:** Accepted
- **Date:** 2026-10-06
- **Ticket:** [BILL-06](https://linear.app/materia-web/issue/MAT-47)
- **Builds on:** [ADR-047: Document templates](047-document-templates-and-docx-merge.md)

## Context

Under the Legal Profession Uniform Law (Part 4.3) a law practice tells a client the basis of its costs and an estimate of the total, and tells them again when anything disclosed changes significantly. Which disclosure a matter needs depends on the estimate: none below a lower threshold, the uniform standard (short) form up to a higher one, and a full disclosure above that. CORE-05 shipped intake with a placeholder single threshold and no way to record a disclosure as given. Firms need to know which matters still owe one, to be reminded, and to see when a fee revision makes the last one out of date.

The thresholds and forms are law, and they change. Nobody on the team is a practitioner, so whatever we encode has to be easy to review and correct, and must say plainly that it hasn't been reviewed yet.

## Decision

- **The rules are data, versioned per jurisdiction.** `libs/domain/costs-disclosure/rules.json` holds, for each jurisdiction, a version (`vic-v1`), an `illustrative` flag and ordered bands: an upper limit in cents (inclusive; the last band has none), the requirement (`none`, `short_form`, `full`), the system template the disclosure is generated from, and a citation. The file is parsed by a Zod schema that checks the bands go up in order and every disclosure band has a form. A change to the bands is a new version. VIC v1 is marked illustrative until a practitioner signs it off (BILL-06a).
- **One pure assessment everywhere.** `assessDisclosure({jurisdiction, estimateHighCents})` in `libs/domain` picks the band; intake, the matter panel, the report and the functions all call it, so they always agree. The estimate it is judged on is the top of the range, else the single estimate, else the fixed fee or cap; pro bono is zero (`disclosureBasisCents`). Without an estimate, or without rules for the jurisdiction, the requirement is unknown and never assumed: the matter still needs a disclosure, and the screens say "Required: estimate needed" or "Rules not configured for NSW".
- **The matter keeps the state.** `matter.costsDisclosure` (server-written) has the status (`required`, `not_required`, `sent`, `update_required`, `updated`, `waived`), the requirement, band and rules version it was assessed on, the estimate it was assessed on (`basisEstimateCents`), since when one has been due (`requiredSince`), the last one sent (date, method, estimate, band) and the generated document, a lawyer's waiver with its reason, and up to 50 history lines. Rules never let a client write it.
- **Intake assesses; a waiver needs a lawyer and a reason.** `matters-createMatter` assesses the new matter's disclosure itself. A `not_required` the estimate doesn't allow is refused. `waived` needs one of the Uniform Law's exceptions (a commercial or government client, a sophisticated client, or another reason with a note) and `matter.fee` (lawyer and above).
- **Generating uses the INT-06 engine.** `costs-generateDisclosure` merges the band's template (the firm's own published replacement first) with the matter and the `disclosure.*` merge fields (form, estimate, citation, and the earlier estimate on an update) through `generateDocument`, filed as correspondence tagged `costs-disclosure`. Nothing is sent from Materia: `costs-markDisclosureSent` records the date and method a person gave it to the client.
- **Significant change is compared with what was disclosed.** When `fees-update` revises the fee, the disclosure is assessed again. Before one is given, the status follows the estimate. Once one is given, it becomes `update_required` when the band moves, or the estimate rises by more than the org's percentage (`org.billing.disclosureChangePct`, default 10) over the estimate disclosed, or an estimate is first given. A fall within the band is never significant. The responsible lawyer gets a high-priority "Send an updated costs disclosure" task and a `costs_disclosure` notification at once, in the same transaction.
- **A reminder after 7 days, once.** `costs-disclosureNightly` (02:00 Melbourne) gives the responsible lawyer a "Send the costs disclosure" task and a notification for each open matter whose disclosure has been `required` for 7 days. The task id is `costs-disclosure-{kind}-{since}`, so a retry or the next night never adds another and a done task is never reopened.
- **Behind a flag.** `billing.costsDisclosure` (server-enforced, default off) gates the panel, the callables, the change detection, the reminders and the report until BILL-06a. Intake's assessment always runs, because it only replaces the placeholder and writes nothing a client sees.
- **No new permission.** Generating, recording and the report use `billing.view`; the waiver uses `matter.fee`. The rules' expression budget can't take another action.

## Consequences

- A practitioner reviews `rules.json`, the two system templates and the wording, then BILL-06a turns the flag on in production. Correcting a threshold is a data change with a new version, and the assessment records which version it used.
- A firm replaces the illustrative templates with its own (INT-06 `replaces`) and they are used from then on.
- Other jurisdictions are added as data. Until then their matters show that no rules are configured.
- Matters from before BILL-06 have only `status` and `estimateCents`. They are read as they are and assessed the first time the fee is revised or the waiver changes; the reminder counts from the day the matter opened.

## Alternatives considered

- **Thresholds in code.** Simpler, but a legal change would be a code change, and nothing would record which rules a matter was assessed under.
- **A permission for the disclosure actions.** The rules can't take another action without passing Firestore's expression limit; the billing and fee permissions already say who may do this.
- **Sending the disclosure by email from Materia.** It needs the email integration (Postmark) and a practitioner-reviewed message. Recording that it was sent covers the obligation now.
