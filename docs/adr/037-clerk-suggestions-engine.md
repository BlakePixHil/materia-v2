# ADR-037: Clerk suggestions are applied through the domain logic, checked against a basis

- **Status:** Accepted
- **Date:** 2026-10-05
- **Ticket:** [AI-07](https://linear.app/materia-web/issue/MAT-68)

## Context

Clerk proposes and a person accepts (Clerk rule 4). Several Clerk features (the matter brief, document ingest, deadline extraction, the chat panel) will propose the same kinds of change: a task, a deadline, a matter event, a party, a key fact, a note or a document's details. Each of those already has a callable with its own validation, permission check, transaction, side effects (deadline recompute, task counters, mentions) and audit. A suggestion can sit for days, and by the time someone accepts it the matter or a cited document may have changed, become privileged or been closed. Two people can accept the same suggestion at once. The ticket also asks for acceptance rates per kind and per prompt version, and for the suggestion card to be reusable without growing the initial bundle (about 297 kB of the 300 kB budget).

## Decision

1. **One stored shape.** We extend the existing `Suggestion` entity (`libs/domain/src/lib/schemas/clerk.ts`, `orgs/{orgId}/matters/{matterId}/suggestions/{id}`) rather than adding a second one. `kind` plus `payload` is a discriminated union with one proposal schema per kind (`SUGGESTION_PAYLOADS`). These are deliberately narrower than the domain create schemas (for example a task proposal has no assignee checks, order or source), because the server fills those in. The server-owned fields are `status` (`proposed | accepted | edited | dismissed | expired | stale`), `promptId`, `promptVersion`, `model`, `basis` and `basisParts`, `dedupeKey`, `expiresAt`, `privileged`, `resolvedBy`, `resolvedAt`, `resultRef`, `appliedPayload`, `dismissReason` and `staleReview`.
2. **A handler registry, applied through the domain cores.** `apps/functions/src/suggestions/registry.ts` maps a kind to a handler with `apply` and an optional `exists` (a matching domain record already exists). The built-in handlers (`handlers.ts`) cover task, deadline, event, key_fact, note, party and document_meta. Each calls the same core function its callable uses: `createNote`, `upsertPartyChange`, `recordEvent` (and so `recomputeMatter`), or the task, deadline and key-fact writes with the domain schemas. The litigation kinds (chronology, order, evidence) and time_entry have no handler and are refused with `SUGGESTION_UNSUPPORTED` ("not available yet"). A later ticket enables one by registering a handler; nothing else changes.
3. **The suggestion check runs inside the domain write's transaction (`TxJoin`).** The cores of notes, parties and deadline recompute take an optional `TxJoin { read(tx), write(tx, resultRef) }`. `read` runs after the core's own reads and before its writes. It re-reads the suggestion (still open), the matter (not closed), and the basis and privilege of the stored payload. `write` marks the suggestion `accepted` or `edited` with `resultRef` in the same transaction. A concurrent accept therefore retries, finds the suggestion resolved and gets `ALREADY_RESOLVED`, so exactly one applies.
4. **Basis.** `suggestionBasisParts` (pure, in the domain lib) lists what a suggestion depends on:
   - the matter's status, stage, privilege and deletion;
   - for each kind, the key fact's value, the live events of the event's kind, the party row, or the target document's title and category;
   - for each cited document, its version, privilege and deletion.

   Each part is hashed (cyrb53 over a stable JSON). `basis` is the hash of the part hashes, and `basisParts` keeps the part hashes so a change can be explained. On accept, a different basis marks the suggestion `stale` with `staleReview {basis, changed, at}` and returns `SUGGESTION_STALE` with the changed parts' labels. Accepting again with `expectedBasis` set to the new basis applies it as it stands. The basis is computed from the stored payload, not the edited one, because an edit changes the proposal, not its sources.
5. **Privilege.** A suggestion is `privileged` when the proposing feature says so (AI-03's `manifest.privileged`), when the matter is privileged, or when a cited or targeted document is privileged. It is re-checked when proposing and when accepting. The rules let only roles with `privileged.view` read a privileged suggestion (`visible(orgId, resource.data)`), and the client queries with `privileged == false` for other roles. If a cited document becomes privileged later, the basis changes. The accept marks the suggestion stale and privileged, and a person without `privileged.view` gets `NOT_FOUND` (it is hidden, never described).
6. **Permissions.** `SUGGESTION_KIND_ACTION` maps each kind to the permission its callable needs:
   - task and deadline need `task.edit`;
   - event, party and key_fact need `matter.edit`;
   - note needs `note.write`;
   - document_meta needs `document.upload`.

   Accepting needs `clerk.use` plus that action (`canAcceptSuggestion`). The callables check it, and the UI hides the buttons. Read-only members can't accept anything.
7. **Writes are callable-only.** `suggestions-accept`, `suggestions-acceptMany` (up to 25 ids, with a result per item) and `suggestions-dismiss` are idempotent and gated by `clerk.features.suggestions`. The rules allow no client writes to suggestions. Dismiss used to be a client update, but it moved to a callable so it is audited and counted.
8. **Proposing and dedupe.** Features call `proposeSuggestions(ctx, matterId, proposals, {privileged, promptId, promptVersion, model, ttlDays?})` from server code. In one transaction it:
   - checks the matter;
   - skips a proposal whose `dedupeKey` matches a `proposed`, `stale` or **dismissed** suggestion (a dismissed idea isn't proposed again) or an earlier proposal in the same call;
   - asks the handler's `exists`;
   - computes the basis and privilege;
   - sets `expiresAt` (14 days by default).

   While the flag is off, it proposes nothing (`disabled`).
9. **Expiry.** `suggestions-expire` runs hourly. A collection-group query (`status in [proposed, stale]`, `expiresAt <= now`, with a composite index) finds suggestions past their time, and each one gets its own transaction that marks it `expired` with `resolvedBy: 'system'`. The UI also hides a suggestion past `expiresAt` before the sweep reaches it, and shows expired ones only under "Show expired".
10. **Audit and metrics.** An accept writes `suggestion.accepted` and a dismiss writes `suggestion.dismissed`. The actor is the human, and `data.via` is `'clerk'`, with the kind, suggestion id, `resultRef` and prompt version. The domain write's own audit (for example `task.created`) is unchanged. Outcomes increment counters in the org's monthly Clerk metrics doc (`metrics/clerk-{YYYY-MM}`, the AI-02 metering doc), under `values["suggestions.{outcome}"]`, `suggestions.kind.{kind}.{outcome}` and `suggestions.prompt.{id}@{version}.{outcome}`. `suggestionAcceptanceRates` turns those counters into rates (accepted plus edited, over resolved). The counting is best effort and never fails the accept.
11. **UI.** `MtSuggestion` moves out of the `@materia/ui` barrel into the secondary entry point `@materia/ui/suggestion` and gains the `canAccept` and `canDismiss` inputs. The web app's `mt-suggestion-card` (`features/suggestions`) adds:
    - the inline editor, validated by the kind's payload schema, which shows the server's field errors on the fields;
    - dismissing with a reason;
    - the stale review ("Accept anyway").

    The Overview's "Clerk suggests…" section groups suggestions by kind and offers "Accept all N …". It is loaded with `@defer (on idle)` only when the flag is on and the role may use Clerk.

## Consequences

- A new kind is a payload schema, a label, a `SUGGESTION_KIND_ACTION` entry, basis sources if it has any, and a handler. Until it has a handler it's refused, never half-applied.
- The notes, parties and recompute cores carry an optional `join`. Their callables pass none and behave as before. Any core added later for a handler needs the same two hooks.
- An accept is one transaction, so a handler can't call another callable or make a slow external call before writing.
- Stale detection covers the listed sources only. A change elsewhere (for example a new task with the same title) isn't detected at accept time, although `exists` catches it when proposing.
- Dismissed suggestions block the same `dedupeKey` for good. A feature that wants to re-propose after real change should put the changed input in its `dedupeKey`.
- The metrics doc's `values` map grows by kind and prompt version. Old prompt versions stay in old months.
- The Clerk panel and Inbox (AI-06 and later) reuse `mt-suggestion-card` and the same callables.

## Alternatives considered

- **Calling the existing callables from the accept (or from the client):** this gives no single transaction with the suggestion's status, so two accepts could both apply and a stale suggestion could still be written. It also needs a second permission and audit path.
- **Optimistic concurrency only on the suggestion (`updatedAt` precondition):** this stops double accepts, but a crash between the domain write and the status update would leave a record with an open suggestion. Doing both in one transaction avoids that.
- **Storing a full snapshot of the sources instead of hashes:** this gives a richer diff, but it copies practice data (possibly privileged) into the suggestion. Hashing per part is enough to say what changed.
- **A separate `suggestionMetrics` collection:** this would be a second metering path. The AI-02 monthly doc already holds Clerk counters, and the rules already restrict it to billing roles.
- **Client-side dismiss (the previous rule):** it can't be audited or counted, and it lets any member write status fields.
