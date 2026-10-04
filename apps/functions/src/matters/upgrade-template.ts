import {
  DomainError,
  isSystemTemplateId,
  mapStageAcrossVersions,
  PERMISSIONS,
  today,
  UpgradeMatterTemplateInput,
  type UpgradeMatterTemplateResult,
} from '@materia/domain';

import { liveMatter, matterPath } from './shared';
import { audit } from '../audit/audit';
import { stamp } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { orgClock } from '../core/emulator-clock';
import { requireFlag } from '../core/flags';
import { assertOpen } from '../templates/apply';
import {
  anchorContext,
  createMissingTasks,
  firstActiveParalegal,
  orgTimeZone,
  planTemplateTasks,
  readEvents,
  readTemplate,
  readWith,
  templateVersionPath,
} from '../templates/shared';

/**
 * `matters-upgradeTemplate` (CORE-07, `matter.edit`, flag `templates.system`). Moves a live, open
 * matter to a later (or the same) published version of its template. Only tasks missing for the
 * current stage are added, plus later tasks whose anchor event is known; earlier stages never get
 * new tasks, and nothing is deleted. Future stages get the new version's tasks when entered. A
 * stage the new version dropped follows the versions' `stageMapping`, else FAILED_PRECONDITION
 * (`details.reason: 'stage_unmapped'`). No template: FAILED_PRECONDITION (`'no_template'`); an
 * earlier version: INVALID_ARGUMENT on `version`; an unknown one: NOT_FOUND. Audited as
 * `matter.template_upgraded`.
 */
export const upgradeTemplateDefinition = {
  name: 'matters-upgradeTemplate',
  input: UpgradeMatterTemplateInput,
  roles: PERMISSIONS['matter.edit'],
  idempotent: true,
  handler: async (ctx): Promise<UpgradeMatterTemplateResult> => {
    const { input, orgId, uid, role, db, requestId, log } = ctx;
    await requireFlag({ orgId, db, clock: ctx.clock }, 'templates.system');
    const clock = await orgClock(db, orgId, ctx.clock);
    const now = clock.now();
    const ref = db.doc(matterPath(orgId, input.matterId));
    const [timeZone, paralegalUid] = await Promise.all([orgTimeZone(db, orgId), firstActiveParalegal(db, orgId)]);

    const result = await db.runTransaction(async (tx) => {
      const data = liveMatter(await tx.get(ref), role, input.matterId);
      assertOpen(data, input.matterId);
      const templateId = data['templateId'];
      if (typeof templateId !== 'string' || !templateId) {
        throw new DomainError('FAILED_PRECONDITION', 'The matter has no template', {
          reason: 'no_template',
          matterId: input.matterId,
        });
      }
      const from = typeof data['templateVersion'] === 'number' ? data['templateVersion'] : 0;
      if (input.version < from) {
        throw new DomainError('INVALID_ARGUMENT', 'A matter cannot go back to an earlier template version', {
          fields: { version: ['Choose this version or a later one'] },
          current: from,
        });
      }
      const template = await readTemplate(db, readWith(tx), orgId, templateId, input.version);
      if (!template) {
        throw new DomainError('NOT_FOUND', 'Template version not found', { templateId, version: input.version });
      }
      const current = typeof data['stageId'] === 'string' ? data['stageId'] : undefined;
      let stageId = template.stages[0]?.id as string;
      if (current) {
        // Versions published since the matter's, for the mappings of stages they dropped.
        const between = isSystemTemplateId(templateId)
          ? []
          : await Promise.all(
              Array.from({ length: Math.max(0, input.version - from) }, (_, i) =>
                tx.get(db.doc(templateVersionPath(orgId, templateId, from + i + 1))),
              ),
            );
        const versions = between.map((snap) => ({
          stages: (snap.get('stages') ?? []) as { id: string }[],
          stageMapping: snap.get('stageMapping') as Record<string, string> | undefined,
        }));
        const mapped = template.stages.some((stage) => stage.id === current)
          ? current
          : mapStageAcrossVersions(current, versions);
        if (!mapped || !template.stages.some((stage) => stage.id === mapped)) {
          throw new DomainError('FAILED_PRECONDITION', 'The matter’s stage is not in that version', {
            reason: 'stage_unmapped',
            matterId: input.matterId,
            stageId: current,
            version: input.version,
          });
        }
        stageId = mapped;
      }
      const stageEnteredOn =
        stageId === current && typeof data['stageEnteredOn'] === 'string'
          ? (data['stageEnteredOn'] as ReturnType<typeof today>)
          : today(timeZone, now);
      const events = await readEvents(db, tx, orgId, input.matterId);
      const planned = planTemplateTasks(template, anchorContext(data, events), {
        orgId,
        matterId: input.matterId,
        stageId,
        stageEnteredOn,
        knownAnchors: true,
        responsibleUid: String(data['responsibleUid']),
        paralegalUid,
        uid,
        now,
        requestId,
      });
      const created = await createMissingTasks(db, tx, ref, planned);
      tx.update(ref, {
        templateVersion: template.version,
        stageId,
        stageEnteredOn,
        ...stamp(uid, now, requestId),
      });
      created.write();
      return { templateId, from, stageId, stageFrom: current ?? null, createdTaskIds: created.ids };
    });

    await audit(ctx, {
      action: 'matter.template_upgraded',
      entity: { path: ref.path },
      summary: `Matter ${input.matterId} moved to template ${result.templateId} v${input.version}`,
      data: {
        templateId: result.templateId,
        from: result.from,
        to: input.version,
        stageFrom: result.stageFrom,
        stageTo: result.stageId,
        createdTasks: result.createdTaskIds.length,
      },
    });
    log.info('matter template upgraded', {
      matterId: input.matterId,
      from: result.from,
      to: input.version,
      created: result.createdTaskIds.length,
    });
    return {
      matterId: input.matterId,
      templateId: result.templateId,
      version: input.version,
      stageId: result.stageId,
      createdTaskIds: result.createdTaskIds,
    };
  },
} satisfies CallableDefinition<typeof UpgradeMatterTemplateInput, UpgradeMatterTemplateResult>;

export const upgradeTemplate = defineCallable(upgradeTemplateDefinition);
