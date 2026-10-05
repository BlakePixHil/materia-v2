import { inject, Injector, runInInjectionContext } from '@angular/core';
import * as z from 'zod';

import {
  Contact,
  contactDisplayName,
  Matter,
  MatterDocument,
  matchesSearch,
  rankSearchHits,
  SEARCH_RESULT_LIMIT,
  SoftDeleteShape,
  Task,
  type RecentRef,
  type SearchQuery,
} from '@materia/domain';

import { OrgContext } from './org-context';
import type { QuerySpec } from './query';
import { groupRepo, repo, type GroupRepository, type Repository } from './repository';

/*
 * ⌘K search (CORE-15, ADR-013, ADR-033): each provider reads at most `SEARCH_RESULT_LIMIT` rows
 * whose `search` holds the query's token (`array-contains`), most recent first, then keeps the rows
 * matching every word typed and ranks them (exact number, title prefix, recency). The queries
 * prove what the rules need: `privileged == false` for roles without privileged.view, the caller's
 * own tasks (or `matterId != null` for roles that see every matter), and documents through the
 * group only with privileged.view. The indexes are in firebase/firestore.indexes.json.
 */

const matter = Matter.schema.shape;
const contact = Contact.schema.shape;
const task = Task.schema.shape;
const document = MatterDocument.schema.shape;

/** A matter as the palette shows it: number, title and type (`status` for the meta line). */
export const MatterSearchItemSchema = /* @__PURE__ */ z.object({
  number: matter.number,
  title: matter.title,
  type: matter.type,
  status: matter.status,
  privileged: matter.privileged,
  search: matter.search.default([]),
  lastActivityAt: matter.lastActivityAt,
  deletedAt: SoftDeleteShape.deletedAt,
});
export type MatterSearchItem = z.infer<typeof MatterSearchItemSchema>;

/** A contact as the palette shows it: its name. */
export const ContactSearchItemSchema = /* @__PURE__ */ z.object({
  kind: contact.kind,
  givenNames: contact.givenNames,
  familyName: contact.familyName,
  preferredName: contact.preferredName,
  orgName: contact.orgName,
  mergedInto: contact.mergedInto,
  search: contact.search.default([]),
  updatedAt: contact.updatedAt.optional(),
  deletedAt: SoftDeleteShape.deletedAt,
});
export type ContactSearchItem = z.infer<typeof ContactSearchItemSchema>;

/** A task (a matter's, or a personal one with `matterId: null`) as the palette shows it. */
export const TaskSearchItemSchema = /* @__PURE__ */ z.object({
  orgId: task.orgId.optional(),
  matterId: task.matterId.nullable().optional(),
  title: task.title,
  status: task.status,
  assigneeUid: task.assigneeUid,
  search: task.search,
  updatedAt: task.updatedAt.optional(),
  deletedAt: SoftDeleteShape.deletedAt,
});
export type TaskSearchItem = z.infer<typeof TaskSearchItemSchema>;

/** A document as the palette shows it: its name and matter. */
export const DocumentSearchItemSchema = /* @__PURE__ */ z.object({
  orgId: document.orgId.optional(),
  matterId: document.matterId.optional(),
  name: document.name,
  category: document.category,
  privileged: document.privileged,
  search: document.search,
  updatedAt: document.updatedAt.optional(),
  deletedAt: SoftDeleteShape.deletedAt,
});
export type DocumentSearchItem = z.infer<typeof DocumentSearchItemSchema>;

// ---------- repositories (call in an injection context) ----------

export function matterSearchRepository(): Repository<MatterSearchItem> {
  return repo((orgId) => `orgs/${orgId}/matters`, { schema: MatterSearchItemSchema, version: Matter.version });
}

export function contactSearchRepository(): Repository<ContactSearchItem> {
  return repo((orgId) => `orgs/${orgId}/contacts`, { schema: ContactSearchItemSchema, version: Contact.version });
}

