import { z } from 'zod';

import { SoftDeleteShape, TaskGroupTemplate } from '@materia/domain';

import type { QuerySpec } from './query';
import { repo, type Repository } from './repository';

const template = TaskGroupTemplate.schema.shape;

/**
 * A task group template as the matter Tasks tab's Templates dialog reads it
 * (`orgs/{orgId}/taskGroupTemplates`, CORE-08f). Other fields are dropped, not rejected.
 */
export const TaskGroupTemplateItemSchema = /* @__PURE__ */ z.object({
  name: template.name,
  tasks: template.tasks,
  updatedAt: template.updatedAt.optional(),
  updatedBy: template.updatedBy.optional(),
  deletedAt: SoftDeleteShape.deletedAt,
});
export type TaskGroupTemplateItem = z.infer<typeof TaskGroupTemplateItemSchema>;

/**
 * The org's task group templates (CORE-08f): every member reads them; task.edit roles
 * (`can('task.edit')`) create them (`TaskGroupTemplate.create`: name and tasks), update the same
 * fields and soft delete them, client-direct (the rules check the name and list sizes). Call it in
 * an injection context.
 */
export function taskGroupTemplatesRepository(): Repository<TaskGroupTemplateItem> {
  return repo((orgId) => `orgs/${orgId}/taskGroupTemplates`, {
    schema: TaskGroupTemplateItemSchema,
    version: TaskGroupTemplate.version,
    create: TaskGroupTemplate.create,
    update: TaskGroupTemplate.update,
  });
}

/** Every live task group template, by name (an org keeps a handful; the dialog filters them). */
export const TASK_GROUP_TEMPLATES_QUERY: QuerySpec<TaskGroupTemplateItem> = {
  orderBy: [['name', 'asc']],
  pageSize: 200,
};
