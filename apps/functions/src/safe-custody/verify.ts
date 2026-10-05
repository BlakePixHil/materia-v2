import {
  PERMISSIONS,
  SAFE_CUSTODY_CALLABLES,
  VerifyPacketsInput,
  type VerifyPacketsResult,
} from '@materia/domain';

import { packetPath } from './shared';
import { isDeleted, stamp } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';

/**
 * `safeCustody-verify` (CORE-17, `safeCustody.edit`, idempotent): the annual stocktake. Each held
 * packet in `ids` was found where the register says: `lastVerified` becomes `{on, by}`. Packets that
 * aren't held (out, released, destroyed, deleted or unknown) are `skipped`.
 */
export const verifyDefinition = {
  name: SAFE_CUSTODY_CALLABLES.verify,
  input: VerifyPacketsInput,
  roles: PERMISSIONS['safeCustody.edit'],
  idempotent: true,
  handler: async ({ input, orgId, uid, db, clock, log, requestId }): Promise<VerifyPacketsResult> => {
    const ids = [...new Set(input.ids)];
    const snaps = await db.getAll(...ids.map((id) => db.doc(packetPath(orgId, id))));
    const verified: string[] = [];
    const skipped: string[] = [];
    const batch = db.batch();
    const meta = stamp(uid, clock.now(), requestId);
    for (const snap of snaps) {
      const data = snap.data();
      if (!snap.exists || !data || isDeleted(data) || data['status'] !== 'held') {
        skipped.push(snap.id);
        continue;
      }
      batch.update(snap.ref, { lastVerified: { on: input.on, by: uid }, ...meta });
      verified.push(snap.id);
    }
    if (verified.length) await batch.commit();
    log.info('stocktake', { verified: verified.length, skipped: skipped.length });
    return { verified, skipped };
  },
} satisfies CallableDefinition<typeof VerifyPacketsInput, VerifyPacketsResult>;

export const verify = defineCallable(verifyDefinition);
