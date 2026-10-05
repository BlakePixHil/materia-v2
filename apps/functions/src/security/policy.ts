import {
  nextMfaDates,
  PERMISSIONS,
  resolveSecurity,
  SENSITIVE_REAUTH_MINUTES,
  UpdateSecurityPolicyInput,
  type OrgSecurity,
} from '@materia/domain';

import { audit } from '../audit/audit';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { readSecurity } from '../core/sessions';

export interface UpdateSecurityPolicyResult {
  /** ISO instant from which members without MFA are blocked, or null when MFA isn't required. */
  mfaEnforceAfter: string | null;
  changed: string[];
}

const FIELDS = ['mfaRequired', 'sessionIdleMinutes', 'maxSessionDays', 'mfaGraceHours'] as const;

/**
 * `security-updatePolicy` (SEC-04; owners and admins, a recent sign-in, idempotent): saves
 * Settings → Security. Turning MFA on starts the grace period now, so members without it are
 * prompted and keep working until `mfaEnforceAfter`; changing the grace while MFA is on moves that
 * deadline from when it was turned on. Audited.
 */
export const updatePolicyDefinition = {
  name: 'security-updatePolicy',
  input: UpdateSecurityPolicyInput,
  roles: PERMISSIONS['org.settings'],
  idempotent: true,
  recentLoginMinutes: SENSITIVE_REAUTH_MINUTES,
  handler: async (ctx): Promise<UpdateSecurityPolicyResult> => {
    const { input, orgId, uid, db, clock, log } = ctx;
    const ref = db.doc(`orgs/${orgId}`);
    const now = clock.now();
    const { next, changed } = await db.runTransaction(async (tx) => {
      const before = resolveSecurity(readSecurity((await tx.get(ref)).get('security')));
      const dates = nextMfaDates(before, input, now);
      const next: OrgSecurity = {
        mfaRequired: input.mfaRequired,
        sessionIdleMinutes: input.sessionIdleMinutes,
        maxSessionDays: input.maxSessionDays,
        mfaGraceHours: input.mfaGraceHours,
        ...(dates ?? {}),
      };
      const changed = FIELDS.filter((field) => before[field] !== next[field]);
      tx.update(ref, { security: next, updatedAt: now, updatedBy: uid });
      return { next, changed };
    });
    await audit(ctx, {
      action: 'org.security_updated',
      // The audit entity is a document inside the org: the caller's membership (as org settings).
      entity: { path: `orgs/${orgId}/members/${uid}` },
      summary: changed.length ? `Security changed: ${changed.join(', ')}` : 'Security saved unchanged',
      data: { ...Object.fromEntries(FIELDS.map((field) => [field, next[field]])), changed },
    });
    log.info('security policy updated', { changed });
    return { mfaEnforceAfter: next.mfaEnforceAfter?.toISOString() ?? null, changed };
  },
} satisfies CallableDefinition<typeof UpdateSecurityPolicyInput, UpdateSecurityPolicyResult>;

export const updatePolicy = defineCallable(updatePolicyDefinition);
