import { defineTrigger, type TriggerChange, type TriggerContext, type TriggerDefinition } from '../core/trigger';

/**
 * `orgs-onProfileWrite` (CORE-20), on updates of `users/{uid}`: when a person changes their display
 * name in Settings → Profile, their member document in every other org they belong to takes the
 * new name too, so the team list, assignees and note authors follow it. The page writes the active
 * org's member document itself; this finds it already current and leaves it alone. Removed
 * memberships keep the name they had.
 */
export async function onProfileUpdate(change: TriggerChange, ctx: TriggerContext): Promise<void> {
  const before = change.before?.data();
  const after = change.after?.data();
  if (!before || !after) return;
  const name = typeof after['displayName'] === 'string' ? after['displayName'].trim() : '';
  if (!name || name === before['displayName']) return;
  const uid = ctx.params['uid'] as string;
  const orgIds = Array.isArray(after['orgIds'])
    ? (after['orgIds'] as unknown[]).filter((id) => typeof id === 'string')
    : [];
  if (!orgIds.length) return;
  const members = await ctx.db.getAll(...orgIds.map((orgId) => ctx.db.doc(`orgs/${orgId}/members/${uid}`)));
  const now = ctx.clock.now();
  const batch = ctx.db.batch();
  let renamed = 0;
  for (const member of members) {
    if (!member.exists || member.get('status') === 'removed' || member.get('displayName') === name) continue;
    batch.update(member.ref, { displayName: name, updatedAt: now, updatedBy: uid });
    renamed++;
  }
  if (renamed) await batch.commit();
  ctx.log.info('profile name copied to memberships', { uid, renamed });
}

export const onProfileWriteDefinition: TriggerDefinition = {
  name: 'orgs-onProfileWrite',
  document: 'users/{uid}',
  on: 'updated',
  handler: onProfileUpdate,
};

export const onProfileWrite = defineTrigger(onProfileWriteDefinition);
