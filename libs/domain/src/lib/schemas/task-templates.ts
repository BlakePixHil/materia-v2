import * as z from 'zod';

import { NonEmptyString, withMeta } from './common';
import { PrioritySchema } from './enums';

const ORG = 'orgs/{orgId}';

/** Limits on checklist templates (CORE-08d); the items match a template task's checklist (CORE-07). */
export const CHECKLIST_TEMPLATE_NAME_MAX = 100;
export const CHECKLIST_TEMPLATE_ITEMS_MAX = 30;
export const CHECKLIST_TEMPLATE_ITEM_MAX = 200;
export const CHECKLIST_TEMPLATE_DUE_MAX_DAYS = 365;

/** One checklist line: trimmed, non-empty, on a single line. */
export const ChecklistTemplateItemSchema = NonEmptyString.max(CHECKLIST_TEMPLATE_ITEM_MAX).regex(/^[^\r\n]*$/, {
  message: 'One item per line',
});

/**
 * `orgs/{orgId}/checklistTemplates/{id}` (CORE-08d): a reusable checklist ("Probate kick-off")
 * applied to a task from its details. `priority` and `dueInDays` fill in a task's priority and due
 * date when it has none. Every member reads them; task.edit roles create, edit and soft delete them
 * client-direct (the rules validate the values).
 */
export const ChecklistTemplate = withMeta(
  () => ({
    name: NonEmptyString.max(CHECKLIST_TEMPLATE_NAME_MAX),
    items: z.array(ChecklistTemplateItemSchema).min(1).max(CHECKLIST_TEMPLATE_ITEMS_MAX),
    priority: PrioritySchema.optional(),
    dueInDays: z.number().int().min(0).max(CHECKLIST_TEMPLATE_DUE_MAX_DAYS).optional(),
  }),
  // Migratable: the legacy board checklist templates load here (MIG-03).
  { path: `${ORG}/checklistTemplates`, softDelete: true },
);

/** Limits on task group templates (CORE-08f); the name becomes a task's group (≤ 120). */
export const TASK_GROUP_TEMPLATE_NAME_MAX = 120;
export const TASK_GROUP_TEMPLATE_TASKS_MAX = 50;
export const TASK_GROUP_TEMPLATE_TITLE_MAX = 500;

/** One task of a task group template: a single-line title, its checklist lines and defaults. */
export const TaskGroupTemplateTaskSchema = z.object({
  title: NonEmptyString.max(TASK_GROUP_TEMPLATE_TITLE_MAX).regex(/^[^\r\n]*$/, { message: 'One task per line' }),
  checklist: z.array(ChecklistTemplateItemSchema).max(CHECKLIST_TEMPLATE_ITEMS_MAX).default([]),
  priority: PrioritySchema.optional(),
  dueInDays: z.number().int().min(0).max(CHECKLIST_TEMPLATE_DUE_MAX_DAYS).optional(),
});
export type TaskGroupTemplateTask = z.infer<typeof TaskGroupTemplateTaskSchema>;

/**
 * `orgs/{orgId}/taskGroupTemplates/{id}` (CORE-08f): a reusable group of tasks ("Checklist A":
 * tasks, each with its checklist) applied to a matter's Tasks tab, where the tasks land in a group
 * named after the template. Every member reads them; task.edit roles create, edit and soft delete
 * them client-direct (the rules check the name and the list sizes).
 */
export const TaskGroupTemplate = withMeta(
  () => ({
    name: NonEmptyString.max(TASK_GROUP_TEMPLATE_NAME_MAX),
    tasks: z.array(TaskGroupTemplateTaskSchema).min(1).max(TASK_GROUP_TEMPLATE_TASKS_MAX),
  }),
  { path: `${ORG}/taskGroupTemplates`, softDelete: true, migratable: false },
);

export type ChecklistTemplate = z.infer<typeof ChecklistTemplate.schema>;
export type TaskGroupTemplate = z.infer<typeof TaskGroupTemplate.schema>;
