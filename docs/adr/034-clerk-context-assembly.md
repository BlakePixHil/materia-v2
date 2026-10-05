# ADR-034: Clerk context assembly enforces scope and privilege in code

- **Status:** Accepted
- **Date:** 2026-10-05
- **Ticket:** [AI-03](https://linear.app/materia-web/issue/MAT-59)

## Context

Every Clerk feature needs matter context: facts, notes, documents and retrieved excerpts. The Clerk rules say scoping (rule 4), honesty about missing material (rule 5) and privilege (rule 6) are enforced server-side, never by the prompt. Functions read Firestore with the Admin SDK, which bypasses the security rules, so "read with the user's permissions" has to be done in code. Retrieval (AI-04) and the provider's token-counting endpoint aren't built yet, and a matter can hold thousands of documents.

## Decision

We will build every Clerk context with one function, `buildContext` (`apps/functions/src/clerk/context/`), and pass its result to the gateway. It returns the base system prompt, the content blocks, the documents and excerpts, a manifest and the truncation record.

1. **Access in code, re-checked at build time.** The member document is re-read uncached on every build; a suspended or removed member, or one whose current role has lost `clerk.use` or can no longer see the matter, gets `ACCESS_REVOKED`. The matter goes through `can(role, 'matter.view', {privileged})` from the permission matrix, as the rules would. A matter the request's role can't see is `NOT_FOUND` (never revealing a privileged matter). Privileged material needs `privileged.view` in both the request's role and the current one, the least privilege of the two. Ids are document ids (no `/`), and everything is read under the claim's org and the scoped matter, so cross-org and cross-matter ids can't resolve.
2. **No matter-level privilege grant yet.** The rules have none: a privileged matter, note or document needs `privileged.view` (owner, admin, lawyer), so paralegals and read-only members never get privileged material. If a grant is added later (for example LIT-08's `accessRestricted`), it goes into `buildContext`'s privilege check and the rules together.
3. **Privilege is filtered at the query and again in code.** Notes for roles without `privileged.view` are queried with `privileged == false`, chunk search runs with `allowPrivileged: false`, and every note, hit and document is still checked again (a hit whose document is privileged is dropped even if the hit says otherwise). Anything privileged that is included sets `manifest.privileged`, which marks the message and the gateway result.
4. **Retrieval, never a dump.** A matter's documents are never listed. Clerk sees the person's attachments (at most 10, each checked against the matter) and the top 12 retrieval hits, de-duplicated by (document, page). Documents not scanned clean or not ingested are left out and counted.
5. **A ranked budget per feature.** `CONTEXT_POLICIES` sets a token budget and the allowed scopes per feature. The system prompt, matter facts and query are fixed; excerpts (farthest first), then notes (oldest first), then attachments (last first) are dropped until the context fits. What was dropped is recorded (`truncated`) and told to the model in a `<context_notice>`, so the reply can say so (rule 5). Counting goes through a `TokenCounter` port; a character estimate (3.5 characters a token) stands in until the provider adapter exposes the token-counting endpoint.
6. **Cache-friendly layout.** The base system prompt (`system@1.0.0`, with today's date in the org time zone) and the stable matter facts and notes come first, ending in a cache breakpoint; attachments, excerpts, notices and the question follow.
7. **Untrusted framing.** Practice material is wrapped in `<matter_facts>`, `<matter_note>`, `<document>`, `<excerpt>` and `<org_metrics>`; text inside can't open or close those tags (escaped), and JSON escapes `<`. The system prompt says their content is data and that instructions found in it are ignored and reported.
8. **A manifest for audit.** The message stores the manifest (ids, versions, counts, notices, truncation, token use; never text) when it is created, so a failed call still records what Clerk was shown.
9. **Cross-matter reads only through an explicit scope.** `scope: {org: 'metrics'}` gives the newest monthly and financial-year rollups (numbers only) to features whose policy lists `metrics` and roles with `billing.view`. No feature lists it yet; the Insights narrative (INS-04) will.

## Consequences

- Each feature calls `buildContext` and passes `context` to `gateway.run`; no feature reads matter data for Clerk itself.
- Production wires AI-04's `chunkSearch({ db, embedding })` and `chunkDocumentText(db)` (`documents/ingest/`, ADR-036) in `clerk/context/service.ts`. Document text is read back from the version's chunks, so a version not yet ingested counts as still processing.
- The estimate over-counts English prose slightly, so contexts run a little under budget; an exact counter can replace it without other changes.
- Privileged messages are marked but not yet hidden by the rules in shared threads: a shared reader without `privileged.view` could read one. The chat panel (AI-06), which introduces sharing in the UI, must add `visible(orgId, resource.data)` to the message read rule (new messages always store `privileged`).
- Rejected ids are `NOT_FOUND` rather than a new error code, matching the documents and matters callables.

## Alternatives considered

- **Reading through the client SDK as the user**, so the rules apply directly: functions would need the user's ID token and a second SDK per request, and still couldn't express the chunk and budget logic. The matrix in `libs/domain` is the rules' source of truth anyway.
- **Trusting the chunk search's privilege filter:** one bug in AI-04 would leak privileged text to paralegals; filtering again costs nothing.
- **Putting the whole matter in the prompt and letting the model ignore what it shouldn't see:** contrary to rule 4 and impossible for large matters.
- **Truncating every source proportionally:** keeps a little of everything but makes it hard to say what was left out; dropping whole items by rank is simpler to disclose and audit.
