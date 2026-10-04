import { inject } from '@angular/core';
import { z } from 'zod';

import {
  Matter,
  SavedView,
  searchQueryToken,
  searchWords,
  SoftDeleteShape,
  type DateOnly,
  type MatterSortField,
  type MatterViewFilters,
  type MatterViewSort,
} from '@materia/domain';

import { OrgContext } from './org-context';
import type { FieldPath, QuerySpec, WhereOp } from './query';
import { repo, type Repository } from './repository';

const matter = Matter.schema.shape;

/**
 * What the Matters list reads from `orgs/{orgId}/matters/{id}` (CORE-03): the fields it shows,
 * filters and sorts by, validated by the `libs/domain` Matter schema. Other fields (fees, the
 * conflict check, the estate) are dropped, not rejected. `search` and `lastActivityAt` are kept by
 * `matters-denormalise`.
 */
export const MatterListItemSchema = /* @__PURE__ */ z.object({
  number: matter.number,
  title: matter.title,
  type: matter.type,
  status: matter.status,
  stageId: matter.stageId,
  jurisdiction: matter.jurisdiction,
  responsibleUid: matter.responsibleUid,
  teamUids: matter.teamUids,
  clientContactIds: matter.clientContactIds,
  privileged: matter.privileged,
  priority: matter.priority,
  labels: matter.labels,
  search: matter.search.default([]),
  nextDeadline: matter.nextDeadline,
  openTaskCount: matter.openTaskCount,
  wipCents: matter.wipCents,
  lastActivityAt: matter.lastActivityAt,
  closedAt: matter.closedAt,
  updatedAt: matter.updatedAt.optional(),
  deletedAt: SoftDeleteShape.deletedAt,
});
export type MatterListItem = z.infer<typeof MatterListItemSchema>;

/** Rows per page of the Matters list (infinite scroll loads the next page). */
export const MATTER_PAGE_SIZE = 50;
/** When the query can't carry every filter, at most this many matters are read and filtered here. */
export const MATTER_CLIENT_FILTER_LIMIT = 500;

/** A Firestore field the list can filter on with an equality (or `in` / `array-contains`). */
export type MatterIndexField = 'status' | 'responsibleUid' | 'type' | 'labels' | 'jurisdiction';
/** A Firestore field the list can order by. */
export type MatterOrderField = 'lastActivityAt' | 'number' | 'title';

/** A filter and sort combination with a composite index in `firebase/firestore.indexes.json`. */
export interface MatterIndexedQuery {
  filters: readonly MatterIndexField[];
  orderBy: MatterOrderField;
  /** The directions the index serves (an index is per direction). */
  directions: readonly ('asc' | 'desc')[];
}

/**
 * The composite indexes the Matters list relies on (CORE-03). Until `MATTER_INDEXED_QUERIES` lands
 * in `libs/domain` with the indexes themselves, this mirrors them; `matterQueryPlan` is the only
 * reader. A query with no filter and one `orderBy` needs no composite index.
 */
export const MATTER_LIST_INDEXES: readonly MatterIndexedQuery[] = [
  { filters: ['status'], orderBy: 'lastActivityAt', directions: ['desc', 'asc'] },
  { filters: ['status', 'responsibleUid'], orderBy: 'lastActivityAt', directions: ['desc', 'asc'] },
  { filters: ['status', 'type'], orderBy: 'lastActivityAt', directions: ['desc', 'asc'] },
  { filters: ['responsibleUid'], orderBy: 'lastActivityAt', directions: ['desc', 'asc'] },
  { filters: ['status'], orderBy: 'number', directions: ['asc', 'desc'] },
  { filters: ['status'], orderBy: 'title', directions: ['asc', 'desc'] },
  { filters: ['labels'], orderBy: 'lastActivityAt', directions: ['desc', 'asc'] },
  { filters: ['jurisdiction', 'status'], orderBy: 'lastActivityAt', directions: ['desc', 'asc'] },
];

/** The list's sort fields that Firestore can order by; the others sort the loaded rows. */
const SERVER_SORT: Partial<Record<MatterSortField, MatterOrderField>> = {
  lastActivity: 'lastActivityAt',
  number: 'number',
  title: 'title',
};

/** Filters as the list applies them: a view's filters, `responsible: 'me'` resolved, plus the search box. */
export interface MatterListFilters extends MatterViewFilters {
  /** What was typed in the filter box: matter number, title or client name. */
  query?: string;
}

export interface MatterQueryPlanOptions {
  /** Who "me" is in `responsible: 'me'`. */
  viewerUid?: string | null;
  /**
   * Whether the viewer may read privileged matters (`privileged.view`). Without it the rules only
   * allow queries that prove `privileged == false`, so the plan adds that filter.
   */
  privilegedVisible?: boolean;
}

/** The parts of a filter the Firestore query can't carry, applied to the loaded rows. */
export type MatterClientFilter = keyof MatterListFilters;

