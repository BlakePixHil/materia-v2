import type {
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  Query,
  QuerySnapshot,
  Transaction,
} from 'firebase-admin/firestore';

import {
  contactDisplayName,
  DomainError,
  formatPacketNo,
  locationKey,
  packetSearchTokens,
  SAFE_CUSTODY_COUNTER,
  SafeCustody,
  type Contact,
  type DateOnly,
  type MatterDocumentRef,
  type Role,
  type SafeCustodyItem,
  type SafeCustodyLocation,
} from '@materia/domain';

import { compact, contactPath, isDeleted } from '../contacts/shared';
import { isClean, loadDocument } from '../documents/shared';
import { counterPath, liveMatter, matterPath } from '../matters/shared';

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

/** Reads a document directly, or through a transaction. */
type Read = (ref: DocumentReference) => Promise<DocumentSnapshot>;

/** Follows `mergedInto` (CORE-01 merges) to the contact kept, at most a few hops. */
async function followMerges(db: Firestore, orgId: string, contactId: string, read?: Read): Promise<DocumentSnapshot> {
  const get: Read = read ?? ((ref) => ref.get());
  let snap = await get(db.doc(contactPath(orgId, contactId)));
  for (let hop = 0; hop < 5; hop++) {
    const next = snap.get('mergedInto') as string | undefined;
    if (!next) break;
    snap = await get(db.doc(contactPath(orgId, next)));
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
  read?: Read,
): Promise<{ id: string; name: string; data: Data }> {
  const snap = await followMerges(db, orgId, contactId, read);
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

/**
 * Reserves the next packet number (`SC-000001` onwards, never reused) in a transaction: reads the
 * `safe-custody` counter now; `commit` writes it back, after the transaction's other reads.
 */
export async function reservePacketNo(
  tx: Transaction,
  db: Firestore,
  orgId: string,
  uid: string,
  now: Date,
): Promise<{ packetNo: string; commit: () => void }> {
  const counterRef = db.doc(counterPath(orgId, SAFE_CUSTODY_COUNTER));
  const counter = await tx.get(counterRef);
  const seq = typeof counter.get('next') === 'number' ? (counter.get('next') as number) : 1;
  const meta = { updatedAt: now, updatedBy: uid };
  return {
    packetNo: formatPacketNo(seq),
    commit: () =>
      tx.set(
        counterRef,
        counter.exists
          ? { next: seq + 1, ...meta }
          : { next: seq + 1, createdAt: now, createdBy: uid, ...meta, schemaVersion: 1 },
        { merge: true },
      ),
  };
}

export interface NewPacket {
  packetNo: string;
  testator: { id: string; name: string };
  responsibleUid: string;
  matterId?: string | undefined;
  items: SafeCustodyItem[];
  location: SafeCustodyLocation;
  receivedOn: DateOnly | string;
  notes?: string | undefined;
  /** The `in` movement's reason. */
  reason?: string;
}

/** Writes a new packet, `held` at its location with an `in` movement (`safeCustody-receive`, closing). */
export function createPacket(
  tx: Transaction,
  ref: DocumentReference,
  packet: NewPacket,
  meta: { uid: string; now: Date; requestId: string },
): void {
  const { uid, now, requestId } = meta;
  tx.create(
    ref,
    SafeCustody.schema.parse(
      compact({
        packetNo: packet.packetNo,
        testatorContactId: packet.testator.id,
        testatorName: packet.testator.name,
        responsibleUid: packet.responsibleUid,
        matterId: packet.matterId,
        items: packet.items,
        location: packet.location,
        receivedOn: packet.receivedOn,
        status: 'held',
        movements: [
          compact({
            at: now,
            by: uid,
            kind: 'in',
            reason: packet.reason ?? 'Received into safe custody',
            location: packet.location,
          }),
        ],
        notes: packet.notes || undefined,
        pendingDestruction: null,
        ...derivedFields(packet.packetNo, packet.testator.name, packet.location),
        createdAt: now,
        createdBy: uid,
        updatedAt: now,
        updatedBy: uid,
        schemaVersion: SafeCustody.version,
        _requestId: requestId,
      }),
    ),
  );
}

/** A testator's packets still in the firm's custody (held or out), oldest first. */
export async function openPacketsOf(
  read: (query: Query) => Promise<QuerySnapshot>,
  db: Firestore,
  orgId: string,
  testatorContactId: string,
): Promise<{ id: string; ref: DocumentReference; data: Data }[]> {
  const snap = await read(db.collection(packetsPath(orgId)).where('testatorContactId', '==', testatorContactId));
  return snap.docs
    .map((doc) => ({ id: doc.id, ref: doc.ref, data: doc.data() }))
    .filter(({ data }) => !isDeleted(data) && !CLOSED_STATUSES.has(data['status']))
    .sort((a, b) => String(a.data['packetNo']).localeCompare(String(b.data['packetNo'])));
}
