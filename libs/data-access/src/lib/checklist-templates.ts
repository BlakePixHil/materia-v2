import * as z from 'zod';

import { ChecklistTemplate, SoftDeleteShape } from '@materia/domain';

import type { QuerySpec } from './query';
import { repo, type Repository } from './repository';

const template = ChecklistTemplate.schema.shape;

/**
 * A checklist template as a task's Templates dialog reads it (`orgs/{orgId}/checklistTemplates`,
 * CORE-08d). Other fields are dropped, not rejected.
 */
export const ChecklistTemplateItemSchema = /* @__PURE__ */ z.object({
  name: template.name,
  items: template.items,
  priority: template.priority,
  dueInDays: template.dueInDays,
  updatedAt: template.updatedAt.optional(),
  updatedBy: template.updatedBy.optional(),
  deletedAt: SoftDeleteShape.deletedAt,
});
export type ChecklistTemplateItem = z.infer<typeof ChecklistTemplateItemSchema>;

/**
 * The org's checklist templates (CORE-08d): every member reads them; task.edit roles (`can('task.edit')`)
 * create them (`ChecklistTemplate.create`: name, items, optional priority and dueInDays), update the
 * same fields (clear `priority`/`dueInDays` with `{ remove: [...] }`) and soft delete them,
 * client-direct (the rules validate the values). Call it in an injection context.
 */
export function checklistTemplatesRepository(): Repository<ChecklistTemplateItem> {
  return repo((orgId) => `orgs/${orgId}/checklistTemplates`, {
    schema: ChecklistTemplateItemSchema,
    version: ChecklistTemplate.version,
    create: ChecklistTemplate.create,
    update: ChecklistTemplate.update,
  });
}

/** Every live checklist template, by name (an org keeps a handful; the dialog filters them). */
export const CHECKLIST_TEMPLATES_QUERY: QuerySpec<ChecklistTemplateItem> = {
  orderBy: [['name', 'asc']],
  pageSize: 200,
};
