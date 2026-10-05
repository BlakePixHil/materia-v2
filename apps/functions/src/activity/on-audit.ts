import { Activity, matterStages, MatterTypeSchema } from '@materia/domain';

import { activityRefs, actorUid, ruleFor, type ActivityFacts, type AuditEntryLike } from './mapping';
import { defineTrigger, type TriggerChange, type TriggerContext, type TriggerDefinition } from '../core/trigger';
import { recordMatterActivity } from '../matters/denormalise';
import { contactNames, matterPath } from '../matters/shared';
import { readMatterTemplateStages, readTemplate, type Read } from '../templates/shared';

type Data = Record<string, unknown>;

const read: Read = (ref) => ref.get();

const toDate = (value: unknown): Date | undefined => {
  if (value instanceof Date) return value;
  const toDateFn = (value as { toDate?: () => Date } | undefined)?.toDate;
  return typeof toDateFn === 'function' ? toDateFn.call(value) : undefined;
};

/** Looks up what the entry's rule needs: the record now, stage titles, the template, the party's name. */
async function factsFor(
  ctx: TriggerContext,
  orgId: string,
  entry: AuditEntryLike,
  matter: Data,
  needs: ReadonlySet<string>,
): Promise<ActivityFacts> {
  const { db } = ctx;
  const entity =
    needs.has('entity') && entry.entity.path !== matterPath(orgId, entry.entity.matterId ?? '')
      ? (await db.doc(entry.entity.path).get()).data()
      : undefined;
  const facts: ActivityFacts = {
    restricted:
      matter['privileged'] === true || entity?.['privileged'] === true || entry.after?.['privileged'] === true,
    ...(entity ? { entity } : {}),
  };
  if (needs.has('stages')) {
    const type = MatterTypeSchema.safeParse(matter['type']);
    const stages = type.success ? matterStages(type.data, await readMatterTemplateStages(db, read, orgId, matter)) : [];
    facts.stageTitle = (id) => stages.find((stage) => stage.id === id)?.title;
  }
  if (needs.has('template')) {
    const { templateId, version } = entry.data ?? {};
    if (typeof templateId === 'string' && templateId) {
      const template = await readTemplate(
        db,
        read,
        orgId,
        templateId,
        typeof version === 'number' ? version : undefined,
      ).catch(() => undefined);
      if (template?.name) facts.templateName = template.name;
    }
  }
  if (needs.has('contact') && !facts.restricted) {
    const contactId = entry.data?.['contactId'];
    if (typeof contactId === 'string' && contactId) {
      const name = (await contactNames(db, orgId, [contactId])).get(contactId);
      if (name) facts.contactName = name;
    }
  }
  return facts;
}

/**
 * `activity-onAudit` (CORE-13), on every new `orgs/{orgId}/audit/{entryId}`: turns the entries the
 * mapping table lists (`ACTIVITY_RULES`) into the matter's feed, at
 * `matters/{matterId}/activity/audit-{entryId}` (so a repeat writes the same line), and moves the
 * matter's `lastActivityAt` forward for changes below the matter. Entries without a matter, about tasks (`tasks-onWrite` writes
 * those), from the migration, or unmapped are skipped, as is a matter that no longer exists.
 * `activity` is excluded from the audit log and `lastActivityAt` is a noise field there, so these
 * writes make no new entries: no loop.
 */
export async function projectActivity(change: TriggerChange, ctx: TriggerContext): Promise<'written' | 'skipped'> {
  const entry = change.after?.data() as AuditEntryLike | undefined;
  const orgId = ctx.params['orgId'] as string;
  const entryId = ctx.params['entryId'] as string;
  const rule = entry ? ruleFor(entry) : undefined;
  const matterId = entry?.entity?.matterId;
  if (!entry || !rule || !matterId) {
    ctx.log.debug('not activity', { action: entry?.action ?? null });
    return 'skipped';
  }
  const matter = (await ctx.db.doc(matterPath(orgId, matterId)).get()).data();
  if (!matter) return 'skipped';
  const facts = await factsFor(ctx, orgId, entry, matter, new Set(rule.needs ?? []));
  const mapped = rule.map(entry, facts);
  if (!mapped) {
    ctx.log.debug('not activity', { action: entry.action });
    return 'skipped';
  }

  const at = toDate(entry.at) ?? ctx.time;
  const now = ctx.clock.now();
  const activity = Activity.schema.parse({
    kind: mapped.kind,
    summary: mapped.summary,
    actorUid: actorUid(entry),
    at,
    refs: activityRefs(entry, entryId),
    createdAt: now,
    createdBy: 'system',
    updatedAt: now,
    updatedBy: 'system',
    schemaVersion: Activity.version,
  });
  await ctx.db.doc(`${matterPath(orgId, matterId)}/activity/audit-${entryId}`).set(activity);
  // A change to the matter document itself already moves lastActivityAt (matters-denormalise), and
  // one already later needs nothing: skipping those keeps the trigger off the matter document, which
  // creates and recomputes contend on.
  const last = toDate(matter['lastActivityAt'])?.getTime();
  if (entry.entity.path !== matterPath(orgId, matterId) && (last === undefined || last < at.getTime())) {
    await recordMatterActivity(ctx.db, orgId, matterId, at);
  }
  ctx.log.info('activity written', { matterId, kind: mapped.kind });
  return 'written';
}

export const onAuditDefinition: TriggerDefinition = {
  name: 'activity-onAudit',
  document: 'orgs/{orgId}/audit/{entryId}',
  on: 'created',
  handler: async (change, ctx) => void (await projectActivity(change, ctx)),
};

/** `activity-onAudit`. */
export const onAudit = defineTrigger(onAuditDefinition);
