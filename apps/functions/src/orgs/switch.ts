import { DomainError, SwitchActiveOrgInput } from '@materia/domain';

import { activeOrgPatch, syncClaims } from './claims';
import { memberPath } from './shared';
import { audit } from '../audit/audit';
import { defineUserCallable, type UserCallableDefinition } from '../core/user-callable';

export interface SwitchResult {
  orgId: string;
  claimsVersion: number;
}

/**
 * `orgs-switchActiveOrg` (FND-17): sets `users/{uid}.activeOrgId` and the claims. The client then
 * refreshes its token and reloads, so nothing from the previous org stays in memory. A
 * person-level callable: the token's org is, by definition, the other one.
 */
export const switchActiveOrgDefinition = {
  name: 'orgs-switchActiveOrg',
  input: SwitchActiveOrgInput,
  idempotent: true,
  handler: async ({ input, uid, db, auth, clock, requestId }): Promise<SwitchResult> => {
    const caller = uid as string;
    const member = await db.doc(memberPath(input.orgId, caller)).get();
    if (member.get('status') !== 'active')
      throw new DomainError('MEMBER_INACTIVE', 'Not an active member of that organisation');
    await db.doc(`users/${caller}`).set(activeOrgPatch(input.orgId), { merge: true });
    const result = await syncClaims({ db, auth, now: clock.now() }, caller, { activeOrgId: input.orgId });
    if (result.activeOrgId !== input.orgId)
      throw new DomainError('MEMBER_INACTIVE', 'Not an active member of that organisation');
    await audit(
      { uid: caller, orgId: input.orgId, requestId, db, clock },
      {
        action: 'member.switched_org',
        entity: { path: memberPath(input.orgId, caller) },
        summary: 'Active organisation switched',
      },
    );
    const version = (await db.doc(`users/${caller}`).get()).get('claimsVersion') as number | undefined;
    return { orgId: input.orgId, claimsVersion: version ?? 0 };
  },
} satisfies UserCallableDefinition<typeof SwitchActiveOrgInput, SwitchResult>;

export const switchActiveOrg = defineUserCallable(switchActiveOrgDefinition);
