import { Timestamp, type DocumentReference } from 'firebase-admin/firestore';

import {
  AcceptInviteInput,
  DomainError,
  INVITE_TTL_DAYS,
  InviteMemberInput,
  InviteRefInput,
  MAX_PENDING_INVITES,
  PERMISSIONS,
  type Role,
} from '@materia/domain';

import { activeOrgPatch, syncClaims } from './claims';
import { appUrl, hashToken, invitePath, memberPath, newInviteToken, newMember, verifiedUser } from './shared';
import { audit } from '../audit/audit';
import { defineCallable, type CallableContext, type CallableDefinition } from '../core/callable';
import { defineUserCallable, type UserCallableDefinition } from '../core/user-callable';

const INVITE_TTL_MS = INVITE_TTL_DAYS * 24 * 60 * 60 * 1000;

export interface InviteResult {
  inviteId: string;
  /** False when the email couldn't be sent (the invite stays pending; resend it later). */
  emailed: boolean;
}

/** Only owners grant or change the owner role (an admin can't make anyone, themselves included, an owner). */
export function assertCanGrant(callerRole: Role, role: Role): void {
  if (role === 'owner' && callerRole !== 'owner') {
    throw new DomainError('PERMISSION_DENIED', 'Only an owner can grant the owner role');
  }
}

type InviteCtx = Pick<CallableContext<unknown>, 'uid' | 'orgId' | 'db' | 'ports' | 'log'>;

/** Emails the invite link (template `invite`). A mail failure is logged, not thrown. */
async function sendInvite(
  ctx: InviteCtx,
  invite: { id: string; email: string; role: Role; token: string; expiresAt: Date },
): Promise<boolean> {
  const [org, inviter] = await Promise.all([
    ctx.db.doc(`orgs/${ctx.orgId}`).get(),
    ctx.db.doc(memberPath(ctx.orgId, ctx.uid)).get(),
  ]);
  try {
    await ctx.ports.mail.send({
      to: invite.email,
      template: 'invite',
      model: {
        orgName: org.get('name') ?? 'your practice',
        inviterName: inviter.get('displayName') ?? 'A colleague',
        role: invite.role,
        link: `${appUrl()}${invitePath(invite.id, invite.token)}`,
        expiresAt: invite.expiresAt.toISOString(),
      },
      // A new token is a new email; resending must not be deduplicated away.
      idempotencyKey: `invite-${invite.id}-${hashToken(invite.token).slice(0, 16)}`,
    });
    return true;
  } catch (error) {
    ctx.log.warn('invite email not sent', {
      inviteId: invite.id,
      errorCode: (error as { code?: string }).code ?? 'unknown',
    });
    return false;
  }
}

/**
 * `orgs-inviteMember` (FND-17): owners and admins invite by email. The invite stores only the
 * token's SHA-256; the token travels in the emailed link. An earlier pending invite for the same
 * email is replaced. At most 50 pending invites per org.
 */
