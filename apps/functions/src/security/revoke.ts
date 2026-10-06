import {
  can,
  DomainError,
  revocationInstant,
  RevokeSessionsInput,
  ROLES,
  SENSITIVE_REAUTH_MINUTES,
  type RevokeSessionsResult,
} from '@materia/domain';

import { audit } from '../audit/audit';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { memberPath } from '../orgs/shared';

/**
 * `security-revokeSessions` (SEC-04; a recent sign-in, idempotent): signs a person out of every
 * device. Their refresh tokens are revoked, and `sessionsValidAfter` on their membership makes the
 * rules refuse their current ID tokens at once (not up to an hour later). They stay a member and
 * can sign in again.
 *
 * - Without `uid`, or with the caller's own: "sign out everywhere else". Every one of the caller's
 *   active memberships is stamped; the web client confirms it's them straight after, so this tab
 *   gets a new sign-in that the stamp doesn't cover.
 * - Another member: owners and admins only (`members.manage`), for a member of this org. An admin
 *   can't sign out an owner.
 */
export const revokeSessionsDefinition = {
  name: 'security-revokeSessions',
  input: RevokeSessionsInput,
  roles: ROLES,
  idempotent: true,
  recentLoginMinutes: SENSITIVE_REAUTH_MINUTES,
  handler: async (ctx): Promise<RevokeSessionsResult> => {
    const { input, orgId, uid, role, db, clock, log } = ctx;
    const target = input.uid ?? uid;
    const self = target === uid;
    if (!self && !can(role, 'members.manage')) {
      throw new DomainError('PERMISSION_DENIED', 'Only owners and admins can sign someone else out');
    }
    const member = await db.doc(memberPath(orgId, target)).get();
    if (!member.exists) throw new DomainError('NOT_FOUND', 'No such member', { uid: target });
    if (!self && member.get('role') === 'owner' && role !== 'owner') {
      throw new DomainError('PERMISSION_DENIED', 'Only an owner can sign an owner out');
    }

    const validAfter = revocationInstant(clock.now());
    // The caller's own memberships in every org they're active in; someone else's in this org only.
    const orgIds = self
      ? (((await db.doc(`users/${uid}`).get()).get('orgIds') as string[] | undefined) ?? [orgId])
      : [orgId];
    const batch = db.batch();
    for (const id of new Set([orgId, ...orgIds])) {
      const ref = db.doc(memberPath(id, target));
      if (id === orgId || (await ref.get()).exists) batch.update(ref, { sessionsValidAfter: validAfter });
    }
    await batch.commit();
    await ctx.auth().revokeRefreshTokens(target);

    await audit(ctx, {
      action: self ? 'member.signed_out_elsewhere' : 'member.signed_out',
      entity: { path: memberPath(orgId, target) },
      summary: self ? 'Signed out of every other session' : 'Signed out of every device by an admin',
    });
    log.info('sessions revoked', { target, self });
    return { uid: target, validAfter: validAfter.toISOString() };
  },
} satisfies CallableDefinition<typeof RevokeSessionsInput, RevokeSessionsResult>;

export const revokeSessions = defineCallable(revokeSessionsDefinition);
