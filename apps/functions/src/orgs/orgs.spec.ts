import { randomUUID } from 'node:crypto';

import type { Timestamp } from 'firebase-admin/firestore';

import { TERMS_VERSION, type Role } from '@materia/domain';

import { mergeClaims, syncClaims } from './claims';
import { createOrgDefinition } from './create-org';
import {
  acceptInviteDefinition,
  assertCanGrant,
  inviteMemberDefinition,
  resendInviteDefinition,
  revokeInviteDefinition,
} from './invites';
import {
  changeRoleDefinition,
  removeMemberDefinition,
  suspendMemberDefinition,
  transferOwnershipDefinition,
} from './members';
import { appUrl, colourFor, hashToken, initialsOf, invitePath, newInviteToken } from './shared';
import { switchActiveOrgDefinition } from './switch';
import { acceptTermsDefinition } from './terms';
import { memoryAuth, memoryFirestore, type FakeUser } from './testing';
import { clearRetentionCache } from '../audit/retention';
import { syncClaimsDefinition } from '../auth/sync-claims';
import { createLog } from '../core/log';
import { FakeClock, FakeKms, FakeMail, fakePorts } from '../ports/fakes';

/**
 * Unit tests for the orgs callables (FND-17) against an in-memory Firestore and Auth. The
 * emulator suite (tests/integration/orgs.spec.ts) covers the same flows end to end.
 */

const ORG = 'org-a';
const people: Record<string, FakeUser> = {
  owner: { uid: 'owner', email: 'owner@example.test', displayName: 'Olive Fictional' },
  admin: { uid: 'admin', email: 'admin@example.test', displayName: 'Adam Fictional' },
  lawyer: { uid: 'lawyer', email: 'lawyer@example.test', displayName: 'Lena Fictional' },
  invitee: { uid: 'invitee', email: 'invitee@example.test', displayName: 'Ivy Fictional' },
  unverified: { uid: 'unverified', email: 'new@example.test', emailVerified: false },
};

const member = (role: Role, status = 'active', email?: string) => ({
  role,
  status,
  ...(email ? { email } : {}),
  displayName: `${role} person`,
});

function world(extra: Record<string, Record<string, unknown>> = {}) {
  const store = memoryFirestore({
    [`orgs/${ORG}`]: { name: 'Fictional Bayside Legal', retentionYears: 7 },
    [`orgs/${ORG}/members/owner`]: member('owner', 'active', 'owner@example.test'),
    [`orgs/${ORG}/members/admin`]: member('admin', 'active', 'admin@example.test'),
    [`orgs/${ORG}/members/lawyer`]: member('lawyer', 'active', 'lawyer@example.test'),
    'users/owner': { email: 'owner@example.test', orgIds: [ORG], activeOrgId: ORG },
    'users/admin': { email: 'admin@example.test', orgIds: [ORG], activeOrgId: ORG },
    'users/lawyer': { email: 'lawyer@example.test', orgIds: [ORG], activeOrgId: ORG },
    ...extra,
  });
  const auth = memoryAuth(Object.values(people));
  const clock = new FakeClock();
  const mail = new FakeMail();
  const logs: string[] = [];
  const log = createLog({ fn: 'test' }, (_severity, message) => logs.push(message));

  /** An org callable's context, as `defineCallable` builds it. */
  const orgCtx = <T>(uid: string, role: Role, input: T, token: Record<string, unknown> = {}) => ({
    input: { requestId: randomUUID(), ...input },
    uid,
    orgId: ORG,
    role,
    token,
    requestId: randomUUID(),
    log,
    clock,
    db: store.db,
    ports: fakePorts({ mail }),
    auth: () => auth.auth,
  });
  /** A person-level callable's context. */
  const userCtx = <T>(uid: string, input: T) => ({
    input: { requestId: randomUUID(), ...input },
    uid,
    token: null,
    requestId: randomUUID(),
    log,
    clock,
    db: store.db,
    auth: auth.auth,
  });
  const doc = (path: string) => store.docs.get(path);
  return { ...store, ...auth, clock, mail, logs, orgCtx, userCtx, doc };
}