export const inviteMemberDefinition = {
  name: 'orgs-inviteMember',
  input: InviteMemberInput,
  roles: PERMISSIONS['members.manage'],
  idempotent: true,
  handler: async (ctx): Promise<InviteResult> => {
    const { input, uid, orgId, role, db, clock, requestId, log } = ctx;
    assertCanGrant(role, input.role);
    const now = clock.now();

    const existingUser = await ctx
      .auth()
      .getUserByEmail(input.email)
      .catch(() => null);
    const members = db.collection(`orgs/${orgId}/members`);
    const [byUid, byEmail] = await Promise.all([
      existingUser ? members.doc(existingUser.uid).get() : null,
      members.where('email', '==', input.email).get(),
    ]);
    const isMember = (status: unknown) => status === 'active' || status === 'suspended';
    if (isMember(byUid?.get('status')) || byEmail.docs.some((doc) => isMember(doc.get('status')))) {
      throw new DomainError('ALREADY_MEMBER', 'This person is already a member');
    }

    const invites = db.collection(`orgs/${orgId}/invites`);
    const token = newInviteToken();
    const ref = invites.doc();
    const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
    await db.runTransaction(async (tx) => {
      const pending = await tx.get(invites.where('status', '==', 'pending'));
      const live = pending.docs.filter((doc) => (doc.get('expiresAt') as Timestamp).toMillis() > now.getTime());
      const replaced = live.filter((doc) => doc.get('email') === input.email);
      if (live.length - replaced.length >= MAX_PENDING_INVITES) {
        throw new DomainError('INVITE_LIMIT', `At most ${MAX_PENDING_INVITES} pending invites`, {
          max: MAX_PENDING_INVITES,
        });
      }
      for (const doc of replaced) {
        tx.update(doc.ref, { status: 'revoked', updatedAt: now, updatedBy: uid, _requestId: requestId });
      }
      tx.create(ref, {
        email: input.email,
        role: input.role,
        tokenHash: hashToken(token),
        expiresAt,
        status: 'pending',
        invitedBy: uid,
        createdAt: now,
        createdBy: uid,
        updatedAt: now,
        updatedBy: uid,
        schemaVersion: 1,
        _requestId: requestId,
      });
    });

    const emailed = await sendInvite(ctx, { id: ref.id, email: input.email, role: input.role, token, expiresAt });
    await audit(
      { uid, orgId, requestId, db, clock },
      {
        action: 'member.invited',
        entity: { path: ref.path },
        summary: `Invite sent for role ${input.role}`,
        data: { role: input.role, emailed },
      },
    );
    log.info('invited', { inviteId: ref.id, emailed });
    return { inviteId: ref.id, emailed };
  },
} satisfies CallableDefinition<typeof InviteMemberInput, InviteResult>;

/** A pending invite of the caller's org, or NOT_FOUND / FAILED_PRECONDITION. */
async function pendingInvite(ref: DocumentReference) {
  const snap = await ref.get();
  if (!snap.exists) throw new DomainError('NOT_FOUND', 'Invite not found');
  if (snap.get('status') !== 'pending') {
    throw new DomainError('FAILED_PRECONDITION', 'The invite is no longer pending', { status: snap.get('status') });
  }
  return snap;
}

/** `orgs-revokeInvite` (FND-17): the link stops working. */
export const revokeInviteDefinition = {
  name: 'orgs-revokeInvite',
  input: InviteRefInput,
  roles: PERMISSIONS['members.manage'],
  idempotent: true,
  handler: async ({ input, uid, orgId, db, clock, requestId }): Promise<{ ok: true }> => {
    const ref = db.doc(`orgs/${orgId}/invites/${input.inviteId}`);
    await pendingInvite(ref);
    await ref.update({ status: 'revoked', updatedAt: clock.now(), updatedBy: uid, _requestId: requestId });
    await audit(
      { uid, orgId, requestId, db, clock },
      { action: 'member.invite_revoked', entity: { path: ref.path }, summary: 'Invite revoked' },
    );
    return { ok: true };
  },
} satisfies CallableDefinition<typeof InviteRefInput, { ok: true }>;

/** `orgs-resendInvite` (FND-17): a new token and seven more days; the old link stops working. */
export const resendInviteDefinition = {
  name: 'orgs-resendInvite',
  input: InviteRefInput,
  roles: PERMISSIONS['members.manage'],
  idempotent: true,
  handler: async (ctx): Promise<InviteResult> => {
    const { input, uid, orgId, role, db, clock, requestId } = ctx;
    const ref = db.doc(`orgs/${orgId}/invites/${input.inviteId}`);
    const snap = await pendingInvite(ref);
    const inviteRole = snap.get('role') as Role;
    assertCanGrant(role, inviteRole);
    const now = clock.now();
    const token = newInviteToken();
    const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
    await ref.update({ tokenHash: hashToken(token), expiresAt, updatedAt: now, updatedBy: uid, _requestId: requestId });
    const email = snap.get('email') as string;
    const emailed = await sendInvite(ctx, { id: ref.id, email, role: inviteRole, token, expiresAt });
    await audit(
      { uid, orgId, requestId, db, clock },
      { action: 'member.invite_resent', entity: { path: ref.path }, summary: 'Invite resent', data: { emailed } },
    );
    return { inviteId: ref.id, emailed };
  },
} satisfies CallableDefinition<typeof InviteRefInput, InviteResult>;

