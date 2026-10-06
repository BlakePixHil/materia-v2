import type { Firestore } from 'firebase-admin/firestore';

import { contactNames, matterPath, matterSearch, searchContactIds } from './shared';
import { changedFields } from '../audit/entry';
import { defineTrigger, type TriggerChange, type TriggerContext, type TriggerDefinition } from '../core/trigger';
import { fillFromKeyFacts } from '../templates/fill-pending';

type Data = Record<string, unknown>;

/**
 * Fields whose change is not activity on the matter: what this trigger and other denormalisers
 * write, ordering, and the soft-delete stamp. Everything else (title, status, people, fees…) is.
 */
export const NON_ACTIVITY_FIELDS: ReadonlySet<string> = new Set([
  'search',
  'lastActivityAt',
  'nextDeadline',
  'openTaskCount',
  'wipCents',
  'recomputeVersion',
  'litigationSummary',
  'budget',
  'boardOrder',
  'deletedAt',
  'deletedBy',
  'emailToken',
  'legacyBilling',
]);

/** Whether a write changed anything that counts as activity (meta fields never do). */
export function isActivity(before: Data | undefined, after: Data | undefined): boolean {
  return changedFields(before, after).some((field) => !NON_ACTIVITY_FIELDS.has(field));
}

const millis = (value: unknown): number | undefined => {
  if (value instanceof Date) return value.getTime();
  const toMillis = (value as { toMillis?: () => number } | undefined)?.toMillis;
  return typeof toMillis === 'function' ? toMillis.call(value) : undefined;
};

/**
 * The denormalised fields of a matter that are out of date (empty when all are current):
 * - `search` from the number, title, client and deceased names and the external reference;
 * - `lastActivityAt`, filled when missing and moved forward to `activityAt` (never backwards);
 * - `deletedAt: null` on a matter written without it (seed, migration), so live lists find it.
 */
export function staleMatterFields(current: Data, names: ReadonlyMap<string, string>, activityAt?: Date): Data {
  const patch: Data = {};
  const search = matterSearch(current, names);
  if (JSON.stringify(current['search'] ?? null) !== JSON.stringify(search)) patch['search'] = search;
  const last = millis(current['lastActivityAt']);
  if (last === undefined) {
    patch['lastActivityAt'] = activityAt ?? current['createdAt'] ?? new Date();
  } else if (activityAt && activityAt.getTime() > last) {
    patch['lastActivityAt'] = activityAt;
  }
  if (!('deletedAt' in current)) patch['deletedAt'] = null;
  // Hook points for later tickets, kept here so one trigger owns a matter's list fields:
  // - openTaskCount: maintained from the tasks subcollection (tasks feature);
  // - nextDeadline: the earliest upcoming deadline (CORE-10, deadline engine);
  // - wipCents: unbilled time and disbursements (BILL-01).
  // Those writers update the matter with only these fields, which NON_ACTIVITY_FIELDS lists, so
  // they don't count as activity here; they call recordMatterActivity when their write is activity.
  return patch;
}

/**
 * For subcollection writers (notes, tasks, time, documents in later tickets): moves the matter's
 * `lastActivityAt` forward to `at`. A no-op when the matter is missing or already later.
 */
export async function recordMatterActivity(db: Firestore, orgId: string, matterId: string, at: Date): Promise<boolean> {
  const ref = db.doc(matterPath(orgId, matterId));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get('destroyedAt')) return false;
    const last = millis(snap.get('lastActivityAt'));
    if (last !== undefined && last >= at.getTime()) return false;
    tx.update(ref, { lastActivityAt: at });
    return true;
  });
}

/**
 * Keeps a matter's server-owned list fields current (CORE-03). Reads the document again in a
 * transaction and writes only the fields that are stale, so its own write (which changes only
 * NON_ACTIVITY_FIELDS) recomputes the same values and stops: no loop. Leaves `updatedAt` and
 * `updatedBy` alone; the audit trigger skips writes of these fields.
 */
export async function denormalise(
  change: TriggerChange,
  ctx: TriggerContext,
): Promise<'updated' | 'unchanged' | 'deleted'> {
  if (!change.after) return 'deleted';
  const before = change.before?.data() as Data | undefined;
  const after = (change.after.data() ?? {}) as Data;
  // A create keeps the lastActivityAt it was written with (filled if missing); an edit is activity.
  const activityAt = before && isActivity(before, after) ? ctx.time : undefined;
  const orgId = ctx.params['orgId'] as string;
  const names = await contactNames(ctx.db, orgId, searchContactIds(after));
  const ref = ctx.db.doc(change.after.ref.path);
  const result = await ctx.db.runTransaction(async (tx) => {
    const current = await tx.get(ref);
    if (!current.exists) return 'deleted' as const;
    // A destroyed matter's tombstone (CORE-19) keeps only what `matters-destroy` wrote.
    if (current.get('destroyedAt')) return 'unchanged' as const;
    const patch = staleMatterFields(current.data() as Data, names, activityAt);
    if (!Object.keys(patch).length) return 'unchanged' as const;
    tx.update(ref, patch);
    return 'updated' as const;
  });
  ctx.log.debug('matter list fields', { result, matterId: ctx.params['matterId'] });
  return result;
}

export const denormaliseDefinition: TriggerDefinition = {
  name: 'matters-denormalise',
  document: 'orgs/{orgId}/matters/{matterId}',
  on: 'written',
  handler: async (change, ctx) => {
    await denormalise(change, ctx);
    // A key fact standing for an event fills the template due dates waiting on it (CORE-07b).
    await fillFromKeyFacts(change, ctx);
  },
};

/** `matters-denormalise`. */
export const denormaliseTrigger = defineTrigger(denormaliseDefinition);
