import {
  can,
  ChangeMatterStageInput,
  DomainError,
  hasUnmetStageEntry,
  MatterTypeSchema,
  matterStages,
  PERMISSIONS,
  stageIndex,
  templateTaskDocId,
  today,
  unmetStageEntry,
  unmetStageRequirements,
  type ChangeMatterStageResult,
  type FactMatter,
} from '@materia/domain';

import { liveMatter, matterPath } from './shared';
import { audit } from '../audit/audit';
import { isDeleted, stamp } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { orgClock } from '../core/emulator-clock';
import { isEnabled } from '../core/flags';
import { recomputeMatter } from '../deadlines/recompute';
import { FROZEN_STATUSES } from '../templates/apply';
import {
  anchorContext,
  createMissingTasks,
  firstActiveParalegal,
  orgTimeZone,
  planTemplateTasks,
  readEvents,
  readMatterTemplateStages,
  readTemplate,
  readWith,
} from '../templates/shared';

/**
 * `matters-changeStage` (CORE-06, CORE-07; `matter.edit`). Moves a live, visible matter that is not
 * closed or archived (FAILED_PRECONDITION, `details.reason: 'matter_closed'`) to another of its
 * stages: its template version's (system bundle, `templates/{id}/versions/{n}`, else the template
 * document) when it has one, else the type's defaults (`matterStages`). An unknown stage is
 * INVALID_ARGUMENT on `stageId`; the same stage is a no-op.
 *
 * With `templates.system` off (CORE-06): a forward move needs the key facts its stages require,
 * else MATTER_STAGE_REQUIREMENTS with `details.requirements` (key fact ids); moving back is free.
 *
 * With it on (CORE-07): a forward move (skips included) needs, for every stage passed into, its key
 * facts (`details.requirements`), known events (`details.events`) and done template tasks
 * (`details.tasks`, template task keys). Moving back needs `matter.status` (PERMISSION_DENIED,
 * `details.reason: 'stage_back_requires_lawyer'`) and a `reason` (INVALID_ARGUMENT on `reason`);
 * later stages' tasks stay. Entering a stage creates its template tasks (idempotent, due dates
 * from today in the org's time zone or their anchor events) and records `stageEnteredOn`.
 *
 * Audited as `matter.stage_changed` with from and to (and the direction and reason going back).
 * Then the matter's deadlines are recomputed (CORE-10; cause `stage`), creating rule tasks that
 * wait for the new stage.
 */
