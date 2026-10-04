import { z } from 'zod';

import { conflictAllowsOpening } from './conflicts';
import { DEFAULT_ORG_TIMEZONE } from './constants';
import { CostsDisclosureInput, FeeInput, IntakeEventInput, IntakePartyInput } from './intake';
import { DocIdSchema } from './schemas/common';
import { Matter } from './schemas/contacts-matters';
import { MatterStatusSchema } from './schemas/enums';
import type { MatterStatus } from './schemas/enums';
import type { MatterGroupBy, MatterSortField, MatterViewFilters, MatterViewSort } from './schemas/views';
import { searchTokens } from './search';
import { dateOnlyAt } from './values/date-only';

/**
 * Matters (CORE-03): number allocation and formatting, the status state machine, search tokens,
 * saved views and the callable inputs. Shared by the web app and Functions.
 */

// ---------- numbers ----------

export const DEFAULT_MATTER_NUMBER_FORMAT = 'M-{YYYY}-{seq:4}';
const FORMAT_TOKEN = /\{(YYYY|YY|seq(?::(\d))?)\}/g;

/** A format must contain `{seq}` (or `{seq:N}`, zero-padded to N digits) and may use `{YYYY}` and `{YY}`. */
export function isMatterNumberFormat(format: string): boolean {
  return /\{seq(?::\d)?\}/.test(format) && format.replace(FORMAT_TOKEN, '').indexOf('{') === -1;
}

/** `formatMatterNumber('M-{YYYY}-{seq:4}', 2026, 7)` → `M-2026-0007`. */
export function formatMatterNumber(format: string, year: number, seq: number): string {
  const pattern = isMatterNumberFormat(format) ? format : DEFAULT_MATTER_NUMBER_FORMAT;
  return pattern.replace(FORMAT_TOKEN, (_match, token: string, width?: string) => {
    if (token === 'YYYY') return String(year);
    if (token === 'YY') return String(year % 100).padStart(2, '0');
    return String(seq).padStart(width ? Number(width) : 1, '0');
  });
}

/** The numbering year: the calendar year in the org's time zone (1 January in Melbourne, not UTC). */
export function matterNumberYear(now: Date, timeZone: string = DEFAULT_ORG_TIMEZONE): number {
  return Number(dateOnlyAt(now, timeZone).slice(0, 4));
}

/** `orgs/{orgId}/counters/matter-{YYYY}`. */
export function matterCounterId(year: number): string {
  return `matter-${year}`;
}

/**
 * The id of a number's reservation, `orgs/{orgId}/matterNumbers/{key}`: case-insensitive (so
 * "m-2026-0007" and "M-2026-0007" can't both exist) and URI-encoded, so a format with `/` or `.`
 * still makes a valid document id.
 */
export function matterNumberKey(number: string): string {
  return encodeURIComponent(number.trim().toUpperCase()).replace(/\./g, '%2E').replace(/_/g, '%5F');
}

// ---------- status ----------

/**
 * Allowed transitions. `closed → open` (reopen) needs a reason; `lead → open` needs a conflict
 * determination that allows opening (`clear` or `potential`, CORE-02).
 */
export const MATTER_TRANSITIONS: Readonly<Record<MatterStatus, readonly MatterStatus[]>> = {
  lead: ['open'],
  open: ['on_hold', 'closed'],
  on_hold: ['open'],
  closed: ['open', 'archived'],
  archived: [],
};

export function canTransition(from: MatterStatus, to: MatterStatus): boolean {
  return MATTER_TRANSITIONS[from].includes(to);
}

export type TransitionRequirement = 'conflict_openable' | 'reason';

/** What a valid transition still needs. */
export function transitionRequirements(from: MatterStatus, to: MatterStatus): TransitionRequirement[] {
  if (from === 'lead' && to === 'open') return ['conflict_openable'];
  if (from === 'closed' && to === 'open') return ['reason'];
  return [];
}

/** The status a new matter starts in: `open` once the conflict check allows it (CONFLICT_OPENABLE), otherwise `lead`. */
export function initialMatterStatus(conflictStatus: Matter['conflictCheck']['status'] | undefined): MatterStatus {
  return conflictAllowsOpening(conflictStatus) ? 'open' : 'lead';
}

export const MATTER_STATUS_LABELS: Readonly<Record<MatterStatus, string>> = {
  lead: 'Lead',
  open: 'Open',
  on_hold: 'On hold',
  closed: 'Closed',
  archived: 'Archived',
};

// ---------- search ----------

export interface MatterSearchFields {
  number: string;
  title: string;
  clientNames?: readonly string[];
  deceasedName?: string;
  externalRef?: string;
}

/**
 * Search tokens for `matters-denormalise`: the number (also without separators, so "M-2026-0007",
 * "m20260007" and "0007" all match), title, client and deceased names, and the external reference.
 */
export function matterSearchTokens(fields: MatterSearchFields): string[] {
  const compact = (value?: string) => value?.replace(/[^\p{L}\p{N}]+/gu, '');
  return searchTokens(
    compact(fields.number),
    fields.number,
    fields.title,
    ...(fields.clientNames ?? []),
    fields.deceasedName,
    fields.externalRef,
    compact(fields.externalRef),
  );
}

