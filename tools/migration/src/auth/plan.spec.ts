import {
  checkImported,
  describeUser,
  planAuthImport,
  planRollback,
  toUserImport,
  type TargetState,
  type TargetUser,
} from './plan.ts';
import type { LegacyAuthRecord } from './record.ts';

const GOOGLE_ONLY: LegacyAuthRecord = {
  uid: 'legacy-1',
  email: 'Alex.Rivers@example.com',
  emailVerified: true,
  displayName: 'Alex Rivers',
  photoUrl: 'https://example.com/a.png',
  createdAt: '1640995200000',
  disabled: false,
  identities: [{ providerId: 'google.com', rawId: 'g-1', email: 'alex.rivers@example.com' }],
  password: 'none',
  phoneSignIn: false,
  mfaFactors: 0,
  hasCustomClaims: false,
};

const WITH_PASSWORD: LegacyAuthRecord = {
  ...GOOGLE_ONLY,
  identities: [...GOOGLE_ONLY.identities, { providerId: 'microsoft.com', rawId: 'm-1' }],
  password: 'hash',
  passwordHash: 'aGFzaA==',
  passwordSalt: 'c2FsdA==',
};

const EMPTY: TargetState = { byUid: null, conflicts: [], enabledProviders: new Set(['password', 'google.com']) };

const user = (fields: Partial<TargetUser> & { uid: string }): TargetUser => ({
  providers: [],
  hasCustomClaims: false,
  ...fields,
});

