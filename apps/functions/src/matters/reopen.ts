import { FieldValue, type Firestore, type Transaction } from 'firebase-admin/firestore';

import {
  dateOnlyAt,
  DomainError,
  PERMISSIONS,
  ReopenMatterInput,
  retentionFor,
  SetLegalHoldInput,
  type ClosingRecord,
  type DestructionRequest,
  type MatterType,
  type ReopenMatterResult,
  type SetLegalHoldResult,
} from '@materia/domain';

import { readClosing, readRetentionSettings } from './closing';
import { liveMatter, matterPath } from './shared';
import { audit } from '../audit/audit';
import { stamp } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { orgClock } from '../core/emulator-clock';

/*
 * Reopening a closed or archived matter, and legal holds (CORE-19). Both take a matter out of the
 * destruction queue: a pending or approved entry is cancelled, and one already being destroyed
 * can't be stopped (FAILED_PRECONDITION, `details.reason: 'destruction_in_progress'`).
 */

type Data = Record<string, unknown>;

export const destructionRequestPath = (orgId: string, matterId: string) => `orgs/${orgId}/destructionQueue/${matterId}`;

/**
 * Reads the matter's destruction queue entry inside `tx` and returns the write that cancels it
 * (call it after every read). Refuses when the destruction has started.
 */
export async function cancelQueuedDestruction(
  tx: Transaction,
  db: Firestore,
  orgId: string,
  matterId: string,
  reason: NonNullable<DestructionRequest['cancelledReason']>,
  now: Date,
): Promise<() => void> {
  const ref = db.doc(destructionRequestPath(orgId, matterId));
  const status = (await tx.get(ref)).get('status') as DestructionRequest['status'] | undefined;
  if (status === 'destroying' || status === 'destroyed') {
    throw new DomainError('FAILED_PRECONDITION', 'The matter is being destroyed', {
      reason: 'destruction_in_progress',
      matterId,
    });
  }
  if (status !== 'pending' && status !== 'approved') return () => undefined;
  return () => tx.update(ref, { status: 'cancelled', cancelledReason: reason, updatedAt: now, updatedBy: 'system' });
}

/** The fields reopening clears: closing, retention and archiving (CORE-19). */
export const REOPEN_CLEARS = ['closedAt', 'closeReason', 'closing', 'destroyAfter', 'archivedAt'] as const;

export function reopenPatch(): Data {
  return Object.fromEntries(REOPEN_CLEARS.map((field) => [field, FieldValue.delete()]));
}

/**
 * `matters-reopen` (CORE-19, `matter.status`: lawyer and above, idempotent): a closed or archived
 * matter back to `open`, with a reason. Clears `destroyAfter` (and the closing record) and cancels
 * a queued destruction. Audited as `matter.reopened`.
 */
export const reopenDefinition = {
  name: 'matters-reopen',
  input: ReopenMatterInput,
  roles: PERMISSIONS['matter.status'],
  idempotent: true,
  handler: async (ctx): Promise<ReopenMatterResult> => {
    const { input, orgId, uid, role, db, requestId, log } = ctx;
    const now = (await orgClock(db, orgId, ctx.clock)).now();
    const ref = db.doc(matterPath(orgId, input.matterId));
    const from = await db.runTransaction(async (tx) => {
      const matter = liveMatter(await tx.get(ref), role, input.matterId);
      const status = matter['status'] as string;
      if (status !== 'closed' && status !== 'archived') {
        throw new DomainError('MATTER_INVALID_TRANSITION', `A ${status} matter can't be reopened`, {
          matterId: input.matterId,
          from: status,
          to: 'open',
          allowed: [],
        });
      }
      const cancel = await cancelQueuedDestruction(tx, db, orgId, input.matterId, 'reopened', now);
      tx.update(ref, { status: 'open', ...reopenPatch(), ...stamp(uid, now, requestId) });
      cancel();
      return status;
    });
    await audit(ctx, {
      action: 'matter.reopened',
      entity: { path: ref.path },
      summary: `Matter ${input.matterId} reopened`,
      data: { from, reason: input.reason },
    });
    log.info('matter reopened', { matterId: input.matterId, from });
    return { matterId: input.matterId, status: 'open' };
  },
} satisfies CallableDefinition<typeof ReopenMatterInput, ReopenMatterResult>;

