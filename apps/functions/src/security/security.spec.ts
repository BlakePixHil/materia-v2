import { randomUUID } from 'node:crypto';

import { Timestamp } from 'firebase-admin/firestore';

import type { Role } from '@materia/domain';

import { updatePolicyDefinition } from './policy';
import { revokeSessionsDefinition } from './revoke';
import { clearRetentionCache } from '../audit/retention';
import { createLog } from '../core/log';
import { memoryAuth, memoryFirestore } from '../orgs/testing';
import { FakeClock, fakePorts } from '../ports/fakes';

const ORG = 'org-a';
const OTHER = 'org-b';

function world() {
  const store = memoryFirestore({
    [`orgs/${ORG}`]: {
      name: 'Fictional Bayside Legal',
      retentionYears: 7,
      security: { mfaRequired: false, sessionIdleMinutes: 60 },
    },
    [`orgs/${ORG}/members/owner`]: { role: 'owner', status: 'active' },
    [`orgs/${ORG}/members/admin`]: { role: 'admin', status: 'active' },
    [`orgs/${ORG}/members/lawyer`]: { role: 'lawyer', status: 'active' },
    [`orgs/${OTHER}/members/lawyer`]: { role: 'admin', status: 'active' },
    'users/lawyer': { orgIds: [ORG, OTHER], activeOrgId: ORG },
  });
  const auth = memoryAuth([{ uid: 'owner' }, { uid: 'admin' }, { uid: 'lawyer' }]);
  const clock = new FakeClock();
  const ctx = <T>(uid: string, role: Role, input: T) => ({
    input: { requestId: randomUUID(), ...input },
    uid,
    orgId: ORG,
    role,
    token: {},
    requestId: randomUUID(),
    log: createLog({ fn: 'test' }, () => undefined),
    clock,
    db: store.db,
    ports: fakePorts(),
    auth: () => auth.auth,
  });
  const security = () => store.docs.get(`orgs/${ORG}`)?.['security'] as Record<string, unknown>;
  const audits = () => [...store.docs.entries()].filter(([path]) => path.startsWith(`orgs/${ORG}/audit/`));
  return { ...store, ...auth, clock, ctx, security, audits };
}

beforeEach(() => clearRetentionCache());

const policy = { mfaRequired: true, sessionIdleMinutes: 30, maxSessionDays: 7, mfaGraceHours: 24 };

describe('security-updatePolicy', () => {
  it('turns MFA on with a grace period from now, and audits the change', async () => {
    const w = world();
    const result = await updatePolicyDefinition.handler(w.ctx('admin', 'admin', policy));
    const now = w.clock.now().getTime();
    expect(result.changed).toEqual(['mfaRequired', 'sessionIdleMinutes', 'maxSessionDays']);
    expect(result.mfaEnforceAfter).toBe(new Date(now + 24 * 3_600_000).toISOString());
    expect(w.security()).toMatchObject({
      mfaRequired: true,
      sessionIdleMinutes: 30,
      maxSessionDays: 7,
      mfaGraceHours: 24,
      mfaRequiredSince: Timestamp.fromMillis(now),
    });
    expect(w.audits()[0]?.[1]).toMatchObject({
      action: 'org.security_updated',
      summary: expect.stringContaining('mfaRequired'),
    });
  });

  it('keeps the grace counting from when MFA was turned on, and clears it when MFA goes off', async () => {
    const w = world();
    await updatePolicyDefinition.handler(w.ctx('owner', 'owner', policy));
    const since = w.clock.now().getTime();
    w.clock.advance(3_600_000);
    await updatePolicyDefinition.handler(w.ctx('owner', 'owner', { ...policy, mfaGraceHours: 72 }));
    expect(w.security()['mfaEnforceAfter']).toEqual(Timestamp.fromMillis(since + 72 * 3_600_000));
    await updatePolicyDefinition.handler(w.ctx('owner', 'owner', { ...policy, mfaRequired: false }));
    expect(w.security()).not.toHaveProperty('mfaEnforceAfter');
    expect(w.security()['mfaRequired']).toBe(false);
  });

  it('is for owners and admins, after a recent sign-in', () => {
    expect(updatePolicyDefinition.roles).toEqual(['owner', 'admin']);
    expect(updatePolicyDefinition.recentLoginMinutes).toBe(5);
  });
});

describe('security-revokeSessions', () => {
  it('signs the caller out everywhere else: every membership is stamped and tokens are revoked', async () => {
    const w = world();
    const result = await revokeSessionsDefinition.handler(w.ctx('lawyer', 'lawyer', {}));
    const stamp = Timestamp.fromMillis(Math.floor(w.clock.now().getTime() / 1000) * 1000);
    expect(result).toEqual({ uid: 'lawyer', validAfter: stamp.toDate().toISOString() });
    expect(w.docs.get(`orgs/${ORG}/members/lawyer`)?.['sessionsValidAfter']).toEqual(stamp);
    expect(w.docs.get(`orgs/${OTHER}/members/lawyer`)?.['sessionsValidAfter']).toEqual(stamp);
    expect(w.revoked).toEqual(['lawyer']);
    expect(w.audits()[0]?.[1]).toMatchObject({ action: 'member.signed_out_elsewhere' });
  });

  it('lets an admin sign another member out of every device, in this org only', async () => {
    const w = world();
    await revokeSessionsDefinition.handler(w.ctx('admin', 'admin', { uid: 'lawyer' }));
    expect(w.docs.get(`orgs/${ORG}/members/lawyer`)?.['sessionsValidAfter']).toBeDefined();
    expect(w.docs.get(`orgs/${OTHER}/members/lawyer`)?.['sessionsValidAfter']).toBeUndefined();
    expect(w.revoked).toEqual(['lawyer']);
    expect(w.audits()[0]?.[1]).toMatchObject({ action: 'member.signed_out' });
  });

  it('refuses other roles, owners signed out by an admin, and people who aren’t members', async () => {
    const w = world();
    await expect(revokeSessionsDefinition.handler(w.ctx('lawyer', 'lawyer', { uid: 'admin' }))).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    await expect(revokeSessionsDefinition.handler(w.ctx('admin', 'admin', { uid: 'owner' }))).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    await expect(revokeSessionsDefinition.handler(w.ctx('owner', 'owner', { uid: 'nobody' }))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(w.revoked).toEqual([]);
    await revokeSessionsDefinition.handler(w.ctx('owner', 'owner', { uid: 'admin' }));
    expect(w.revoked).toEqual(['admin']);
  });
});