export interface AcceptResult {
  orgId: string;
  orgName: string;
}

/**
 * `orgs-acceptInvite` (FND-17): the signed-in person joins the org with the invited role. Their
 * verified email must match the invite, which must be pending and under seven days old. Accepting
 * again is a no-op. The org becomes their active org. A person-level callable: the invitee has no
 * claim for the org yet.
 */
export const acceptInviteDefinition = {
  name: 'orgs-acceptInvite',
  input: AcceptInviteInput,
  idempotent: true,
  handler: async ({ input, uid, db, auth, clock, requestId, log }): Promise<AcceptResult> => {
    const caller = uid as string;
    const user = await verifiedUser(auth, caller);
    const found = await db.collectionGroup('invites').where('tokenHash', '==', hashToken(input.token)).limit(5).get();
    const match = found.docs.find((doc) => doc.id === input.inviteId);
    const orgRef = match?.ref.parent.parent;
    if (!match || !orgRef) throw new DomainError('INVITE_INVALID', 'Invite not found');
    const orgId = orgRef.id;
    const now = clock.now();

    const joined = await db.runTransaction(async (tx) => {
      const [invite, member] = await Promise.all([tx.get(match.ref), tx.get(db.doc(memberPath(orgId, caller)))]);
      const status = invite.get('status') as string;
      if (status === 'accepted' && invite.get('acceptedBy') === caller) return false;
      if (status !== 'pending') throw new DomainError('INVITE_INVALID', 'The invite is no longer valid');
      if ((invite.get('expiresAt') as Timestamp).toMillis() <= now.getTime()) {
        throw new DomainError('INVITE_EXPIRED', 'The invite has expired');
      }
      if (invite.get('email') !== user.email.toLowerCase()) {
        throw new DomainError('INVITE_EMAIL_MISMATCH', 'The invite was sent to a different email');
      }
      const memberStatus = member.get('status') as string | undefined;
      if (memberStatus === 'active' || memberStatus === 'suspended') {
        throw new DomainError('ALREADY_MEMBER', 'Already a member of this organisation');
      }
      const role = invite.get('role') as Role;
      const by = invite.get('invitedBy') as string;
      tx.set(member.ref, {
        ...newMember(user, role, now, by),
        // A returning member keeps their profile fields (rates, title, budgets).
        ...(member.exists ? pickProfile(member.data() ?? {}) : {}),
        role,
        status: 'active',
        updatedBy: caller,
        _requestId: requestId,
      });
      tx.set(db.doc(`users/${caller}`), activeOrgPatch(orgId), { merge: true });
      tx.update(match.ref, {
        status: 'accepted',
        acceptedBy: caller,
        acceptedAt: now,
        updatedAt: now,
        updatedBy: caller,
        _requestId: requestId,
      });
      return true;
    });

    const synced = await syncClaims({ db, auth, now }, caller, { activeOrgId: orgId });
    if (joined) {
      await audit(
        { uid: caller, orgId, requestId, db, clock },
        {
          action: 'member.joined',
          entity: { path: memberPath(orgId, caller) },
          summary: 'Invite accepted',
          data: { inviteId: match.id },
        },
      );
    }
    log.info(joined ? 'invite accepted' : 'invite already accepted', { orgId, inviteId: match.id });
    return { orgId, orgName: synced.memberships.find((m) => m.orgId === orgId)?.name ?? '' };
  },
} satisfies UserCallableDefinition<typeof AcceptInviteInput, AcceptResult>;

const PROFILE_FIELDS = [
  'displayName',
  'initials',
  'title',
  'admissionNo',
  'defaultRateCents',
  'rates',
  'colour',
  'budgets',
  'supervisorUid',
  'createdAt',
  'createdBy',
];

function pickProfile(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(PROFILE_FIELDS.filter((key) => data[key] !== undefined).map((key) => [key, data[key]]));
}

export const inviteMember = defineCallable(inviteMemberDefinition);
export const revokeInvite = defineCallable(revokeInviteDefinition);
export const resendInvite = defineCallable(resendInviteDefinition);
export const acceptInvite = defineUserCallable(acceptInviteDefinition);
