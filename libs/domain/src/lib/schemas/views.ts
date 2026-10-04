import { z } from 'zod';

import { DocIdSchema, NonEmptyString, withMeta } from './common';
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
