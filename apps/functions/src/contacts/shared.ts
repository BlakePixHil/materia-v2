import type { Firestore } from 'firebase-admin/firestore';

import { contactDerivedFields, type Contact, type ContactDerived } from '@materia/domain';

/** Shared helpers for the contacts functions (CORE-01). */

export const contactsPath = (orgId: string) => `orgs/${orgId}/contacts`;
export const contactPath = (orgId: string, contactId: string) => `${contactsPath(orgId)}/${contactId}`;

type Data = Record<string, unknown>;

/** Drops undefined values (the Admin SDK rejects them), one level deep. */
export function compact<T extends Data>(data: T): T {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)) as T;
}

/** The fields every server write stamps, so the audit trigger attributes it to the caller's request. */
export function stamp(uid: string, now: Date, requestId: string) {
  return { updatedAt: now, updatedBy: uid, _requestId: requestId };
}

const isDeleted = (data: Data | undefined) => data?.['deletedAt'] !== undefined && data?.['deletedAt'] !== null;

/** A live contact: not soft-deleted and not a merge tombstone. */
export function isLive(data: Data | undefined): boolean {
  return !!data && !isDeleted(data) && !data['mergedInto'];
}

export { isDeleted };

/** The derived fields that differ from what is stored (empty when they are up to date). */
export function staleDerived(data: Partial<Contact>): Partial<ContactDerived> {
  const derived = contactDerivedFields(data);
  const patch: Partial<ContactDerived> = {};
  if (JSON.stringify(data.search ?? null) !== JSON.stringify(derived.search)) patch.search = derived.search;
  if (data.dedupeKey !== derived.dedupeKey) patch.dedupeKey = derived.dedupeKey;
  if (data.sortName !== derived.sortName) patch.sortName = derived.sortName;
  return patch;
}

/** Where a contact id can be referenced from a matter (besides parties). */
export const MATTER_REFERENCE_FIELDS = [
  { field: 'clientContactIds', op: 'array-contains', role: 'client' },
  { field: 'referrerContactId', op: '==', role: 'referrer' },
  { field: 'deceased.contactId', op: '==', role: 'deceased' },
  { field: 'testator.contactId', op: '==', role: 'testator' },
] as const;

/** Queries for the matters that reference a contact, one per reference field. */
export function matterReferenceQueries(db: Firestore, orgId: string, contactId: string) {
  return MATTER_REFERENCE_FIELDS.map(({ field, op, role }) => ({
    role,
    query: db.collection(`orgs/${orgId}/matters`).where(field, op, contactId),
  }));
}

/** Party rows across the org's matters that point at a contact (the `parties` collection group). */
export function partyQuery(db: Firestore, orgId: string, contactId: string) {
  return db.collectionGroup('parties').where('orgId', '==', orgId).where('contactId', '==', contactId);
}

export function safeCustodyQuery(db: Firestore, orgId: string, contactId: string) {
  return db.collection(`orgs/${orgId}/safeCustody`).where('testatorContactId', '==', contactId);
}

/** The matter id of `orgs/{orgId}/matters/{matterId}/parties/{partyId}`, or null for another path. */
export function matterIdOfParty(path: string, orgId: string): string | null {
  const parts = path.split('/');
  return parts.length === 6 && parts[0] === 'orgs' && parts[1] === orgId && parts[2] === 'matters'
    ? (parts[3] ?? null)
    : null;
}
