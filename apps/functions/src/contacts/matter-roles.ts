import type { Firestore } from 'firebase-admin/firestore';

import { contactMatterRoles, matterCountsForRoles, PartyRoleSchema, type PartyRole } from '@materia/domain';

import { contactPath, isDeleted, isLive, matterIdOfParty, partyQuery } from './shared';
import { defineTrigger, type TriggerChange, type TriggerContext, type TriggerDefinition } from '../core/trigger';
import { matterPath } from '../matters/shared';

type Data = Record<string, unknown>;

/**
 * A contact's `matterRoles` (CORE-01a): the roles it holds on live matters that aren't privileged,
 * for the contacts list's "Role in matters" filter. Server-owned, never stamped with `updatedAt`, and a noise field to the
 * audit trigger, so keeping it current is invisible in the contact's history.
 */

const sameRoles = (a: unknown, b: readonly string[]) =>
  Array.isArray(a) && a.length === b.length && a.every((role, i) => role === b[i]);

/**
 * Recomputes a contact's `matterRoles` from its party rows across the org (the `parties`
 * collection group) and their matters, in one transaction, so concurrent recomputes for the same
 * contact can't leave an older answer behind. A missing, deleted or merged contact is left alone
 * (it never shows in the list).
 */
export async function recomputeMatterRoles(
  db: Firestore,
  orgId: string,
  contactId: string,
): Promise<'updated' | 'unchanged' | 'skipped'> {
  const ref = db.doc(contactPath(orgId, contactId));
  return db.runTransaction(async (tx) => {
    const contact = await tx.get(ref);
    if (!contact.exists || !isLive(contact.data())) return 'skipped' as const;
    const parties = await tx.get(partyQuery(db, orgId, contactId));
    const rows = parties.docs.flatMap((doc) => {
      const matterId = matterIdOfParty(doc.ref.path, orgId);
      const data = doc.data() as Data;
      return matterId ? [{ role: data['role'], matterId, deletedAt: data['deletedAt'] }] : [];
    });
    const matterIds = [...new Set(rows.filter((row) => !isDeleted(row)).map((row) => row.matterId))];
    const matters = matterIds.length ? await tx.getAll(...matterIds.map((id) => db.doc(matterPath(orgId, id)))) : [];
    const live = new Set(matters.filter((m) => matterCountsForRoles(m.data() as Data | undefined)).map((m) => m.id));
    const roles = contactMatterRoles(rows, (matterId) => live.has(matterId));
    if (sameRoles(contact.get('matterRoles'), roles)) return 'unchanged' as const;
    tx.update(ref, { matterRoles: roles });
    return 'updated' as const;
  });
}

/**
 * Adds one role to a contact's `matterRoles` when it holds it on a live matter and the list
 * doesn't have it yet: the cheap path for a party added, without reading every party row.
 */
async function addRole(
  db: Firestore,
  orgId: string,
  contactId: string,
  matterId: string,
  role: PartyRole,
): Promise<'updated' | 'unchanged' | 'skipped'> {
  const ref = db.doc(contactPath(orgId, contactId));
  return db.runTransaction(async (tx) => {
    const contact = await tx.get(ref);
    if (!contact.exists || !isLive(contact.data())) return 'skipped' as const;
    const current = contact.get('matterRoles');
    if (Array.isArray(current) && current.includes(role)) return 'unchanged' as const;
    const matter = await tx.get(db.doc(matterPath(orgId, matterId)));
    if (!matterCountsForRoles(matter.data() as Data | undefined)) return 'unchanged' as const;
    const held = new Set<string>([...(Array.isArray(current) ? (current as string[]) : []), role]);
    tx.update(ref, { matterRoles: PartyRoleSchema.options.filter((r) => held.has(r)) });
    return 'updated' as const;
  });
}

/** A party row's contact and role while it is live (null when deleted, missing or malformed). */
function liveRow(data: Data | undefined): { contactId: string; role: PartyRole } | null {
  if (!data || isDeleted(data)) return null;
  const role = PartyRoleSchema.safeParse(data['role']);
  const contactId = data['contactId'];
  return role.success && typeof contactId === 'string' && contactId ? { contactId, role: role.data } : null;
}

/**
 * `contacts-onPartyWrite` (CORE-01a), on every write of `matters/{matterId}/parties/{partyId}`:
 * a row that gained a live contact and role adds the role (`addRole`); a contact that lost a live
 * row (removed, re-roled, re-pointed by a merge, deleted) is recomputed in full. A write that
 * leaves the live contact and role as they were (share, notes) reads nothing.
 */
export async function onPartyWriteHandler(
  change: TriggerChange,
  ctx: TriggerContext,
): Promise<Record<string, 'updated' | 'unchanged' | 'skipped'>> {
  const orgId = ctx.params['orgId'] as string;
  const matterId = ctx.params['matterId'] as string;
  const before = liveRow(change.before?.data() as Data | undefined);
  const after = liveRow(change.after?.data() as Data | undefined);
  const results: Record<string, 'updated' | 'unchanged' | 'skipped'> = {};
  if (before && after && before.contactId === after.contactId && before.role === after.role) return results;
  if (before && before.contactId !== after?.contactId) {
    results[before.contactId] = await recomputeMatterRoles(ctx.db, orgId, before.contactId);
  }
  if (after) {
    // Same contact, new role: the old role may now be gone too.
    results[after.contactId] =
      before && before.contactId === after.contactId
        ? await recomputeMatterRoles(ctx.db, orgId, after.contactId)
        : await addRole(ctx.db, orgId, after.contactId, matterId, after.role);
  }
  ctx.log.debug('matter roles', { matterId, results: Object.values(results) });
  return results;
}

export const onPartyWriteDefinition: TriggerDefinition = {
  name: 'contacts-onPartyWrite',
  document: 'orgs/{orgId}/matters/{matterId}/parties/{partyId}',
  on: 'written',
  handler: async (change, ctx) => void (await onPartyWriteHandler(change, ctx)),
};

/** `contacts-onPartyWrite`. */
export const onPartyWrite = defineTrigger(onPartyWriteDefinition);

/**
 * For `matters-denormalise`: a matter that was deleted, restored, destroyed, or marked or unmarked
 * privileged changes whether its parties' roles count (`matterCountsForRoles`), so each contact with
 * a live row on it is recomputed. Other writes do nothing.
 */
export async function refreshMatterRoles(
  db: Firestore,
  orgId: string,
  matterId: string,
  before: Data | undefined,
  after: Data | undefined,
): Promise<number> {
  if (!before || matterCountsForRoles(before) === matterCountsForRoles(after)) return 0;
  const parties = await db.collection(`${matterPath(orgId, matterId)}/parties`).get();
  const contactIds = [...new Set(parties.docs.flatMap((doc) => liveRow(doc.data() as Data)?.contactId ?? []))];
  for (const contactId of contactIds) await recomputeMatterRoles(db, orgId, contactId);
  return contactIds.length;
}
