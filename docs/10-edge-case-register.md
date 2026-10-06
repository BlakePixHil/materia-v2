# Edge-case register

This register lists cross-cutting edge cases. When a ticket touches one of these areas, its Edge cases section must cover the relevant rows, and its tests must too. When you find a new edge case, add it here in your PR.

## Identity, tenancy & access

- A user belongs to two orgs and switches between them. Caches, listeners and the Firestore offline cache must not show the previous org's data. Tear down every listener on switch.
- A member is removed while online. Their open listeners get `permission-denied`: show a "You no longer have access" screen, not a crash loop.
- A role is downgraded mid-session. The claims refresh lags, so sensitive rules also check the `members` document.
- An invite is accepted by a different email than the one invited: reject, with a clear message. The invite has expired. The invite was accepted twice, which must be idempotent.
- The last owner tries to leave or demote themselves: block it. There must always be ≥ 1 owner.
- SSO and password accounts share an email: account linking flow. Microsoft personal versus work accounts.
- A user signs in on a new device while MFA is enforced and they have no MFA enrolled: forced enrolment, with recovery codes.

## Dates & time

- `Australia/Melbourne` DST changes on the first Sunday in October and the first Sunday in April. Events at 02:30 on the change day don't exist, or happen twice.
- A user travelling, with a browser timezone other than the org timezone. Legal dates follow the **org** timezone, and the UI shows a hint when the two differ.
- Leap days (29 Feb anniversaries) and month-end clamping.
- Public holidays that differ by state, and **within Victoria by municipality**: Greater Geelong substitutes Geelong Cup Day for Melbourne Cup Day. The firm's calendar and the court's calendar can disagree, so court deadlines use the court calendar. Matters in another jurisdiction use that jurisdiction's calendar.
- Next year's calendar data is missing, which must fail loudly.
- Financial year boundaries (1 Jul to 30 Jun) for budgets, insights and GST periods.
- Timers running over midnight, over DST changes, or left running for days.

## Money & billing

- GST rounding: compute per line, round half-up to the cent, and sum the lines. The invoice total must equal the sum of the lines. Don't re-compute GST on the total.
- GST-free disbursements (some court filing fees) mixed with taxable fees on one invoice.
- A rate change part-way through a matter: entries keep the rate in force on their date.
- Write-downs and write-offs; a negative line only through a credit note.
- An invoice number must stay gapless across concurrent issue attempts, which needs a transaction and a retry.
- A fixed-fee matter with time recorded for productivity tracking: WIP is not billable but is still visible.
- Costs disclosure thresholds and an estimate exceeded: alert at 80% and 100%, and prompt an updated disclosure.

## Matters & W&E domain

- A deceased person with an unknown or approximate date of death.
- A testator who dies while their will matter is open. Convert or link the will matter to a new probate matter, and keep the will in safe custody.
- Several wills or codicils found later: a supersession chain. Informal wills (s 8) are flagged for practitioner attention.
- The same person as an executor and a beneficiary, or the client and a defendant: a conflict-check flag.
- A deceased domiciled interstate or overseas with Victorian assets (reseal).
- An estate with assets passing outside it (super, joint tenancy). These are not distributable, but they are relevant to notional estate.
- Minor or incapacitated beneficiaries, which affects distribution and the parties to a family provision claim.
- A family provision claim made after the window closes, 6 months after the grant (Administration and Probate Act 1958 (Vic) s 99), which needs an extension of time; a claim considered before any grant exists (the window hasn't started).
- Matters merged, split or duplicated by mistake: merge-matter tooling (admin only, audited).
- A matter closed and then reopened, with retention dates recalculated (CORE-19: reopening clears `destroyAfter` and cancels a queued destruction; closing again dates it afresh).

## Documents

- Large PDFs (more than 500 pages) and scanned PDFs with no text layer, which need OCR.
- Password-protected PDFs: detect them, ask the user, and never store the password.
- Office files, `.msg` and `.eml`: convert them for preview, and extract attachments from emails.
- The same file uploaded twice: dedupe by sha256 within a matter, and offer a link instead.
- A document deleted while it is referenced by citations, the chronology or a court book: soft-delete it and show it as a "removed document" reference.
- An upload interrupted by a mobile network drop: resumable upload, retry, and orphan clean-up.
- A malware scan that fails or times out: the file stays quarantined, and the user is told.

## Clerk (AI)

- A model outage or rate limit: degrade gracefully, and every feature keeps a manual path.
- A document containing instructions (prompt injection).
- A citation pointing at a page that changed after the document was re-versioned. Citations pin the document version.
- Very long matters whose context exceeds the budget: truncation is disclosed.
- A suggestion accepted after the underlying data changed: re-validate on accept, and on a conflict show a diff and require a re-accept.
- Duplicate suggestions across runs: dedupe with a `dedupeKey` per kind.
- A user asks for an outcome prediction for a client: refuse, and explain why.
- A paralegal asks about privileged material: refuse, and say so.

## Offline / PWA

- An edit made offline conflicts with an edit made online. Firestore is last-write-wins per field, so critical fields (deadline dates, invoice data) are callable-only and blocked offline.
- A service worker serves a stale app after a deploy: an "Update available" toast, and the app forces a reload when the API version is incompatible.
- iOS Safari: push needs the app installed. MediaRecorder produces audio/mp4, not webm. Storage may be evicted.

## Integrations

- An OAuth token is revoked by the user outside Materia: mark the integration disconnected and notify, without crashing the sync loop. (INT-01: `reconnect_required`, one `integration_error` notification, no retries until reconnected.)
- An OAuth consent link is opened by someone other than the person who started it: refused, and the attempt is left for its owner (INT-01, ADR-051).
- A provider rotates refresh tokens (Xero) while a person reconnects: the refresh only stores its new token if the connection is still the same one (`connectionId`).
- Xero already has an invoice with the number (typed in by hand): reported on the invoice as a conflict and never overwritten. One with the same type, total and reference is an earlier send, and is adopted (BILL-09, ADR-053).
- Two clients share a name in Xero: contacts are matched by a stored link or a unique email, never by name; a new contact whose name is taken gets the client's Materia reference in brackets.
- A payment is recorded in Materia by hand and in Xero: the Xero one is still recorded (once, by Xero's payment id) and marked "Possible duplicate" when the amounts match within 7 days. One that would overpay is listed on the invoice as not recorded, and the owners and admins are told once.
- A payment is deleted in Xero: the payment recorded from it is reversed. Xero refuses to void an invoice with payments, or to allocate a credit note to one already paid there: the reason shows on the document.
- Xero rate-limits (60 calls a minute per organisation): the `xero-push` queue sends one document a second, and a 429 reschedules the task for when Xero says without using a try.
- A calendar event is deleted in Outlook: don't recreate it endlessly. Respect the deletion and flag it.
- Duplicate calendar events from legacy and v2 after migration.
- Microsoft Graph throttling (429 with `Retry-After`).
- An inbound email arrives at a matter address after the matter has closed: hold it in an "unfiled" queue.

## Migration

See the *Legacy migration plan*, Hazards section.
