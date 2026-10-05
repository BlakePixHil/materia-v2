import { FieldValue } from 'firebase-admin/firestore';

import {
  ConfirmDestructionInput,
  DomainError,
  SAFE_CUSTODY_CALLABLES,
  SAFE_CUSTODY_RELEASE_ROLES,
  SafeCustodyMovementSchema,
  type MatterDocumentRef,
  type RecordMovementResult,
  type SafeCustodyStatus,
} from '@materia/domain';

import { assertMayRelease } from './record-movement';
import { livePacket, packetPath } from './shared';
import { stamp } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';

interface Pending {
  requestedBy: string;
  authority: MatterDocumentRef;
  reason: string;
}

/**
 * `safeCustody-confirmDestruction` (CORE-17, lawyer or above, a sign-in within five minutes,
 * idempotent): the second half of the two-person rule. A lawyer other than the one who asked
 * confirms (`approve: true`): the packet is `destroyed`, with a `destroyed` movement carrying the
 * authority and both people. Either of them may decline (`approve: false`), which clears the
 * request and changes nothing else. The one who asked can't confirm their own: PERMISSION_DENIED
 * `same_person`. Nothing pending: FAILED_PRECONDITION `no_pending_destruction`.
 */
export const confirmDestructionDefinition = {
  name: SAFE_CUSTODY_CALLABLES.confirmDestruction,
  input: ConfirmDestructionInput,
  roles: SAFE_CUSTODY_RELEASE_ROLES,
  idempotent: true,
  handler: async (ctx): Promise<RecordMovementResult> => {
    const { input, orgId, uid, db, clock, log, requestId } = ctx;
    assertMayRelease(ctx);
    const ref = db.doc(packetPath(orgId, input.id));
    const now = clock.now();
    const status = await db.runTransaction(async (tx) => {
      const packet = livePacket(await tx.get(ref), input.id);
      const pending = packet['pendingDestruction'] as Pending | null | undefined;
      if (!pending) {
        throw new DomainError('FAILED_PRECONDITION', 'No destruction is waiting', { reason: 'no_pending_destruction' });
      }
      const patch: Record<string, unknown> = { ...stamp(uid, now, requestId), pendingDestruction: null };
      if (!input.approve) {
        tx.update(ref, patch);
        return packet['status'] as SafeCustodyStatus;
      }
      if (pending.requestedBy === uid) {
        throw new DomainError('PERMISSION_DENIED', 'A second lawyer must confirm the destruction', {
          reason: 'same_person',
        });
      }
      const movement = SafeCustodyMovementSchema.parse({
        at: now,
        by: pending.requestedBy,
        kind: 'destroyed',
        reason: input.reason ? `${pending.reason} (${input.reason})` : pending.reason,
        authority: pending.authority,
        approvedBy: uid,
      });
      patch['movements'] = FieldValue.arrayUnion(movement);
      patch['status'] = 'destroyed';
      tx.update(ref, patch);
      return 'destroyed' as const;
    });
    log.info(input.approve ? 'destruction confirmed' : 'destruction declined', { packetId: input.id });
    return { status, pendingConfirmation: false };
  },
} satisfies CallableDefinition<typeof ConfirmDestructionInput, RecordMovementResult>;

export const confirmDestruction = defineCallable(confirmDestructionDefinition);
