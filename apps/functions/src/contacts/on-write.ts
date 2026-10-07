import type { Contact } from '@materia/domain';

import { staleDerived } from './shared';
import { defineTrigger, type TriggerChange, type TriggerContext, type TriggerDefinition } from '../core/trigger';
import { clearFixedReviewCodes } from '../migration/clear';

/**
 * Keeps a contact's server-owned `search`, `dedupeKey` and `sortName` in step with its fields
 * (CORE-01). Reads the current document in a transaction and writes only the fields that are out
 * of date, so its own write (and any write that leaves the names alone) is a no-op: no loop.
 * It leaves `updatedAt`/`updatedBy` alone, and the audit trigger ignores these fields.
 */
export async function maintainDerived(
  change: TriggerChange,
  ctx: TriggerContext,
): Promise<'updated' | 'unchanged' | 'deleted'> {
  if (!change.after) return 'deleted';
  const ref = ctx.db.doc(change.after.ref.path);
  const result = await ctx.db.runTransaction(async (tx) => {
    const current = await tx.get(ref);
    if (!current.exists) return 'deleted' as const;
    const patch = staleDerived(current.data() as Partial<Contact>);
    if (!Object.keys(patch).length) return 'unchanged' as const;
    tx.update(ref, patch);
    return 'updated' as const;
  });
  ctx.log.debug('derived fields', { result, contactId: ctx.params['contactId'] });
  return result;
}

export const onWriteDefinition: TriggerDefinition = {
  name: 'contacts-onWrite',
  document: 'orgs/{orgId}/contacts/{contactId}',
  on: 'written',
  handler: async (change, ctx) => {
    await maintainDerived(change, ctx);
    // A migrated referrer named, or a contact merged or deleted, loses its review codes (MIG-08).
    await clearFixedReviewCodes(change, ctx);
  },
};

/** `contacts-onWrite`. */
export const onWrite = defineTrigger(onWriteDefinition);