// ---------- saved views ----------

export interface MatterViewDefinition {
  id: string;
  name: string;
  filters: MatterViewFilters;
  sort: MatterViewSort;
  groupBy: MatterGroupBy;
}

/** The built-in views every user has. "My open matters" is the default. */
export const DEFAULT_MATTER_VIEWS: readonly MatterViewDefinition[] = [
  {
    id: 'my-open',
    name: 'My open matters',
    filters: { status: ['open'], responsible: 'me' },
    sort: { field: 'lastActivity', dir: 'desc' },
    groupBy: 'none',
  },
  {
    id: 'all-open',
    name: 'All open',
    filters: { status: ['open'] },
    sort: { field: 'lastActivity', dir: 'desc' },
    groupBy: 'none',
  },
  {
    id: 'leads',
    name: 'Leads',
    filters: { status: ['lead'] },
    sort: { field: 'lastActivity', dir: 'desc' },
    groupBy: 'none',
  },
  {
    id: 'on-hold',
    name: 'On hold',
    filters: { status: ['on_hold'] },
    sort: { field: 'lastActivity', dir: 'desc' },
    groupBy: 'none',
  },
  {
    id: 'recently-closed',
    name: 'Recently closed',
    filters: { status: ['closed'], closedWithinDays: 90 },
    sort: { field: 'lastActivity', dir: 'desc' },
    groupBy: 'none',
  },
];

// ---------- list queries ----------

/** Fields the Matters list filters on in Firestore. `status` and `type` take `==` or `in`; `labels` and `search` take `array-contains`. */
export type MatterListFilter = 'status' | 'responsibleUid' | 'type' | 'labels' | 'jurisdiction' | 'search';
/** Fields the Matters list orders by in Firestore. */
export type MatterListOrderField = 'lastActivityAt' | 'number' | 'title';

export interface MatterIndexedQuery {
  /** The filtered fields, in any order. */
  filters: readonly MatterListFilter[];
  orderBy: MatterListOrderField;
  dir: 'asc' | 'desc';
}

/** Rows per page of the Matters list (cursor pagination). */
export const MATTER_LIST_PAGE_SIZE = 50;

/**
 * Filters every Matters list query has besides its own: `deletedAt == null` (live matters; the
 * server keeps `deletedAt: null` on every live matter), and `privileged == false` for roles without
 * `privileged.view` (the rules refuse those roles a query that doesn't prove it). Each indexed
 * query below is indexed both with and without `privileged`.
 */
export const MATTER_LIST_BASE_FILTERS = ['deletedAt', 'privileged'] as const;

/** The list's order field for a saved view's sort; other sorts are applied client-side. */
export const MATTER_SORT_ORDER_FIELD: Readonly<Partial<Record<MatterSortField, MatterListOrderField>>> = {
  lastActivity: 'lastActivityAt',
  number: 'number',
  title: 'title',
};

const byActivity = (...filters: MatterListFilter[]): MatterIndexedQuery => ({
  filters,
  orderBy: 'lastActivityAt',
  dir: 'desc',
});
const byNumberAndTitle = (...filters: MatterListFilter[]): MatterIndexedQuery[] =>
  (['number', 'title'] as const).flatMap((orderBy) =>
    (['asc', 'desc'] as const).map((dir) => ({ filters, orderBy, dir })),
  );

/**
 * The Matters list queries `firebase/firestore.indexes.json` indexes (CORE-03). A list whose
 * filters and order match one of these runs in Firestore; anything else (another combination, or a
 * sort on client, responsible, stage, next deadline or WIP) should query the closest indexed subset
 * and filter or sort the rest client-side. Firestore also caps the product of `in` list sizes
 * (status × type) at 30. `firebase/tests/indexes.spec.ts` checks every entry has its indexes.
 */
export const MATTER_INDEXED_QUERIES: readonly MatterIndexedQuery[] = [
  byActivity(),
  ...byNumberAndTitle(),
  byActivity('status'),
  ...byNumberAndTitle('status'),
  byActivity('status', 'responsibleUid'),
  byActivity('status', 'type'),
  byActivity('status', 'responsibleUid', 'type'),
  byActivity('status', 'labels'),
  byActivity('status', 'jurisdiction'),
  byActivity('status', 'search'),
  byActivity('responsibleUid'),
  byActivity('type'),
  byActivity('labels'),
  byActivity('jurisdiction'),
  byActivity('search'),
];

/** Whether a Matters list query (its filtered fields, order field and direction) is indexed. */
export function isIndexedMatterQuery(
  filters: readonly MatterListFilter[],
  orderBy: MatterListOrderField,
  dir: 'asc' | 'desc',
): boolean {
  const wanted = [...new Set(filters)].sort().join(',');
  return MATTER_INDEXED_QUERIES.some(
    (query) => query.orderBy === orderBy && query.dir === dir && [...query.filters].sort().join(',') === wanted,
  );
}

