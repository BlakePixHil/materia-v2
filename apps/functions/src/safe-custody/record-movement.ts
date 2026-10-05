import { FieldValue } from 'firebase-admin/firestore';

import {
  DomainError,
  MOVEMENT_TRANSITIONS,
  needsAuthority,
  PERMISSIONS,
  RecordMovementInput,
  SAFE_CUSTODY_CALLABLES,
  SAFE_CUSTODY_REAUTH_MINUTES,
  SAFE_CUSTODY_RELEASE_ROLES,
  SafeCustodyMovementSchema,
  type RecordMovementResult,
  type Role,
  type SafeCustodyStatus,
} from '@materia/domain';

import { notifyApprovers } from './notify';
import { assertDocument, assertOpen, derivedFields, livePacket, packetPath, resolveRecipient } from './shared';
import { compact, stamp } from '../contacts/shared';
import { defineCallable, type CallableContext, type CallableDefinition } from '../core/callable';
import { requireRecentLogin } from '../core/user-callable';

/** Releasing or destroying an original: a lawyer or above, signed in within the last few minutes. */
export function assertMayRelease(ctx: Pick<CallableContext<unknown>, 'role' | 'token' | 'clock'>): void {
  if (!(SAFE_CUSTODY_RELEASE_ROLES as readonly Role[]).includes(ctx.role)) {
    throw new DomainError('PERMISSION_DENIED', 'Releasing or destroying an original needs a lawyer or above');
  }
  requireRecentLogin(ctx.token, ctx.clock.now().getTime(), SAFE_CUSTODY_REAUTH_MINUTES);
}

/**
 * `safeCustody-recordMovement` (CORE-17, `safeCustody.edit`, idempotent): appends one movement to
 * the packet's chain of custody and moves its status (`MOVEMENT_TRANSITIONS`).
 *
 * - `released` and `destroyed` need a lawyer or above (PERMISSION_DENIED), a sign-in within five
 *   minutes (REAUTH_REQUIRED) and an authority document the caller can open, scanned clean.
 * - `destroyed` doesn't destroy: it records the request as `pendingDestruction` and tells the other
 *   lawyers; a second lawyer confirms with `safeCustody-confirmDestruction`.
 * - Nothing else moves while a destruction is pending: FAILED_PRECONDITION `destruction_pending`.
 * - A movement the status doesn't allow is FAILED_PRECONDITION `invalid_movement`; a released or
 *   destroyed packet `packet_closed`.
 */
export const recordMovementDefinition = {
  name: SAFE_CUSTODY_CALLABLES.recordMovement,
  input: RecordMovementInput,
  roles: PERMISSIONS['safeCustody.edit'],
  idempotent: true,
  handler: async (ctx): Promise<RecordMovementResult> => {
    const { input, orgId, uid, role, db, clock, log, requestId } = ctx;
    if (needsAuthority(input.kind)) assertMayRelease(ctx);
    if (input.authority) await assertDocument(db, orgId, role, input.authority, 'authority');
    const toContactId = input.toContactId ? await resolveRecipient(db, orgId, input.toContactId) : undefined;

    const ref = db.doc(packetPath(orgId, input.id));
    const now = clock.now();
    const outcome = await db.runTransaction(async (tx) => {
      const packet = livePacket(await tx.get(ref), input.id);
      assertOpen(packet);
      if (packet['pendingDestruction']) {
        throw new DomainError('FAILED_PRECONDITION', 'A destruction is waiting for a second lawyer', {
          reason: 'destruction_pending',
        });
      }
      const status = packet['status'] as SafeCustodyStatus;
      const transition = MOVEMENT_TRANSITIONS[input.kind];
      if (!transition.from.includes(status)) {
        throw new DomainError('FAILED_PRECONDITION', `A ${status} packet can’t be ${input.kind}`, {
          reason: 'invalid_movement',
          status,
        });
      }
      const patch: Record<string, unknown> = { ...stamp(uid, now, requestId) };
      if (input.kind === 'destroyed') {
        patch['pendingDestruction'] = {
          requestedBy: uid,
          requestedAt: now,
          authority: input.authority,
          reason: input.reason,
        };
        tx.update(ref, patch);
        return { status, pendingConfirmation: true, packet };
      }
      const movement = SafeCustodyMovementSchema.parse(
        compact({
          at: now,
          by: uid,
          kind: input.kind,
          reason: input.reason,
          to: input.to || undefined,
          toContactId,
          authority: input.authority,
          location: input.kind === 'returned' ? (input.location ?? packet['location']) : undefined,
        }),
      );
      patch['movements'] = FieldValue.arrayUnion(movement);
      patch['status'] = transition.to;
      if (input.kind === 'returned' && input.location) {
        patch['location'] = input.location;
        Object.assign(
          patch,
          derivedFields(String(packet['packetNo']), String(packet['testatorName'] ?? ''), input.location),
        );
      }
      tx.update(ref, patch);
      return { status: transition.to, pendingConfirmation: false, packet };
    });

    if (outcome.pendingConfirmation) {
      await notifyApprovers(ctx, input.id, String(outcome.packet['packetNo']));
    }
    log.info('movement recorded', { packetId: input.id, kind: input.kind, status: outcome.status });
    return { status: outcome.status, pendingConfirmation: outcome.pendingConfirmation };
  },
} satisfies CallableDefinition<typeof RecordMovementInput, RecordMovementResult>;

export const recordMovement = defineCallable(recordMovementDefinition);