/** Tasks across the org (the `tasks` collection group, scoped to the active org). */
export function taskSearchRepository(): GroupRepository<TaskSearchItem> {
  return groupRepo('tasks', { schema: TaskSearchItemSchema, version: Task.version });
}

/** Documents across the org (the `documents` collection group): privileged.view roles only (ADR-033). */
export function documentSearchRepository(): GroupRepository<DocumentSearchItem> {
  return groupRepo('documents', { schema: DocumentSearchItemSchema, version: MatterDocument.version });
}

/** One matter's documents, for roles without privileged.view while that matter is open. */
export function matterDocumentSearchRepository(matterId: () => string | null): Repository<DocumentSearchItem> {
  return repo((orgId) => `orgs/${orgId}/matters/${matterId() ?? '-'}/documents`, {
    schema: DocumentSearchItemSchema,
    version: MatterDocument.version,
  });
}

// ---------- queries ----------

/** Live matters holding the token, most recently active first (the Matters list's `search` indexes). */
export function matterSearchQuery(token: string, privilegedVisible: boolean): QuerySpec<MatterSearchItem> {
  return {
    where: [
      ['deletedAt', '==', null],
      ...(privilegedVisible ? [] : [['privileged', '==', false] as const]),
      ['search', 'array-contains', token],
    ],
    orderBy: [['lastActivityAt', 'desc']],
    pageSize: SEARCH_RESULT_LIMIT,
  };
}

/** Contacts holding the token, most recently updated first (indexed: search, updatedAt desc). */
export const contactSearchQuery = (token: string): QuerySpec<ContactSearchItem> => ({
  where: [['search', 'array-contains', token]],
  orderBy: [['updatedAt', 'desc']],
  pageSize: SEARCH_RESULT_LIMIT,
});

/** My tasks (matter and personal) holding the token (indexed: orgId, assigneeUid, search, updatedAt desc). */
export const myTaskSearchQuery = (uid: string, token: string): QuerySpec<TaskSearchItem> => ({
  where: [
    ['assigneeUid', '==', uid],
    ['search', 'array-contains', token],
  ],
  orderBy: [['updatedAt', 'desc']],
  pageSize: SEARCH_RESULT_LIMIT,
});

/**
 * Every matter task holding the token, for roles with privileged.view: `matterId != null` proves
 * to the rules that no one's personal task is read (indexed: orgId, search, matterId). Firestore
 * orders an inequality by its field, so these are ranked here, not by recency in the query.
 */
export const matterTaskSearchQuery = (token: string): QuerySpec<TaskSearchItem> => ({
  where: [
    ['search', 'array-contains', token],
    ['matterId', '!=', null],
  ],
  pageSize: SEARCH_RESULT_LIMIT,
});

/** Documents holding the token, most recently updated first; `privileged == false` at a matter's path for roles without privileged.view. */
export function documentSearchQuery(token: string, privilegedVisible = true): QuerySpec<DocumentSearchItem> {
  return {
    where: [...(privilegedVisible ? [] : [['privileged', '==', false] as const]), ['search', 'array-contains', token]],
    orderBy: [['updatedAt', 'desc']],
    pageSize: SEARCH_RESULT_LIMIT,
  };
}

// ---------- matching and ranking ----------

/** One provider's answer: its rows, best first, and whether the token had more rows than were read. */
export interface SearchPage<T> {
  rows: T[];
  /** The token matched at least `SEARCH_RESULT_LIMIT` rows: a "type more" hint. */
  more: boolean;
}

type Row = { id: string };

/** Keeps the rows matching every word typed and ranks them (ADR-013: at most 20 read per query). */
export function rankRows<T extends Row>(
  rows: readonly T[],
  query: SearchQuery,
  view: (row: T) => {
    tokens: readonly string[];
    texts: readonly string[];
    title: string;
    number?: string;
    at?: Date | null;
  },
  read = rows.length,
): SearchPage<T> {
  const hits = rows.map((row) => ({ row, ...view(row) })).filter((hit) => matchesSearch(hit.tokens, query, hit.texts));
  return {
    rows: rankSearchHits(hits, query).map((hit) => hit.row),
    more: read >= SEARCH_RESULT_LIMIT,
  };
}

