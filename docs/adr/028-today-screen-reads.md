# ADR-028: The Today screen reads only what is mine, live only where it can't wait

- **Status:** Accepted
- **Date:** 2026-10-05
- **Ticket:** [CORE-14](https://linear.app/materia-web/issue/MAT-50)

## Context

Today (`/today`) is the first screen after sign-in. It gathers the signed-in person's day from several collections: overdue deadlines and proposals waiting on them (CORE-10), what is due this week, their tasks (CORE-08), the matters they opened lately, and a few counts. Escalations (CORE-11) will join Needs attention. The screen has to:

- open fast from a cold start and work offline (ADR-020), without growing the initial bundle;
- not leak rows on matters the person can't read;
- use the org's day boundary, not the device's;
- stay cheap: it is opened many times a day by everyone.

## Decision

We will build Today from the person's own collection-group reads, each scoped to the active org by `groupRepo` and capped at 50 rows (`TODAY_SECTION_LIMIT`), with the merging and ordering as pure functions in `libs/domain/src/lib/today.ts` (`needsAttention`, `dueThisWeek`, `groupDueItems`).

- **Live only for Needs attention.** Overdue deadlines and pending changes keep listeners (two). Everything else (this week's deadlines and tasks, my next tasks, recent matters) is read once and read again when the window regains focus (at most every 10 seconds, online only) and after a task changes on the page.
- **Cached first.** One-shot reads take `cacheFirst`: the engine asks `getDocsFromCache` and shows its rows (when there are any) until the server answers. Offline, the page keeps what it showed and says so.
- **Counts by aggregation.** Open matters, deadlines this week, open tasks, and the org's matters and members for the new-practice checklist use `count()` (cached for 60 seconds), never a list read. They aren't asked for offline.
- **Access by lookup.** Each row's matter is read once with `get`. Rows wait for their matter's answer, and are dropped silently when it is refused, missing or deleted. Personal tasks need no lookup.
- **Recent matters are a per-user collection.** `users/{uid}/recent/{orgId}_{matterId}` (`RecentMatter`) is written by the matter screen whenever a matter opens. The whole entry is written again, so `updatedAt` orders them, and `expireAt` (90 days on) feeds a TTL. Only its user reads or writes it, for their current org.
- **The org's day.** Today is the date in `orgs/{orgId}.timezone`; the page provides `MT_TODAY` from it, so deadline chips and dialogs agree. A device in another time zone gets a hint.

## Consequences

- Two listeners on the page, so it stays cheap to leave open.
- Lists that aren't live can be a little stale until focus or a change on the page. Counts can be a minute old.
- Indexes: the existing assignee indexes on `deadlines`, `deadlineChanges` and `tasks` serve every query. `recent` needs (orgId, updatedAt desc) and a TTL on `expireAt`.
- Escalations plug into `needsAttention` as a third source when CORE-11 lands; `a` already acknowledges the focused one.
- The Stats are drawn with the design system's `.mt-stat` styles in the page, because a `@materia/ui` component first used from a lazy page lands in the initial bundle.

## Alternatives considered

- **Everything live.** Simpler code, but a dozen listeners per open tab, most for lists that change a few times a day.
- **A server-built `today` document per user.** One read, but a fan-out on every task, deadline and matter write, and stale whenever the trigger lags.
- **Recents in local storage.** No writes, but lost across devices and invisible to Clerk and the command palette (CORE-15) later.
- **Filtering by the matter list.** Reading every matter the person can see to filter rows costs more than one `get` per distinct matter on screen.
