import { z } from 'zod';

import { DocIdSchema, InstantSchema, NonEmptyString, withMeta } from './common';
import { JurisdictionSchema, MatterStatusSchema, MatterTypeSchema } from './enums';

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
  {
    orgId: DocIdSchema,
    list: z.literal('matters'),
    name: NonEmptyString.max(60),
    filters: MatterViewFiltersSchema,
    sort: MatterViewSortSchema,
    groupBy: z.enum(MATTER_GROUP_BY),
  },
  { path: 'users/{uid}/views', migratable: false },
);
export type SavedView = z.infer<typeof SavedView.schema>;

/** How long a recent matter is kept after it was last opened (Firestore TTL on `expireAt`). */
export const RECENT_MATTER_TTL_DAYS = 90;

/**
 * `users/{uid}/recent/{orgId}_{matterId}`: a matter the person opened (CORE-14), private to them.
 * The client writes the whole entry each time the matter screen opens, so `updatedAt` is when it
 * was last opened; Today lists the latest few in the current org. `expireAt` is that time plus
 * `RECENT_MATTER_TTL_DAYS`, and Firestore TTL deletes the entry then, which keeps the list small.
 */
export const RecentMatter = withMeta(
  {
    orgId: DocIdSchema,
    matterId: DocIdSchema,
    expireAt: InstantSchema,
  },
  { path: 'users/{uid}/recent', migratable: false },
);
export type RecentMatter = z.infer<typeof RecentMatter.schema>;

/** A recent matter's document id: one entry per org and matter. */
export function recentMatterId(orgId: string, matterId: string): string {
  return `${orgId}_${matterId}`;
}

/** When a recent matter opened at `openedAt` expires. */
export function recentMatterExpireAt(openedAt: Date): Date {
  return new Date(openedAt.getTime() + RECENT_MATTER_TTL_DAYS * 86_400_000);
}
