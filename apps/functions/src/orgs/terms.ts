import { AcceptTermsInput, DomainError, TERMS_VERSION, type AcceptTermsResult } from '@materia/domain';

import { memberPath } from './shared';
import { audit, type AuditContext } from '../audit/audit';
import { defineCallable, type CallableDefinition } from '../core/callable';

/** Refuses any version but the current one: the page showed an older version than the one in force. */
export function assertCurrentTerms(version: string): void {
  if (version !== TERMS_VERSION) {
    throw new DomainError('FAILED_PRECONDITION', 'Those aren’t the current terms', {
      reason: 'terms_outdated',
      current: TERMS_VERSION,
    });
  }
}

/** The org fields that record the acceptance. */
export function termsAcceptance(uid: string, at: Date) {
  return { termsAcceptedVersion: TERMS_VERSION, termsAcceptedAt: at, termsAcceptedBy: uid };
}

/** The audit entry for an acceptance. The entity is the owner's membership, as for `org.created`. */
export function auditTermsAccepted(ctx: AuditContext): Promise<string> {
  return audit(ctx, {
    action: 'org.terms_accepted',
    entity: { path: memberPath(ctx.orgId, ctx.uid) },
    summary: `Terms of service version ${TERMS_VERSION} accepted`,
    data: { version: TERMS_VERSION },
  });
}

/**
 * `orgs-acceptTerms` (SEC-01): the org's owner accepts the terms of service and DPA on the
 * practice's behalf. The version must be the current one (the page showed it). Records the
 * version, when and who on the org, and audits it as `org.terms_accepted`. Accepting a version
 * the org has already accepted writes nothing. Other members never need to.
 */
export const acceptTermsDefinition = {
  name: 'orgs-acceptTerms',
  input: AcceptTermsInput,
  roles: ['owner'],
  idempotent: true,
  handler: async (ctx): Promise<AcceptTermsResult> => {
    const { input, uid, orgId, db, clock, log } = ctx;
    assertCurrentTerms(input.version);
    const orgRef = db.doc(`orgs/${orgId}`);
    const at = clock.now();
    const recorded = await db.runTransaction(async (tx) => {
      const org = await tx.get(orgRef);
      if (!org.exists) throw new DomainError('NOT_FOUND', 'Org not found');
      if (org.get('termsAcceptedVersion') === TERMS_VERSION) return false;
      tx.update(orgRef, { ...termsAcceptance(uid, at), updatedAt: at, updatedBy: uid });
      return true;
    });
    if (recorded) await auditTermsAccepted(ctx);
    log.info('terms accepted', { version: TERMS_VERSION, recorded });
    return { version: TERMS_VERSION, recorded };
  },
} satisfies CallableDefinition<typeof AcceptTermsInput, AcceptTermsResult>;

export const acceptTerms = defineCallable(acceptTermsDefinition);