/** Canonical index field order: equality and `in` fields, then `array-contains`, then the order field. */
const INDEX_FIELD_ORDER: readonly MatterListFilter[] = [
  'status',
  'responsibleUid',
  'type',
  'jurisdiction',
  'labels',
  'search',
];

export interface MatterIndexField {
  fieldPath: string;
  order?: 'ASCENDING' | 'DESCENDING';
  arrayConfig?: 'CONTAINS';
}

/** The composite index fields for an indexed query, with or without the `privileged == false` filter. */
export function matterIndexFields(query: MatterIndexedQuery, withPrivileged: boolean): MatterIndexField[] {
  const filters = INDEX_FIELD_ORDER.filter((field) => query.filters.includes(field));
  return [
    { fieldPath: 'deletedAt', order: 'ASCENDING' },
    ...(withPrivileged ? [{ fieldPath: 'privileged', order: 'ASCENDING' as const }] : []),
    ...filters.map((fieldPath): MatterIndexField =>
      fieldPath === 'labels' || fieldPath === 'search'
        ? { fieldPath, arrayConfig: 'CONTAINS' }
        : { fieldPath, order: 'ASCENDING' },
    ),
    { fieldPath: query.orderBy, order: query.dir === 'asc' ? 'ASCENDING' : 'DESCENDING' },
  ];
}

// ---------- callable inputs ----------

const RequestId = z.uuid();

/**
 * `matters-createMatter`: the matter's fields without the number and status, which the server
 * allocates. Status is `lead`, or `open` when `conflictCheck.status` is already `clear` or
 * `potential`. A status other than `pending` is a determination: it needs `conflict.determine`, a
 * reason for `potential` and `conflict`, and the server stamps `checkedAt` and `checkedBy` (CORE-02).
 * CORE-05 adds the intake fields (`parties`, `events`, `fee`, `costsDisclosure`, `conflictCheckId`);
 * `intakeToCreateMatterInput` builds them from the New matter form.
 */
export const CreateMatterInput = z
  .object({
    requestId: RequestId,
    /** `fee` and `costsDisclosure` may come here (before CORE-05) or at the top level (intake). */
    matter: Matter.create.omit({ status: true }).extend({
      fee: Matter.create.shape.fee.optional(),
      costsDisclosure: Matter.create.shape.costsDisclosure.optional(),
    }),
    /**
     * CORE-05 intake: more party rows, created with the matter at `partyDocId(role, contactId)`
     * besides the clients, deceased and testator (duplicates collapse to one row).
     */
    parties: z.array(IntakePartyInput).max(100).optional(),
    /** Matter events; the date of death event is added from `matter.deceased.dateOfDeath`. */
    events: z.array(IntakeEventInput).max(20).optional(),
    /** The fee arrangement (wins over `matter.fee`). One of the two is required. */
    fee: FeeInput.optional(),
    /** Costs disclosure (wins over `matter.costsDisclosure`); computed from the fee's estimate when neither is given. */
    costsDisclosure: CostsDisclosureInput.optional(),
    /** The conflict check run for this intake: stored as `matter.conflictCheck.resultId`. */
    conflictCheckId: DocIdSchema.optional(),
  })
  .superRefine((input, ctx) => {
    if (!input.fee && !input.matter.fee) {
      ctx.addIssue({ code: 'custom', path: ['fee'], message: 'Choose a fee arrangement' });
    }
    const resultId = input.matter.conflictCheck.resultId;
    if (input.conflictCheckId && resultId && resultId !== input.conflictCheckId) {
      ctx.addIssue({
        code: 'custom',
        path: ['conflictCheckId'],
        message: 'The conflict check differs from matter.conflictCheck.resultId',
      });
    }
  });
export type CreateMatterInput = z.infer<typeof CreateMatterInput>;

/** `matters-changeStatus` (lawyer and above). */
export const ChangeMatterStatusInput = z.object({
  requestId: RequestId,
  matterId: DocIdSchema,
  to: MatterStatusSchema,
  reason: z.string().trim().max(500).optional(),
});
export type ChangeMatterStatusInput = z.infer<typeof ChangeMatterStatusInput>;

export interface CreateMatterResult {
  matterId: string;
  number: string;
  status: MatterStatus;
}
export interface ChangeMatterStatusResult {
  matterId: string;
  status: MatterStatus;
}

/** A soft-deleted matter can be restored (by `matters-restore`, owner or admin) for this long. */
export const MATTER_RESTORE_WINDOW_DAYS = 30;

/** `matters-restore` (owner and admin, within MATTER_RESTORE_WINDOW_DAYS of the delete). */
export const RestoreMatterInput = z.object({
  requestId: RequestId,
  matterId: DocIdSchema,
});
export type RestoreMatterInput = z.infer<typeof RestoreMatterInput>;

export interface RestoreMatterResult {
  matterId: string;
  /** False when the matter wasn't deleted (nothing to do). */
  restored: boolean;
}

/** Whether a matter deleted at `deletedAt` can still be restored at `now`. */
export function canRestoreMatter(deletedAt: Date, now: Date): boolean {
  return now.getTime() - deletedAt.getTime() <= MATTER_RESTORE_WINDOW_DAYS * 86_400_000;
}