describe('planAuthImport', () => {
  it('imports a Google-only account into an empty target, without hash parameters', () => {
    expect(planAuthImport(GOOGLE_ONLY, EMPTY)).toEqual({
      action: 'import',
      reasons: [],
      replace: [],
      needsHashParams: false,
      notes: [],
    });
  });

  it('needs the scrypt parameters for a password, and every provider on in the target', () => {
    const plan = planAuthImport(WITH_PASSWORD, EMPTY);
    expect(plan.action).toBe('abort');
    expect(plan.reasons).toEqual([expect.stringMatching(/^microsoft\.com sign-in is off in the target project/)]);
    const onEmulator = planAuthImport(WITH_PASSWORD, { ...EMPTY, enabledProviders: 'any' });
    expect(onEmulator).toMatchObject({ action: 'import', needsHashParams: true });
    const noEmail = planAuthImport(WITH_PASSWORD, {
      ...EMPTY,
      enabledProviders: new Set(['google.com', 'microsoft.com']),
    });
    expect(noEmail.reasons).toEqual([expect.stringMatching(/^Email and password sign-in is off/)]);
  });

  it('is a no-op when the uid is already there with the same email', () => {
    const byUid = user({
      uid: 'legacy-1',
      email: 'alex.rivers@example.com',
      providers: [{ providerId: 'google.com', uid: 'g-1' }],
    });
    expect(planAuthImport(GOOGLE_ONLY, { ...EMPTY, byUid })).toMatchObject({
      action: 'skip',
      reasons: [expect.stringMatching(/nothing to do/)],
      notes: [],
    });
    const partial = planAuthImport(GOOGLE_ONLY, { ...EMPTY, byUid: { ...byUid, providers: [] } });
    expect(partial).toMatchObject({ action: 'skip', notes: [expect.stringMatching(/lacks google\.com/)] });
  });

  it('stops when the uid is there with a different email', () => {
    const byUid = user({ uid: 'legacy-1', email: 'someone@example.com' });
    expect(planAuthImport(GOOGLE_ONLY, { ...EMPTY, byUid })).toMatchObject({
      action: 'abort',
      reasons: [expect.stringMatching(/with a different email/)],
    });
  });

  it('stops for a person on a disabled account, second factors, phone sign-in, a tenant or a missing email', () => {
    const plan = planAuthImport(
      {
        ...GOOGLE_ONLY,
        email: undefined as unknown as string,
        disabled: true,
        mfaFactors: 1,
        phoneSignIn: true,
        tenantId: 't',
        identities: [{ providerId: 'google.com', rawId: '' }],
      },
      EMPTY,
    );
    expect(plan.action).toBe('abort');
    expect(plan.reasons.join('\n')).toMatch(/disabled/);
    expect(plan.reasons.join('\n')).toMatch(/no email/);
    expect(plan.reasons.join('\n')).toMatch(/second factor/);
    expect(plan.reasons.join('\n')).toMatch(/by phone/);
    expect(plan.reasons.join('\n')).toMatch(/tenant t/);
    expect(plan.reasons.join('\n')).toMatch(/no provider uid/);
  });

  it("stops when the hash isn't in this source", () => {
    expect(planAuthImport({ ...GOOGLE_ONLY, password: 'unavailable' }, EMPTY).reasons).toEqual([
      expect.stringMatching(/doesn't show its hash/),
    ]);
  });

  it('replaces a conflicting v2 user only when a person names it', () => {
    const tester = user({
      uid: 'v2-test',
      email: 'alex.rivers@example.com',
      providers: [{ providerId: 'google.com', uid: 'g-1' }],
      lastSignInAt: 'Mon, 06 Oct 2026 01:00:00 GMT',
      hasCustomClaims: true,
    });
    const state = { ...EMPTY, conflicts: [tester] };
    const stopped = planAuthImport(GOOGLE_ONLY, state);
    expect(stopped.action).toBe('abort');
    expect(stopped.reasons[0]).toContain('--replace-user v2-test');
    expect(stopped.reasons[0]).not.toContain('example.com');
    expect(planAuthImport(GOOGLE_ONLY, state, { replaceUids: ['v2-test'] })).toMatchObject({
      action: 'import',
      replace: [tester],
    });
    expect(planAuthImport(GOOGLE_ONLY, EMPTY, { replaceUids: ['nobody'] }).reasons).toEqual([
      expect.stringMatching(/--replace-user nobody doesn't hold/),
    ]);
  });

  it('notes that legacy custom claims are not carried over', () => {
    expect(planAuthImport({ ...GOOGLE_ONLY, hasCustomClaims: true }, EMPTY).notes).toEqual([
      expect.stringMatching(/claims are not imported/),
    ]);
  });
});

describe('describeUser', () => {
  it('says enough to decide without the email', () => {
    expect(describeUser(user({ uid: 'u', email: 'x@example.com' }))).toBe(
      'u (no providers; created unknown, never signed in)',
    );
  });
});

describe('planRollback', () => {
  const imported = user({ uid: 'legacy-1', email: 'alex.rivers@example.com' });

  it('deletes only the imported account, and in prod only if it never signed in', () => {
    const rehearsal = { signedInMayGo: true };
    const prod = { signedInMayGo: false };
    expect(planRollback(GOOGLE_ONLY, imported, prod).action).toBe('delete');
    expect(planRollback(GOOGLE_ONLY, null, prod).action).toBe('skip');
    expect(planRollback(GOOGLE_ONLY, { ...imported, email: 'other@example.com' }, rehearsal).action).toBe('abort');
    const signedIn = { ...imported, lastSignInAt: 'Mon, 06 Oct 2026 01:00:00 GMT' };
    expect(planRollback(GOOGLE_ONLY, signedIn, prod)).toMatchObject({
      action: 'abort',
      reason: expect.stringMatching(/would lock the user out/),
    });
    expect(planRollback(GOOGLE_ONLY, signedIn, rehearsal)).toMatchObject({
      action: 'delete',
      reason: expect.stringMatching(/sign-in log .* stays for the load's rollback/),
    });
  });
});

describe('toUserImport', () => {
  it('keeps the uid, email, name, creation time and every identity with its provider uid', () => {
    expect(toUserImport(GOOGLE_ONLY)).toEqual({
      uid: 'legacy-1',
      email: 'Alex.Rivers@example.com',
      emailVerified: true,
      displayName: 'Alex Rivers',
      photoURL: 'https://example.com/a.png',
      disabled: false,
      metadata: { creationTime: 'Sat, 01 Jan 2022 00:00:00 GMT' },
      providerData: [{ providerId: 'google.com', uid: 'g-1', email: 'alex.rivers@example.com' }],
    });
  });

  it('carries the password hash and salt as bytes, and all providers', () => {
    const imported = toUserImport(WITH_PASSWORD);
    expect(imported.passwordHash?.toString()).toBe('hash');
    expect(imported.passwordSalt?.toString()).toBe('salt');
    expect(imported.providerData?.map((p) => `${p.providerId}:${p.uid}`)).toEqual([
      'google.com:g-1',
      'microsoft.com:m-1',
    ]);
  });

  it('leaves out what is missing', () => {
    const bare = toUserImport({
      ...GOOGLE_ONLY,
      identities: [],
      createdAt: 'not a time',
      photoUrl: undefined as never,
    });
    expect(bare).not.toHaveProperty('providerData');
    expect(bare).not.toHaveProperty('metadata');
    expect(bare).not.toHaveProperty('photoURL');
  });
});

describe('checkImported', () => {
  it('compares the email, identities and password', () => {
    const good = user({
      uid: 'legacy-1',
      email: 'alex.rivers@example.com',
      providers: [
        { providerId: 'google.com', uid: 'g-1' },
        { providerId: 'microsoft.com', uid: 'm-1' },
        { providerId: 'password', uid: 'alex.rivers@example.com' },
      ],
    });
    expect(checkImported(WITH_PASSWORD, good)).toEqual([]);
    expect(checkImported(WITH_PASSWORD, null)).toEqual(["legacy-1 isn't in v2 after the import."]);
    expect(checkImported(WITH_PASSWORD, { ...good, email: 'x@example.com', providers: [] })).toEqual([
      'the email differs',
      'the google.com identity is missing',
      'the microsoft.com identity is missing',
      'the password is missing',
    ]);
  });
});
