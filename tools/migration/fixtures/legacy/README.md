# Synthetic legacy fixtures

A tiny fictional legacy materia database for the migration tests (MIG-01; reused by MIG-02 and
MIG-03). Each `*.json` file is a list of `{ path, data }` documents as the REST reader decodes them
(`storage-objects.json` lists Storage objects). Values JSON can't hold are tagged:
`{ "$timestamp": "…" }`. Everything here is invented. Load it with `loadLegacyFixtures()` from
`src/legacy/fixtures.ts`.

**Users.** Alex Rivers (`AlexRiversLegacyUid000000001`) is the user being migrated. Jordan Ellis
is a colleague on two boards (their profile has no `displayName`, only first and last names). A
departed user is mentioned in a comment but has no profile. An unrelated user owns a board and a
referrer Alex can't see.

**Workflows.**

| Board                | Alex's role                      | What it covers                                                         |
| -------------------- | -------------------------------- | ---------------------------------------------------------------------- |
| Wills & powers       | owner (and legacy `owner` field) | labels, duplicate `uids`, a shared member, most card hazards           |
| Estates              | admin                            | no `labels` field, folio fee, a 26 MB attachment, orphans              |
| Business development | owner                            | a non-matter board (personal tasks)                                    |
| Shared board         | readWrite only                   | a shared board Alex doesn't own (excluded by default)                  |
| Someone else's board | not a member                     | must never be read into the snapshot, except a linked card's existence |

**Hazards exercised.** `assignee` as `''`, `null`, Alex and Jordan; `matterReference` as `null`,
`''`, a value and the same value in another case; an empty title and one needing a trim; a card in
a swimlane that no longer exists; an unknown label id; quill HTML with mentions, an inline base64
image, a remote tracking image, a link and a `<script>`; Quill's empty `<p><br></p>`; checklist
due dates at Melbourne midnight stored as UTC (`2025-03-13T13:00:00.000Z` is 14 March in
Melbourne) and at UTC midnight; `calendarSyncByUser` and the legacy single `calendarSync`;
`templateExists` persisted on a card checklist; fee types `fixed`, `hourly` (with cents),
`nowin`, `folio`, `''` and `value: 0`; legacy `fee.realisedFees`, `fee.hasDisbursements` and
`fee.disbursements`; `billable` pending and billed; a referrer id that names no referrer;
`linkedCardIds` to a migrated card, a card on the shared board, a card on someone else's board, a
deleted card and the bare-id legacy form; a `createdOn` that isn't a date, an `updatedOn` that is a
Firestore Timestamp, and one updated before it was created; an archived card; a set `dueDate`,
`hoursEstimate` and `actualHours`; attachments of PDF, JPEG, SVG (not on the v2 allow-list),
an untyped `.msg` whose size differs from its object, a missing Storage object, a Storage object
with no document, a workflow-level object, and one over 25 MB; a checklist template whose `id`
field differs from its document id; referrers as a person, an organisation-only company and one
with neither, with free-text industries and Australian phone formats; a profile with FY budgets
and a photo; two calendar integrations; a prime and a non-prime workspace.
