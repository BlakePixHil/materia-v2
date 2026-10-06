import type { Firestore } from 'firebase-admin/firestore';

import {
  ApplyTemplateInput,
  DomainError,
  MatterTypeSchema,
  PERMISSIONS,
  today,
  type ApplyTemplateResult,
  type Role,
  type Template,
} from '@materia/domain';

import {
  anchorContext,
  createMissingTasks,
  firstActiveParalegal,
  orgTimeZone,
  planTemplateTasks,
  readEvents,
  readTemplate,
  readWith,
} from './shared';
import { audit } from '../audit/audit';
import { stamp } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { orgClock } from '../core/emulator-clock';
import { requireFlag } from '../core/flags';
import { writableMatter, matterPath } from '../matters/shared';
import type { Clock } from '../ports';

/** Statuses a matter's template can't change in: the file is shut. */
export const FROZEN_STATUSES: ReadonlySet<unknown> = new Set(['closed', 'archived']);

export function assertOpen(data: Record<string, unknown>, matterId: string): void {
  if (FROZEN_STATUSES.has(data['status'])) {
    throw new DomainError('FAILED_PRECONDITION', 'A closed or archived matter cannot change', {
      reason: 'matter_closed',
      matterId,
      status: String(data['status']),
    });
  }
}

export interface ApplyArgs {
  db: Firestore;
  orgId: string;
  uid: string;
  role: Role;
  requestId: string;
  clock: Clock;
  matterId: string;
  template: Template;
}

/**
 * Gives a live, open matter a template version (`templateId`, `templateVersion`) and creates its
 * tasks: the current stage's when the template has it, else the template's first stage (entered
 * today, org time zone), plus later tasks whose anchor event is known. Existing template tasks are
 * left alone. Shared by `templates-apply` and `matters-upgradeTemplate`-style callers.
 */
export async function applyTemplate(args: ApplyArgs): Promise<ApplyTemplateResult> {
  const { db, orgId, uid, role, requestId, clock, matterId, template } = args;
  const ref = db.doc(matterPath(orgId, matterId));
  const now = clock.now();
  const [timeZone, paralegalUid] = await Promise.all([orgTimeZone(db, orgId), firstActiveParalegal(db, orgId)]);
  const entered = today(timeZone, now);

  return db.runTransaction(async (tx) => {
    const data = writableMatter(await tx.get(ref), role, matterId);
    assertOpen(data, matterId);
    const type = MatterTypeSchema.safeParse(data['type']);
    if (!type.success || type.data !== template.matterType) {
      throw new DomainError('INVALID_ARGUMENT', 'The template is for another matter type', {
        fields: { templateId: ['Choose a template for this matter type'] },
        matterType: type.success ? type.data : null,
        templateType: template.matterType,
      });
    }
    const current = typeof data['stageId'] === 'string' ? data['stageId'] : undefined;
    const kept = template.stages.some((stage) => stage.id === current);
    const stageId = kept ? (current as string) : (template.stages[0]?.id as string);
    const enteredOn = kept && typeof data['stageEnteredOn'] === 'string' ? data['stageEnteredOn'] : entered;
    const events = await readEvents(db, tx, orgId, matterId);
    const planned = planTemplateTasks(template, anchorContext(data, events), {
      orgId,
      matterId,
      stageId,
      stageEnteredOn: enteredOn as typeof entered,
      knownAnchors: true,
      responsibleUid: String(data['responsibleUid']),
      paralegalUid,
      uid,
      now,
      requestId,
    });
    const created = await createMissingTasks(db, tx, ref, planned);
    tx.update(ref, {
      templateId: template.id,
      templateVersion: template.version,
      stageId,
      stageEnteredOn: enteredOn,
      ...stamp(uid, now, requestId),
    });
    created.write();
    return {
      matterId,
      templateId: template.id,
      version: template.version,
      stageId,
      createdTaskIds: created.ids,
    };
  });
}

/**
 * `templates-apply` (CORE-07, `matter.edit`, flag `templates.system`). Gives a matter a system
 * template (`system-{type}`) or a published org template version, and creates its tasks (see
 * `applyTemplate`). An unknown template or version is NOT_FOUND; another type's template is
 * INVALID_ARGUMENT on `templateId`. Audited as `matter.template_applied`.
 */
export const applyDefinition = {
  name: 'templates-apply',
  input: ApplyTemplateInput,
  roles: PERMISSIONS['matter.edit'],
  idempotent: true,
  handler: async (ctx): Promise<ApplyTemplateResult> => {
    const { input, orgId, uid, role, db, requestId, log } = ctx;
    await requireFlag({ orgId, db, clock: ctx.clock }, 'templates.system');
    const clock = await orgClock(db, orgId, ctx.clock);
    const template = await readTemplate(db, readWith(), orgId, input.templateId, input.version);
    if (!template) {
      throw new DomainError('NOT_FOUND', 'Template version not found', {
        templateId: input.templateId,
        version: input.version,
      });
    }
    const result = await applyTemplate({ db, orgId, uid, role, requestId, clock, matterId: input.matterId, template });
    await audit(
      { uid, orgId, requestId, db, clock },
      {
        action: 'matter.template_applied',
        entity: { path: matterPath(orgId, input.matterId) },
        summary: `Template ${template.id} v${template.version} applied to matter ${input.matterId}`,
        data: {
          templateId: template.id,
          version: template.version,
          stageId: result.stageId,
          createdTasks: result.createdTaskIds.length,
        },
      },
    );
    log.info('template applied', {
      matterId: input.matterId,
      templateId: template.id,
      version: template.version,
      created: result.createdTaskIds.length,
    });
    return result;
  },
} satisfies CallableDefinition<typeof ApplyTemplateInput, ApplyTemplateResult>;

export const apply = defineCallable(applyDefinition);
