import {
  DEFAULT_ORG_TIMEZONE,
  disclosureChangePct,
  feeTerms,
  PERMISSIONS,
  reviseDisclosure,
  today as todayIn,
  UpdateFeeInput,
  type DisclosureRevision,
  type FeeRevision,
  type FeeTerms,
  type UpdateFeeResult,
} from '@materia/domain';

import { recomputeBudget } from './budget';
import { audit } from '../audit/audit';
import { stamp } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { isEnabled, requireFlag } from '../core/flags';
import { cleanDisclosure, disclosureDue, disclosureOf } from '../costs/shared';
import { matterPath, writableMatter } from '../matters/shared';

/** Terms in a stable form, to tell whether a revision changes anything. */
function canonical(terms: FeeTerms): string {
  const record = terms as Record<string, unknown>;
  return JSON.stringify(
    Object.keys(record)
      .sort()
      .map((key) => [key, record[key]]),
  );
}

/**
 * `fees-update` (BILL-05; `matter.fee`: lawyer and above; flag `billing.feeBudgets`). Revises a
 * matter's fee arrangement: the terms are replaced, `fee.revision` goes up by one (re-arming the
 * budget alerts) and `fee.history` gains `{at, by, from, to, reason}`. The change applies forward
 * only: final, billed and written-off time keeps its snapshot and issued invoices are untouched.
 * Terms identical to the current ones change nothing. Audited as `matter.fee_revised`; then the
 * budget is recomputed against the new basis.
 *
 * With `billing.costsDisclosure` on (BILL-06) the same transaction assesses the costs disclosure
 * again on the new estimate (`reviseDisclosure`): one already given that the revision changes
 * significantly (its band moves, or the estimate rises by more than `org.billing.disclosureChangePct`,
 * 10% by default) becomes `update_required`, with a task and a notification for the responsible
 * lawyer (audited as `matter.disclosure_update_required`).
 */
export const updateDefinition = {
  name: 'fees-update',
  input: UpdateFeeInput,
  roles: PERMISSIONS['matter.fee'],
  idempotent: true,
  handler: async (ctx): Promise<UpdateFeeResult> => {
    const { input, orgId, uid, role, db, clock, requestId, log } = ctx;
    await requireFlag({ orgId, db, clock }, 'billing.feeBudgets');
    const ref = db.doc(matterPath(orgId, input.matterId));
    const reason = input.reason.trim();
    const next = feeTerms(input.fee);
    const now = clock.now();
    const [disclosureOn, org] = await Promise.all([
      isEnabled({ orgId, db, clock }, 'billing.costsDisclosure'),
      db.doc(`orgs/${orgId}`).get(),
    ]);
    const orgData = org.data() as { timezone?: unknown; billing?: { disclosureChangePct?: unknown } } | undefined;
    const timeZone =
      typeof orgData?.timezone === 'string' && orgData.timezone ? orgData.timezone : DEFAULT_ORG_TIMEZONE;
    const day = todayIn(timeZone, now);

    let dispatch: () => Promise<void> = async () => undefined;
    const result = await db.runTransaction(async (tx) => {
      dispatch = async () => undefined;
      const matter = writableMatter(await tx.get(ref), role, input.matterId);
      const fee = (matter['fee'] ?? {}) as Partial<FeeTerms> & { revision?: number; history?: FeeRevision[] };
      const current = fee.arrangement ? feeTerms(fee as FeeTerms) : undefined;
      const revision = typeof fee.revision === 'number' ? fee.revision : 0;
      if (current && canonical(current) === canonical(next)) {
        return { revision, changed: false, from: current, disclosure: undefined };
      }
      const entry: FeeRevision = { at: now, by: uid, ...(current ? { from: current } : {}), to: next, reason };
      // BILL-06: the disclosure follows the new estimate (its task is read before anything is written).
      let disclosure: DisclosureRevision | undefined;
      if (disclosureOn) {
        disclosure = reviseDisclosure({
          current: disclosureOf(matter),
          jurisdiction: String(matter['jurisdiction'] ?? ''),
          fee: next,
          pct: disclosureChangePct(orgData),
          uid,
          now,
          today: day,
        });
        if (disclosure.updateRequired) {
          const due = await disclosureDue(
            { db, orgId, clock, log, ports: ctx.ports },
            { tx, matterRef: ref, matter, kind: 'update', since: day, today: day, reasons: disclosure.reasons },
          );
          disclosure.next.taskId = due.taskId;
          dispatch = due.dispatch;
        }
      }
      tx.update(ref, {
        fee: { ...next, revision: revision + 1, history: [...(fee.history ?? []), entry] },
        ...(disclosure && !disclosure.unchanged ? { costsDisclosure: cleanDisclosure(disclosure.next) } : {}),
        ...stamp(uid, now, requestId),
      });
      return { revision: revision + 1, changed: true, from: current, disclosure };
    });
    await dispatch();

    if (result.disclosure?.updateRequired) {
      await audit(ctx, {
        action: 'matter.disclosure_update_required',
        entity: { path: ref.path },
        summary: `Costs disclosure on matter ${input.matterId} needs updating after fee revision ${result.revision}`,
        data: { revision: result.revision, reasons: result.disclosure.reasons },
      });
    }
    if (result.changed) {
      await audit(ctx, {
        action: 'matter.fee_revised',
        entity: { path: ref.path },
        summary: `Fee on matter ${input.matterId} revised (revision ${result.revision})`,
        data: {
          revision: result.revision,
          ...(result.from ? { fromArrangement: result.from.arrangement } : {}),
          toArrangement: next.arrangement,
          reason,
        },
      });
      await recomputeBudget({ db, orgId, clock, log, ports: ctx.ports }, input.matterId);
    }
    log.info('fee updated', { matterId: input.matterId, revision: result.revision, changed: result.changed });
    return { matterId: input.matterId, revision: result.revision, changed: result.changed };
  },
} satisfies CallableDefinition<typeof UpdateFeeInput, UpdateFeeResult>;

export const update = defineCallable(updateDefinition);