/** The token from the last invite email. */
const lastToken = (mail: FakeMail) =>
  new URL(String((mail.sent.at(-1)?.model as { link: string }).link)).searchParams.get('token') as string;

beforeEach(() => clearRetentionCache());

describe('orgs shared helpers', () => {
  it('makes url-safe tokens and stores only their hash', () => {
    const token = newInviteToken(Buffer.alloc(32, 7));
    expect(token).toMatch(/^[\w-]{43}$/);
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(invitePath('inv 1', 'a+b')).toBe('/invite/inv%201?token=a%2Bb');
  });

  it('derives initials and a stable colour', () => {
    expect(initialsOf('Priya Fictional Shah')).toBe('PS');
    expect(initialsOf('cher')).toBe('CH');
    expect(initialsOf('  ')).toBe('?');
    expect(colourFor('abc')).toBe(colourFor('abc'));
  });

  it('builds links from MATERIA_APP_URL, the emulator or Hosting', () => {
    const env = { ...process.env };
    try {
      process.env['MATERIA_APP_URL'] = 'https://app.example.test/';
      expect(appUrl()).toBe('https://app.example.test');
      delete process.env['MATERIA_APP_URL'];
      process.env['FUNCTIONS_EMULATOR'] = 'true';
      expect(appUrl()).toBe('http://localhost:4200');
      delete process.env['FUNCTIONS_EMULATOR'];
      process.env['GCLOUD_PROJECT'] = 'materia-v2-dev';
      expect(appUrl()).toBe('https://materia-v2-dev.web.app');
    } finally {
      process.env = env;
    }
  });

  it('lets only owners grant the owner role', () => {
    expect(() => assertCanGrant('admin', 'owner')).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
    expect(() => assertCanGrant('owner', 'owner')).not.toThrow();
    expect(() => assertCanGrant('admin', 'lawyer')).not.toThrow();
  });
});

describe('syncClaims', () => {
  it('sets claims from active memberships, keeps platformAdmin and bumps claimsVersion only on change', async () => {
    const w = world();
    Object.assign(w.records.get('lawyer') ?? {}, { customClaims: { platformAdmin: true } });
    const first = await syncClaims({ db: w.db, auth: w.auth, now: w.clock.now() }, 'lawyer');
    expect(first.changed).toBe(true);
    expect(w.records.get('lawyer')?.customClaims).toEqual({
      platformAdmin: true,
      orgId: ORG,
      role: 'lawyer',
      orgName: 'Fictional Bayside Legal',
      orgs: { [ORG]: 'lawyer' },
    });
    expect(w.doc('users/lawyer')).toMatchObject({
      orgIds: [ORG],
      memberships: { [ORG]: { role: 'lawyer', name: 'Fictional Bayside Legal' } },
      claimsVersion: 1,
    });
    const again = await syncClaims({ db: w.db, auth: w.auth, now: w.clock.now() }, 'lawyer');
    expect(again.changed).toBe(false);
    expect(w.doc('users/lawyer')?.['claimsVersion']).toBe(1);
  });

  it('drops a suspended membership and writes a profile for a new users doc', async () => {
    const w = world({ [`orgs/${ORG}/members/invitee`]: member('lawyer', 'suspended') });
    Object.assign(w.records.get('invitee') ?? {}, { customClaims: { orgId: ORG, role: 'lawyer' } });
    const result = await syncClaims({ db: w.db, auth: w.auth, now: w.clock.now() }, 'invitee', { alsoOrgIds: [ORG] });
    expect(result.activeOrgId).toBeNull();
    expect(w.records.get('invitee')?.customClaims).not.toHaveProperty('orgId');
    expect(w.doc('users/invitee')).toMatchObject({
      email: 'invitee@example.test',
      firstName: 'Ivy',
      lastName: 'Fictional',
      orgIds: [],
      claimsVersion: 1,
    });
  });

  it('mergeClaims replaces only the tenancy keys', () => {
    expect(mergeClaims({ platformAdmin: true, orgId: 'old', role: 'owner' }, { orgs: {} } as never)).toEqual({
      platformAdmin: true,
      orgs: {},
    });
    expect(mergeClaims(undefined, { orgs: {} } as never)).toEqual({ orgs: {} });
  });

  it('runs as the auth-syncClaims trigger', async () => {
    const w = world();
    const def = syncClaimsDefinition(() => w.auth);
    const infos: string[] = [];
    await def.handler(
      {} as never,
      {
        params: { orgId: ORG, memberUid: 'admin' },
        db: w.db,
        clock: w.clock,
        log: { info: (m: string) => infos.push(m) },
      } as never,
    );
    expect(w.records.get('admin')?.customClaims).toMatchObject({ orgId: ORG, role: 'admin' });
    expect(infos).toEqual(['claims synced']);
  });
});

