import { FieldPath, FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';

import { DocIdSchema, DomainError, isFlagKey, isValidFlagValue, type FlagKey } from '@materia/domain';

import { audit } from '../audit/audit';
import { clearFlagCaches } from '../core/flags';
import { defineUserCallable, type UserCallableDefinition } from '../core/user-callable';

export const SetOrgOverrideInput = z.object({
  orgId: DocIdSchema,
  key: z.string().refine(isFlagKey, { message: 'Unknown flag' }),
  /** `null` removes the override. */
  value: z.union([z.boolean(), z.string(), z.number(), z.null()]),
});

/**
 * `flags-setOrgOverride` (FND-23): sets or clears one org's override for a flag. Only for people
 * with the `platformAdmin` claim, which only a human sets (`materia-scripts platform-admin`). The
 * org document itself is outside the audit trigger, so the change is audited here, in that org.
 */
export const setOrgOverrideDefinition = {
  name: 'flags-setOrgOverride',
  input: SetOrgOverrideInput,
  handler: async ({ input, uid, token, db, requestId, clock }): Promise<{ ok: true }> => {
    if (token?.['platformAdmin'] !== true) throw new DomainError('PERMISSION_DENIED', 'Platform admins only');
    const key = input.key as FlagKey;
    if (input.value !== null && !isValidFlagValue(key, input.value)) {
      throw new DomainError('INVALID_ARGUMENT', `Wrong type for ${key}`, {
        fields: { value: ['Wrong type for this flag'] },
      });
    }
    const org = db.doc(`orgs/${input.orgId}`);
    if (!(await org.get()).exists) throw new DomainError('NOT_FOUND', 'Organisation not found');
    // Flag keys contain dots, so address the map entry with a FieldPath, not a dotted string.
    await org.update(
      new FieldPath('flags', key),
      input.value === null ? FieldValue.delete() : input.value,
      'updatedAt',
      FieldValue.serverTimestamp(),
      'updatedBy',
      uid as string,
    );
    await audit(
      { uid: uid as string, orgId: input.orgId, requestId, db, clock },
      {
        action: input.value === null ? 'flag.override_cleared' : 'flag.override_set',
        entity: { path: `orgs/${input.orgId}/flags/${key}` },
        summary: input.value === null ? `Override for ${key} cleared` : `Override for ${key} set`,
        data: { key, value: input.value },
      },
    );
    clearFlagCaches();
    return { ok: true };
  },
} satisfies UserCallableDefinition<typeof SetOrgOverrideInput, { ok: true }>;

export const setOrgOverride = defineUserCallable(setOrgOverrideDefinition);
