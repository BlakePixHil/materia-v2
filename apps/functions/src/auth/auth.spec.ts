import { Timestamp } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';

import {
  checkSignUp,
  hasPendingInvite,
  openSignupFor,
  SIGNUP_CLOSED_MESSAGE,
  stampSignIn,
  type BlockingDeps,
} from './blocking';
import {
  generateRecoveryCodesDefinition,
  hashCode,
  matchesCode,
  MAX_ATTEMPTS,
  newRecoveryCode,
  normaliseCode,
  RECOVERY_CODE_COUNT,
  RECOVERY_SCRYPT,
  useRecoveryCodeDefinition,
} from './recovery';
import { requireRecentLogin, runUserCallable, type UserCallableDeps } from '../core/user-callable';

const NOW = new Date('2026-10-04T00:00:00.000Z');
const nowSeconds = NOW.getTime() / 1000;

describe('requireRecentLogin', () => {
  it('accepts a sign-in within the window and rejects older or missing ones', () => {
    expect(() => requireRecentLogin({ auth_time: nowSeconds - 60 }, NOW.getTime())).not.toThrow();
    expect(() => requireRecentLogin({ auth_time: nowSeconds - 6 * 60 }, NOW.getTime())).toThrow(
      expect.objectContaining({ code: 'REAUTH_REQUIRED' }),
    );
    expect(() => requireRecentLogin(null, NOW.getTime())).toThrow(expect.objectContaining({ code: 'REAUTH_REQUIRED' }));
    expect(() => requireRecentLogin({ auth_time: nowSeconds - 9 * 60 }, NOW.getTime(), 10)).not.toThrow();
  });
});

