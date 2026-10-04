import {
  CloneTemplateInput,
  DomainError,
  isSystemTemplateId,
  MatterTemplate,
  MatterTemplateVersion,
  PERMISSIONS,
  PublishTemplateInput,
  removedStageIds,
  SaveTemplateInput,
  TemplateContentSchema,
  type CloneTemplateResult,
  type FieldErrors,
  type PublishTemplateResult,
  type SaveTemplateResult,
  type TemplateContent,
} from '@materia/domain';

import { readTemplate, readWith, templatePath, templatesPath, templateVersionPath } from './shared';
import { audit } from '../audit/audit';
import { compact, isDeleted, stamp } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { requireFlag } from '../core/flags';
import { mattersPath } from '../matters/shared';

/**
 * Org templates (CORE-07): `templates-clone`, `templates-save` and `templates-publish`, all
 * `org.settings` (owner and admin) behind the `templates.system` flag. The draft lives on
 * `orgs/{orgId}/templates/{id}`; each publish copies it to `versions/{n}`, immutable.
 */

type Data = Record<string, unknown>;

/** The draft content of an org template document, or NOT_FOUND (system ids are read-only here). */
function orgDraft(templateId: string, data: Data | undefined): TemplateContent & { version: number } {
  if (isSystemTemplateId(templateId) || !data || data['source'] !== 'org') {
    throw new DomainError('NOT_FOUND', 'Template not found', { templateId });
  }
  const version = typeof data['version'] === 'number' ? data['version'] : 0;
  return {
    matterType: data['matterType'] as TemplateContent['matterType'],
    name: String(data['name'] ?? ''),
    stages: (data['stages'] ?? []) as TemplateContent['stages'],
    tasks: (data['tasks'] ?? []) as TemplateContent['tasks'],
    deadlineRuleIds: (data['deadlineRuleIds'] ?? []) as string[],
    version,
  };
}

/**
 * `templates-clone`: a new org draft (version 0, unpublished) from a system template
 * (`system-{type}`) or an org template's published version (`version`, else the latest).
 * `basedOn` records the source. NOT_FOUND when there is no such template or version.
 */
export const cloneDefinition = {
  name: 'templates-clone',
  input: CloneTemplateInput,
  roles: PERMISSIONS['org.settings'],
  idempotent: true,
  handler: async (ctx): Promise<CloneTemplateResult> => {
    const { input, orgId, uid, db, clock, requestId, log } = ctx;
    await requireFlag({ orgId, db, clock }, 'templates.system');
    const source = await readTemplate(db, readWith(), orgId, input.sourceTemplateId, input.version);
    if (!source) {
      throw new DomainError('NOT_FOUND', 'Template not found', {
        templateId: input.sourceTemplateId,
        ...(input.version ? { version: input.version } : {}),
      });
    }
    const now = clock.now();
    const ref = db.collection(templatesPath(orgId)).doc();
    await ref.create(
      MatterTemplate.schema.parse({
        matterType: source.matterType,
        name: input.name ?? source.name,
        stages: source.stages,
        tasks: source.tasks,
        deadlineRuleIds: source.deadlineRuleIds,
        version: 0,
        source: 'org',
        basedOn: { templateId: source.id, version: source.version },
        published: false,
        createdAt: now,
        createdBy: uid,
        updatedAt: now,
        updatedBy: uid,
        _requestId: requestId,
        schemaVersion: MatterTemplate.version,
      }),
    );
    await audit(ctx, {
      action: 'template.cloned',
      entity: { path: ref.path },
      summary: `Template ${ref.id} cloned from ${source.id} v${source.version}`,
      data: { from: source.id, fromVersion: source.version, matterType: source.matterType },
    });
    log.info('template cloned', { templateId: ref.id, from: source.id, fromVersion: source.version });
    return { templateId: ref.id };
  },
} satisfies CallableDefinition<typeof CloneTemplateInput, CloneTemplateResult>;

/**
 * `templates-save`: replaces the given fields of an org template's draft (`name`, `stages`,
 * `tasks`, `deadlineRuleIds`; the matter type never changes). The whole draft must be valid
 * (`TemplateContentSchema`), else INVALID_ARGUMENT with field paths (`stages.2.id`). Published
 * versions are untouched until the next publish.
 */
export const saveDefinition = {
  name: 'templates-save',
  input: SaveTemplateInput,
  roles: PERMISSIONS['org.settings'],
  idempotent: true,
  handler: async (ctx): Promise<SaveTemplateResult> => {
    const { input, orgId, uid, db, clock, requestId, log } = ctx;
    await requireFlag({ orgId, db, clock }, 'templates.system');
    const ref = db.doc(templatePath(orgId, input.templateId));
    const now = clock.now();
    const changed = await db.runTransaction(async (tx) => {
      const draft = orgDraft(input.templateId, (await tx.get(ref)).data());
      const next = TemplateContentSchema.parse({
        matterType: draft.matterType,
        name: input.name ?? draft.name,
        stages: input.stages ?? draft.stages,
        tasks: input.tasks ?? draft.tasks,
        deadlineRuleIds: input.deadlineRuleIds ?? draft.deadlineRuleIds,
      });
      const fields = (['name', 'stages', 'tasks', 'deadlineRuleIds'] as const).filter(
        (key) => input[key] !== undefined,
      );
      tx.update(ref, {
        name: next.name,
        stages: next.stages.map((stage) => compact(stage)),
        tasks: next.tasks.map((task) => compact(task)),
        deadlineRuleIds: next.deadlineRuleIds,
        ...stamp(uid, now, requestId),
      });
      return fields;
    });
    await audit(ctx, {
      action: 'template.saved',
      entity: { path: ref.path },
      summary: `Template ${input.templateId} draft saved`,
      data: { fields: changed },
    });
    log.info('template saved', { templateId: input.templateId, fields: changed });
    return { templateId: input.templateId };
  },
} satisfies CallableDefinition<typeof SaveTemplateInput, SaveTemplateResult>;

