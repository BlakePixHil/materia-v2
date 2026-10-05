import { FieldValue } from 'firebase-admin/firestore';

import type { RateMatter, RateMember } from '@materia/domain';

import { planTimeSync, rateOrg, timeEntryPath, type TimeSyncPlan } from './shared';
import { defineTrigger, type TriggerChange, type TriggerContext, type TriggerDefinition } from '../core/trigger';
import { recordMatterActivity } from '../matters/denormalise';
import { matterPath } from '../matters/shared';

type Data = Record<string, unknown>;

export interface TimeWriteOutcome {
  wipDelta: TimeSyncPlan['wipDelta'];
  patched: string[];
}

/**
 * `time-onWrite` (BILL-01), on every write of `orgs/{orgId}/matters/{matterId}/timeEntries/{id}`:
 *
 * 1. Reads the org's billing settings, the matter's fee and the author's rates, then in one
 *    transaction on the entry recomputes a draft's `units`, `rateCents` and `amountCents`
 *    (`planTimeSync`; the client's values are only a preview) and moves the matter's `wipCents` by
 *    the change in the entry's contribution (a server increment), recording it in `wipCountedCents`.
 *    The transaction reads the entry again, so concurrent and out-of-order events converge on the
 *    exact WIP.
 * 2. A new entry moves the matter's `lastActivityAt` forward. Entries aren't written to the
 *    activity feed (a day's time would drown it).
 *
 * Metrics rollups (INS-01) hook in here when they land.
 */
export async function syncTimeEntry(change: TriggerChange, ctx: TriggerContext): Promise<TimeWriteOutcome> {
  const { db, log } = ctx;
  const orgId = ctx.params['orgId'] as string;
  const matterId = ctx.params['matterId'] as string;
  const entryId = ctx.params['entryId'] as string;
  const before = change.before?.data() as Data | undefined;
  const after = change.after?.data() as Data | undefined;
  const entryRef = db.doc(timeEntryPath(orgId, matterId, entryId));
  const matterRef = db.doc(matterPath(orgId, matterId));
  const author = (after?.['uid'] ?? before?.['uid']) as string | undefined;

  const [org, matter, member] = await Promise.all([
    db.doc(`orgs/${orgId}`).get(),
    matterRef.get(),
    author ? db.doc(`orgs/${orgId}/members/${author}`).get() : Promise.resolve(null),
  ]);
  const billing = rateOrg(org.data());
  const inputs = billing
    ? {
        org: billing,
        matter: (matter.data() as RateMatter | undefined) ?? null,
        member: (member?.data() as RateMember | undefined) ?? null,
      }
    : null;
  if (!billing) log.warn('org has no billing settings; time entry values left as written', { matterId, entryId });

  // A destroyed matter's tombstone (CORE-19) keeps no WIP or activity.
  const live = matter.exists && !matter.get('destroyedAt');

  const plan = await db.runTransaction(async (tx) => {
    const current = await tx.get(entryRef);
    const planned = planTimeSync(current.exists ? (current.data() as Data) : undefined, before, inputs);
    // Without the matter there's no WIP to keep; leave the count alone so nothing is lost.
    if (!live) {
      delete planned.patch['wipCountedCents'];
      planned.wipDelta = 0;
    }
    if (planned.wipDelta) tx.update(matterRef, { wipCents: FieldValue.increment(planned.wipDelta) });
    if (current.exists && Object.keys(planned.patch).length) tx.update(entryRef, planned.patch);
    return planned;
  });

  if (!before && after && live) await recordMatterActivity(db, orgId, matterId, ctx.time);

  const outcome = { wipDelta: plan.wipDelta, patched: Object.keys(plan.patch) };
  log.info('time entry synced', { matterId, entryId, ...outcome });
  return outcome;
}

export const onWriteDefinition: TriggerDefinition = {
  name: 'time-onWrite',
  document: 'orgs/{orgId}/matters/{matterId}/timeEntries/{entryId}',
  on: 'written',
  handler: async (change, ctx) => void (await syncTimeEntry(change, ctx)),
};

export const onWrite = defineTrigger(onWriteDefinition);
