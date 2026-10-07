import type { Firestore } from 'firebase-admin/firestore';

import {
  ChangeRoleInput,
  DomainError,
  MemberRefInput,
  PERMISSIONS,
  SENSITIVE_REAUTH_MINUTES,
  SuspendMemberInput,
  TransferOwnershipInput,
  type Role,
} from '@materia/domain';

import { syncClaims } from './claims';
import { assertCanGrant } from './invites';
import { assertAnotherOwner, memberPath } from './shared';
import { audit } from '../audit/audit';
import { defineCallable, type CallableContext, type CallableDefinition } from '../core/callable';
import { errorReportFields } from '../core/log';
import { OAUTH_SECRETS } from '../integrations/providers';
import { removeMemberConnections } from '../integrations/vault';

export type MemberCtx = CallableContext<unknown>;
type Ctx = MemberCtx;

interface MemberState {
  role: Role;
  status: string;
}

/**
 * Changes one member inside a transaction: reads them (NOT_FOUND unless active or suspended), lets
 * `decide` validate and return the new fields, and keeps at least one active owner whenever an
 * active owner stops being one.
 */
export async function changeMember(
  ctx: Ctx,
  uid: string,
  decide: (member: MemberState) => Partial<MemberState>,
): Promise<{ before: MemberState; after: MemberState }> {
  const { db, orgId, clock, requestId } = ctx;
  const ref = db.doc(memberPath(orgId, uid));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const before = { role: snap.get('role') as Role, status: snap.get('status') as string };
    if (!snap.exists || (before.status !== 'active' && before.status !== 'suspended')) {
      throw new DomainError('NOT_FOUND', 'Member not found', { uid });
    }
    const after = { ...before, ...decide(before) };
    const wasOwner = before.role === 'owner' && before.status === 'active';
    const staysOwner = after.role === 'owner' && after.status === 'active';
    if (wasOwner && !staysOwner) await assertAnotherOwner(tx, db, orgId, uid);
    tx.update(ref, { ...after, updatedAt: clock.now(), updatedBy: ctx.uid, _requestId: requestId });
    return { before, after };
  });
}

/** Signs the person out everywhere when the org they lost was their active org (FND-17). */
export async function revokeIfActive(ctx: Ctx, db: Firestore, uid: string): Promise<boolean> {
  const user = await db.doc(`users/${uid}`).get();
  if (user.get('activeOrgId') !== ctx.orgId) return false;
  await ctx.auth().revokeRefreshTokens(uid);
  return true;
}

/** Recomputes the person's claims, this org included (FND-17). */
export const syncMember = (ctx: Ctx, uid: string) =>
  syncClaims({ db: ctx.db, auth: ctx.auth(), now: ctx.clock.now() }, uid, { alsoOrgIds: [ctx.orgId] });

/** `orgs-changeRole` (FND-17). Only owners grant or take away the owner role. */
export const changeRoleDefinition = {
  name: 'orgs-changeRole',
  recentLoginMinutes: SENSITIVE_REAUTH_MINUTES,
  input: ChangeRoleInput,
  roles: PERMISSIONS['members.manage'],
  idempotent: true,
  handler: async (ctx): Promise<{ ok: true }> => {
    const { input } = ctx;
    const { before } = await changeMember(ctx, input.uid, (member) => {
      assertCanGrant(ctx.role, member.role);
      assertCanGrant(ctx.role, input.role);
      return { role: input.role };
    });
    await syncMember(ctx, input.uid);
    await audit(ctx, {
      action: 'member.role_changed',
      entity: { path: memberPath(ctx.orgId, input.uid) },
      summary: `Role changed from ${before.role} to ${input.role}`,
      data: { from: before.role, to: input.role },
    });
    return { ok: true };
  },
} satisfies CallableDefinition<typeof ChangeRoleInput, { ok: true }>;

