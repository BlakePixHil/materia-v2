import {
  BILLING_UNIT_MINUTES,
  DomainError,
  PERMISSIONS,
  planWriteDown,
  TimeWriteDownInput,
  type SetTimeEntryStatusResult,
  type WriteDownChange,
} from '@materia/domain';

import { auditReview, REMOVE, reviewEntries } from './review';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { matterPath, writableMatter } from '../matters/shared';

/**
 * `time-writeDown` (BILL-03; `time.approve`, idempotent): writes down a matter's draft or final
 * entries to `newUnits` (one entry) or by `percent`, or writes them off (`writeOff`), with a
 * reason. A write-down approves the entry at the lower value; a write-off sets `written_off`. Both
 * keep the first original units and amount in `writeDown {originalUnits, originalAmountCents, by,
 * reason}` (`planWriteDown`), so `time-onWrite` moves the matter's WIP. Billed and written-off
 * entries, and write-downs that wouldn't lower the value, are skipped; entries changed since the
 * caller saw them are conflicts. Audited as `time.written_down` or `time.written_off`.
 */
export const writeDownDefinition = {
  name: 'time-writeDown',
  input: TimeWriteDownInput,
  roles: PERMISSIONS['time.approve'],
  idempotent: true,
  handler: async (ctx): Promise<SetTimeEntryStatusResult> => {
    const { input, orgId, uid, role, db, log } = ctx;
    writableMatter(await db.doc(matterPath(orgId, input.matterId)).get(), role, input.matterId);
    const billing = (await db.doc(`orgs/${orgId}`).get()).get('billing') as { unitMinutes?: unknown } | undefined;
    const unitMinutes = typeof billing?.unitMinutes === 'number' ? billing.unitMinutes : BILLING_UNIT_MINUTES;
    const change: WriteDownChange =
      input.writeOff === true
        ? { writeOff: true }
        : input.newUnits !== undefined
          ? { newUnits: input.newUnits }
          : input.percent !== undefined
            ? { percent: input.percent }
            : (() => {
                throw new DomainError('INVALID_ARGUMENT', 'Give new units, a percentage or a write-off');
              })();
    const result = await reviewEntries(ctx, input, (data) => {
      const { plan } = planWriteDown(
        {
          status: String(data['status']),
          units: Number(data['units']),
          amountCents: Number(data['amountCents']),
          rateCents: Number(data['rateCents']),
          writeDown: data['writeDown'] as { originalUnits: number; originalAmountCents: number } | undefined,
        },
        change,
        { by: uid, reason: input.reason, unitMinutes },
      );
      if (!plan) return null;
      return {
        status: plan.status,
        units: plan.units,
        amountCents: plan.amountCents,
        writeDown: plan.writeDown,
        ...(data['rejection'] !== undefined ? { rejection: REMOVE } : {}),
      };
    });
    const writeOff = 'writeOff' in change;
    await auditReview(
      ctx,
      input.matterId,
      writeOff ? 'time.written_off' : 'time.written_down',
      writeOff ? 'written off' : 'written down',
      result,
      writeOff ? {} : 'percent' in change ? { percent: change.percent } : { newUnits: change.newUnits },
    );
    log.info('time written down', {
      matterId: input.matterId,
      writeOff,
      updated: result.updated.length,
      skipped: result.skipped.length,
      conflicts: result.conflicts.length,
    });
    return result;
  },
} satisfies CallableDefinition<typeof TimeWriteDownInput, SetTimeEntryStatusResult>;

export const writeDown = defineCallable(writeDownDefinition);
