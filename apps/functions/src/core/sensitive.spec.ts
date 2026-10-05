import type { HttpsError } from 'firebase-functions/v2/https';

import { resolveSecurity } from '@materia/domain';

import { runCallable, type CallableDefinition, type CallableDeps } from './callable';
import { assertSessionAllowed, cachedSessionLookup, type SessionPolicy } from './sessions';
import { auditExportDefinition } from '../audit/query';
import { setApiKeyDefinition } from '../clerk/keys';
import {
  changeRoleDefinition,
  removeMemberDefinition,
  suspendMemberDefinition,
  transferOwnershipDefinition,
} from '../orgs/members';
import { memoryFirestore } from '../orgs/testing';
import { FakeClock, fakePorts } from '../ports/fakes';
import { confirmDestructionDefinition } from '../safe-custody/confirm-destruction';
import { recordMovementDefinition } from '../safe-custody/record-movement';
import { updatePolicyDefinition } from '../security/policy';
import { revokeSessionsDefinition } from '../security/revoke';

const REQUEST_ID = '6f1c1c2e-8a43-4b8e-9d0e-0a3f5b1d2c4e';
const clock = new FakeClock();
const nowSeconds = Math.floor(clock.now().getTime() / 1000);

const deps = (sessions?: SessionPolicy): CallableDeps => ({
  db: () => memoryFirestore().db,
  clock,
  ports: () => fakePorts(),
  memberLookup: async () => true,
  idempotency: {
    begin: async () => ({ replay: false }),
    complete: async () => undefined,
    abandon: async () => undefined,
  },
  sink: () => undefined,
  ...(sessions ? { sessions: async () => sessions } : {}),
});

const call = (
  def: CallableDefinition<never, unknown>,
  data: Record<string, unknown>,
  token: Record<string, unknown>,
  sessions?: SessionPolicy,
) =>
  runCallable(
    def,
    {
      data: { requestId: REQUEST_ID, ...data },
      auth: { uid: 'owner-1', token: { orgId: 'org-a', role: 'owner', ...token } },
    },
    deps(sessions),
  ).catch((error: unknown) => error as HttpsError);

/**
 * Every sensitive action SEC-04 lists (exports, deletes, role changes, integration connects, safe
 * custody releases and destruction approvals), with an input that gets past validation. A new
 * sensitive callable belongs here.
 */
const SENSITIVE: [string, CallableDefinition<never, unknown>, Record<string, unknown>][] = [
  ['export: audit log CSV', auditExportDefinition as never, {}],
  ['role change', changeRoleDefinition as never, { uid: 'lawyer-1', role: 'admin' }],
  ['suspension', suspendMemberDefinition as never, { uid: 'lawyer-1', suspended: true }],
  ['removal', removeMemberDefinition as never, { uid: 'lawyer-1' }],
  ['ownership transfer', transferOwnershipDefinition as never, { toUid: 'lawyer-1' }],
  ['integration connect: Anthropic key', setApiKeyDefinition as never, { apiKey: `sk-ant-api03-${'x'.repeat(80)}` }],
  [
    'safe custody release',
    recordMovementDefinition as never,
    {
      id: 'packet-1',
      kind: 'released',
      reason: 'Executor collected',
      to: 'Executor',
      authority: { matterId: 'm1', documentId: 'd1' },
    },
  ],
  ['destruction approval', confirmDestructionDefinition as never, { id: 'packet-1', approve: true }],
  [
    'security policy change',
    updatePolicyDefinition as never,
    { mfaRequired: true, sessionIdleMinutes: 30, maxSessionDays: 14, mfaGraceHours: 24 },
  ],
  ['remote sign-out', revokeSessionsDefinition as never, { uid: 'lawyer-1' }],
];

