import {
  PERMISSIONS,
  ReceivePacketInput,
  SAFE_CUSTODY_CALLABLES,
  type ReceivePacketResult,
  type SafeCustodyItem,
  type SafeCustodyLocation,
} from '@materia/domain';

import {
  assertActiveMember,
  assertDocument,
  assertMatter,
  createPacket,
  packetsPath,
  reservePacketNo,
  resolveTestator,
} from './shared';
import { defineCallable, type CallableDefinition } from '../core/callable';

/**
 * `safeCustody-receive` (CORE-17, `safeCustody.edit`, idempotent): a new packet. In one
 * transaction it takes the next number from `orgs/{orgId}/counters/safe-custody` (`SC-000001`
 * onwards, never reused) and writes the packet `held` at its location, with an `in` movement.
 * The testator (followed through merges) must be a live person; each item's scan a clean document
 * the caller can open; the responsible lawyer (default the caller) an active member.
 */
export const receiveDefinition = {
  name: SAFE_CUSTODY_CALLABLES.receive,
  input: ReceivePacketInput,
  roles: PERMISSIONS['safeCustody.edit'],
  idempotent: true,
  handler: async ({ input, orgId, uid, role, db, clock, log, requestId }): Promise<ReceivePacketResult> => {
    const testator = await resolveTestator(db, orgId, input.testatorContactId);
    const responsibleUid = input.responsibleUid ?? uid;
    await assertActiveMember(db, orgId, responsibleUid, 'responsibleUid');
    if (input.matterId) await assertMatter(db, orgId, role, input.matterId);
    for (const [index, item] of input.items.entries()) {
      if (item.document) await assertDocument(db, orgId, role, item.document, `items.${index}.document`);
    }

    const now = clock.now();
    const ref = db.collection(packetsPath(orgId)).doc();
    const packetNo = await db.runTransaction(async (tx) => {
      const reserved = await reservePacketNo(tx, db, orgId, uid, now);
      reserved.commit();
      createPacket(
        tx,
        ref,
        {
          packetNo: reserved.packetNo,
          testator,
          responsibleUid,
          matterId: input.matterId,
          items: input.items as SafeCustodyItem[],
          location: input.location as SafeCustodyLocation,
          receivedOn: input.receivedOn,
          notes: input.notes,
        },
        { uid, now, requestId },
      );
      return reserved.packetNo;
    });
    log.info('packet received', { packetId: ref.id, items: input.items.length });
    return { id: ref.id, packetNo };
  },
} satisfies CallableDefinition<typeof ReceivePacketInput, ReceivePacketResult>;

export const receive = defineCallable(receiveDefinition);
