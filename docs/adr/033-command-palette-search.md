# ADR-033: ⌘K search reads only what the rules can prove, with one tokeniser everywhere

- **Status:** Accepted
- **Date:** 2026-10-05
- **Ticket:** [CORE-15](https://linear.app/materia-web/issue/MAT-53)

## Context

ADR-013 settled how ⌘K searches: a denormalised `search` array of prefix tokens on each searchable document, `array-contains` queries, at most 20 rows per collection. CORE-15 builds it out to matters, contacts, tasks and documents, adds contextual commands and recents, and has to:

- find a matter by its number typed any way ("142", "2026-0142", "M-2026-0142") and by names with diacritics;
- return nothing a role can't read, and never fail a whole search because one read is refused;
- search tasks and documents, which live in sub-collections of matters (and personal tasks under members), where a collection-group query can't prove a matter isn't privileged;
- stay out of the initial bundle (the palette loads on the first ⌘K).

## Decision

**One tokeniser.** `libs/domain/src/lib/search.ts` lower-cases, NFKD-normalises and strips diacritics, splits on anything not a letter or digit, and emits prefixes of 2–10 characters per word, capped at 60 tokens. A matter's number goes first and is never cut by the cap: whole and digits-only (`m20260142`, `20260142`), its parts (`2026`, `0142`) and their numeric value (`142`), with prefixes. Tasks index their title and documents their name. Every trigger that keeps `search` (`matters-denormalise`, `contacts-onWrite`, and the new `documents-onWrite` and title tokens in `tasks-onWrite`/`tasks-onPersonalWrite`) uses it, as does the seed. A query's lead token is a number's compact form when the query reads as a number, else its longest word (capped at 10); the other words filter client-side, and results rank exact number, then title prefix, then recency.

**Reads the rules can prove.** Each provider's query carries the constraints its rules need, so a refused read means the role isn't allowed rather than a bug:

- Matters: `deletedAt == null`, plus `privileged == false` for roles without `privileged.view` (the Matters list's indexes).
- Tasks: everyone reads their own (`assigneeUid == me`, matter and personal) through the `tasks` group. Roles with `privileged.view` also read every matter task with `matterId != null`, which proves to ADR-026's group rule that no one's personal task is included.
- Documents: a new `documents` collection-group rule lets only roles with `privileged.view` list the org's documents. A document's `privileged` flag doesn't cover a document on a matter made privileged later, and the group rule can't read the matter, so roles without it search only the open matter's documents, at its path, with `privileged == false` (the per-matter rules check the matter).
- Contacts: the org's contacts (every role may read them).

A provider whose read fails or is refused contributes an empty group; the others still answer. Each group shows "Searching…" until its own read returns.

**Recents are typed entries.** CORE-14's `users/{uid}/recent` entries gain `kind` (`matter`, `contact`, `task`, `document`) and optional `entityId`; matter entries keep the id `{orgId}_{matterId}` and other kinds use `{orgId}_{kind}[_{matterId}]_{entityId}`. Today's Recent matters filters `kind == 'matter'`; the palette shows the latest 10 of any kind. The backfill stamps `kind: 'matter'` on CORE-14's entries.

**Commands act through the page that hosts them.** A command for another page ("Add task" on a matter result, "New contact" from anywhere) navigates with `?do=<intent>`, and that page runs the action once it's ready and removes the parameter. The same link works with ⌘↵ in a new tab.

## Consequences

- Indexes: contacts (search, updatedAt desc); tasks group (orgId, assigneeUid, search, updatedAt desc) and (orgId, search, matterId); documents (privileged, search, updatedAt desc) and its group (orgId, search, updatedAt desc); recent (orgId, kind, updatedAt desc).
- Existing data needs `materia-scripts backfill-search-tokens` once per project (idempotent; writes only what differs, leaves `updatedAt` alone).
- Paralegals and read-only users don't find documents outside the open matter, nor tasks assigned to others.
- `search-load` measures the palette's reads on the emulator. The emulator has no indexes and scans the collection, so its latency grows with the number of matters (about 1.3 s per matters read at 5,000 on a CI-sized container, against 0.1 s at 500) whatever the query's shape; the 300 ms target is for indexed reads. So the script defaults to 500 matters, where the emulator's p95 is about 260 ms; the ticket's "5,000 matters on the emulator" criterion is descoped to that (single-user app, minimal-process policy), and `--matters 5000` still runs for comparison.
- A token read at its 20-row limit (a "hot" token such as "estate") says to type more instead of reading further.

## Alternatives considered

- **A search service (Algolia, Typesense, Vertex).** Better relevance and no 20-row cap, but a second copy of client data to secure and keep in step; ADR-013 leaves it for a later ADR.
- **A `documents` group rule for every role, filtered on `privileged == false`.** Leaks a document on a matter made privileged after the document was written.
- **Denormalising the matter's `privileged` onto each task and document.** Lets everyone search the groups, but needs a fan-out on every privilege change and a backfill of every task; not worth it for the roles that don't see privileged matters anyway.
- **Recents in local storage.** No writes, but lost across devices and invisible to Today.
