import type { Firestore } from 'firebase-admin/firestore';

import {
  DeleteContactInput,
  DomainError,
  PERMISSIONS,
  type ContactReference,
  type DeleteContactResult,
} from '@materia/domain';

import {
  contactPath,
  isDeleted,
  matterIdOfParty,
  matterReferenceQueries,
  partyQuery,
  safeCustodyQuery,
  stamp,
} from './shared';
import { defineCallable, type CallableDefinition } from '../core/callable';

/** At most this many references are listed in the refusal (enough to act on). */
export const MAX_REFERENCES = 20;

/**
 * What still references a contact: live party rows (with their matter's title), live matters
 * (as client, referrer, deceased or testator) and live safe custody packets.
 */
export async function contactReferences(
  db: Firestore,
  orgId: string,
  contactId: string,
  max = MAX_REFERENCES,
): Promise<ContactReference[]> {
  const found: { matterId: string; role: string }[] = [];
  const parties = await partyQuery(db, orgId, contactId)
    .limit(max * 2)
    .get();
  for (const party of parties.docs) {
    const matterId = matterIdOfParty(party.ref.path, orgId);
    if (matterId && !isDeleted(party.data())) found.push({ matterId, role: String(party.get('role')) });
  }
  const titles = new Map<string, string>();
  for (const { role, query } of matterReferenceQueries(db, orgId, contactId)) {
    const matters = await query.limit(max).get();
    for (const matter of matters.docs) {
      if (isDeleted(matter.data())) continue;
      titles.set(matter.id, String(matter.get('title') ?? ''));
      found.push({ matterId: matter.id, role });
    }
  }
  const missing = [...new Set(found.map((ref) => ref.matterId))].filter((id) => !titles.has(id));
  if (missing.length) {
    const snaps = await db.getAll(...missing.map((id) => db.doc(`orgs/${orgId}/matters/${id}`)));
    for (const snap of snaps) {
      // A party row on a deleted (or missing) matter doesn't block the delete.
      if (snap.exists && !isDeleted(snap.data())) titles.set(snap.id, String(snap.get('title') ?? ''));
    }
  }
  const references: ContactReference[] = found
    .filter((ref) => titles.has(ref.matterId))
    .map((ref) => ({ ...ref, matterTitle: titles.get(ref.matterId) as string }));
  const packets = await safeCustodyQuery(db, orgId, contactId).limit(max).get();
  for (const packet of packets.docs) {
    if (isDeleted(packet.data())) continue;
    references.push({
      matterId: '',
      matterTitle: String(packet.get('packetNo') ?? ''),
      role: 'safe_custody',
      safeCustodyId: packet.id,
    });
  }
  const unique = new Map(references.map((ref) => [`${ref.matterId}|${ref.role}|${ref.safeCustodyId ?? ''}`, ref]));
  return [...unique.values()].slice(0, max);
}

/**
 * `contacts-delete` (CORE-01): a soft delete, refused with FAILED_PRECONDITION
 * (`details.reason: 'contact_referenced'`, `details.references: ContactReference[]`) while a
 * matter, party or safe custody packet still references the contact. Deleting an already deleted
 * contact (or a merge tombstone) succeeds without writing.
 */
export const deleteDefinition = {
  name: 'contacts-delete',
  input: DeleteContactInput,
  roles: PERMISSIONS['contact.delete'],
  idempotent: true,
  handler: async ({ input, orgId, uid, db, clock, requestId, log }): Promise<DeleteContactResult> => {
    const ref = db.doc(contactPath(orgId, input.contactId));
    const snap = await ref.get();
    if (!snap.exists) throw new DomainError('NOT_FOUND', 'Contact not found', { contactId: input.contactId });
    if (isDeleted(snap.data())) return { deleted: true };
    const references = await contactReferences(db, orgId, input.contactId);
    if (references.length) {
      log.info('delete refused: referenced', { contactId: input.contactId, references: references.length });
      throw new DomainError('FAILED_PRECONDITION', 'The contact is still referenced', {
        reason: 'contact_referenced',
        contactId: input.contactId,
        references,
      });
    }
    const now = clock.now();
    await ref.update({ deletedAt: now, deletedBy: uid, ...stamp(uid, now, requestId) });
    log.info('contact deleted', { contactId: input.contactId });
    return { deleted: true };
  },
} satisfies CallableDefinition<typeof DeleteContactInput, DeleteContactResult>;

export const deleteContact = defineCallable(deleteDefinition);
