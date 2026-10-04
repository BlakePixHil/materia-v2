import {
  CONFLICT_RECHECK_STATUSES,
  contactSubject,
  hasAdverseHit,
  Notification,
  PartyRoleSchema,
  type Contact,
} from '@materia/domain';

import { findConflictHits, storeConflictCheck } from './shared';
import { contactPath, isDeleted } from '../contacts/shared';
import { isEnabled } from '../core/flags';
import { defineTrigger, type TriggerChange, type TriggerContext, type TriggerDefinition } from '../core/trigger';
import { matterPath } from '../matters/shared';

type Data = Record<string, unknown>;

const millis = (value: unknown): number | undefined => {
  if (value instanceof Date) return value.getTime();
  const toMillis = (value as { toMillis?: () => number } | undefined)?.toMillis;
  return typeof toMillis === 'function' ? toMillis.call(value) : undefined;
};

export type PartyRecheckOutcome =
  | 'skipped_deleted'
  | 'skipped_not_added'
  | 'skipped_matter'
  | 'skipped_with_matter'
  | 'skipped_contact'
  | 'no_hits'
  | 'alerted';

/**
 * Re-checks conflicts when a party is added to an open or on-hold matter (CORE-02): a new row, or a
 * soft-deleted row revived by `matters-upsertParty` (CORE-06). Other edits of a row are skipped
 * (`skipped_not_added`). Leads are skipped (they get the full check before opening), and so are the
 * party rows `matters-createMatter` writes with the matter (same `createdAt`). The party's contact is checked
 * as a subject in its role, the matter itself excluded, and the run is stored as a ConflictCheck.
 * When the contact (or someone like them) is on other matters, the matter gets a server-owned
 * `conflictAlert` and its responsible lawyer a high-priority in-app notification. Nothing is
 * blocked.
 */
export async function recheckParty(change: TriggerChange, ctx: TriggerContext): Promise<PartyRecheckOutcome> {
  const party = change.after?.data() as Data | undefined;
  if (!party || isDeleted(party)) return 'skipped_deleted';
  const before = change.before?.data() as Data | undefined;
  const revived = !!before && isDeleted(before);
  if (before && !revived) return 'skipped_not_added';
  const orgId = ctx.params['orgId'] as string;
  const matterId = ctx.params['matterId'] as string;
  const partyId = ctx.params['partyId'] as string;
  const { db, log } = ctx;

  const matterRef = db.doc(matterPath(orgId, matterId));
  const matterSnap = await matterRef.get();
  const matter = matterSnap.data();
  const status = matter?.['status'];
  if (!matter || isDeleted(matter) || !(CONFLICT_RECHECK_STATUSES as readonly unknown[]).includes(status)) {
    return 'skipped_matter';
  }
  const partyCreated = millis(party['createdAt']);
  if (!revived && partyCreated !== undefined && partyCreated === millis(matter['createdAt'])) {
    return 'skipped_with_matter';
  }

  const role = PartyRoleSchema.safeParse(party['role']);
  const contactId = party['contactId'];
  if (!role.success || typeof contactId !== 'string') return 'skipped_contact';
  const contact = (await db.doc(contactPath(orgId, contactId)).get()).data() as Partial<Contact> | undefined;
  if (!contact) return 'skipped_contact';

  const subject = contactSubject(contact as never, role.data, contactId);
  const adverseOn = await isEnabled({ orgId, db, clock: ctx.clock }, 'conflicts.enforced');
  const hits = await findConflictHits(db, orgId, [subject], { excludeMatterId: matterId, adverse: adverseOn });
  // Whoever added the party: the creator of a new row, the last editor of a revived one.
  const addedBy = revived ? party['updatedBy'] : party['createdBy'];
  const by = typeof addedBy === 'string' && addedBy ? addedBy : 'system';
  const now = ctx.clock.now();
  const checkId = await storeConflictCheck(db, orgId, {
    subjects: [subject],
    hits,
    excludeMatterId: matterId,
    adverseRolesChecked: adverseOn,
    ranBy: by,
    now,
  });
  const relevant = hits.filter((hit) => hit.matters.length > 0);
  if (!relevant.length) {
    log.info('party re-check clear', { matterId, partyId, checkId });
    return 'no_hits';
  }

  const adverse = hasAdverseHit(relevant);
  await matterRef.update({ conflictAlert: { checkId, contactId, partyId, at: now, adverse } });
  const recipientUid = matter['responsibleUid'];
  if (typeof recipientUid === 'string' && recipientUid) {
    const number = typeof matter['number'] === 'string' && matter['number'] ? matter['number'] : 'a matter';
    const notification = Notification.schema.parse({
      kind: 'conflict_alert',
      matterId,
      checkId,
      contactId,
      recipientUid,
      title: adverse ? `Possible conflict on ${number}` : `Conflict check needed on ${number}`,
      body: adverse
        ? 'A party just added is on other matters in an adverse role. Review the conflict check.'
        : 'A party just added is on other matters. Review the conflict check.',
      link: `/matters/${matterId}`,
      channel: ['inapp'],
      priority: 'high',
      createdAt: now,
      createdBy: 'system',
      updatedAt: now,
      updatedBy: 'system',
      schemaVersion: Notification.version,
    });
    await db.collection(`orgs/${orgId}/notifications`).doc().create(notification);
  }
  log.info('party re-check alert', { matterId, partyId, checkId, hits: relevant.length, adverse });
  return 'alerted';
}

export const onPartyAddedDefinition: TriggerDefinition = {
  name: 'conflicts-onPartyAdded',
  document: 'orgs/{orgId}/matters/{matterId}/parties/{partyId}',
  on: 'created',
  handler: async (change, ctx) => {
    await recheckParty(change, ctx);
  },
};

/**
 * The same re-check for a revived row (`deletedAt` set, then cleared: `matters-upsertParty` adding
 * a contact back in a role they had). A separate update trigger, so the create trigger's event type
 * never changes on deploy; every other update is `skipped_not_added`.
 */
export const onPartyRevivedDefinition: TriggerDefinition = {
  name: 'conflicts-onPartyRevived',
  document: 'orgs/{orgId}/matters/{matterId}/parties/{partyId}',
  on: 'updated',
  handler: async (change, ctx) => {
    await recheckParty(change, ctx);
  },
};

export const onPartyAdded = defineTrigger(onPartyAddedDefinition);
export const onPartyRevived = defineTrigger(onPartyRevivedDefinition);
