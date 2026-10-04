# data-access

The web app's data layer (FND-19): typed repositories over Firestore, signal query resources with cursor paging, the callable client, listener lifecycle, optimistic updates and `can()`. Features use this library instead of `firebase/firestore` (AGENTS.md: `apps/web` may not import the SDK).

Two entry points:

| Import                            | What                                                                                                                                                  | Where it can go                                   |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `@materia/data-access`            | `OrgContext`, `ListenerRegistry`, `FirestoreClient`, `CallableClient`, `DataLifecycle`, `optimistic`, `can`, `toDomainError`, tenancy and job sources | Anywhere, including `main` (it's small)           |
| `@materia/data-access/repository` | `repo()`, `groupRepo()`, the query resources, the Firestore driver, `membersRepository()`, the contacts repositories, the in-memory test driver       | Lazily loaded features only, to keep `main` small |

The Firestore SDK itself loads on the first query, as two lazy chunks (ADR-024), never on the sign-in screens.

## A repository

```ts
import { Matter } from '@materia/domain';
import { repo } from '@materia/data-access/repository';

// In an injection context (a component field, a service constructor).
const matters = repo((orgId) => `orgs/${orgId}/matters`, Matter);
```

`repo(path, entity, { mode, upgrades })` takes the org-scoped path and a `libs/domain` entity (`withMeta(...)`, or `{ schema, version }`). Reads go through the domain converter: invalid documents throw in dev and tests and are flagged in production. Writes validate against the entity's `create` / `update` schemas and stamp the meta fields the rules check (`createdBy`, `updatedAt: serverTimestamp()`, `schemaVersion` on create). Every error comes out as a `DomainError`.

| Method                           | Does                                                            |
| -------------------------------- | --------------------------------------------------------------- |
| `get(id)` / `query(spec)`        | One read (`WithId<T>`, `null` when missing)                     |
| `watch(id)`                      | A live `DocResource` (`value`, `status`, `exists`, `fromCache`) |
| `watchQuery(spec, { live })`     | A live, paged `QueryResource` (below); `live: false` reads once |
| `count(spec)`                    | `getCountFromServer`, cached 60 s per path and spec             |
| `create`, `update`, `softDelete` | Validated writes; soft delete sets `deletedAt` / `deletedBy`    |
| `hardDelete(id)`                 | Removes the document, where the rules allow it (saved views)    |

`update(id, patch, { remove: ['dateOfDeath'] })` also deletes fields (`deleteField()`), for clearing an optional value; removed fields must be in the update whitelist too.

Queries hide soft-deleted documents unless `includeDeleted: true`. A query with `where` plus `orderBy` on another field needs a composite index in `firebase/firestore.indexes.json`.

## Collection groups

`groupRepo('parties', entity)` reads one collection id across every matter: `query`, `watchQuery` and `count` only (writes stay with the owning collection's repository). Every query gets `orgId == <active org>` added, so the group's documents must carry a server-owned `orgId`, and the query needs a collection-group index or field override in `firebase/firestore.indexes.json`. Ties sort by full document path, as in Firestore. `contactPartiesRepository()` (a contact's roles on matters, CORE-01) is the first user; the in-memory driver supports groups too (`fs.driver('parties', { group: true })`).

## Contacts (CORE-01)

`contactsRepository()` lists `orgs/{orgId}/contacts` with `contactListQuery(filters)` (ordered by the server-maintained `sortName`; one Firestore filter: the search token, kind, referrer or tag) and `contactMatchesFilters(row, filters)` for the rest (and to hide merged tombstones). Edits are client-direct through `Contact.update`; creates, deletes and merges go through the `contacts-*` callables. `matterSummariesRepository()` reads a matter's number and title.

## Matters and saved views (CORE-03)

`mattersRepository()` reads `orgs/{orgId}/matters` as `MatterListItem` and edits the whitelisted fields client-direct (`Matter.update`: title, responsible, team, labels, priority, stage, external reference, estate). Number and status change only through the callables in `MATTER_CALLABLES` (`matters-createMatter`, `matters-changeStatus`, `matters-restore`), called through `CALLABLES` like any other.

`matterQueryPlan(filters, sort, { viewerUid, privilegedVisible })` is the one place that decides how a list view reads, against the domain's `MATTER_INDEXED_QUERIES` (the composite indexes in `firebase/firestore.indexes.json`). Every query reads live matters (`deletedAt == null`), plus `privileged == false` for roles without `privileged.view`, as the rules require. A combination Firestore can serve is `paged` (50 rows a page, cursor paging); anything else is `capped`: the largest indexed subset of the filters, most recently active first, at most 500 rows, with the rest filtered and sorted in the browser and a `notice` to show. `matterMatchesFilters(row, filters, { today, now })` applies every filter to loaded rows (overdue, recently closed and multi-word searches always run there).

`savedViewsRepository()` is the signed-in person's `users/{uid}/views` (`SavedView`), listed per org with `SAVED_MATTER_VIEWS_QUERY(orgId)`; views are created, renamed and removed (`hardDelete`) client-direct.

## Conflict checks (CORE-02)

`matterConflictsRepository()` reads a matter for its check (`MatterConflict`: number, title, status, the client, deceased and testator contact ids, `conflictCheck` and the server's optional `conflictAlert`); it has no writes. Checks run and determinations are recorded through the callables in `CONFLICT_CALLABLES` (`conflicts-run`, `conflicts-determine`), called through `CALLABLES`. `matters-changeStatus` refuses `lead → open` with `FAILED_PRECONDITION` and `details.reason: 'conflict_check_not_clear'` until the determination is `clear` or `potential`.

## Lists: watchQuery and paging

```ts
readonly members = membersRepository().watchQuery(MEMBER_LIST_QUERY);
// or reactive: watchQuery(() => (this.filter() ? { where: [['role', '==', this.filter()]] } : null))
```

```html
@switch (members.status()) { @case ('loading') { <mt-skeleton /> } @case ('error') {
<p>{{ errorCopy(members.error()) }}</p>
<button (click)="members.refresh()">Try again</button> } @default { @if (members.status() === 'offline') {
<p>Showing saved data while you're offline.</p>
} @for (m of members.value(); track m.id) { … } @empty {
<p>No members yet.</p>
} @if (members.newItems() > 0) { <button (click)="members.refresh()">{{ members.newItems() }} new</button> } @if
(members.hasMore()) { <button (click)="members.loadMore()" [disabled]="members.loadingMore()">Show more</button> } } }
```

- `status` is `loading`, `ready`, `error` or `offline` (rows came from the cache and the browser is offline). `fromCache` is the raw flag.
- Pages are cursor based (`startAfter` the last row, `pageSize` + 1 to know `hasMore`). Every loaded page stays live. Once there's a second page, rows that would sort above the first page don't jump in; they're counted in `newItems` and `refresh()` reloads from the top.
- The listener lives as long as the calling injector (pass `{ injector }` to choose another), is tracked by the `ListenerRegistry`, and stops on an org switch or sign-out.
- A read the rules refuse (removed or suspended member) becomes `ACCESS_REVOKED`; the app's `ACCESS_REVOKED_HANDLER` routes to the no-access page.

`apps/web/src/app/pages/orgs/team.ts` is the worked example: loading, empty, error and offline states, the new-members pill and "Show more".

## Callables

```ts
const callables = inject(CALLABLES); // apps/web/src/app/core/data/callables.ts
await callables.call('orgs-inviteMember', { email, role }, { idempotent: true });

// Or as an action with pending/error signals for a button:
readonly invite = callables.action<InviteInput, InviteResult>('orgs-inviteMember');
// (click)="invite.run(form.value)"  [disabled]="invite.pending()"  {{ invite.error() }}
```

- Idempotent calls carry a `requestId`; retries of the same logical action reuse it, so the server's idempotency record (FND-15) runs the write once. An `action` keeps its `requestId` until a call succeeds, so a person clicking "Try again" retries the same request.
- `ORG_CLAIM_MISMATCH` refreshes the ID token once and retries.
- `UNAVAILABLE` and `REQUEST_IN_PROGRESS` retry with backoff (250 ms, 1 s, 3 s), idempotent calls only.

## Optimistic updates

Repository writes don't need help: listeners show local writes immediately. For state behind a callable:

```ts
await optimistic(
  this.items,
  (items) => items.filter((i) => i.id !== id),
  () => archive.run({ id }),
);
```

On failure the store rolls back and the error is rethrown as a `DomainError`.

## Permissions

```ts
readonly canManage = can('members.manage'); // Signal<boolean>, from OrgContext's role
```

```html
@if (canManage()) { <button>Invite</button> }
```

The rules are still the authority; `can()` only hides what the person can't do.

## Lifecycle

- `OrgContext.setSession({ uid, orgId, role })` is driven by the auth session (`OrgService`). A new uid or org stops every listener (`ListenerRegistry.stopAll()`) and bumps `generation`; a role change alone doesn't.
- `DataLifecycle.orgSwitch()` runs before an org switch; `DataLifecycle.signOut()` runs on sign-out: listeners stop, the session clears, Firestore terminates and its IndexedDB cache is deleted. A sign-out in another tab runs the same clean-up (`SessionWatcher`).
- `hasUnsyncedChanges()` / `waitForSync()` back the "You have unsynced changes" prompt on sign-out.
- On a shared computer (session-only sign-in) Firestore uses a memory cache, so nothing is written to IndexedDB.
- Custom listeners: `inject(ListenerRegistry).add(unsubscribe, { destroyRef, label })`.

## Testing

Feature tests use the in-memory driver instead of the emulator:

```ts
const fs = new InMemoryFirestore();
fs.set('orgs/org-1/members/u1', { displayName: 'Alex Fictional', status: 'active', … });
TestBed.configureTestingModule({ providers: [provideInMemoryFirestore(fs)] });
fs.failNext({ code: 'permission-denied' }); fs.setOffline(true); fs.listenerCount; // and so on
```

| Command                                    | Runs                                                                         |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| `pnpm nx test data-access`                 | Unit tests (in-memory driver, fake transports)                               |
| `pnpm nx run data-access:test-integration` | Emulator tests: repositories, paging, rules, org switch, sign-out (`tests/`) |

## Deviations from the ticket

- `schemaVersion` is stamped on create only; updates keep the version the document was written with, and the converter's `upgrades` bring old documents forward on read.
- The query resources are small signal classes rather than Angular's `resource()`, which has no way to stream snapshots or append pages.