/** `orgs-suspendMember` (FND-17): pauses access (`suspended: false` reinstates). */
export const suspendMemberDefinition = {
  name: 'orgs-suspendMember',
  recentLoginMinutes: SENSITIVE_REAUTH_MINUTES,
  input: SuspendMemberInput,
  roles: PERMISSIONS['members.manage'],
  idempotent: true,
  handler: async (ctx): Promise<{ ok: true }> => {
    const { input } = ctx;
    await changeMember(ctx, input.uid, (member) => {
      assertCanGrant(ctx.role, member.role);
      return { status: input.suspended ? 'suspended' : 'active' };
    });
    const revoked = input.suspended ? await revokeIfActive(ctx, ctx.db, input.uid) : false;
    await syncMember(ctx, input.uid);
    await audit(ctx, {
      action: input.suspended ? 'member.suspended' : 'member.reinstated',
      entity: { path: memberPath(ctx.orgId, input.uid) },
      summary: input.suspended ? 'Member suspended' : 'Member reinstated',
      data: { tokensRevoked: revoked },
    });
    return { ok: true };
  },
} satisfies CallableDefinition<typeof SuspendMemberInput, { ok: true }>;

/**
 * `orgs-removeMember` (FND-17): the member document stays (status `removed`) for the audit trail.
 * If this was their active org their refresh tokens are revoked, so they are signed out; the
 * rules deny them at once either way. Their own integrations (INT-01) are revoked and deleted.
 */
export const removeMemberDefinition = {
  name: 'orgs-removeMember',
  recentLoginMinutes: SENSITIVE_REAUTH_MINUTES,
  input: MemberRefInput,
  roles: PERMISSIONS['members.manage'],
  idempotent: true,
  secrets: OAUTH_SECRETS,
  handler: async (ctx): Promise<{ ok: true; tokensRevoked: boolean }> => {
    const { input } = ctx;
    await changeMember(ctx, input.uid, (member) => {
      assertCanGrant(ctx.role, member.role);
      return { status: 'removed' };
    });
    const tokensRevoked = await revokeIfActive(ctx, ctx.db, input.uid);
    await syncMember(ctx, input.uid);
    // Best effort: a provider being down never blocks removing someone.
    const integrationsRemoved = await removeMemberConnections(ctx, input.uid).catch((error: unknown) => {
      ctx.log.warn('member integrations not removed', errorReportFields(error));
      return 0;
    });
    await audit(ctx, {
      action: 'member.removed',
      entity: { path: memberPath(ctx.orgId, input.uid) },
      summary: 'Member removed',
      data: { tokensRevoked, ...(integrationsRemoved ? { integrationsRemoved } : {}) },
    });
    return { ok: true, tokensRevoked };
  },
} satisfies CallableDefinition<typeof MemberRefInput, { ok: true; tokensRevoked: boolean }>;

/**
 * `orgs-transferOwnership` (FND-17): the caller (an owner, signed in within five minutes) makes an
 * active member the owner and becomes an admin.
 */
export const transferOwnershipDefinition = {
  name: 'orgs-transferOwnership',
  recentLoginMinutes: SENSITIVE_REAUTH_MINUTES,
  input: TransferOwnershipInput,
  roles: ['owner'],
  idempotent: true,
  handler: async (ctx): Promise<{ ok: true }> => {
    const { input, uid, orgId, db, clock, requestId } = ctx;
    if (input.toUid === uid) throw new DomainError('INVALID_ARGUMENT', 'Transfer to another member');
    const now = clock.now();
    await db.runTransaction(async (tx) => {
      const [from, to] = await Promise.all([
        tx.get(db.doc(memberPath(orgId, uid))),
        tx.get(db.doc(memberPath(orgId, input.toUid))),
      ]);
      if (from.get('role') !== 'owner' || from.get('status') !== 'active') {
        throw new DomainError('PERMISSION_DENIED', 'Only an active owner can transfer ownership');
      }
      if (!to.exists || to.get('status') !== 'active') throw new DomainError('NOT_FOUND', 'Member not found');
      const stamp = { updatedAt: now, updatedBy: uid, _requestId: requestId };
      tx.update(to.ref, { role: 'owner', ...stamp });
      tx.update(from.ref, { role: 'admin', ...stamp });
    });
    await Promise.all([syncMember(ctx, input.toUid), syncMember(ctx, uid)]);
    await audit(ctx, {
      action: 'org.ownership_transferred',
      entity: { path: memberPath(orgId, input.toUid) },
      summary: 'Ownership transferred',
      data: { fromUid: uid, toUid: input.toUid },
    });
    return { ok: true };
  },
} satisfies CallableDefinition<typeof TransferOwnershipInput, { ok: true }>;

export const changeRole = defineCallable(changeRoleDefinition);
export const suspendMember = defineCallable(suspendMemberDefinition);
export const removeMember = defineCallable(removeMemberDefinition);
export const transferOwnership = defineCallable(transferOwnershipDefinition);
