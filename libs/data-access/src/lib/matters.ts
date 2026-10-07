import { inject } from '@angular/core';
import * as z from 'zod';

import {
  DestructionRequest,
  isIndexedMatterQuery,
  matterPassesFilters,
  Matter,
  MATTER_LIST_PAGE_SIZE,
  MATTER_SORT_ORDER_FIELD,
  SavedView,
  SEARCH_TOKEN_MAX,
  searchQueryToken,
  searchWords,
  SoftDeleteShape,
  type MatterFilterContext,
  type MatterListFilter,
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
  /** Read as any string: the UI links it only when `isMatterLink` (a bad value never hides the matter). */
  externalUrl: z.string().optional(),
  /** The Matters board's card order (CORE-04). */
  boardOrder: matter.boardOrder,
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

/**
 * A pinned matter as the sidebar names it (CORE-23): its number, title and type, its status, and
 * whether it is still live. Read one document at a time, by id.
 */
export const PinnedMatterSchema = /* @__PURE__ */ z.object({
  number: matter.number,
  title: matter.title,
  type: matter.type,
  status: matter.status,
  deletedAt: SoftDeleteShape.deletedAt,
  destroyedAt: matter.destroyedAt,
});
export type PinnedMatter = z.infer<typeof PinnedMatterSchema>;

/** The active org's matters, watched one at a time for the sidebar's Pinned section (CORE-23). */
export function pinnedMatterRepository(): Repository<PinnedMatter> {
  return repo((orgId) => `orgs/${orgId}/matters`, { schema: PinnedMatterSchema, version: Matter.version });
}

/** Rows per page of the Matters list (infinite scroll loads the next page). */
export const MATTER_PAGE_SIZE = MATTER_LIST_PAGE_SIZE;
/** When the query can't carry every filter, at most this many matters are read and filtered here. */
export const MATTER_CLIENT_FILTER_LIMIT = 500;
/** Firestore caps the product of a query's `in` list sizes (status × type). */
const MAX_DISJUNCTIONS = 30;

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

const FILTER_NAMES: Record<MatterListFilter, MatterClientFilter> = {
  status: 'status',
  responsibleUid: 'responsible',
  type: 'type',
  labels: 'label',
  jurisdiction: 'jurisdiction',
  search: 'query',
};

function resolveResponsible(responsible: string | undefined, viewerUid: string | null): string | null {
  if (!responsible) return null;
  if (responsible === 'me') return viewerUid;
  return responsible;
}

/** The Firestore filter each set filter could become (before choosing an indexed combination). */
function serverCandidates(filters: MatterListFilters, viewerUid: string | null): Map<MatterListFilter, Where> {
  const candidates = new Map<MatterListFilter, Where>();
  const status = filters.status ?? [];
  if (status.length === 1) candidates.set('status', ['status', '==', status[0]]);
  else if (status.length > 1) candidates.set('status', ['status', 'in', [...status]]);
  const responsible = resolveResponsible(filters.responsible, viewerUid);
  if (responsible) candidates.set('responsibleUid', ['responsibleUid', '==', responsible]);
  const type = filters.type ?? [];
  if (type.length === 1) candidates.set('type', ['type', '==', type[0]]);
  else if (type.length > 1 && Math.max(1, status.length) * type.length <= MAX_DISJUNCTIONS) {
    candidates.set('type', ['type', 'in', [...type]]);
  }
  if (filters.label) candidates.set('labels', ['labels', 'array-contains', filters.label]);
  if (filters.jurisdiction) candidates.set('jurisdiction', ['jurisdiction', '==', filters.jurisdiction]);
  const token = searchQueryToken(filters.query ?? '');
  if (token) candidates.set('search', ['search', 'array-contains', token]);
  return candidates;
}

/** Every subset of a list, largest first (the lists here have at most six fields). */
function subsetsBySize<T>(items: readonly T[]): T[][] {
  const subsets: T[][] = [[]];
  for (const item of items) for (const subset of [...subsets]) subsets.push([...subset, item]);
  return subsets.sort((a, b) => b.length - a.length);
}

const CAPPED_NOTICE =
  'Some of these filters or this sort run in your browser, over the 500 most recently active matters that match the rest.';

/**
 * Maps a view (filters and sort) to the Firestore query for the Matters list (CORE-03): which
 * filters Firestore applies, which run here, and whether the list pages (50 at a time) or reads at
 * most 500 rows and filters them here. Decided against the domain's `MATTER_INDEXED_QUERIES` (the
 * indexes in `firebase/firestore.indexes.json`). Every query reads live matters only
 * (`deletedAt == null`, which the server keeps on every live matter), and `privileged == false` for
 * roles without `privileged.view`.
 */
export function matterQueryPlan(
  filters: MatterListFilters,
  sort: MatterViewSort,
  options: MatterQueryPlanOptions = {},
): MatterQueryPlan {
  const viewerUid = options.viewerUid ?? null;
  const base: Where[] = [['deletedAt', '==', null]];
  if (options.privilegedVisible === false) base.push(['privileged', '==', false]);
  const candidates = serverCandidates(filters, viewerUid);
  const fields = [...candidates.keys()];
  const where = (subset: readonly MatterListFilter[]) => [
    ...base,
    ...subset.map((field) => candidates.get(field) as Where),
  ];

  // Always here: overdue and recently closed (ranges on other fields than the order), a type list
  // too long to combine with the statuses, and the search box beyond what its first token covers.
  const alwaysClient: MatterClientFilter[] = [];
  if (filters.hasOverdue) alwaysClient.push('hasOverdue');
  if (filters.closedWithinDays) alwaysClient.push('closedWithinDays');
  if ((filters.type?.length ?? 0) > 1 && !candidates.has('type')) alwaysClient.push('type');
  const words = searchWords(filters.query).filter((word) => word.length >= 2);
  if (words.length > 1 || (words[0]?.length ?? 0) > SEARCH_TOKEN_MAX) alwaysClient.push('query');

  const order = MATTER_SORT_ORDER_FIELD[sort.field];
  if (order && alwaysClient.length === 0 && isIndexedMatterQuery(fields, order, sort.dir)) {
    return {
      mode: 'paged',
      spec: { where: where(fields), orderBy: [[order, sort.dir]], pageSize: MATTER_PAGE_SIZE },
      clientFilters: [],
      clientSort: false,
    };
  }

  // The largest indexed subset of the filters (a search token first: it narrows most), most
  // recently active first; the rest here.
  const subset =
    subsetsBySize(fields)
      .sort((a, b) => b.length - a.length || Number(b.includes('search')) - Number(a.includes('search')))
      .find((s) => isIndexedMatterQuery(s, 'lastActivityAt', 'desc')) ?? [];
  const clientFilters = [
    ...new Set([
      ...fields.filter((field) => !subset.includes(field)).map((field) => FILTER_NAMES[field]),
      ...alwaysClient,
    ]),
  ];
  return {
    mode: 'capped',
    spec: { where: where(subset), orderBy: [['lastActivityAt', 'desc']], pageSize: MATTER_CLIENT_FILTER_LIMIT },
    clientFilters,
    clientSort: true,
    notice: CAPPED_NOTICE,
  };
}

export type { MatterFilterContext } from '@materia/domain';

/**
 * Whether a loaded matter passes every filter. Applied to every row, so filters Firestore already
 * applied cost nothing and the ones it couldn't take still hold. The same check decides what the
 * list's CSV export holds (`matterPassesFilters`, INS-03).
 */
export function matterMatchesFilters(
  row: MatterListItem,
  filters: MatterListFilters,
  context: MatterFilterContext,
): boolean {
  return matterPassesFilters(row, filters, context);
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

/**
 * The `matters-*` callables (built in apps/functions/src/matters, CORE-03; the stage and parties
 * CORE-06). `matterCallables(client)` wraps the matter screen's with their input and result types.
 */
export const MATTER_CALLABLES = {
  create: 'matters-createMatter',
  changeStatus: 'matters-changeStatus',
  restore: 'matters-restore',
  /** `ChangeMatterStageInput` → `ChangeMatterStageResult` (matter.edit). */
  changeStage: 'matters-changeStage',
  /** `UpsertPartyInput` → `PartyResult` (matter.edit). */
  upsertParty: 'matters-upsertParty',
  /** `RemovePartyInput` → `PartyResult` (matter.edit). */
  removeParty: 'matters-removeParty',
  /** `UpgradeMatterTemplateInput` → `UpgradeMatterTemplateResult` (matter.edit, CORE-07). */
  upgradeTemplate: 'matters-upgradeTemplate',
  /** `RenumberMatterInput` → `RenumberMatterResult` (matter.renumber, CORE-21a). */
  renumber: 'matters-renumber',
  /** `RebalanceBoardInput` → `RebalanceBoardResult` (matter.edit, CORE-04). */
  rebalanceBoard: 'matters-rebalanceBoard',
  /** CORE-19: the closing checklist, closing, reopening and legal holds (see `MatterCallables`). */
  closingChecklist: 'matters-closingChecklist',
  close: 'matters-close',
  reopen: 'matters-reopen',
  setLegalHold: 'matters-setLegalHold',
  /** `ApproveDestructionInput` → `ApproveDestructionResult` (matter.destroy, a recent sign-in). */
  approveDestruction: 'matters-approveDestruction',
  /** `DestructionCertificateUrlInput` → `DestructionCertificateUrlResult` (matter.destroy). */
  destructionCertificateUrl: 'matters-destructionCertificateUrl',
} as const;

// ---------- destruction queue (CORE-19) ----------

export type DestructionQueueItem = z.infer<typeof DestructionRequest.schema>;

/** The org's destruction queue (`orgs/{orgId}/destructionQueue`, owners and admins): server-written. */
export function destructionQueueRepository(): Repository<DestructionQueueItem> {
  return repo((orgId) => `orgs/${orgId}/destructionQueue`, DestructionRequest);
}

/** Every entry, newest first; the page groups them by status (a single-field order needs no index). */
export const DESTRUCTION_QUEUE_QUERY: QuerySpec<DestructionQueueItem> = {
  orderBy: [['queuedAt', 'desc']],
  pageSize: 200,
};

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
