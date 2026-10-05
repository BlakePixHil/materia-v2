import { FieldValue } from 'firebase-admin/firestore';

import { PERMISSIONS, SAFE_CUSTODY_CALLABLES, UpdatePacketInput, type SafeCustodyLocation } from '@materia/domain';

import {
  assertActiveMember,
  assertDocument,
  assertMatter,
  assertOpen,
  derivedFields,
  livePacket,
  packetPath,
} from './shared';
import { stamp } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';

/**
 * `safeCustody-update` (CORE-17, `safeCustody.edit`, idempotent): changes a packet's items,
 * location, responsible lawyer, will matter (`null` unlinks it) or notes. Movements and status
 * change only through `safeCustody-recordMovement`. Released and destroyed packets are closed:
 * FAILED_PRECONDITION `packet_closed`.
 */
export const updateDefinition = {
  name: SAFE_CUSTODY_CALLABLES.update,
  input: UpdatePacketInput,
  roles: PERMISSIONS['safeCustody.edit'],
  idempotent: true,
  handler: async ({ input, orgId, uid, role, db, clock, log, requestId }): Promise<{ id: string }> => {
    if (input.responsibleUid) await assertActiveMember(db, orgId, input.responsibleUid, 'responsibleUid');
    if (input.matterId) await assertMatter(db, orgId, role, input.matterId);
    for (const [index, item] of (input.items ?? []).entries()) {
      if (item.document) await assertDocument(db, orgId, role, item.document, `items.${index}.document`);
    }
    const ref = db.doc(packetPath(orgId, input.id));
    await db.runTransaction(async (tx) => {
      const packet = livePacket(await tx.get(ref), input.id);
      assertOpen(packet);
      const patch: Record<string, unknown> = { ...stamp(uid, clock.now(), requestId) };
      if (input.items) patch['items'] = input.items;
      if (input.responsibleUid) patch['responsibleUid'] = input.responsibleUid;
      if (input.matterId !== undefined) patch['matterId'] = input.matterId ?? FieldValue.delete();
      if (input.notes !== undefined) patch['notes'] = input.notes || FieldValue.delete();
      if (input.location) {
        patch['location'] = input.location;
        Object.assign(
          patch,
          derivedFields(String(packet['packetNo']), String(packet['testatorName'] ?? ''), input.location as SafeCustodyLocation),
        );
      }
      tx.update(ref, patch);
    });
    log.info('packet updated', { packetId: input.id, fields: Object.keys(input).filter((key) => key !== 'requestId') });
    return { id: input.id };
  },
} satisfies CallableDefinition<typeof UpdatePacketInput, { id: string }>;

export const update = defineCallable(updateDefinition);
