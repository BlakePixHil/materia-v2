# ADR-044: The Clerk chat panel writes answers server-side and replays every earlier turn unchanged

- **Status:** Accepted
- **Date:** 2026-10-06
- **Ticket:** [AI-06](https://linear.app/materia-web/issue/MAT-65)
- **Refines:** [ADR-011a: Clerk provider](ADR-011a-clerk-provider.md), [ADR-034: Clerk context assembly](034-clerk-context-assembly.md), [ADR-037: Clerk suggestions engine](037-clerk-suggestions-engine.md), [ADR-043: Citations](043-citations.md)

## Context

⌘J opens Clerk beside any page. On a matter it should answer questions about that matter, with citations, from the matter's own records and documents. It must keep streaming when the person navigates away, show the same stream in a second tab, and never change anything on its own (rule 3). Conversations run to many turns. The Messages API needs earlier assistant turns sent back exactly as they were returned, thinking blocks included, and allows at most four cache breakpoints per request. A thread can also grow past what one request can hold.

## Decision

- **Data.** `orgs/{orgId}/clerkThreads/{threadId}` and its `messages`:
  - A thread has `title`, `ownerUid`, `matterId`, `shared`, `privileged`, `lastMessageAt` and `continuedFrom?`.
  - A thread is private to its owner until they turn on "Share with matter team" (`shared`). The owner may change only `title` and `shared`.
  - A message adds `privileged` (always stored, so the rules can test it), `replyTo`, `attachments`, `suggestionIds`, `feedback` and `error {code, switch?}` to the AI-02 fields. Only `stopRequested` is client-writable, and only by the thread's owner.
  - A privileged thread or message needs `privileged.view`, even when shared. Lists by other roles must filter `privileged == false`.
- **Callables return at once; Cloud Tasks write the answer.**
  - `clerk-sendMessage({threadId?, matterId, text, attachments?, requestId})` checks the kill switches, the key and the budget first, so the Composer can say why at once. It then creates the thread (for a first question), the question and a `streaming` answer, and queues `clerk-runMessage`.
  - `clerk-runMessage` runs `buildContext`, then the gateway in stream mode into that message (`stream.adopt`).
  - A task (not a Firestore trigger) gives one run per answer: a `dedupeKey` per message, and a redelivery finds the answer finished. A second attempt after a lost instance ends the answer as `error` rather than calling the model twice.
  - One answer runs per thread at a time (`CONFLICT`).
- **Retry adds; it never edits.** `clerk-retryMessage` adds a new answer to the same question (`replyTo`) after the old one. Only the newest answer can be retried.
- **Feedback.** `clerk-setFeedback` stores `{rating, reason?, comment?, by, at}` on the answer. It counts `feature.chat.feedback_up` and `feature.chat.feedback_down` in the monthly Clerk metrics; changing one's mind moves the count.
- **History is replayed byte for byte, never trimmed.**
  - Each answer stores its whole exchange in the server-only `private/raw.exchangeJson`: the user turn, the assistant turns, tool results and the sources.
  - A later question sends, for each earlier question, its newest finished answer's exchange unchanged, then the new question.
  - Cache markers are stripped from stored user turns, so the request's only breakpoint is on the current question's facts.
  - Exchanges that can't be replayed are left out whole: unfinished answers, answers stored before AI-06, answers from another model (thinking is bound to it), and exchanges that end in a tool call.
  - Sources from earlier exchanges come first, so the API's document and search-result numbering stays stable for citations.
- **Continuing a long thread.** When the newest answer used 150k tokens or more (everything sent plus the reply), the next question starts a new thread with `continuedFrom`. That thread's first answer gets a summary of the earlier thread (`chat-summary@1.0.0`, wrapped as an untrusted `<matter_note kind="conversation_summary">`). The earlier thread stays as it was.
- **Read-only tools, chosen by the model, at most six rounds.**
  - The tools are `search_documents(query)`, `get_deadlines(status?)`, `get_tasks(status?)`, `get_parties()`, `get_time_summary(from?, to?)` and `get_document_text(documentId, pages)`. They are offered and never forced, as the API requires with thinking.
  - Each reads only the scoped matter, with `buildContext`'s privilege rules checked again in code. Amounts in the time summary need `billing.view`.
  - Results are wrapped as untrusted (`<matter_facts tool=…>`, `<excerpt>`). Passages are `search_result` blocks, so they can be cited.
  - After six rounds, each further call is answered "Tool limit reached", and the model gets one last turn.
  - After a tool round the model is fixed: no fallback mid-answer.
  - `toolCalls` on the message shows each tool while it runs ("Searching documents…").
  - What the tools showed is merged into the message's manifest (ids only). A privileged passage marks the answer and its thread privileged as soon as it is read (rule 6).
- **Proposals are a separate structured step.** After a finished answer, `chat-proposals@1.0.0` (structured output, so no citations API) proposes up to five tasks, deadlines, events, notes or key facts.
  - A proposal's citations are kept only for documents the context or the tools showed, at the version read.
  - `proposeSuggestions` creates them, and the answer links them in `suggestionIds`.
  - The step is off with `clerk.features.suggestions`, and its failure never fails the answer.
- **Follow-on calls take no rate slot.** `chatProposals` and `chatSummary` are `background` features. They are metered and budgeted, but don't use the person's per-user window, so one question costs one slot.
- **The panel is a lazy chunk.** The shell defers `mt-clerk-chat` until ⌘J first opens the panel. The panel:
  - lists the person's threads and the shared ones per matter;
  - shows the scope chip ("Asking about M-2026-0142 · 3 attachments") and the `/` commands;
  - streams answers from Firestore listeners, offers Stop, Retry, Copy and Helpful / Not helpful with a reason;
  - shows proposed suggestions as `mt-suggestion-card`s;
  - opens citations in `mt-citation-viewer`. `CitationSources` now takes a `CitationScope` (the matter screen, or the panel's scope) rather than `MatterScreen`.
- **Commands.** `/summarise` is built. `/chronology` (LIT-06), `/draft` (AI-10) and `/timeline` (INS) are listed, dimmed and "coming soon", and can't be picked.
- **Unavailable says why.** When Clerk is off, has no usable key, is over budget or is rate limited, the Composer shows the reason and the manual path (the matter's Documents, Deadlines and Tasks tabs). A refusal is shown as written, with a note.

## Consequences

- Prompts `chat@1.0.0`, `chat-proposals@1.0.0` and `chat-summary@1.0.0` are new. The evals (AI-12) still exercise `chat-answer@0.1.0`; moving them to `chat@1.0.0` is a follow-up.
- Phones don't get the panel yet (the shell hides it under 768px); MOB tickets bring Clerk to mobile.
- Per-org Clerk feature toggles (`ORG_CLERK_FEATURES`, PR #132) aren't in this tree. The panel follows `clerk.enabled`, `clerk.features.chat` and the org's own `settings.clerk.enabled`; wiring the org toggle in is a follow-up.
- Suggestions proposed from chat are not citation-verified yet (as for AI-07; see ADR-043).
- The staging smoke test against the real model is pending, for a person to run.

## Amendment: drafting from a direct request (AI-06b, 2026-10-06)

Blake asked to tell Clerk "add a file note to X saying Y". `chat@1.0.0` told Clerk it couldn't change anything, so it refused, and the proposals step only sometimes proposed the note.

- `chat@1.1.0` adds two tools, `draft_note` and `draft_task`, offered only with `clerk.features.suggestions`. Each creates one AI-07 suggestion straight away (`proposeSuggestions`) and returns what became of it (drafted, already drafted, already on the matter, suggestions off, matter closed). So Clerk's "drafted, confirm it below" is never a guess.
- Clerk rule 3 still holds: the tools write suggestions, never records. The person accepts the card under the answer, as for any suggestion.
- The `dedupeKey` is scoped to the question (`ask:{questionId}:{defaultDedupeKey}`): Retry finds the existing draft, while asking again in a new question can re-draft a note the person dismissed.
- A draft is privileged when the context, the thread or a tool result before it was (rule 6).
- An answer that drafted links its drafts and skips `chat-proposals`, which would only duplicate them.
- Only notes and tasks. Deadlines, events, key facts and time still come from the proposals step. Requests about another matter are declined with "open Clerk on that matter".
- Evals: the chat, privilege and injection suites run `chat@1.1.0`; `draftAccuracy` and `draftHonesty` grade drafts, and drafts count as output for the leak and injection graders (inj-016: an injected "draft a note" must draft nothing).

**Alternative considered:** a stronger `chat-proposals` prompt for direct requests. This lost because it runs after the answer is written, so the answer can't truthfully say whether anything was drafted.

## Alternatives considered

- **A Firestore trigger on the new message.** This lost because an onCreate trigger can fire twice for one event, and per-trigger idempotency (PR #136) isn't in this tree. A task with a dedupe key per answer is simpler and can be retried.
- **Stream through the callable's response.** This lost because navigating away or a second tab would lose the stream, and the panel already listens to Firestore.
- **Trim or summarise old turns in place.** This lost because it breaks the byte-identical replay that thinking needs, and it silently changes what Clerk was told. Continuing in a new thread is visible and keeps the old one intact.
- **Proposals in the same call as the answer (structured output).** This lost because structured output disables the citations API, and the answer's citations matter more.