/**
 * How the Matters list reads a view (`matterQueryPlan`):
 * - `paged`: Firestore filters and sorts everything; 50 rows a page, more on scroll.
 * - `capped`: the combination has no index, so Firestore narrows what it can (the largest indexed
 *   subset of the filters, most recently active first), at most 500 rows are read, and the rest is
 *   filtered (and sorted) here. `notice` says so on screen.
 */
export interface MatterQueryPlan {
  mode: 'paged' | 'capped';
  spec: QuerySpec<MatterListItem>;
  /** Filters applied to the loaded rows (`matterMatchesFilters` applies them all anyway; this is for display and tests). */
  clientFilters: MatterClientFilter[];
  /** The rows need sorting here (`sort` isn't a Firestore order). */
  clientSort: boolean;
  notice?: string;
}

type Where = readonly [FieldPath<MatterListItem>, WhereOp, unknown];

/** Firestore filter candidates from the filters, in the order a smaller indexed subset keeps them. */
function serverCandidates(filters: MatterListFilters, viewerUid: string | null): Map<MatterIndexField, Where> {
  const candidates = new Map<MatterIndexField, Where>();
  const status = filters.status ?? [];
  if (status.length === 1) candidates.set('status', ['status', '==', status[0]]);
  else if (status.length > 1) candidates.set('status', ['status', 'in', [...status]]);
  const responsible = resolveResponsible(filters.responsible, viewerUid);
  if (responsible) candidates.set('responsibleUid', ['responsibleUid', '==', responsible]);
  const type = filters.type ?? [];
  if (type.length === 1) candidates.set('type', ['type', '==', type[0]]);
  // Firestore allows one `in` per query: a second list stays a client filter.
  else if (type.length > 1 && status.length <= 1) candidates.set('type', ['type', 'in', [...type]]);
  if (filters.label) candidates.set('labels', ['labels', 'array-contains', filters.label]);
  if (filters.jurisdiction) candidates.set('jurisdiction', ['jurisdiction', '==', filters.jurisdiction]);
  return candidates;
}

function resolveResponsible(responsible: string | undefined, viewerUid: string | null): string | null {
  if (!responsible) return null;
  if (responsible === 'me') return viewerUid;
  return responsible;
}

function sameFields(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((field) => b.includes(field));
}

/** Whether Firestore can serve these filters ordered by this field (a composite index, or none needed). */
export function isIndexedMatterQuery(
  fields: readonly MatterIndexField[],
  orderBy: MatterOrderField,
  direction: 'asc' | 'desc',
): boolean {
  if (fields.length === 0) return true;
  return MATTER_LIST_INDEXES.some(
    (index) => index.orderBy === orderBy && index.directions.includes(direction) && sameFields(index.filters, fields),
  );
}

/** Every subset of a list, largest first (the lists here have at most five fields). */
function subsetsBySize<T>(items: readonly T[]): T[][] {
  const subsets: T[][] = [[]];
  for (const item of items) for (const subset of [...subsets]) subsets.push([...subset, item]);
  return subsets.sort((a, b) => b.length - a.length);
}

const CAPPED_NOTICE =
  'Some of these filters or this sort run in your browser, over the 500 most recently active matters that match the rest.';
const SEARCH_NOTICE = 'Searching the first 500 matters that match; add a filter to narrow it down.';

/**
 * Maps a view (filters and sort) to the Firestore query for the Matters list (CORE-03): which
 * filters Firestore applies, which run here, and whether the list pages (50 at a time) or reads at
 * most 500 rows and filters them here. Decided against `MATTER_LIST_INDEXES`. Soft-deleted matters
 * never show (the repository drops rows with `deletedAt`).
 */
export function matterQueryPlan(
  filters: MatterListFilters,
  sort: MatterViewSort,
  options: MatterQueryPlanOptions = {},
): MatterQueryPlan {
  const viewerUid = options.viewerUid ?? null;
  const privileged: Where[] = options.privilegedVisible === false ? [['privileged', '==', false]] : [];
  const candidates = serverCandidates(filters, viewerUid);
  const fields = [...candidates.keys()];
  const where = (subset: readonly MatterIndexField[]) => [
    ...privileged,
    ...subset.map((field) => candidates.get(field) as Where),
  ];

  // Always client-side: overdue (a range on another field), recently closed (likewise), the search box
  // beyond its first word, and any list filter Firestore couldn't take.
  const alwaysClient: MatterClientFilter[] = [];
  if (filters.hasOverdue) alwaysClient.push('hasOverdue');
  if (filters.closedWithinDays) alwaysClient.push('closedWithinDays');
  if ((filters.type?.length ?? 0) > 1 && !candidates.has('type')) alwaysClient.push('type');
  const token = searchQueryToken(filters.query ?? '');
  if (filters.query?.trim()) alwaysClient.push('query');

  const order = SERVER_SORT[sort.field];
  if (order && alwaysClient.length === 0 && isIndexedMatterQuery(fields, order, sort.dir)) {
    return {
      mode: 'paged',
      spec: { where: where(fields), orderBy: [[order, sort.dir]], pageSize: MATTER_PAGE_SIZE },
      clientFilters: [],
      clientSort: false,
    };
  }

  const fieldToFilter: Record<MatterIndexField, MatterClientFilter> = {
    status: 'status',
    responsibleUid: 'responsible',
    type: 'type',
    labels: 'label',
    jurisdiction: 'jurisdiction',
  };

  // A search: the first word's token narrows the read (no order, so no composite index needed).
  if (token) {
    return {
      mode: 'capped',
      spec: {
        where: [...privileged, ['search', 'array-contains', token]],
        pageSize: MATTER_CLIENT_FILTER_LIMIT,
      },
      clientFilters: [...new Set([...fields.map((field) => fieldToFilter[field]), ...alwaysClient])],
      clientSort: true,
      notice: SEARCH_NOTICE,
    };
  }

  // The largest indexed subset of the filters, most recently active first; the rest here.
  const subset = subsetsBySize(fields).find((s) => isIndexedMatterQuery(s, 'lastActivityAt', 'desc')) ?? [];
  const clientFilters = [
    ...fields.filter((field) => !subset.includes(field)).map((field) => fieldToFilter[field]),
    ...alwaysClient,
  ];
  return {
    mode: 'capped',
    spec: {
      where: where(subset),
      orderBy: [['lastActivityAt', 'desc']],
      pageSize: MATTER_CLIENT_FILTER_LIMIT,
    },
    clientFilters,
    clientSort: true,
    notice: CAPPED_NOTICE,
  };
}

