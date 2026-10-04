import { getAuth, type Auth } from 'firebase-admin/auth';

import { adminApp } from '../core/admin';
import { defineTrigger, type TriggerDefinition } from '../core/trigger';
import { syncClaims } from '../orgs/claims';

/**
 * `auth-syncClaims` (FND-17): any write to `orgs/{orgId}/members/{uid}` (including one made in the
 * console or by a migration) recomputes that person's claims and bumps `users/{uid}.claimsVersion`
 * when they change, so their client refreshes its token. The orgs callables also sync directly,
 * so the caller's next token is right; this pass then finds nothing to change.
 */
export function syncClaimsDefinition(auth: () => Auth = () => getAuth(adminApp())): TriggerDefinition {
  return {
    name: 'auth-syncClaims',
    document: 'orgs/{orgId}/members/{memberUid}',
    on: 'written',
    handler: async (_change, ctx) => {
      const uid = ctx.params['memberUid'] as string;
      const orgId = ctx.params['orgId'] as string;
      const result = await syncClaims({ db: ctx.db, auth: auth(), now: ctx.clock.now() }, uid, { alsoOrgIds: [orgId] });
      ctx.log.info('claims synced', { memberUid: uid, changed: result.changed, orgs: result.memberships.length });
    },
  };
}

export const syncClaimsTrigger = defineTrigger(syncClaimsDefinition());