describe('orgs-createOrg', () => {
  it('creates the org with defaults, the owner, counters and claims, and audits it', async () => {
    const w = world();
    const { orgId } = await createOrgDefinition.handler(
      w.userCtx('invitee', { name: 'Fictional Harbour Law', primaryJurisdiction: 'NSW', timezone: 'Australia/Sydney' }),
    );
    expect(w.doc(`orgs/${orgId}`)).toMatchObject({
      name: 'Fictional Harbour Law',
      billing: { unitMinutes: 6, gstRegistered: true },
      fy: { startMonth: 7 },
      retentionYears: 7,
    });
    expect(w.doc(`orgs/${orgId}/members/invitee`)).toMatchObject({ role: 'owner', status: 'active', initials: 'IF' });
    expect(w.doc(`orgs/${orgId}/counters/matters`)).toEqual({ next: 1 });
    expect(w.records.get('invitee')?.customClaims).toMatchObject({ orgId, role: 'owner' });
    const audits = [...w.docs.entries()].filter(([path]) => path.startsWith(`orgs/${orgId}/audit/`));
    expect(audits.map(([, entry]) => entry['action'])).toEqual(['org.created']);
  });

  it('requires a verified email', async () => {
    const w = world();
    await expect(
      createOrgDefinition.handler(
        w.userCtx('unverified', { name: 'X', primaryJurisdiction: 'VIC', timezone: 'Australia/Melbourne' }),
      ),
    ).rejects.toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
  });

  it('records the terms the owner ticked (SEC-01), and refuses an outdated version', async () => {
    const w = world();
    const input = {
      name: 'Fictional Harbour Law',
      primaryJurisdiction: 'VIC',
      timezone: 'Australia/Melbourne',
    } as const;
    await expect(
      createOrgDefinition.handler(w.userCtx('invitee', { ...input, acceptTermsVersion: '0.0' })),
    ).rejects.toMatchObject({ code: 'FAILED_PRECONDITION', details: { reason: 'terms_outdated' } });
    const { orgId } = await createOrgDefinition.handler(
      w.userCtx('invitee', { ...input, acceptTermsVersion: TERMS_VERSION }),
    );
    const org = w.doc(`orgs/${orgId}`) as Record<string, Timestamp | string>;
    expect(org['termsAcceptedVersion']).toBe(TERMS_VERSION);
    expect(org['termsAcceptedBy']).toBe('invitee');
    expect((org['termsAcceptedAt'] as Timestamp).toDate()).toEqual(w.clock.now());
    const audits = [...w.docs.entries()].filter(([path]) => path.startsWith(`orgs/${orgId}/audit/`));
    expect(audits.map(([, entry]) => entry['action']).sort()).toEqual(['org.created', 'org.terms_accepted']);
  });

  it('leaves the terms for the owner to accept later when they weren’t ticked', async () => {
    const w = world();
    const { orgId } = await createOrgDefinition.handler(
      w.userCtx('invitee', {
        name: 'Fictional Harbour Law',
        primaryJurisdiction: 'VIC',
        timezone: 'Australia/Melbourne',
      }),
    );
    expect(w.doc(`orgs/${orgId}`)).not.toHaveProperty('termsAcceptedVersion');
  });
});

