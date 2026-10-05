# ADR-036: The will safe custody register is written only through callables

- **Status:** Accepted
- **Date:** 2026-10-05
- **Ticket:** [CORE-17](https://linear.app/materia-web/issue/MAT-58)

## Context

W&E firms hold original wills, codicils and powers of attorney for decades. Releasing an original without authority is a serious professional risk, so every movement needs who, when, why and on what authority, and the chain of custody must not be editable after the fact. Documents live under matters (`matters/{matterId}/documents/{id}`), not at org level. Release needs a lawyer, and destruction (on the testator's written instruction) needs two lawyers. It's a single-firm app, so the design should stay small.

## Decision

1. **Callables only.** The rules let members read `safeCustody/{id}` and nobody write it. `safeCustody-receive`, `-update`, `-recordMovement`, `-confirmDestruction`, `-verify`, `-receipt` and `-stocktakeReport` are the only writers. `movements[]` is only appended to, inside a transaction that checks the status transition (`MOVEMENT_TRANSITIONS`). The generic audit trigger records each write as well.
2. **Authority is a document reference, not an id.** The ticket's `authorityDocumentId` becomes `authority: {matterId, documentId}`, because documents only exist under a matter. The document must be on a matter the caller can open, live and scanned clean. The UI picks it from the testator's matters (their party rows, plus the packet's will matter). The same shape is used for an item's optional scan (`items[].document`).
3. **Release and destruction gates.** Both need `safeCustody.release` (owner, admin, lawyer) and a sign-in within 5 minutes (`REAUTH_REQUIRED`). The web app asks the person to sign in again (Google or password, then their authenticator code), and once more if the server still refuses. A release also needs a recipient: free text, or a contact (`toContactId`), for example the receiving firm.
4. **Two-person destruction.** `recordMovement` with `destroyed` only sets `pendingDestruction` and notifies the other owners, admins and lawyers. A different lawyer confirms with `confirmDestruction`, which appends the `destroyed` movement with `by` (the requester) and `approvedBy`. Anyone with the role can decline, which includes the requester withdrawing it. While it is pending, no other movement is allowed.
5. **"Current" is a flag.** The latest-dated will (or a later codicil) is marked current in the UI. Nothing is enforced, because revocation is a legal question.
6. **Probate links through the testator.** There is no packet-to-probate field. The packet page offers `/matters/new?type=probate&deceased={contactId}`. The new matter's deceased party row links it back, and the packet page lists the testator's matters. When `dateOfDeath` is first recorded, a separate trigger (`safeCustody-onContactWrite`) notifies each held or out packet's responsible lawyer. The notification says "Original will held: SC-…" with no names, because it may be emailed. The same trigger keeps `testatorName` and `search` in step with renames, and merges re-point packets (CORE-01).
7. **PDFs are export jobs.** The receipt and the stocktake report are FND-24 `pdf.render` jobs with an export target. The new `jobs-getExportUrl` gives only the member who started the job a 5-minute signed link, once the job has succeeded. The receipt leaves out the cabinet and slot.

## Consequences

- A mistaken movement can't be edited away. It's corrected with another movement (for example, `returned` after a wrong `out`), so the history stays honest.
- The web app must leave optional callable fields out rather than send `null`, because the client SDK turns `undefined` into `null` and the inputs are strict.
- CORE-19's "Original held in safe custody" closing item should call `safeCustody-receive` with the will matter's `matterId`, or `safeCustody-update` to link an existing packet (`matterId`). The packets for a matter are the `safeCustody` documents whose `matterId` matches. CORE-17 adds no closing-checklist code.
- The stocktake reads held packets in `locationKey` order (site, cabinet and slot, with numbers zero-padded). `verify` takes at most 200 packets per call; the page batches.

## Alternatives considered

- **Client-direct writes with rules checking the transition.** The rules can't check a document on another path for scan status and access in one write, can't require a recent sign-in, and can't stop a client rewriting `movements[]`.
- **An org-level authority document collection.** It would duplicate CORE-12's upload, scanning and access model for one feature.
- **A `probateMatterId` on the packet.** It duplicates the deceased party link and goes stale when the matter is merged or deleted.