/**
 * `matters-setLegalHold` (CORE-19, `matter.legalHold`: owner and admin, idempotent). Placing a
 * hold clears `destroyAfter` and cancels a queued destruction; releasing it on a closed or archived
 * matter recomputes `destroyAfter` from the closing day (minors and originals in custody still
 * keep it). Audited as `matter.legal_hold_placed` or `matter.legal_hold_released`.
 */
export const setLegalHoldDefinition = {
  name: 'matters-setLegalHold',
  input: SetLegalHoldInput,
  roles: PERMISSIONS['matter.legalHold'],
  idempotent: true,
  handler: async (ctx): Promise<SetLegalHoldResult> => {
    const { input, orgId, uid, role, db, requestId, log } = ctx;
    const now = (await orgClock(db, orgId, ctx.clock)).now();
    const settings = await readRetentionSettings(db, orgId);
    const ref = db.doc(matterPath(orgId, input.matterId));

    const result = await db.runTransaction(async (tx) => {
      const matter = liveMatter(await tx.get(ref), role, input.matterId);
      const closed = matter['status'] === 'closed' || matter['status'] === 'archived';
      const legalHold = { on: input.on, reason: input.reason, by: uid, at: now };
      if (input.on) {
        const cancel = await cancelQueuedDestruction(tx, db, orgId, input.matterId, 'legal_hold', now);
        tx.update(ref, {
          legalHold,
          ...(closed
            ? { destroyAfter: FieldValue.delete(), 'closing.holds': FieldValue.arrayUnion('legal_hold') }
            : {}),
          ...stamp(uid, now, requestId),
        });
        cancel();
        return { destroyAfter: null, holds: closed ? ['legal_hold' as const] : [] };
      }
      if (!closed) {
        tx.update(ref, { legalHold, ...stamp(uid, now, requestId) });
        return { destroyAfter: null, holds: [] };
      }
      // Released on a closed matter: the retention date as closing would have set it.
      const closedAt = (matter['closedAt'] as { toDate?: () => Date } | undefined)?.toDate?.() ?? now;
      const closedOn = dateOnlyAt(closedAt, settings.timeZone);
      const reads = await readClosing(db, tx, orgId, input.matterId, matter, closedOn);
      const retention = retentionFor({
        type: matter['type'] as MatterType,
        closedOn,
        retentionYears: settings.retentionYears,
        originals: (matter['closing'] as ClosingRecord | undefined)?.originals,
        hasMinor: reads.hasMinor,
        legalHold: false,
      });
      tx.update(ref, {
        legalHold,
        destroyAfter: retention.destroyAfter ?? FieldValue.delete(),
        ...(matter['closing'] ? { 'closing.holds': retention.holds } : {}),
        ...stamp(uid, now, requestId),
      });
      return retention;
    });

    await audit(ctx, {
      action: input.on ? 'matter.legal_hold_placed' : 'matter.legal_hold_released',
      entity: { path: ref.path },
      summary: `Legal hold ${input.on ? 'placed on' : 'released from'} matter ${input.matterId}`,
      data: { reason: input.reason, destroyAfter: result.destroyAfter },
    });
    log.info('legal hold set', { matterId: input.matterId, on: input.on });
    return { matterId: input.matterId, on: input.on, ...result };
  },
} satisfies CallableDefinition<typeof SetLegalHoldInput, SetLegalHoldResult>;

export const reopen = defineCallable(reopenDefinition);
export const setLegalHold = defineCallable(setLegalHoldDefinition);