export const changeStageDefinition = {
  name: 'matters-changeStage',
  input: ChangeMatterStageInput,
  roles: PERMISSIONS['matter.edit'],
  idempotent: true,
  handler: async (ctx): Promise<ChangeMatterStageResult> => {
    const { input, orgId, uid, role, db, requestId, log } = ctx;
    const ref = db.doc(matterPath(orgId, input.matterId));
    const templatesOn = await isEnabled({ orgId, db, clock: ctx.clock }, 'templates.system');
    const clock = templatesOn ? await orgClock(db, orgId, ctx.clock) : ctx.clock;
    const now = clock.now();
    const [timeZone, paralegalUid] = templatesOn
      ? await Promise.all([orgTimeZone(db, orgId), firstActiveParalegal(db, orgId)])
      : [undefined, undefined];

    const moved = await db.runTransaction(async (tx) => {
      const data = liveMatter(await tx.get(ref), role, input.matterId);
      if (FROZEN_STATUSES.has(data['status'])) {
        throw new DomainError('FAILED_PRECONDITION', 'A closed or archived matter’s stage cannot change', {
          reason: 'matter_closed',
          matterId: input.matterId,
          status: String(data['status']),
        });
      }
      const type = MatterTypeSchema.safeParse(data['type']);
      if (!type.success) {
        throw new DomainError('FAILED_PRECONDITION', 'The matter has no valid type', {
          reason: 'invalid_type',
          matterId: input.matterId,
        });
      }
      const stages = matterStages(type.data, await readMatterTemplateStages(db, readWith(tx), orgId, data));
      if (!stages.some((stage) => stage.id === input.stageId)) {
        throw new DomainError('INVALID_ARGUMENT', 'Unknown stage', {
          fields: { stageId: ['Choose one of the matter’s stages'] },
          allowed: stages.map((stage) => stage.id),
        });
      }
      const current = typeof data['stageId'] === 'string' ? data['stageId'] : undefined;
      if (current === input.stageId) return { current, changed: false, back: false, createdTaskIds: [] };

      if (!templatesOn) {
        const requirements = unmetStageRequirements(data as FactMatter, stages, current, input.stageId);
        if (requirements.length) {
          throw new DomainError('MATTER_STAGE_REQUIREMENTS', 'Record the key facts this stage needs first', {
            matterId: input.matterId,
            stageId: input.stageId,
            requirements,
          });
        }
        tx.update(ref, { stageId: input.stageId, ...stamp(uid, now, requestId) });
        return { current, changed: true, back: false, createdTaskIds: [] };
      }

      const back = stages.findIndex((stage) => stage.id === input.stageId) < stageIndex(stages, current);
      if (back) {
        if (!can(role, 'matter.status')) {
          throw new DomainError('PERMISSION_DENIED', 'Moving a matter back a stage needs a lawyer', {
            reason: 'stage_back_requires_lawyer',
            matterId: input.matterId,
          });
        }
        if (!input.reason) {
          throw new DomainError('INVALID_ARGUMENT', 'Give a reason for moving the matter back', {
            fields: { reason: ['Say why the matter is moving back a stage'] },
          });
        }
      }
      const events = await readEvents(db, tx, orgId, input.matterId);
      const anchors = anchorContext(data, events);
      const required = [...new Set(stages.flatMap((stage) => stage.tasksDone ?? []))];
      const taskSnaps = await Promise.all(
        required.map((key) => tx.get(db.doc(`${ref.path}/tasks/${templateTaskDocId(key)}`))),
      );
      const doneTaskKeys = new Set(
        required.filter((_, i) => {
          const task = taskSnaps[i]?.data();
          return !!task && !isDeleted(task) && task['status'] === 'done';
        }),
      );
      const unmet = unmetStageEntry(stages, current, input.stageId, { ...anchors, doneTaskKeys });
      if (hasUnmetStageEntry(unmet)) {
        throw new DomainError('MATTER_STAGE_REQUIREMENTS', 'Complete what this stage needs first', {
          matterId: input.matterId,
          stageId: input.stageId,
          ...unmet,
        });
      }

      const templateId = data['templateId'];
      const version = data['templateVersion'];
      const template =
        typeof templateId === 'string' && templateId
          ? await readTemplate(
              db,
              readWith(tx),
              orgId,
              templateId,
              typeof version === 'number' && version >= 1 ? version : undefined,
            )
          : undefined;
      const stageEnteredOn = today(timeZone, now);
      const created = template
        ? await createMissingTasks(
            db,
            tx,
            ref,
            planTemplateTasks(template, anchors, {
              orgId,
              matterId: input.matterId,
              stageId: input.stageId,
              stageEnteredOn,
              knownAnchors: false,
              responsibleUid: String(data['responsibleUid']),
              paralegalUid,
              uid,
              now,
              requestId,
            }),
          )
        : { ids: [], write: () => undefined };
      tx.update(ref, { stageId: input.stageId, stageEnteredOn, ...stamp(uid, now, requestId) });
      created.write();
      return { current, changed: true, back, createdTaskIds: created.ids };
    });

    if (moved.changed) {
      await audit(
        { uid, orgId, requestId, db, clock },
        {
          action: 'matter.stage_changed',
          entity: { path: ref.path },
          summary: `Matter ${input.matterId} moved from stage ${moved.current ?? '(none)'} to ${input.stageId}`,
          data: {
            from: moved.current ?? null,
            to: input.stageId,
            ...(moved.back ? { direction: 'back', reason: input.reason ?? '' } : {}),
            ...(moved.createdTaskIds.length ? { createdTasks: moved.createdTaskIds.length } : {}),
          },
        },
      );
      log.info('matter stage changed', {
        matterId: input.matterId,
        from: moved.current ?? null,
        to: input.stageId,
        created: moved.createdTaskIds.length,
      });
      // CORE-10: rule tasks that wait for this stage, and anything else that changed. Best effort:
      // the stage has moved either way, and the next recompute catches up.
      try {
        await recomputeMatter(db, {
          orgId,
          matterId: input.matterId,
          uid,
          role,
          requestId,
          cause: 'stage',
          clock,
          log,
        });
      } catch (error) {
        log.error('deadline recompute after stage change failed', {
          matterId: input.matterId,
          errorType: error instanceof Error ? error.name : typeof error,
        });
      }
    }
    return {
      matterId: input.matterId,
      stageId: input.stageId,
      ...(templatesOn ? { createdTaskIds: moved.createdTaskIds } : {}),
    };
  },
} satisfies CallableDefinition<typeof ChangeMatterStageInput, ChangeMatterStageResult>;

export const changeStage = defineCallable(changeStageDefinition);
