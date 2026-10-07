import { FieldValue } from 'firebase-admin/firestore';

import { openReviewCodes, reviewCodesFixedBy, reviewPatch } from '@materia/domain';

import { isMigrationWrite } from '../core/migration';
import type { TriggerChange, TriggerContext } from '../core/trigger';

type Data = Record<string, unknown>;

/**
 * Clears the migration review codes (MIG-08) a person's edit put right elsewhere in the app: a
 * migrated matter renamed, its client, stage, fee or closing changed; a referrer named; a file
 * uploaded again; a member's budgets changed; or the record deleted or merged away. The codes move
 * from `needsReview` to `reviewed`, re-read in a transaction. The migration's own writes and
 * creates are left alone, and so is this write (it changes no field a code names): no loop.
 * Called by the triggers that already run on these records (matters-denormalise, contacts-onWrite,
 * documents-onWrite, auth-syncClaims; `orgs-updateSettings` confirms a renamed practice's name).
 * Returns the codes cleared.
 */
export async function clearFixedReviewCodes(change: TriggerChange, ctx: TriggerContext): Promise<string[]> {
  const before = change.before?.data() as Data | undefined;
  const after = change.after?.data() as Data | undefined;
  // A destroyed matter's tombstone (CORE-19) keeps only what `matters-destroy` wrote.
  if (!change.after || after?.['destroyedAt'] || isMigrationWrite(before, after)) return [];
  const codes = reviewCodesFixedBy(before, after);
  if (!codes.length) return [];
  const ref = ctx.db.doc(change.after.ref.path);
  const cleared = await ctx.db.runTransaction(async (tx) => {
    const current = await tx.get(ref);
    if (!current.exists) return [];
    const data = current.data() as Data;
    const patch = reviewPatch(data, codes, FieldValue.delete());
    if (!patch) return [];
    tx.update(ref, patch);
    return openReviewCodes(data).filter((code) => codes.includes(code));
  });
  if (cleared.length) ctx.log.info('migration review codes cleared', { path: ref.path, codes: cleared });
  return cleared;
}