/**
 * `templates-publish`: the draft becomes version `n + 1` (`versions/{n + 1}`, immutable) and the
 * template's `version`, `published`, `publishedAt` and `publishedBy` follow. Matters keep the
 * version they have. A draft that drops a stage some live matter on this template is in needs
 * `stageMapping[stageId]` naming a stage of the draft, else TEMPLATE_STAGE_MAPPING_REQUIRED
 * (`details.stages`); a mapping to an unknown stage is INVALID_ARGUMENT on `stageMapping.{id}`.
 * The mapping is stored on the version for `matters-upgradeTemplate`.
 */
export const publishDefinition = {
  name: 'templates-publish',
  input: PublishTemplateInput,
  roles: PERMISSIONS['org.settings'],
  idempotent: true,
  handler: async (ctx): Promise<PublishTemplateResult> => {
    const { input, orgId, uid, db, clock, requestId, log } = ctx;
    await requireFlag({ orgId, db, clock }, 'templates.system');
    const ref = db.doc(templatePath(orgId, input.templateId));
    const now = clock.now();
    const published = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const draft = orgDraft(input.templateId, snap.data());
      const content = TemplateContentSchema.parse({
        matterType: draft.matterType,
        name: draft.name,
        stages: draft.stages,
        tasks: draft.tasks,
        deadlineRuleIds: draft.deadlineRuleIds,
      });
      const previous =
        draft.version >= 1 ? await readTemplate(db, readWith(tx), orgId, input.templateId, draft.version) : undefined;
      const removed = previous ? removedStageIds(previous, content) : [];
      const mapping = input.stageMapping ?? {};
      const kept = new Set(content.stages.map((stage) => stage.id));
      const fields: FieldErrors = {};
      for (const [from, to] of Object.entries(mapping)) {
        if (!removed.includes(from)) fields[`stageMapping.${from}`] = ['This stage is not being removed'];
        else if (!kept.has(to)) fields[`stageMapping.${from}`] = ['Choose a stage of the new version'];
      }
      if (Object.keys(fields).length) throw new DomainError('INVALID_ARGUMENT', 'Invalid stage mapping', { fields });
      if (removed.length) {
        const matters = await tx.get(db.collection(mattersPath(orgId)).where('templateId', '==', input.templateId));
        const occupied = new Set(
          matters.docs
            .map((doc) => doc.data())
            .filter((data) => !isDeleted(data))
            .map((data) => data['stageId'])
            .filter((stageId): stageId is string => typeof stageId === 'string' && removed.includes(stageId)),
        );
        const unmapped = [...occupied].filter((stageId) => !mapping[stageId]).sort();
        if (unmapped.length) {
          throw new DomainError('TEMPLATE_STAGE_MAPPING_REQUIRED', 'Map the removed stages matters are in', {
            templateId: input.templateId,
            stages: unmapped,
            allowed: [...kept],
          });
        }
      }
      const version = draft.version + 1;
      const stageMapping = Object.fromEntries(Object.entries(mapping).filter(([from]) => removed.includes(from)));
      const basedOn = snap.get('basedOn') as Data | undefined;
      tx.create(
        db.doc(templateVersionPath(orgId, input.templateId, version)),
        MatterTemplateVersion.schema.parse({
          ...content,
          stages: content.stages.map((stage) => compact(stage)),
          tasks: content.tasks.map((task) => compact(task)),
          templateId: input.templateId,
          version,
          source: 'org',
          ...(basedOn ? { basedOn } : {}),
          published: true,
          publishedAt: now,
          publishedBy: uid,
          ...(Object.keys(stageMapping).length ? { stageMapping } : {}),
          createdAt: now,
          createdBy: uid,
          updatedAt: now,
          updatedBy: uid,
          _requestId: requestId,
          schemaVersion: MatterTemplateVersion.version,
        }),
      );
      tx.update(ref, { version, published: true, publishedAt: now, publishedBy: uid, ...stamp(uid, now, requestId) });
      return { version, removed };
    });
    await audit(ctx, {
      action: 'template.published',
      entity: { path: ref.path },
      summary: `Template ${input.templateId} published as v${published.version}`,
      data: { version: published.version, removedStages: published.removed },
    });
    log.info('template published', { templateId: input.templateId, version: published.version });
    return { templateId: input.templateId, version: published.version };
  },
} satisfies CallableDefinition<typeof PublishTemplateInput, PublishTemplateResult>;

export const clone = defineCallable(cloneDefinition);
export const save = defineCallable(saveDefinition);
export const publish = defineCallable(publishDefinition);
