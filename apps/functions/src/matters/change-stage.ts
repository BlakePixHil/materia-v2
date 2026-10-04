import {
  ChangeMatterStageInput,
  DomainError,
  MatterTypeSchema,
  matterStages,
  PERMISSIONS,
  unmetStageRequirements,
  type ChangeMatterStageResult,
  type FactMatter,
} from '@materia/domain';

import { liveMatter, matterPath } from './shared';
import { audit } from '../audit/audit';
import { stamp } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';

/** Statuses a matter's stage can't move in: the file is shut. */
const FROZEN_STATUSES: ReadonlySet<unknown> = new Set(['closed', 'archived']);

/** A template's `{ id, title }` stages, skipping malformed entries; undefined when it has none. */
function templateStages(value: unknown): { id: string; title: string }[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const stages = value.filter(
    (stage): stage is { id: string; title: string } =>
      !!stage && typeof stage.id === 'string' && !!stage.id && typeof stage.title === 'string' && !!stage.title,
  );
  return stages.length ? stages.map(({ id, title }) => ({ id, title })) : undefined;
}

/**
 * `matters-changeStage` (CORE-06, `matter.edit`). Moves a live, visible matter that is not closed
 * or archived (FAILED_PRECONDITION, `details.reason: 'matter_closed'`) to another of its stages:
 * the template's (`orgs/{orgId}/templates/{templateId}`) when the matter has one and it exists,
 * else the type's defaults (`matterStages`). An unknown stage is INVALID_ARGUMENT on `stageId`. A
 * forward move needs the key facts its stages require, else MATTER_STAGE_REQUIREMENTS with
 * `details.requirements` (key fact ids only). Moving back is always allowed; the same stage is a
 * no-op. Writes `stageId` and the meta; audited as `matter.stage_changed` with from and to.
 */
export const changeStageDefinition = {
  name: 'matters-changeStage',
  input: ChangeMatterStageInput,
  roles: PERMISSIONS['matter.edit'],
  idempotent: true,
  handler: async (ctx): Promise<ChangeMatterStageResult> => {
    const { input, orgId, uid, role, db, clock, requestId, log } = ctx;
    const ref = db.doc(matterPath(orgId, input.matterId));
    const now = clock.now();

    const from = await db.runTransaction(async (tx) => {
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
      const templateId = data['templateId'];
      const template =
        typeof templateId === 'string' && templateId
          ? await tx.get(db.doc(`orgs/${orgId}/templates/${templateId}`))
          : undefined;
      const stages = matterStages(type.data, template?.exists ? templateStages(template.get('stages')) : undefined);
      if (!stages.some((stage) => stage.id === input.stageId)) {
        throw new DomainError('INVALID_ARGUMENT', 'Unknown stage', {
          fields: { stageId: ['Choose one of the matter’s stages'] },
          allowed: stages.map((stage) => stage.id),
        });
      }
      const current = typeof data['stageId'] === 'string' ? data['stageId'] : undefined;
      if (current === input.stageId) return { current, changed: false };
      const requirements = unmetStageRequirements(data as FactMatter, stages, current, input.stageId);
      if (requirements.length) {
        throw new DomainError('MATTER_STAGE_REQUIREMENTS', 'Record the key facts this stage needs first', {
          matterId: input.matterId,
          stageId: input.stageId,
          requirements,
        });
      }
      tx.update(ref, { stageId: input.stageId, ...stamp(uid, now, requestId) });
      return { current, changed: true };
    });

    if (from.changed) {
      await audit(ctx, {
        action: 'matter.stage_changed',
        entity: { path: ref.path },
        summary: `Matter ${input.matterId} moved from stage ${from.current ?? '(none)'} to ${input.stageId}`,
        data: { from: from.current ?? null, to: input.stageId },
      });
      log.info('matter stage changed', { matterId: input.matterId, from: from.current ?? null, to: input.stageId });
    }
    return { matterId: input.matterId, stageId: input.stageId };
  },
} satisfies CallableDefinition<typeof ChangeMatterStageInput, ChangeMatterStageResult>;

export const changeStage = defineCallable(changeStageDefinition);
