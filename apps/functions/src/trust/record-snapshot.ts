import {
  asAtProblem,
  can,
  DomainError,
  PERMISSIONS,
  RecordTrustSnapshotInput,
  TRUST_CALLABLES,
  TrustSnapshot,
  today,
  trustRecordsName,
  type TrustSaveResult,
} from '@materia/domain';

import { trustOrg, trustSnapshotPath } from './shared';
import { audit } from '../audit/audit';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { matterPath, writableMatter } from '../matters/shared';

/**
 * `trust-recordSnapshot` (BILL-11, ADR-035; `trust.record` and `billing.view`, idempotent): records
 * the trust balance someone copied from the firm's trust records for a matter, as at a date that
 * isn't in the future (the org's time zone). It replaces the matter's snapshot; the audit log keeps
 * every change, which is the history. Refused while the org's "Show trust balances on matters" is
 * off, and while `billing.trustDisplay` is. Never a transaction: no deposit, withdrawal or balance
 * arithmetic, only the copied amount.
 */
export const recordSnapshotDefinition = {
  name: TRUST_CALLABLES.recordSnapshot,
  input: RecordTrustSnapshotInput,
  roles: PERMISSIONS['trust.record'],
  idempotent: true,
  handler: async ({ input, orgId, uid, role, db, clock, requestId, log }): Promise<TrustSaveResult> => {
    if (!can(role, 'billing.view')) throw new DomainError('PERMISSION_DENIED', 'This role cannot see trust balances');
    const org = await trustOrg(db, orgId, clock);
    if (!org.settings.showOnMatters)
      throw new DomainError('FAILED_PRECONDITION', 'Trust balances are off for this practice', {
        reason: 'trust_display_off',
      });
    const problem = asAtProblem(input.asAt, today(org.timeZone, clock.now()));
    if (problem) throw new DomainError('INVALID_ARGUMENT', problem, { fields: { asAt: [problem] } });
    writableMatter(await db.doc(matterPath(orgId, input.matterId)).get(), role, input.matterId);

    const ref = db.doc(trustSnapshotPath(orgId, input.matterId));
    const now = clock.now();
    const before = await ref.get();
    const fields = {
      matterId: input.matterId,
      amountCents: input.amountCents,
      asAt: input.asAt,
      source: 'manual' as const,
      sourceSystemName: trustRecordsName(org.settings),
      ...(input.note ? { note: input.note } : {}),
      recordedBy: uid,
      recordedAt: now,
    };
    const meta = {
      createdAt: now,
      createdBy: uid,
      updatedAt: now,
      updatedBy: uid,
      schemaVersion: TrustSnapshot.version,
    };
    // Validated as stored; an update keeps the snapshot's creation.
    TrustSnapshot.schema.parse({ ...fields, ...meta });
    await ref.set({
      ...fields,
      ...meta,
      ...(before.exists ? { createdAt: before.get('createdAt'), createdBy: before.get('createdBy') } : {}),
      _requestId: requestId,
    });

    await audit(
      { uid, orgId, requestId, db, clock },
      {
        action: 'trust.snapshot_recorded',
        entity: { path: ref.path },
        summary: before.exists ? 'Trust balance snapshot updated' : 'Trust balance snapshot recorded',
        data: {
          matterId: input.matterId,
          amountCents: input.amountCents,
          asAt: input.asAt,
          sourceSystemName: fields.sourceSystemName,
          ...(before.exists
            ? { previousAmountCents: before.get('amountCents'), previousAsAt: before.get('asAt') }
            : {}),
        },
      },
    );
    log.info('trust snapshot recorded', { orgId, matterId: input.matterId, replaced: before.exists });
    return { saved: true };
  },
} satisfies CallableDefinition<typeof RecordTrustSnapshotInput, TrustSaveResult>;

export const recordSnapshot = defineCallable(recordSnapshotDefinition);