describe('orgs-acceptTerms (SEC-01)', () => {
  it('is for owners only', () => {
    expect(acceptTermsDefinition.roles).toEqual(['owner']);
    expect(acceptTermsDefinition.idempotent).toBe(true);
  });

  it('records the current version, when and who on the org, and audits it once', async () => {
    const w = world();
    const result = await acceptTermsDefinition.handler(w.orgCtx('owner', 'owner', { version: TERMS_VERSION }));
    expect(result).toEqual({ version: TERMS_VERSION, recorded: true });
    const org = w.doc(`orgs/${ORG}`) as Record<string, unknown>;
    expect(org).toMatchObject({ termsAcceptedVersion: TERMS_VERSION, termsAcceptedBy: 'owner', updatedBy: 'owner' });
    expect((org['termsAcceptedAt'] as Timestamp).toDate()).toEqual(w.clock.now());
    const audits = () =>
      [...w.docs.entries()].filter(([path]) => path.startsWith(`orgs/${ORG}/audit/`)).map(([, entry]) => entry);
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({
      action: 'org.terms_accepted',
      entity: { path: `orgs/${ORG}/members/owner` },
      summary: `Terms of service version ${TERMS_VERSION} accepted`,
    });

    // Accepting again writes nothing more.
    w.clock.advance(60_000);
    const again = await acceptTermsDefinition.handler(w.orgCtx('owner', 'owner', { version: TERMS_VERSION }));
    expect(again).toEqual({ version: TERMS_VERSION, recorded: false });
    expect((w.doc(`orgs/${ORG}`)?.['termsAcceptedAt'] as Timestamp).toDate()).toEqual(
      new Date(w.clock.now().getTime() - 60_000),
    );
    expect(audits()).toHaveLength(1);
  });

  it('refuses a version that isn’t current, and an org that doesn’t exist', async () => {
    const w = world();
    await expect(acceptTermsDefinition.handler(w.orgCtx('owner', 'owner', { version: '0.0' }))).rejects.toMatchObject({
      code: 'FAILED_PRECONDITION',
      details: { reason: 'terms_outdated', current: TERMS_VERSION },
    });
    expect(w.doc(`orgs/${ORG}`)).not.toHaveProperty('termsAcceptedVersion');
    w.docs.delete(`orgs/${ORG}`);
    await expect(
      acceptTermsDefinition.handler(w.orgCtx('owner', 'owner', { version: TERMS_VERSION })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('invites', () => {
  async function invite(w: ReturnType<typeof world>, email = 'invitee@example.test', role: Role = 'paralegal') {
    return inviteMemberDefinition.handler(w.orgCtx('admin', 'admin', { email, role }));
  }

  it('stores only the token hash, emails the link and audits', async () => {
    const w = world();
    const { inviteId, emailed } = await invite(w);
    expect(emailed).toBe(true);
    const token = lastToken(w.mail);
    const stored = w.doc(`orgs/${ORG}/invites/${inviteId}`);
    expect(stored).toMatchObject({ email: 'invitee@example.test', status: 'pending', tokenHash: hashToken(token) });
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(w.mail.sent[0]).toMatchObject({
      to: 'invitee@example.test',
      template: 'invite',
      model: { orgName: 'Fictional Bayside Legal', inviterName: 'admin person', role: 'paralegal' },
    });
  });

  it('replaces an earlier pending invite for the same email', async () => {
    const w = world();
    const first = await invite(w);
    await invite(w);
    expect(w.doc(`orgs/${ORG}/invites/${first.inviteId}`)?.['status']).toBe('revoked');
  });

  it('rejects members, admins granting owner, and more than 50 pending invites', async () => {
    const w = world();
    await expect(invite(w, 'lawyer@example.test')).rejects.toMatchObject({ code: 'ALREADY_MEMBER' });
    await expect(invite(w, 'someone@example.test', 'owner')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const expiresAt = new Date(w.clock.now().getTime() + 86_400_000);
    for (let i = 0; i < 50; i++) {
      w.docs.set(`orgs/${ORG}/invites/p${i}`, {
        email: `p${i}@example.test`,
        status: 'pending',
        expiresAt: { toMillis: () => expiresAt.getTime() } as Timestamp,
      });
    }
    await expect(invite(w, 'one-more@example.test')).rejects.toMatchObject({ code: 'INVITE_LIMIT' });
  });

  it('still creates the invite when the email cannot be sent', async () => {
    const w = world();
    w.mail.send = async () => {
      throw Object.assign(new Error('down'), { code: 'unavailable' });
    };
    const { inviteId, emailed } = await invite(w);
    expect(emailed).toBe(false);
    expect(w.doc(`orgs/${ORG}/invites/${inviteId}`)?.['status']).toBe('pending');
    expect(w.logs).toContain('invite email not sent');
  });

  it('resends with a new token and revokes', async () => {
    const w = world();
    const { inviteId } = await invite(w);
    const oldHash = w.doc(`orgs/${ORG}/invites/${inviteId}`)?.['tokenHash'];
    await resendInviteDefinition.handler(w.orgCtx('admin', 'admin', { inviteId }));
    expect(w.doc(`orgs/${ORG}/invites/${inviteId}`)?.['tokenHash']).not.toBe(oldHash);
    expect(w.mail.sent).toHaveLength(2);
    await revokeInviteDefinition.handler(w.orgCtx('admin', 'admin', { inviteId }));
    expect(w.doc(`orgs/${ORG}/invites/${inviteId}`)?.['status']).toBe('revoked');
    await expect(revokeInviteDefinition.handler(w.orgCtx('admin', 'admin', { inviteId }))).rejects.toMatchObject({
      code: 'FAILED_PRECONDITION',
    });
    await expect(
      revokeInviteDefinition.handler(w.orgCtx('admin', 'admin', { inviteId: 'missing' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('accepts once for the invited email, and again as a no-op', async () => {
    const w = world();
    const { inviteId } = await invite(w);
    const token = lastToken(w.mail);
    await expect(acceptInviteDefinition.handler(w.userCtx('lawyer', { inviteId, token }))).rejects.toMatchObject({
      code: 'INVITE_EMAIL_MISMATCH',
    });
    await expect(
      acceptInviteDefinition.handler(w.userCtx('invitee', { inviteId, token: 'wrong' })),
    ).rejects.toMatchObject({ code: 'INVITE_INVALID' });

    const accepted = await acceptInviteDefinition.handler(w.userCtx('invitee', { inviteId, token }));
    expect(accepted).toEqual({ orgId: ORG, orgName: 'Fictional Bayside Legal' });
    expect(w.doc(`orgs/${ORG}/members/invitee`)).toMatchObject({ role: 'paralegal', status: 'active' });
    expect(w.doc(`orgs/${ORG}/invites/${inviteId}`)).toMatchObject({ status: 'accepted', acceptedBy: 'invitee' });
    expect(w.records.get('invitee')?.customClaims).toMatchObject({ orgId: ORG, role: 'paralegal' });

    expect(await acceptInviteDefinition.handler(w.userCtx('invitee', { inviteId, token }))).toEqual(accepted);
  });

  it('rejects an expired invite and an existing member, and keeps a returning member’s profile', async () => {
    const w = world({ [`orgs/${ORG}/members/invitee`]: { ...member('lawyer', 'removed'), title: 'Senior Associate' } });
    const { inviteId } = await invite(w);
    const token = lastToken(w.mail);
    w.clock.advance(8 * 86_400_000);
    await expect(acceptInviteDefinition.handler(w.userCtx('invitee', { inviteId, token }))).rejects.toMatchObject({
      code: 'INVITE_EXPIRED',
    });
    w.clock.advance(-8 * 86_400_000);
    await acceptInviteDefinition.handler(w.userCtx('invitee', { inviteId, token }));
    expect(w.doc(`orgs/${ORG}/members/invitee`)).toMatchObject({ title: 'Senior Associate', status: 'active' });

    const second = await invite(w, 'admin@example.test').catch((error: unknown) => error);
    expect(second).toMatchObject({ code: 'ALREADY_MEMBER' });
    w.docs.set(`orgs/${ORG}/members/invitee`, { ...member('lawyer', 'active') });
    const again = await invite(w, 'invitee@example.test').catch((error: unknown) => error);
    expect(again).toMatchObject({ code: 'ALREADY_MEMBER' });
  });

  it('rejects a revoked invite', async () => {
    const w = world();
    const { inviteId } = await invite(w);
    const token = lastToken(w.mail);
    await revokeInviteDefinition.handler(w.orgCtx('admin', 'admin', { inviteId }));
    await expect(acceptInviteDefinition.handler(w.userCtx('invitee', { inviteId, token }))).rejects.toMatchObject({
      code: 'INVITE_INVALID',
    });
  });
});

describe('members', () => {
  it('changes a role and syncs the claims', async () => {
    const w = world();
    await changeRoleDefinition.handler(w.orgCtx('owner', 'owner', { uid: 'lawyer', role: 'admin' }));
    expect(w.doc(`orgs/${ORG}/members/lawyer`)?.['role']).toBe('admin');
    expect(w.records.get('lawyer')?.customClaims).toMatchObject({ role: 'admin' });
  });

  it('keeps the last active owner', async () => {
    const w = world();
    const ctx = (input: Record<string, unknown>) => w.orgCtx('owner', 'owner', input);
    await expect(changeRoleDefinition.handler(ctx({ uid: 'owner', role: 'admin' }) as never)).rejects.toMatchObject({
      code: 'LAST_OWNER',
    });
    await expect(
      suspendMemberDefinition.handler(ctx({ uid: 'owner', suspended: true }) as never),
    ).rejects.toMatchObject({ code: 'LAST_OWNER' });
    await expect(removeMemberDefinition.handler(ctx({ uid: 'owner' }) as never)).rejects.toMatchObject({
      code: 'LAST_OWNER',
    });
    await expect(removeMemberDefinition.handler(ctx({ uid: 'nobody' }) as never)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('lets an admin change neither an owner nor anyone to owner', async () => {
    const w = world();
    await expect(
      changeRoleDefinition.handler(w.orgCtx('admin', 'admin', { uid: 'owner', role: 'lawyer' })),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      changeRoleDefinition.handler(w.orgCtx('admin', 'admin', { uid: 'lawyer', role: 'owner' })),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('suspends with token revocation and reinstates', async () => {
    const w = world();
    await suspendMemberDefinition.handler(w.orgCtx('admin', 'admin', { uid: 'lawyer', suspended: true }));
    expect(w.doc(`orgs/${ORG}/members/lawyer`)?.['status']).toBe('suspended');
    expect(w.revoked).toEqual(['lawyer']);
    expect(w.records.get('lawyer')?.customClaims ?? {}).not.toHaveProperty('orgId');
    await suspendMemberDefinition.handler(w.orgCtx('admin', 'admin', { uid: 'lawyer', suspended: false }));
    expect(w.doc(`orgs/${ORG}/members/lawyer`)?.['status']).toBe('active');
    expect(w.records.get('lawyer')?.customClaims).toMatchObject({ orgId: ORG });
  });

  it('removes a member, revoking tokens only when it was their active org', async () => {
    const w = world();
    expect(await removeMemberDefinition.handler(w.orgCtx('admin', 'admin', { uid: 'lawyer' }))).toEqual({
      ok: true,
      tokensRevoked: true,
    });
    expect(w.doc(`orgs/${ORG}/members/lawyer`)?.['status']).toBe('removed');
    w.docs.set('users/admin', { ...w.doc('users/admin'), activeOrgId: 'org-b' });
    expect(await removeMemberDefinition.handler(w.orgCtx('owner', 'owner', { uid: 'admin' }))).toEqual({
      ok: true,
      tokensRevoked: false,
    });
  });

  it('revokes and deletes the removed member’s own integrations (INT-01)', async () => {
    const w = world();
    const path = `orgs/${ORG}/integrations/lawyer_microsoft`;
    const sealed = await new FakeKms('fake-kms/oauth-tokens/cryptoKeyVersions/1').encrypt(
      'fake-refresh.microsoft.lawyer',
      path,
    );
    w.docs.set(path, {
      provider: 'microsoft',
      uid: 'lawyer',
      level: 'user',
      status: 'connected',
      connectionId: 'c1',
      encryptedRefreshToken: sealed.ciphertext,
      kmsKeyVersion: sealed.keyVersion,
    });
    await removeMemberDefinition.handler(w.orgCtx('admin', 'admin', { uid: 'lawyer' }));
    expect(w.doc(path)).toBeUndefined();
    expect(w.doc(`orgs/${ORG}/integrationStatus/lawyer_microsoft`)).toMatchObject({
      status: 'disconnected',
      reason: 'member_removed',
    });
  });

  it('transfers ownership after a recent sign-in', async () => {
    const w = world();
    const recent = { auth_time: Math.floor(w.clock.now().getTime() / 1000) };
    // The wrapper refuses a stale sign-in before the handler runs (core/sensitive.spec.ts).
    expect(transferOwnershipDefinition.recentLoginMinutes).toBe(5);
    await expect(
      transferOwnershipDefinition.handler(w.orgCtx('owner', 'owner', { toUid: 'owner' }, recent)),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      transferOwnershipDefinition.handler(w.orgCtx('owner', 'owner', { toUid: 'nobody' }, recent)),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await transferOwnershipDefinition.handler(w.orgCtx('owner', 'owner', { toUid: 'lawyer' }, recent));
    expect(w.doc(`orgs/${ORG}/members/lawyer`)?.['role']).toBe('owner');
    expect(w.doc(`orgs/${ORG}/members/owner`)?.['role']).toBe('admin');
    await expect(
      transferOwnershipDefinition.handler(w.orgCtx('owner', 'owner', { toUid: 'admin' }, recent)),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});

describe('orgs-switchActiveOrg', () => {
  it('switches to an org the person is an active member of', async () => {
    const w = world({
      'orgs/org-b': { name: 'Fictional Beta Lawyers' },
      'orgs/org-b/members/lawyer': member('readonly'),
    });
    const result = await switchActiveOrgDefinition.handler(w.userCtx('lawyer', { orgId: 'org-b' }));
    expect(result.orgId).toBe('org-b');
    expect(result.claimsVersion).toBe(1);
    expect(w.records.get('lawyer')?.customClaims).toMatchObject({
      orgId: 'org-b',
      role: 'readonly',
      orgs: { [ORG]: 'lawyer', 'org-b': 'readonly' },
    });
    await expect(switchActiveOrgDefinition.handler(w.userCtx('lawyer', { orgId: 'org-c' }))).rejects.toMatchObject({
      code: 'MEMBER_INACTIVE',
    });
  });
});
