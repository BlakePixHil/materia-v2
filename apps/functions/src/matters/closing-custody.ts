import type { DocumentReference, DocumentSnapshot, Firestore, Transaction } from 'firebase-admin/firestore';

import {
  DomainError,
  type ClosingSafeCustody,
  type DateOnly,
  type SafeCustodyItem,
  type SafeCustodyLocation,
} from '@materia/domain';

import { stamp } from '../contacts/shared';
import { createPacket, openPacketsOf, packetsPath, reservePacketNo, resolveTestator } from '../safe-custody/shared';

/*
 * Closing a will matter with its original into safe custody (CORE-17a): the will joins the
 * testator's packet still in custody, or closing creates one through the same code as
 * `safeCustody-receive`. Audited by the org audit trigger, like every packet write.
 */

type Data = Record<string, unknown>;
type Reader = Pick<Transaction, 'get'>;

interface Custody {
  testator: { id: string; name: string } | null;
  packet: { id: string; ref: DocumentReference; data: Data } | null;
}

/** The testator (followed through merges; null when missing or not a live person) and their open packet. */
export async function readCustody(
  db: Firestore,
  reader: Reader,
  orgId: string,
  testatorContactId: string | undefined,
): Promise<Custody> {
  if (!testatorContactId) return { testator: null, packet: null };
  const testator = await resolveTestator(db, orgId, testatorContactId, (ref) => reader.get(ref)).catch(
    (error: unknown) => {
      if (error instanceof DomainError && error.code === 'INVALID_ARGUMENT') return null;
      throw error;
    },
  );
  if (!testator) return { testator: null, packet: null };
  const packets = await openPacketsOf((query) => reader.get(query), db, orgId, testator.id);
  return { testator: { id: testator.id, name: testator.name }, packet: packets[0] ?? null };
}

/** What the closing checklist shows about it. */
export function custodySummary(custody: Custody): ClosingSafeCustody {
  return {
    testator: custody.testator ? { contactId: custody.testator.id, name: custody.testator.name } : null,
    packet: custody.packet ? { id: custody.packet.id, packetNo: String(custody.packet.data['packetNo']) } : null,
  };
}

export interface CustodyPlacement {
  packetId: string;
  packetNo: string;
  created: boolean;
}

/**
 * Reads what placing the will needs, inside the closing transaction and before its writes; the
 * returned `write` then files it. The will joins the testator's open packet (once: a packet already
 * linked to this matter is left alone, so closing again after a reopen adds nothing), or a new
 * packet is created at `location`, numbered from the counter, for the matter's responsible lawyer.
 */
export async function planCustody(
  tx: Transaction,
  db: Firestore,
  args: {
    orgId: string;
    matterId: string;
    matter: Data;
    testatorContactId: string | undefined;
    location: SafeCustodyLocation | undefined;
    receivedOn: DateOnly;
    uid: string;
    now: Date;
    requestId: string;
  },
): Promise<() => CustodyPlacement> {
  const { orgId, matterId, matter, uid, now, requestId } = args;
  const custody = await readCustody(db, tx, orgId, args.testatorContactId);
  if (!custody.testator) {
    throw new DomainError(
      'FAILED_PRECONDITION',
      'Add the testator as a party to place the original will in safe custody',
      {
        reason: 'safe_custody_testator',
        matterId,
      },
    );
  }
  const testator = custody.testator;
  const number = String(matter['number'] ?? matterId);
  const reason = `Original will received on closing matter ${number}`;
  const will: SafeCustodyItem = { kind: 'will', description: `Original will (matter ${number})` };

  const existing = custody.packet;
  if (existing) {
    return () => {
      const packet = { packetId: existing.id, packetNo: String(existing.data['packetNo']), created: false };
      if (existing.data['matterId'] === matterId) return packet;
      const items = (existing.data['items'] as SafeCustodyItem[] | undefined) ?? [];
      const movements = (existing.data['movements'] as unknown[] | undefined) ?? [];
      const location = existing.data['location'] as SafeCustodyLocation | undefined;
      tx.update(existing.ref, {
        items: [...items, will],
        matterId,
        movements: [...movements, { at: now, by: uid, kind: 'in', reason, ...(location ? { location } : {}) }],
        ...stamp(uid, now, requestId),
      });
      return packet;
    };
  }

  if (!args.location) {
    throw new DomainError('FAILED_PRECONDITION', 'Say where the new safe custody packet is kept', {
      reason: 'safe_custody_location',
      matterId,
    });
  }
  const location = args.location;
  const responsible = typeof matter['responsibleUid'] === 'string' ? (matter['responsibleUid'] as string) : undefined;
  const member: DocumentSnapshot | null = responsible
    ? await tx.get(db.doc(`orgs/${orgId}/members/${responsible}`))
    : null;
  const responsibleUid = member?.get('status') === 'active' && responsible ? responsible : uid;
  const reserved = await reservePacketNo(tx, db, orgId, uid, now);
  const ref = db.collection(packetsPath(orgId)).doc();
  return () => {
    reserved.commit();
    createPacket(
      tx,
      ref,
      {
        packetNo: reserved.packetNo,
        testator,
        responsibleUid,
        matterId,
        items: [will],
        location,
        receivedOn: args.receivedOn,
        reason,
      },
      { uid, now, requestId },
    );
    return { packetId: ref.id, packetNo: reserved.packetNo, created: true };
  };
}
