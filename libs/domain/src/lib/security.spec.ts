import {
  describeUserAgent,
  formatDays,
  formatGraceHours,
  formatMinutes,
  mfaEnforced,
  newOrgSecurity,
  nextMfaDates,
  resolveSecurity,
  revocationInstant,
  sessionExpired,
  sessionRevoked,
  signInState,
  UpdateSecurityPolicyInput,
  usedSecondFactor,
} from './security';

const NOW = new Date('2026-10-06T00:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe('org security policy (SEC-04)', () => {
  it('fills defaults for orgs made before SEC-04, and treats a missing policy as MFA off', () => {
    expect(resolveSecurity({ mfaRequired: true, sessionIdleMinutes: 30 })).toEqual({
      mfaRequired: true,
      sessionIdleMinutes: 30,
      maxSessionDays: 14,
      mfaGraceHours: 24,
      mfaRequiredSince: null,
      mfaEnforceAfter: null,
    });
    expect(resolveSecurity(undefined)).toMatchObject({ mfaRequired: false, sessionIdleMinutes: 60 });
    expect(resolveSecurity({ mfaRequired: false, sessionIdleMinutes: 5 }).sessionIdleMinutes).toBe(15);
  });

  it('starts new orgs on required MFA after a 24-hour grace', () => {
    expect(newOrgSecurity(NOW)).toEqual({
      mfaRequired: true,
      sessionIdleMinutes: 60,
      maxSessionDays: 14,
      mfaGraceHours: 24,
      mfaRequiredSince: NOW,
      mfaEnforceAfter: new Date(NOW.getTime() + 24 * HOUR),
    });
  });

  it('enforces MFA only once required and the grace is over (at once without a deadline)', () => {
    const policy = resolveSecurity(newOrgSecurity(NOW));
    expect(mfaEnforced(policy, NOW.getTime())).toBe(false);
    expect(mfaEnforced(policy, NOW.getTime() + 24 * HOUR)).toBe(true);
    expect(mfaEnforced(resolveSecurity({ mfaRequired: true, sessionIdleMinutes: 60 }), 0)).toBe(true);
    expect(mfaEnforced(resolveSecurity({ mfaRequired: false, sessionIdleMinutes: 60 }), 0)).toBe(false);
  });

  it('expires sign-ins older than the session length, and revokes those before a sign-out everywhere', () => {
    const policy = resolveSecurity({ mfaRequired: false, sessionIdleMinutes: 60, maxSessionDays: 7 });
    expect(sessionExpired(NOW.getTime() - 7 * DAY, policy, NOW.getTime())).toBe(false);
    expect(sessionExpired(NOW.getTime() - 7 * DAY - 1, policy, NOW.getTime())).toBe(true);
    expect(sessionRevoked(NOW.getTime() - 1, NOW)).toBe(true);
    expect(sessionRevoked(NOW.getTime(), NOW)).toBe(false);
    expect(sessionRevoked(0, null)).toBe(false);
    expect(revocationInstant(new Date('2026-10-06T00:00:01.999Z'))).toEqual(new Date('2026-10-06T00:00:01.000Z'));
  });

  it('reads the second factor from the ID token', () => {
    expect(usedSecondFactor({ firebase: { sign_in_second_factor: 'totp' } })).toBe(true);
    expect(usedSecondFactor({ firebase: { sign_in_provider: 'password' } })).toBe(false);
    expect(usedSecondFactor(null)).toBe(false);
  });

  it('moves the MFA deadline from when MFA was turned on', () => {
    const off = resolveSecurity({ mfaRequired: false, sessionIdleMinutes: 60 });
    expect(nextMfaDates(off, { mfaRequired: true, mfaGraceHours: 72 }, NOW)).toEqual({
      mfaRequiredSince: NOW,
      mfaEnforceAfter: new Date(NOW.getTime() + 72 * HOUR),
    });
    const on = resolveSecurity(newOrgSecurity(new Date(NOW.getTime() - DAY)));
    expect(nextMfaDates(on, { mfaRequired: true, mfaGraceHours: 0 }, NOW)).toEqual({
      mfaRequiredSince: new Date(NOW.getTime() - DAY),
      mfaEnforceAfter: new Date(NOW.getTime() - DAY),
    });
    expect(nextMfaDates(on, { mfaRequired: false, mfaGraceHours: 24 }, NOW)).toBeNull();
  });

  it('validates the policy input ranges', () => {
    const valid = {
      requestId: '6f1c1c2e-8a43-4b8e-9d0e-0a3f5b1d2c4e',
      mfaRequired: true,
      sessionIdleMinutes: 15,
      maxSessionDays: 90,
      mfaGraceHours: 0,
    };
    expect(UpdateSecurityPolicyInput.safeParse(valid).success).toBe(true);
    expect(UpdateSecurityPolicyInput.safeParse({ ...valid, sessionIdleMinutes: 14 }).success).toBe(false);
    expect(UpdateSecurityPolicyInput.safeParse({ ...valid, sessionIdleMinutes: 481 }).success).toBe(false);
    expect(UpdateSecurityPolicyInput.safeParse({ ...valid, maxSessionDays: 0 }).success).toBe(false);
    expect(UpdateSecurityPolicyInput.safeParse({ ...valid, mfaGraceHours: 169 }).success).toBe(false);
  });
});

describe('sign-in log (SEC-04)', () => {
  it.each([
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
      'Mac',
      'Safari',
    ],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0 Safari/537.36 Edg/141.0', 'Windows PC', 'Edge'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) CriOS/141.0 Mobile Safari/604.1', 'iPhone', 'Chrome'],
    ['Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) FxiOS/130.0 Mobile Safari/605.1.15', 'iPad', 'Firefox'],
    ['Mozilla/5.0 (Linux; Android 15) Chrome/141.0 Mobile Safari/537.36', 'Android', 'Chrome'],
    ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) Chrome/141.0 Safari/537.36', 'Chromebook', 'Chrome'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0', 'Linux', 'Firefox'],
    ['curl/8.0', 'Device', 'Browser'],
    [undefined, 'Device', 'Browser'],
  ])('%s is a %s with %s', (ua, device, browser) => {
    expect(describeUserAgent(ua)).toEqual({ device, browser });
  });

  it('tells this session, signed-out, expired and other sessions apart', () => {
    const policy = resolveSecurity({ mfaRequired: false, sessionIdleMinutes: 60, maxSessionDays: 14 });
    const context = {
      currentAuthTimeMs: NOW.getTime(),
      validAfter: new Date(NOW.getTime() - DAY),
      policy,
      nowMs: NOW.getTime(),
    };
    const at = (ms: number) => ({ authTime: Math.floor(ms / 1000) });
    expect(signInState(at(NOW.getTime() - 30_000), context)).toBe('current');
    expect(signInState(at(NOW.getTime() - 2 * DAY), context)).toBe('signedOut');
    expect(signInState(at(NOW.getTime() - HOUR), context)).toBe('active');
    expect(signInState(at(NOW.getTime() - 20 * DAY), { ...context, validAfter: null })).toBe('expired');
  });

  it('words the durations', () => {
    expect([15, 60, 120, 1].map(formatMinutes)).toEqual(['15 minutes', '1 hour', '2 hours', '1 minute']);
    expect([1, 14].map(formatDays)).toEqual(['1 day', '14 days']);
    expect([0, 24, 72, 168, 12].map(formatGraceHours)).toEqual([
      'No grace period',
      '24 hours',
      '3 days',
      '1 week',
      '12 hours',
    ]);
  });
});
