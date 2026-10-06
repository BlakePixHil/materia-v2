# ADR-049: Key fact citations live beside the matter and stand for one value

- **Status:** Accepted
- **Date:** 2026-10-06
- **Ticket:** [CORE-06a](https://linear.app/materia-web/issue/MAT-156)
- **Refines:** [ADR-037: Clerk suggestions engine](037-clerk-suggestions-engine.md), [ADR-043: Citations](043-citations.md)

## Context

CORE-06 left a hook for showing where Clerk found a key fact's value, and AI-07 accepted `key_fact` suggestions without keeping their citations. A lawyer looking at "Will date 3 May 2019" on the Overview can't tell whether a person typed it or Clerk read it from the will, or check the passage.

Two things make the obvious place, the matter document, wrong:

- Readonly roles read the matter. A citation's quote can come from a privileged document, and privileged material must never reach a role without `privileged.view`.
- A citation supports one value. Once a person changes the fact, the old sources say nothing about the new value, and leaving them on screen would misrepresent it.

## Decision

- **Where:** accepting a `key_fact` suggestion writes `orgs/{orgId}/matters/{matterId}/factCitations/{factId}` (`FactCitation`, libs/domain): `factId`, `value` (as the matter stores it), `citations[]` (the `Citation` shape, 1–20), `suggestionId` and `privileged`. One record per fact; a later accept replaces it.
- **Same transaction:** the key-fact handler wraps the accept's `TxJoin`, so the fact (or its event, for the date of death and the grant date), the record and the suggestion's resolution commit together. The wrapper re-reads the cited documents with the other reads.
- **Privileged:** the record is privileged when the suggestion is or a cited document is at accept time. The rules let a role read it only when it may see both the record and its matter, so a list without `privileged.view` must filter on `privileged == false`.
- **Bound to its value:** readers show the citations only while `keyFactValue(matter, factId) === record.value` (`keyFactCitations`). The chips disappear the moment a person's edit lands, with no client write to the record. `matters-denormalise` then deletes records whose fact changed (`clearStaleFactCitations`). It does this in a transaction against the current matter, so out-of-order events never delete a record that still holds.
- **Only for Clerk's value:** a person who edits the value before accepting keeps no citation, because the sources may not say what they wrote. A suggestion with no citations keeps none either.
- **Server-only writes:** clients never create, change or delete records. Archived matters are refused by the accept, and destroying a matter deletes the subcollection with the rest (CORE-19).
- **UI:** the Key facts card shows one chip per verified source. The chip opens the Overview's citation viewer, which is now shared with "Clerk suggests…", at the cited page with the quote highlighted.

## Consequences

- Provenance survives the suggestion's own life (expiry, dismissal of later ones) because the citations are copied, not referenced.
- The Overview has one more listener (the matter's `factCitations`, a handful of documents).
- A fact edited back to the cited value shows its sources again if the trigger hasn't deleted the record yet. That is still true provenance for that value.
- Other accepted kinds (tasks, notes, events) don't keep citations yet. If they need to, they can follow the same pattern.

## Alternatives considered

- **A `factCitations` map on the matter:** leaks privileged quotes to readonly roles, and clearing it on edit would need the client to write a server-owned field.
- **A pointer to the suggestion (`suggestionId` only):** no quote on the matter, but the source then depends on the suggestion being kept.
- **Clearing on the client when a person saves:** a second, non-atomic write that misses edits made elsewhere (events, other suggestions, migration). The value binding plus the trigger covers every path.
