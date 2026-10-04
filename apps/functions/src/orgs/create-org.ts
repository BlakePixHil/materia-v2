import type { z } from 'zod';

import { CreateOrgInput, Org } from '@materia/domain';

import { activeOrgPatch, syncClaims } from './claims';
import { memberPath, newMember, verifiedUser } from './shared';
import { audit } from '../audit/audit';
import { defineUserCallable, type UserCallableDefinition } from '../core/user-callable';

export interface CreateOrgResult {
  orgId: string;
}

/** Defaults for a new practice (FND-17): GST-registered, 6-minute units, FY from July, 7-year retention. */
export function newOrgDoc(input: z.output<typeof CreateOrgInput>, uid: string, now: Date) {
  return Org.schema.parse({
    name: input.name,
    ...(input.abn ? { abn: input.abn } : {}),
    practiceType: 'wills_estates',
    jurisdictions: [input.primaryJurisdiction],
    primaryJurisdiction: input.primaryJurisdiction,
    timezone: input.timezone,
    holidayLocality: input.primaryJurisdiction,
    billing: {
      unitMinutes: 6,
      rounding: 'up',
      gstRegistered: true,
      defaultRateCents: 0,
      invoicePrefix: 'INV-',
      paymentTermsDays: 14,
    },
    matterNumberFormat: 'M-{YYYY}-{seq:4}',
    fy: { startMonth: 7 },
    retentionYears: 7,
    plan: 'trial',
    security: { mfaRequired: false, sessionIdleMinutes: 60 },
    createdAt: now,
    createdBy: uid,
    updatedAt: now,
    updatedBy: uid,
    schemaVersion: 1,
  });
}

/**
 * `orgs-createOrg` (FND-17): onboarding. Creates the org with its defaults, the caller as its
 * owner and the sequence counters in one batch, then makes it the caller's active org and sets
 * their claims. A person-level callable: the caller has no org claim yet.
 */
export const createOrgDefinition = {
  name: 'orgs-createOrg',
  input: CreateOrgInput,
  idempotent: true,
  handler: async ({ input, uid, db, auth, clock, requestId, log }): Promise<CreateOrgResult> => {
    const caller = uid as string;
    const user = await verifiedUser(auth, caller);
    const now = clock.now();
    const orgRef = db.collection('orgs').doc();
    const orgId = orgRef.id;
    const org = newOrgDoc(input, caller, now);

    const batch = db.batch();
    batch.create(orgRef, { ...org, _requestId: requestId });
    batch.create(db.doc(memberPath(orgId, caller)), {
      ...newMember(user, 'owner', now, caller),
      _requestId: requestId,
    });
    for (const counter of ['matters', 'invoices'])
      batch.create(db.doc(`orgs/${orgId}/counters/${counter}`), { next: 1 });
    batch.set(db.doc(`users/${caller}`), activeOrgPatch(orgId), { merge: true });
    await batch.commit();

    await syncClaims({ db, auth, now }, caller, { activeOrgId: orgId });
    await audit(
      { uid: caller, orgId, requestId, db, clock },
      {
        action: 'org.created',
        // The audit entity is a document inside the org: the founding owner's membership.
        entity: { path: memberPath(orgId, caller) },
        summary: 'Organisation created',
      },
    );
    log.info('org created', { orgId });
    return { orgId };
  },
} satisfies UserCallableDefinition<typeof CreateOrgInput, CreateOrgResult>;

export const createOrg = defineUserCallable(createOrgDefinition);
