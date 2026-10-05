import type { DocumentSnapshot, Firestore } from 'firebase-admin/firestore';

import {
  contactDisplayName,
  DomainError,
  locationKey,
  packetSearchTokens,
  type Contact,
  type MatterDocumentRef,
  type Role,
  type SafeCustodyLocation,
} from '@materia/domain';

import { contactPath, isDeleted } from '../contacts/shared';
import { isClean, loadDocument } from '../documents/shared';
import { liveMatter, matterPath } from '../matters/shared';

/** Shared helpers for the will safe-custody register (CORE-17). */

type Data = Record<string, unknown>;

export const packetsPath = (orgId: string) => `orgs/${orgId}/safeCustody`;
export const packetPath = (orgId: string, id: string) => `${packetsPath(orgId)}/${id}`;

/** Released and destroyed packets have left the firm's custody: nothing about them changes again. */
export const CLOSED_STATUSES: ReadonlySet<unknown> = new Set(['released', 'destroyed']);

/** A packet that exists and isn't deleted, or NOT_FOUND. */
export function livePacket(snap: DocumentSnapshot, id: string): Data {
  const data = snap.data();
  if (!snap.exists || !data || isDeleted(data)) throw new DomainError('NOT_FOUND', 'Packet not found', { id });
  return data;
}

/** A packet that is still in the firm's custody (held or out), or FAILED_PRECONDITION `packet_closed`. */
export function assertOpen(packet: Data): void {
  if (CLOSED_STATUSES.has(packet['status'])) {
    throw new DomainError('FAILED_PRECONDITION', 'This packet has been released or destroyed', {
      reason: 'packet_closed',
    });
  }
}

/** Follows `mergedInto` (CORE-01 merges) to the contact kept, at most a few hops. */
async function followMerges(db: Firestore, orgId: string, contactId: string): Promise<DocumentSnapshot> {
  let snap = await db.doc(contactPath(orgId, contactId)).get();
  for (let hop = 0; hop < 5; hop++) {
    const next = snap.get('mergedInto') as string | undefined;
    if (!next) break;
    snap = await db.doc(contactPath(orgId, next)).get();
  }
  return snap;
}

/**
 * The testator: a live person contact, following merges. Anything else is INVALID_ARGUMENT on
 * `testatorContactId`.
 */
export async function resolveTestator(
  db: Firestore,
  orgId: string,
  contactId: string,
): Promise<{ id: string; name: string; data: Data }> {
  const snap = await followMerges(db, orgId, contactId);
  const data = snap.data();
  if (!snap.exists || !data || isDeleted(data) || data['mergedInto']) {
    throw new DomainError('INVALID_ARGUMENT', 'Testator not found', {
      fields: { testatorContactId: ['Choose a contact'] },
    });
  }
  if (data['kind'] !== 'person') {
    throw new DomainError('INVALID_ARGUMENT', 'The testator must be a person', {
      fields: { testatorContactId: ['Choose a person'] },
    });
  }
  return { id: snap.id, name: contactDisplayName(data as Partial<Contact>), data };
}

/** A live contact (a person or firm) a packet is released to, following merges. */
export async function resolveRecipient(db: Firestore, orgId: string, contactId: string): Promise<string> {
  const snap = await followMerges(db, orgId, contactId);
  const data = snap.data();
  if (!snap.exists || !data || isDeleted(data) || data['mergedInto']) {
    throw new DomainError('INVALID_ARGUMENT', 'Contact not found', { fields: { toContactId: ['Choose a contact'] } });
  }
  return snap.id;
}

/** An active member of the org (the responsible lawyer), or INVALID_ARGUMENT on `field`. */
export async function assertActiveMember(db: Firestore, orgId: string, uid: string, field: string): Promise<void> {
  const member = await db.doc(`orgs/${orgId}/members/${uid}`).get();
  if (member.get('status') !== 'active') {
    throw new DomainError('INVALID_ARGUMENT', 'Not an active member', { fields: { [field]: ['Choose a member'] } });
  }
}

/** A live matter the caller can see (the will matter a packet came from). */
export async function assertMatter(db: Firestore, orgId: string, role: Role, matterId: string): Promise<void> {
  liveMatter(await db.doc(matterPath(orgId, matterId)).get(), role, matterId);
}

/**
 * A document the caller can open, scanned clean: an item's scan or a movement's authority. Anything
 * else is INVALID_ARGUMENT on `field`, saying why.
 */
export async function assertDocument(
  db: Firestore,
  orgId: string,
  role: Role,
  ref: MatterDocumentRef,
  field: string,
): Promise<void> {
  let doc: Data;
  try {
    ({ doc } = await loadDocument(db, orgId, role, ref.matterId, ref.documentId));
  } catch (error) {
    if (error instanceof DomainError && error.code === 'NOT_FOUND') {
      throw new DomainError('INVALID_ARGUMENT', 'Document not found', { fields: { [field]: ['Choose a document'] } });
    }
    throw error;
  }
  if (!isClean(doc)) {
    throw new DomainError('INVALID_ARGUMENT', 'The document hasn’t passed the malware scan', {
      fields: { [field]: ['Wait for the scan to finish, or choose another document'] },
    });
  }
}

/** The denormalised fields: search tokens and the stocktake's sort key. */
export function derivedFields(packetNo: string, testatorName: string, location: Partial<SafeCustodyLocation>) {
  return { search: packetSearchTokens(packetNo, testatorName, location), locationKey: locationKey(location) };
}