export const matterHit = (row: MatterSearchItem & Row) => ({
  tokens: row.search,
  texts: [row.number, row.title],
  title: row.title,
  number: row.number,
  at: row.lastActivityAt ?? null,
});

export const contactHit = (row: ContactSearchItem & Row) => {
  const name = contactDisplayName(row);
  return { tokens: row.search, texts: [name], title: name, at: row.updatedAt ?? null };
};

export const taskHit = (row: TaskSearchItem & Row) => ({
  tokens: row.search,
  texts: [row.title],
  title: row.title,
  at: row.updatedAt ?? null,
});

export const documentHit = (row: DocumentSearchItem & Row) => ({
  tokens: row.search,
  texts: [row.name],
  title: row.name,
  at: row.updatedAt ?? null,
});

/** Live, unmerged contacts only (a merge tombstone is never a result). */
export const liveContact = (row: ContactSearchItem) => !row.mergedInto && !row.deletedAt;

// ---------- recents ----------

/** What a recent entry points at, read now: its title, and its matter's number when it has one. */
export interface RecentTarget {
  ref: RecentRef;
  title: string;
  /** The matter number (a matter) or the matter it's on (a task, a document). */
  number?: string;
}

/**
 * Reads what recent entries point at (CORE-15), for the palette's Recent group: a matter, contact,
 * task (a matter's or my personal one) or document by id. Entries that are gone, deleted or no
 * longer readable (a matter made privileged) are left out. Create it in an injection context.
 */
export function recentTargets(): (refs: readonly RecentRef[]) => Promise<RecentTarget[]> {
  const injector = inject(Injector);
  const context = inject(OrgContext);
  const matters = matterSearchRepository();
  const contacts = contactSearchRepository();
  const repos = new Map<string, Repository<TaskSearchItem> | Repository<DocumentSearchItem>>();
  const at = <T>(path: string, schema: z.ZodType<T>, version: number): Repository<T> => {
    const known = repos.get(path) as Repository<T> | undefined;
    if (known) return known;
    const created = runInInjectionContext(injector, () => repo(() => path, { schema, version }));
    repos.set(path, created as never);
    return created;
  };
  const matterNumber = async (matterId: string | null | undefined) =>
    matterId ? ((await matters.get(matterId).catch(() => null))?.number ?? undefined) : undefined;

  const read = async (ref: RecentRef): Promise<RecentTarget | null> => {
    const orgId = context.requireOrgId();
    const id = ref.entityId ?? '';
    switch (ref.kind) {
      case 'matter': {
        const row = ref.matterId ? await matters.get(ref.matterId) : null;
        return row && !row.deletedAt ? { ref, title: row.title, number: row.number } : null;
      }
      case 'contact': {
        const row = await contacts.get(id);
        return row && liveContact(row) ? { ref, title: contactDisplayName(row) } : null;
      }
      case 'task': {
        const path = ref.matterId
          ? `orgs/${orgId}/matters/${ref.matterId}/tasks`
          : `orgs/${orgId}/members/${context.requireUid()}/tasks`;
        const row = await at(path, TaskSearchItemSchema, Task.version).get(id);
        if (!row || row.deletedAt) return null;
        const number = await matterNumber(ref.matterId);
        return { ref, title: row.title, ...(number ? { number } : {}) };
      }
      case 'document': {
        const path = `orgs/${orgId}/matters/${ref.matterId ?? '-'}/documents`;
        const row = await at(path, DocumentSearchItemSchema, MatterDocument.version).get(id);
        if (!row || row.deletedAt) return null;
        const number = await matterNumber(ref.matterId);
        return { ref, title: row.name, ...(number ? { number } : {}) };
      }
    }
  };

  return async (refs) => {
    const settled = await Promise.allSettled(refs.map(read));
    return settled.flatMap((result) => (result.status === 'fulfilled' && result.value ? [result.value] : []));
  };
}
