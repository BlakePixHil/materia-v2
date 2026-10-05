import {
  formatPacketNo,
  PERMISSIONS,
  ReceivePacketInput,
  SAFE_CUSTODY_CALLABLES,
  SAFE_CUSTODY_COUNTER,
  SafeCustody,
  type ReceivePacketResult,
} from '@materia/domain';

import { assertActiveMember, assertDocument, assertMatter, derivedFields, packetsPath, resolveTestator } from './shared';
import { compact } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { counterPath } from '../matters/shared';

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
    const counterRef = db.doc(counterPath(orgId, SAFE_CUSTODY_COUNTER));
    const packetNo = await db.runTransaction(async (tx) => {
      const counter = await tx.get(counterRef);
      const seq = typeof counter.get('next') === 'number' ? (counter.get('next') as number) : 1;
      const packetNo = formatPacketNo(seq);
      const meta = { updatedAt: now, updatedBy: uid };
      tx.set(
        counterRef,
        counter.exists ? { next: seq + 1, ...meta } : { next: seq + 1, createdAt: now, createdBy: uid, ...meta, schemaVersion: 1 },
        { merge: true },
      );
      const packet = SafeCustody.schema.parse(
        compact({
          packetNo,
          testatorContactId: testator.id,
          testatorName: testator.name,
          responsibleUid,
          matterId: input.matterId,
          items: input.items,
          location: input.location,
          receivedOn: input.receivedOn,
          status: 'held',
          movements: [
            compact({ at: now, by: uid, kind: 'in', reason: 'Received into safe custody', location: input.location }),
          ],
          notes: input.notes || undefined,
          pendingDestruction: null,
          ...derivedFields(packetNo, testator.name, input.location),
          createdAt: now,
          createdBy: uid,
          updatedAt: now,
          updatedBy: uid,
          schemaVersion: SafeCustody.version,
          _requestId: requestId,
        }),
      );
      tx.create(ref, packet);
      return packetNo;
    });
    log.info('packet received', { packetId: ref.id, items: input.items.length });
    return { id: ref.id, packetNo };
  },
} satisfies CallableDefinition<typeof ReceivePacketInput, ReceivePacketResult>;

export const receive = defineCallable(receiveDefinition);
