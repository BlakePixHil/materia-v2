import { rescheduleOrg } from './schedule';
import { orgClock } from '../core/emulator-clock';
import { defineTrigger, type TriggerChange, type TriggerContext, type TriggerDefinition } from '../core/trigger';

/**
 * `reminders-onOrgWrite` (CORE-11), on updates of `orgs/{orgId}`: when the org's time zone or
 * locality calendar changes, its deadlines' reminders move with it, so every upcoming deadline's
 * `nextReminderAt` is set again. Other org edits do nothing.
 */
export async function onOrgUpdate(change: TriggerChange, ctx: TriggerContext): Promise<void> {
  const before = change.before?.data();
  const after = change.after?.data();
  if (!before || !after) return;
  if (before['timezone'] === after['timezone'] && before['holidayLocality'] === after['holidayLocality']) return;
  const orgId = ctx.params['orgId'] as string;
  const written = await rescheduleOrg(ctx.db, orgId, (await orgClock(ctx.db, orgId, ctx.clock)).now());
  ctx.log.info('reminders rescheduled', { orgId, written });
}

export const onOrgWriteDefinition: TriggerDefinition = {
  name: 'reminders-onOrgWrite',
  document: 'orgs/{orgId}',
  on: 'updated',
  handler: onOrgUpdate,
};

export const onOrgWrite = defineTrigger(onOrgWriteDefinition);
