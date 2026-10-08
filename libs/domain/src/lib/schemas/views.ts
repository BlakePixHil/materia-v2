import * as z from 'zod';

import { DocIdSchema, InstantSchema, NonEmptyString, withMeta } from './common';
import { JurisdictionSchema, MatterStatusSchema, MatterTypeSchema } from './enums';
import { RecentMatterCopySchema, type RecentMatterCopy } from './matter-records';

export const MATTER_SORT_FIELDS = [
  'number',
  'title',
  'type',
  'client',
  'responsible',
  'stage',
  'nextDeadline',
  'wip',
  'lastActivity',
] as const;
export type MatterSortField = (typeof MATTER_SORT_FIELDS)[number];
export const MATTER_GROUP_BY = ['none', 'status', 'type', 'responsible'] as const;
export type MatterGroupBy = (typeof MATTER_GROUP_BY)[number];

export const MatterViewFiltersSchema = z
  .object({
    status: z.array(MatterStatusSchema).optional(),
    type: z.array(MatterTypeSchema).optional(),
    /** `me` resolves to the viewer, so a shared definition stays personal. */
    responsible: z.union([z.literal('me'), DocIdSchema]).optional(),
    label: z.string().optional(),
    jurisdiction: JurisdictionSchema.optional(),
    hasOverdue: z.boolean().optional(),
    /** Recently closed: closed within this many days. */
    closedWithinDays: z.number().int().min(1).max(3650).optional(),
  })
  .strict();
export type MatterViewFilters = z.infer<typeof MatterViewFiltersSchema>;

export const MatterViewSortSchema = z.object({
  field: z.enum(MATTER_SORT_FIELDS),
  dir: z.enum(['asc', 'desc']),
});
export type MatterViewSort = z.infer<typeof MatterViewSortSchema>;

/** `users/{uid}/views/{viewId}`: a saved Matters list view, private to its user. */
export const SavedView = withMeta(
  () => ({
    orgId: DocIdSchema,
    list: z.literal('matters'),
    name: NonEmptyString.max(60),
    filters: MatterViewFiltersSchema,
    sort: MatterViewSortSchema,
    groupBy: z.enum(MATTER_GROUP_BY),
  }),
  { path: 'users/{uid}/views', migratable: false },
);
export type SavedView = z.infer<typeof SavedView.schema>;

/** How long a recent entry is kept after it was last opened (Firestore TTL on `expireAt`). */
export const RECENT_MATTER_TTL_DAYS = 90;

/** What a recent entry names (CORE-14 recorded matters; CORE-15 adds contacts, tasks and documents). */
export const RECENT_KINDS = ['matter', 'contact', 'task', 'document'] as const;
export type RecentKind = (typeof RECENT_KINDS)[number];
/** Recent entries the ⌘K palette shows while its query is empty (CORE-15). */
export const RECENT_ENTRIES_SHOWN = 10;

/**
 * `users/{uid}/recent/{id}`: something the person opened, private to them. Matters since CORE-14
 * (Today's Recent matters); contacts, tasks and documents since CORE-15 (the ⌘K palette's recents).
 * The client writes the whole entry each time the thing opens, so `updatedAt` is when it was last
 * opened. `expireAt` is that time plus `RECENT_MATTER_TTL_DAYS`, and Firestore TTL deletes the
 * entry then, which keeps the list small.
 *
 * - `kind`: entries written before CORE-15 have none and are matters.
 * - `matterId`: the matter itself, or the matter a task or document is on (absent for contacts and
 *   personal tasks).
 * - `entityId`: the contact, task or document (absent for a matter).
 *
 * - `matter`: for a matter, its number, title and type (SEC-07e, `RecentMatterCopySchema`), so
 *   Today names its Recent matters without reading each one; absent on entries from before it until
 *   `backfill-matter-copies` runs, and Today reads those matters instead.
 *
 * Otherwise ids only: the palette reads each entry's title (so a rename or a lost permission shows
 * at once).
 */
export const RecentMatter = withMeta(
  () => ({
    orgId: DocIdSchema,
    kind: z.enum(RECENT_KINDS).default('matter'),
    matterId: DocIdSchema.optional(),
    entityId: DocIdSchema.optional(),
    matter: RecentMatterCopySchema.optional(),
    expireAt: InstantSchema,
  }),
  { path: 'users/{uid}/recent', migratable: false },
);
export type RecentMatter = z.infer<typeof RecentMatter.schema>;

/** What a recent entry points at, and for a matter, its name as the screen shows it (SEC-07e). */
export interface RecentRef {
  kind: RecentKind;
  matterId?: string | null | undefined;
  entityId?: string | null | undefined;
  matter?: RecentMatterCopy | null | undefined;
}

/** A recent matter's document id: one entry per org and matter (CORE-14). */
export function recentMatterId(orgId: string, matterId: string): string {
  return `${orgId}_${matterId}`;
}

/**
 * A recent entry's document id: `{orgId}_{matterId}` for a matter (as CORE-14 wrote them), and
 * `{orgId}_{kind}[_{matterId}]_{entityId}` otherwise (task ids repeat across matters: `tpl-…`).
 */
export function recentEntryId(orgId: string, ref: RecentRef): string {
  if (ref.kind === 'matter') return recentMatterId(orgId, ref.matterId ?? '');
  return [orgId, ref.kind, ...(ref.matterId ? [ref.matterId] : []), ref.entityId ?? ''].join('_');
}

/** When a recent entry opened at `openedAt` expires. */
export function recentMatterExpireAt(openedAt: Date): Date {
  return new Date(openedAt.getTime() + RECENT_MATTER_TTL_DAYS * 86_400_000);
}