describe('runUserCallable', () => {
  const deps = (): UserCallableDeps => ({
    db: () => ({}) as never,
    auth: () => ({}) as never,
    clock: { now: () => NOW },
    sink: () => undefined,
  });
  const def = {
    name: 'test-fn',
    input: z.object({ n: z.number() }),
    handler: ({ input, uid }: { input: { n: number }; uid: string | null }) => ({ n: input.n, uid }),
  };

  it('requires sign-in by default and passes the uid', async () => {
    await expect(runUserCallable(def, { data: { n: 1 } }, deps())).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(await runUserCallable(def, { data: { n: 1 }, auth: { uid: 'u1', token: {} } }, deps())).toEqual({
      n: 1,
      uid: 'u1',
    });
  });

  it('allows anonymous calls when auth is optional, and validates input', async () => {
    expect(await runUserCallable({ ...def, auth: 'optional' }, { data: { n: 2 } }, deps())).toEqual({
      n: 2,
      uid: null,
    });
    const error = await runUserCallable({ ...def, auth: 'optional' }, { data: { n: 'x' } }, deps()).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(HttpsError);
    expect((error as HttpsError).details).toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('enforces a recent login when asked', async () => {
    const recent = { ...def, recentLoginMinutes: 5 };
    await expect(
      runUserCallable(recent, { data: { n: 1 }, auth: { uid: 'u1', token: { auth_time: nowSeconds - 3600 } } }, deps()),
    ).rejects.toMatchObject({
      details: { code: 'REAUTH_REQUIRED' },
    });
    expect(
      await runUserCallable(recent, { data: { n: 1 }, auth: { uid: 'u1', token: { auth_time: nowSeconds } } }, deps()),
    ).toEqual({ n: 1, uid: 'u1' });
  });

  it('hides unexpected errors as INTERNAL', async () => {
    const crash = { ...def, handler: () => Promise.reject(new Error('details for Margaret Whitfield')) };
    const error = (await runUserCallable(crash, { data: { n: 1 }, auth: { uid: 'u1', token: {} } }, deps()).catch(
      (e: unknown) => e,
    )) as HttpsError;
    expect(error.code).toBe('internal');
    expect(JSON.stringify(error)).not.toContain('Whitfield');
  });
});

/** Fake Firestore for the invite lookup and the session stamp. */
function blockingDeps(invites: { email: string; status: string; expiresAt?: Timestamp }[], open = false) {
  const writes: { path: string; data: Record<string, unknown> }[] = [];
  const db = {
    collectionGroup: () => {
      const filters: [string, unknown][] = [];
      const query = {
        where: (field: string, _op: string, value: unknown) => {
          filters.push([field, value]);
          return query;
        },
        get: async () => ({
          docs: invites
            .filter((invite) => filters.every(([field, value]) => (invite as Record<string, unknown>)[field] === value))
            .map((invite) => ({ get: (field: string) => (invite as Record<string, unknown>)[field] })),
        }),
      };
      return query;
    },
    doc: (path: string) => ({ set: async (data: Record<string, unknown>) => void writes.push({ path, data }) }),
  };
  const deps: BlockingDeps = { db: () => db as never, openSignup: () => open, now: () => NOW, sink: () => undefined };
  return { deps, writes };
}

describe('blocking functions', () => {
  const future = Timestamp.fromMillis(NOW.getTime() + 86_400_000);
  const past = Timestamp.fromMillis(NOW.getTime() - 1);

  it('opens sign-up only in the listed projects', () => {
    expect(openSignupFor('materia-v2-dev')).toBe(true);
    expect(openSignupFor('materia-v2-prod')).toBe(false);
    expect(openSignupFor('demo-materia')).toBe(false);
    expect(openSignupFor(undefined)).toBe(false);
  });

  it('finds pending, unexpired invites by lower-cased email', async () => {
    const { deps } = blockingDeps([
      { email: 'alex@example.test', status: 'pending', expiresAt: future },
      { email: 'old@example.test', status: 'pending', expiresAt: past },
      { email: 'used@example.test', status: 'accepted', expiresAt: future },
      { email: 'noexpiry@example.test', status: 'pending' },
    ]);
    const db = deps.db();
    expect(await hasPendingInvite(db, 'Alex@Example.test', NOW)).toBe(true);
    expect(await hasPendingInvite(db, 'old@example.test', NOW)).toBe(false);
    expect(await hasPendingInvite(db, 'used@example.test', NOW)).toBe(false);
    expect(await hasPendingInvite(db, 'noexpiry@example.test', NOW)).toBe(true);
  });

  it('blocks sign-up without an invite, unless sign-up is open', async () => {
    const { deps } = blockingDeps([{ email: 'alex@example.test', status: 'pending', expiresAt: future }]);
    await expect(
      checkSignUp({ eventId: 'e1', data: { uid: 'u1', email: 'stranger@example.test' } as never }, deps),
    ).rejects.toMatchObject({
      code: 'permission-denied',
      message: SIGNUP_CLOSED_MESSAGE,
    });
    await expect(checkSignUp({ eventId: 'e2', data: { uid: 'u2' } as never }, deps)).rejects.toBeInstanceOf(HttpsError);
    await expect(
      checkSignUp({ eventId: 'e3', data: { uid: 'u3', email: 'alex@example.test' } as never }, deps),
    ).resolves.toBeUndefined();
    const open = blockingDeps([], true);
    await expect(
      checkSignUp({ eventId: 'e4', data: { uid: 'u4', email: 'anyone@example.test' } as never }, open.deps),
    ).resolves.toBeUndefined();
  });

  it('stamps the sign-in in the private session document', async () => {
    const { deps, writes } = blockingDeps([]);
    await stampSignIn(
      { eventId: 'e1', data: { uid: 'u1' } as never, additionalUserInfo: { providerId: 'password' } as never },
      deps,
    );
    await stampSignIn({ eventId: 'e2', data: { uid: 'u2' } as never }, deps);
    await stampSignIn({ eventId: 'e3' }, deps);
    expect(writes.map((w) => [w.path, w.data['lastSignInProvider']])).toEqual([
      ['users/u1/private/session', 'password'],
      ['users/u2/private/session', 'unknown'],
    ]);
  });
});

describe('recovery codes', () => {
  // Production cost (N=16384) is slow under coverage on CI; the stored N keeps verification honest.
  const productionN = RECOVERY_SCRYPT.N;
  beforeAll(() => (RECOVERY_SCRYPT.N = 1024));
  afterAll(() => (RECOVERY_SCRYPT.N = productionN));

  it('generates readable codes without ambiguous characters', () => {
    const code = newRecoveryCode();
    expect(code).toMatch(/^[A-HJ-KM-NP-Z2-9]{5}-[A-HJ-KM-NP-Z2-9]{5}$/);
    expect(newRecoveryCode(Buffer.alloc(10, 0))).toBe('AAAAA-AAAAA');
    expect(normaliseCode(' abcde-fghjk ')).toBe('ABCDEFGHJK');
  });

  it('hashes with a salt and matches ignoring case and dashes, at the cost it was stored with', async () => {
    const stored = await hashCode('ABCDE-FGHJK');
    expect(stored.N).toBe(1024);
    const legacy = await hashCode('ABCDE-FGHJK', undefined, 16384);
    expect(await matchesCode('ABCDE-FGHJK', { salt: legacy.salt, hash: legacy.hash })).toBe(true);
    expect(stored.hash).not.toContain('ABCDE');
    expect(await matchesCode('abcdefghjk', stored)).toBe(true);
    expect(await matchesCode('ABCDE-FGHJM', stored)).toBe(false);
    expect((await hashCode('ABCDE-FGHJK')).hash).not.toBe(stored.hash);
  });

  /** In-memory recovery doc with transaction support. */
  function recoveryWorld() {
    const docs = new Map<string, Record<string, unknown>>();
    const snap = (path: string) => ({ exists: docs.has(path), get: (field: string) => docs.get(path)?.[field] });
    const ref = (path: string) => ({
      path,
      get: async () => snap(path),
      set: async (data: Record<string, unknown>) => void docs.set(path, data),
      create: async (data: Record<string, unknown>) => void docs.set(path, data),
    });
    const db = {
      doc: ref,
      collection: (path: string) => ({ doc: () => ref(`${path}/auto`) }),
      runTransaction: async <T>(fn: (tx: unknown) => Promise<T>) =>
        fn({
          get: async (r: { path: string }) => snap(r.path),
          update: (r: { path: string }, data: Record<string, unknown>) =>
            void docs.set(r.path, { ...docs.get(r.path), ...data }),
        }),
    };
    const updateUser = vi.fn(async () => undefined);
    const users: Record<string, { uid: string; customClaims?: Record<string, unknown> }> = {
      'alex@example.test': { uid: 'u-alex', customClaims: { orgId: 'org-a', role: 'lawyer' } },
      'sam@example.test': { uid: 'u-sam' },
    };
    const auth = {
      getUserByEmail: async (email: string) => {
        const user = users[email];
        if (!user) throw new Error('auth/user-not-found');
        return user;
      },
      updateUser,
    };
    let now = NOW.getTime();
    const clock = { now: () => new Date(now) };
    const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    const ctx = (uid: string | null, input: unknown) =>
      ({ uid, token: null, input, requestId: 'req-1', log, clock, db, auth }) as never;
    return { docs, ctx, updateUser, advance: (ms: number) => (now += ms) };
  }

  it('stores only hashes, and each code works exactly once', async () => {
    const world = recoveryWorld();
    const { codes } = await generateRecoveryCodesDefinition.handler(world.ctx('u-alex', {}));
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
    const stored = JSON.stringify(world.docs.get('users/u-alex/private/recovery'));
    for (const code of codes) expect(stored).not.toContain(normaliseCode(code));

    const first = codes[0] as string;
    expect(
      await useRecoveryCodeDefinition.handler(
        world.ctx(null, { email: 'alex@example.test', code: first.toLowerCase() }),
      ),
    ).toEqual({ ok: true, remaining: 9 });
    expect(world.updateUser).toHaveBeenCalledWith('u-alex', { multiFactor: { enrolledFactors: null } });
    // The audit entry in the member's org.
    expect(world.docs.get('orgs/org-a/audit/auto')).toMatchObject({
      action: 'auth.mfa_recovered',
      actor: { uid: 'u-alex' },
    });
    await expect(
      useRecoveryCodeDefinition.handler(world.ctx(null, { email: 'alex@example.test', code: first })),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(
      await useRecoveryCodeDefinition.handler(world.ctx(null, { email: 'alex@example.test', code: codes[1] })),
    ).toEqual({ ok: true, remaining: 8 });
  });

  it('gives unknown emails and accounts without codes the same error', async () => {
    const world = recoveryWorld();
    await expect(
      useRecoveryCodeDefinition.handler(world.ctx(null, { email: 'nobody@example.test', code: 'AAAAA-AAAAA' })),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      useRecoveryCodeDefinition.handler(world.ctx(null, { email: 'sam@example.test', code: 'AAAAA-AAAAA' })),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('rate-limits failed attempts per account, resetting after the window', async () => {
    const world = recoveryWorld();
    const { codes } = await generateRecoveryCodesDefinition.handler(world.ctx('u-sam', {}));
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await expect(
        useRecoveryCodeDefinition.handler(world.ctx(null, { email: 'sam@example.test', code: 'WRONG-CODE2' })),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
    // Even the right code is refused while limited.
    await expect(
      useRecoveryCodeDefinition.handler(world.ctx(null, { email: 'sam@example.test', code: codes[0] })),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    world.advance(16 * 60_000);
    expect(
      await useRecoveryCodeDefinition.handler(world.ctx(null, { email: 'sam@example.test', code: codes[0] })),
    ).toEqual({ ok: true, remaining: 9 });
    // No org claim: no audit entry.
    expect(world.docs.has('orgs/undefined/audit/auto')).toBe(false);
  });
});