export interface MatterFilterContext {
  viewerUid?: string | null;
  /** Today in the org's time zone, for "has overdue". */
  today: DateOnly;
  /** Now, for "closed within N days". */
  now: Date;
}

/**
 * Whether a loaded matter passes every filter. Applied to every row, so filters Firestore already
 * applied cost nothing and the ones it couldn't take still hold.
 */
export function matterMatchesFilters(
  row: MatterListItem,
  filters: MatterListFilters,
  context: MatterFilterContext,
): boolean {
  if (row.deletedAt) return false;
  if (filters.status?.length && !filters.status.includes(row.status)) return false;
  if (filters.type?.length && !filters.type.includes(row.type)) return false;
  const responsible = resolveResponsible(filters.responsible, context.viewerUid ?? null);
  if (filters.responsible && row.responsibleUid !== responsible) return false;
  if (filters.label && !row.labels.includes(filters.label)) return false;
  if (filters.jurisdiction && row.jurisdiction !== filters.jurisdiction) return false;
  if (filters.hasOverdue && !(row.nextDeadline && row.nextDeadline.dueDate < context.today)) return false;
  if (filters.closedWithinDays) {
    const since = context.now.getTime() - filters.closedWithinDays * 86_400_000;
    if (!row.closedAt || row.closedAt.getTime() < since) return false;
  }
  const words = searchWords(filters.query).filter((word) => word.length >= 2);
  if (words.length) {
    const tokens = new Set(row.search);
    const haystack = `${row.number} ${row.title}`.toLowerCase();
    if (!words.every((word) => tokens.has(word.slice(0, 10)) || haystack.includes(word))) return false;
  }
  return true;
}

/** Whether any filter is set (for "No matters match" and "Clear filters"). */
export function hasMatterFilters(filters: MatterListFilters): boolean {
  return !!(
    filters.status?.length ||
    filters.type?.length ||
    filters.responsible ||
    filters.label ||
    filters.jurisdiction ||
    filters.hasOverdue ||
    filters.closedWithinDays ||
    filters.query?.trim()
  );
}

/**
 * The matters repository for the list (CORE-03): live lists and documents, and client-direct edits
 * of the whitelisted fields (`Matter.update`: title, responsible, team, labels, priority, stage,
 * external reference, estate). Number and status change only through the `matters-*` callables.
 */
export function mattersRepository(): Repository<MatterListItem> {
  return repo((orgId) => `orgs/${orgId}/matters`, {
    schema: MatterListItemSchema,
    version: Matter.version,
    update: Matter.update,
  });
}

/** The `matters-*` callables (built in apps/functions/src/matters, CORE-03). */
export const MATTER_CALLABLES = {
  create: 'matters-createMatter',
  changeStatus: 'matters-changeStatus',
  restore: 'matters-restore',
} as const;

// ---------- saved views ----------

export type SavedViewItem = z.infer<typeof SavedView.schema>;

/** A person's saved Matters views in the active org (`users/{uid}/views`, at most 100). */
export const SAVED_MATTER_VIEWS_QUERY = (orgId: string): QuerySpec<SavedViewItem> => ({
  where: [
    ['orgId', '==', orgId],
    ['list', '==', 'matters'],
  ],
  pageSize: 100,
});

/**
 * The signed-in person's saved views (`users/{uid}/views/{viewId}`, CORE-03). Private to them and
 * scoped to an org by `orgId`; created, updated and deleted client-direct (the rules allow only
 * their own). Call it in an injection context.
 */
export function savedViewsRepository(): Repository<SavedViewItem> {
  const context = inject(OrgContext);
  return repo(() => `users/${context.requireUid()}/views`, SavedView);
}