describe('re-authentication for sensitive actions (SEC-04)', () => {
  it.each(SENSITIVE)('%s needs a sign-in within five minutes', async (_label, def, data) => {
    const error = await call(def, data, { auth_time: nowSeconds - 6 * 60 });
    expect((error as HttpsError).details).toMatchObject({ code: 'REAUTH_REQUIRED' });
  });

  it('a recent sign-in gets past the check', async () => {
    const error = await call(
      changeRoleDefinition as never,
      { uid: 'nobody', role: 'admin' },
      { auth_time: nowSeconds },
    );
    expect((error as HttpsError).details).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('session policy in the callable wrapper (SEC-04)', () => {
  const recent = { auth_time: nowSeconds };
  const mfaOn = (enforceAfter: Date | undefined): SessionPolicy => ({
    policy: resolveSecurity({ mfaRequired: true, sessionIdleMinutes: 60, mfaEnforceAfter: enforceAfter }),
    validAfter: null,
  });
  const echoLike = changeRoleDefinition as never;
  const input = { uid: 'nobody', role: 'admin' };

  it('refuses a sign-in without a second factor once the org requires MFA', async () => {
    const error = await call(echoLike, input, recent, mfaOn(undefined));
    expect((error as HttpsError).details).toMatchObject({ code: 'MFA_REQUIRED' });
    expect((error as HttpsError).code).toBe('permission-denied');
  });

  it('lets members without MFA work during the grace period', async () => {
    const error = await call(echoLike, input, recent, mfaOn(new Date(clock.now().getTime() + 3_600_000)));
    expect((error as HttpsError).details).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('accepts a sign-in that used a second factor', async () => {
    const token = { ...recent, firebase: { sign_in_second_factor: 'totp' } };
    const error = await call(echoLike, input, token, mfaOn(undefined));
    expect((error as HttpsError).details).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses a sign-in from before a "sign out everywhere"', async () => {
    const policy = { policy: resolveSecurity(undefined), validAfter: new Date(clock.now().getTime()) };
    const error = await call(echoLike, input, { auth_time: nowSeconds - 1 }, policy);
    expect((error as HttpsError).details).toMatchObject({ code: 'SESSION_REVOKED' });
    expect(((await call(echoLike, input, recent, policy)) as HttpsError).details).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses a sign-in older than the org’s session length', async () => {
    const policy = {
      policy: resolveSecurity({ mfaRequired: false, sessionIdleMinutes: 60, maxSessionDays: 1 }),
      validAfter: null,
    };
    expect(() => assertSessionAllowed({ auth_time: nowSeconds - 2 * 86_400 }, policy, clock.now().getTime())).toThrow(
      expect.objectContaining({ code: 'SESSION_EXPIRED' }),
    );
    expect(() => assertSessionAllowed({ auth_time: nowSeconds - 3_600 }, policy, clock.now().getTime())).not.toThrow();
  });

  it('skips the MFA check for calls that opt out', () => {
    expect(() => assertSessionAllowed(recent, mfaOn(undefined), clock.now().getTime(), { mfa: false })).not.toThrow();
  });

  it('reads the policy and the member’s revocation, cached for a minute', async () => {
    const { db } = memoryFirestore({
      'orgs/org-a': { security: { mfaRequired: true, sessionIdleMinutes: 30, maxSessionDays: 7 } },
      'orgs/org-a/members/u1': { status: 'active', sessionsValidAfter: new Date('2026-03-01T00:00:00Z') },
    });
    const lookup = cachedSessionLookup(() => db, clock);
    const first = await lookup('org-a', 'u1');
    expect(first.policy).toMatchObject({ mfaRequired: true, sessionIdleMinutes: 30, maxSessionDays: 7 });
    expect(first.validAfter).toEqual(new Date('2026-03-01T00:00:00Z'));
    await db.doc('orgs/org-a').set({ security: { mfaRequired: false, sessionIdleMinutes: 60 } });
    expect((await lookup('org-a', 'u1')).policy.mfaRequired).toBe(true);
    lookup.clear();
    expect((await lookup('org-a', 'u1')).policy.mfaRequired).toBe(false);
  });
});
