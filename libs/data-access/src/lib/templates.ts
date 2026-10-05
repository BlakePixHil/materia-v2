import * as z from 'zod';

import {
  MatterTemplate,
  type ApplyTemplateInput,
  type ApplyTemplateResult,
  type CloneTemplateInput,
  type CloneTemplateResult,
  type PublishTemplateInput,
  type PublishTemplateResult,
  type SaveTemplateInput,
  type SaveTemplateResult,
} from '@materia/domain';

import type { CallableClient } from './callable-client';
import type { QuerySpec } from './query';
import { repo, type Repository } from './repository';

const template = MatterTemplate.schema.shape;

/**
 * An org's matter template as Settings → Templates reads it (`orgs/{orgId}/templates/{id}`,
 * CORE-07): the draft content plus its latest published version. Written by the `templates-*`
 * callables only.
 */
export const OrgTemplateSchema = /* @__PURE__ */ z.object({
  matterType: template.matterType,
  name: template.name,
  stages: template.stages,
  tasks: template.tasks,
  deadlineRuleIds: template.deadlineRuleIds,
  version: template.version,
  source: template.source,
  basedOn: template.basedOn,
  published: template.published,
  publishedAt: template.publishedAt,
  updatedAt: template.updatedAt.optional(),
});
export type OrgTemplate = z.infer<typeof OrgTemplateSchema>;

/** The org's templates (read-only: they change through the `templates-*` callables). */
export function orgTemplatesRepository(): Repository<OrgTemplate> {
  return repo((orgId) => `orgs/${orgId}/templates`, { schema: OrgTemplateSchema, version: MatterTemplate.version });
}

/** Every org template, by name (an org has a handful). */
export const ORG_TEMPLATES_QUERY: QuerySpec<OrgTemplate> = { orderBy: [['name', 'asc']], pageSize: 100 };

/** The `templates-*` callables (built in apps/functions/src/templates, CORE-07). */
export const TEMPLATE_CALLABLES = {
  /** `CloneTemplateInput` → `CloneTemplateResult` (org.settings). */
  clone: 'templates-clone',
  /** `SaveTemplateInput` → `SaveTemplateResult` (org.settings). */
  save: 'templates-save',
  /** `PublishTemplateInput` → `PublishTemplateResult` (org.settings). */
  publish: 'templates-publish',
  /** `ApplyTemplateInput` → `ApplyTemplateResult` (matter.edit). */
  apply: 'templates-apply',
} as const;

/** Callable input without the request id, which the client adds. */
type Input<T> = Omit<T, 'requestId'>;

/** The `templates-*` callables, typed. Every call is idempotent. All need the `templates.system` flag. */
export interface TemplateCallables {
  /** A new org draft from a system or org template. */
  clone(input: Input<CloneTemplateInput>): Promise<CloneTemplateResult>;
  /** Replaces fields of a draft; INVALID_ARGUMENT names field paths (`stages.2.id`). */
  save(input: Input<SaveTemplateInput>): Promise<SaveTemplateResult>;
  /** Publishes the draft as the next version; TEMPLATE_STAGE_MAPPING_REQUIRED asks for `stageMapping`. */
  publish(input: Input<PublishTemplateInput>): Promise<PublishTemplateResult>;
  /** Gives a matter a template version and creates its tasks. */
  apply(input: Input<ApplyTemplateInput>): Promise<ApplyTemplateResult>;
}

export function templateCallables(client: Pick<CallableClient, 'call'>): TemplateCallables {
  const call =
    <I extends object, O>(name: string) =>
    (input: I) =>
      client.call<I, O>(name, input, { idempotent: true });
  return {
    clone: call(TEMPLATE_CALLABLES.clone),
    save: call(TEMPLATE_CALLABLES.save),
    publish: call(TEMPLATE_CALLABLES.publish),
    apply: call(TEMPLATE_CALLABLES.apply),
  };
}
