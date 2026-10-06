import { documentSearchTokens } from '@materia/domain';

import { searchPatch } from '../core/search';
import { defineTrigger, type TriggerChange, type TriggerContext, type TriggerDefinition } from '../core/trigger';
import { clearFixedReviewCodes } from '../migration/clear';

/**
 * Keeps a document's server-owned `search` in step with its name (CORE-15), for ⌘K. Reads the
 * current document in a transaction and writes `search` only when it's out of date, so its own
 * write (and any write that leaves the name alone: scans, versions, tags) is a no-op: no loop. It
 * leaves `updatedAt`/`updatedBy` alone, and the audit trigger ignores `search`.
 */
export async function maintainSearch(
  change: TriggerChange,
  ctx: TriggerContext,
): Promise<'updated' | 'unchanged' | 'deleted'> {
  if (!change.after) return 'deleted';
  const ref = ctx.db.doc(change.after.ref.path);
  const result = await ctx.db.runTransaction(async (tx) => {
    const current = await tx.get(ref);
    if (!current.exists) return 'deleted' as const;
    const data = current.data() as Record<string, unknown>;
    const patch = searchPatch(data, documentSearchTokens(typeof data['name'] === 'string' ? data['name'] : ''));
    if (!Object.keys(patch).length) return 'unchanged' as const;
    tx.update(ref, patch);
    return 'updated' as const;
  });
  ctx.log.debug('document search', { result, documentId: ctx.params['documentId'] });
  return result;
}

export const onWriteDefinition: TriggerDefinition = {
  name: 'documents-onWrite',
  document: 'orgs/{orgId}/matters/{matterId}/documents/{documentId}',
  on: 'written',
  handler: async (change, ctx) => {
    await maintainSearch(change, ctx);
    // A migrated document whose file was missing or unreadable, uploaded again, loses its review
    // codes (MIG-08).
    await clearFixedReviewCodes(change, ctx);
  },
};

/** `documents-onWrite`. */
export const onWrite = defineTrigger(onWriteDefinition);
