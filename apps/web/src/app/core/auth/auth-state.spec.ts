import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, type UrlTree } from '@angular/router';

import { DataLifecycle } from '@materia/data-access';

import { AUTH_PORT, AuthFlowError, lazyFirebaseAuthPort, type AuthPort } from './auth-port';
import { AuthState, clearFirestoreCaches, SIGN_OUT_CLEANUP, statusOf } from './auth-state';
import { authErrorCode } from './firebase-auth-port';
import { authGuard, mfaGuard, orgGuard, roleGuard, signedOutGuard, STATUS_ROUTES, unverifiedGuard } from './guards';
import { FakeAuthPort, SlowAuthPort, testSession } from './testing';
import { PushDevices } from '../push/push-devices';

function setup(port = new FakeAuthPort(), cleanups: (() => void)[] = []) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: AUTH_PORT, useValue: port },
      { provide: SIGN_OUT_CLEANUP, useValue: cleanups },
    ],
  });
  return { auth: TestBed.inject(AuthState), port };
}

describe('statusOf', () => {
  it('walks loading → signedOut → needsVerification → needsMfa → needsOrg → ready', () => {
    expect(statusOf(undefined, false)).toBe('loading');
    expect(statusOf(null, false)).toBe('signedOut');
    expect(statusOf(testSession({ emailVerified: false }), false)).toBe('needsVerification');
    expect(statusOf(testSession({ emailVerified: false, providerIds: ['google.com'] }), false)).toBe('ready');
    expect(statusOf(testSession(), true)).toBe('needsMfa');
    expect(statusOf(testSession({ mfaEnrolled: true }), true)).toBe('ready');
    expect(statusOf(testSession({ claims: {} }), false)).toBe('needsOrg');
    expect(statusOf(testSession(), false)).toBe('ready');
  });
});

describe('AuthState', () => {
  it('draws a returning person from the cached session until Auth answers (MAT-177)', async () => {
    const port = new SlowAuthPort(testSession({ displayName: 'Jordan Price-Hale' }));
    port.cached = testSession();
    const { auth } = setup(port);
    expect(auth.cached).toBe(port.cached);
    expect(auth.status()).toBe('ready');
    expect(auth.user()?.displayName).toBe('Jordan Price');
    expect(auth.confirmed()).toBe(false);
    await auth.whenReady();
    let confirmed = false;
    void auth.whenConfirmed().then(() => (confirmed = true));
    await Promise.resolve();
    expect(confirmed).toBe(false);

    port.answer();
    await auth.whenConfirmed();
    expect(auth.confirmed()).toBe(true);
    expect(auth.user()?.displayName).toBe('Jordan Price-Hale');
  });

  it('is loading until the port reports, then follows session changes', async () => {
    const { auth, port } = setup();
    expect(auth.status()).toBe('loading');
    await auth.whenReady();
    expect(auth.status()).toBe('ready');
    expect(auth.user()).toEqual({
      uid: 'user-jordan',
      displayName: 'Jordan Price',
      email: 'lawyer@harbourvine.example',
      orgId: 'org-harbour-vine',
      orgName: 'Harbour & Vine Legal',
    });
    expect(auth.activeOrgId()).toBe('org-harbour-vine');
    port.emit(testSession({ displayName: null, claims: {} }));
    expect(auth.status()).toBe('needsOrg');
    expect(auth.user()?.displayName).toBe('lawyer@harbourvine.example');
    port.emit(null);
    expect(auth.status()).toBe('signedOut');
    expect(auth.user()).toBeNull();
    expect(auth.signedIn()).toBe(false);
    await auth.whenReady();
  });

  it('applies the org MFA requirement', async () => {
    const { auth } = setup();
    await auth.whenReady();
    auth.mfaRequired.set(true);
    expect(auth.status()).toBe('needsMfa');
  });

  it('knows whether the sign-in is recent', async () => {
    const { auth, port } = setup(new FakeAuthPort(testSession({ authTime: 1_000_000 })));
    await auth.whenReady();
    expect(auth.isRecentLogin(5, 1_000_000 + 4 * 60_000)).toBe(true);
    expect(auth.isRecentLogin(5, 1_000_000 + 6 * 60_000)).toBe(false);
    port.emit(null);
    expect(auth.isRecentLogin()).toBe(false);
  });

  it('counts a test session as signed in just now, however long ago it was made', async () => {
    // Spec files make their sessions as they load, and the unit tests run without isolation.
    const { auth } = setup(new FakeAuthPort(testSession()));
    await auth.whenReady();
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60 * 60_000);
    try {
      expect(auth.isRecentLogin()).toBe(true);
    } finally {
      now.mockRestore();
    }
  });

  it('delegates flows to the port', async () => {
    const { auth, port } = setup(new FakeAuthPort(null));
    await auth.whenReady();
    expect(await auth.signInWithPassword('a@example.test', 'password', 'session')).toEqual({ kind: 'signedIn' });
    expect(port.persistence).toBe('session');
    await expect(auth.signInWithPassword('a@example.test', 'nope')).rejects.toBeInstanceOf(AuthFlowError);
    expect(await auth.signInWithGoogle()).toEqual({ kind: 'signedIn' });
    port.mfaOnSignIn = true;
    expect(await auth.signInWithPassword('a@example.test', 'password')).toEqual({ kind: 'mfaRequired' });
    await auth.completeMfa('123456');
    expect(auth.session()?.mfaEnrolled).toBe(true);
    await auth.signUp('new@example.test', 'long-enough-pass', 'New Person');
    expect(auth.status()).toBe('needsVerification');
    await auth.sendVerificationEmail();
    await auth.reload();
    await auth.refreshClaims();
    expect(auth.api).toBe(port);
  });

  it('signs out after running every clean-up, even failing ones, and clears per-user storage', async () => {
    const calls: string[] = [];
    const { auth, port } = setup(new FakeAuthPort(), [
      () => void calls.push('a'),
      () => {
        throw new Error('broken');
      },
      () => void calls.push('c'),
    ]);
    await auth.whenReady();
    localStorage.setItem('materia.commands.recent', '[]');
    await auth.signOut();
    expect(calls).toEqual(['a', 'c']);
    expect(port.session).toBeNull();
    expect(localStorage.getItem('materia.commands.recent')).toBeNull();
  });
});

describe('SIGN_OUT_CLEANUP', () => {
  function cleanups(pushSignOut: () => Promise<void>) {
    const calls: string[] = [];
    TestBed.configureTestingModule({
      providers: [
        { provide: PushDevices, useValue: { signOut: () => (calls.push('push'), pushSignOut()) } },
        { provide: DataLifecycle, useValue: { signOut: async () => void calls.push('data') } },
      ],
    });
    return { calls, run: TestBed.inject(SIGN_OUT_CLEANUP) };
  }

  afterEach(() => vi.unstubAllGlobals());

  it('deletes this browser’s push device before the data layer closes Firestore (MOB-04)', async () => {
    vi.stubGlobal('PushManager', Object);
    const { calls, run } = cleanups(async () => undefined);
    for (const cleanup of run) await cleanup();
    expect(calls).toEqual(['push', 'data']);
  });

  it('carries on when the push device can’t be deleted', async () => {
    vi.stubGlobal('PushManager', Object);
    const { calls, run } = cleanups(() => Promise.reject(new Error('offline')));
    for (const cleanup of run) await cleanup();
    expect(calls).toEqual(['push', 'data']);
  });

  it('skips push in a browser that can’t get push notifications', async () => {
    const { calls, run } = cleanups(async () => undefined);
    for (const cleanup of run) await cleanup();
    expect(calls).toEqual(['data']);
  });
});

describe('clearFirestoreCaches', () => {
  it('deletes only Firestore IndexedDB databases', async () => {
    const deleted: string[] = [];
    const idb = {
      databases: async () => [
        { name: 'firestore/[DEFAULT]/demo-materia/main' },
        { name: 'firebaseLocalStorageDb' },
        { name: 'firestore/[DEFAULT]/demo-materia/x' },
        {},
      ],
      deleteDatabase: (name: string) => {
        deleted.push(name);
        const request = {} as IDBOpenDBRequest;
        queueMicrotask(() => request.onsuccess?.({} as Event));
        return request;
      },
    } as unknown as IDBFactory;
    expect(await clearFirestoreCaches(idb)).toEqual([
      'firestore/[DEFAULT]/demo-materia/main',
      'firestore/[DEFAULT]/demo-materia/x',
    ]);
    expect(deleted).toHaveLength(2);
    expect(await clearFirestoreCaches({} as IDBFactory)).toEqual([]);
    expect(await clearFirestoreCaches(undefined)).toEqual([]);
  });
});

describe('guards', () => {
  async function run(
    guard: (...args: never[]) => unknown,
    session: ReturnType<typeof testSession> | null,
    mfaRequired = false,
  ) {
    TestBed.resetTestingModule();
    const { auth } = setup(new FakeAuthPort(session));
    auth.mfaRequired.set(mfaRequired);
    const result = (await TestBed.runInInjectionContext(() => guard())) as true | UrlTree;
    return result === true ? true : TestBed.inject(Router).serializeUrl(result);
  }

  it('authGuard: signed in and verified', async () => {
    expect(await run(authGuard, testSession())).toBe(true);
    expect(await run(authGuard, testSession({ claims: {} }))).toBe(true);
    expect(await run(authGuard, null)).toBe(STATUS_ROUTES.signedOut);
    expect(await run(authGuard, testSession({ emailVerified: false }))).toBe(STATUS_ROUTES.needsVerification);
  });

  it('mfaGuard and orgGuard add their steps', async () => {
    expect(await run(mfaGuard, testSession(), true)).toBe(STATUS_ROUTES.needsMfa);
    expect(await run(mfaGuard, testSession({ claims: {} }))).toBe(true);
    expect(await run(orgGuard, testSession({ claims: {} }))).toBe(STATUS_ROUTES.needsOrg);
    expect(await run(orgGuard, testSession())).toBe(true);
  });

  it('roleGuard sends other roles to no-access', async () => {
    expect(await run(roleGuard(['owner', 'admin']), testSession())).toBe('/no-access');
    expect(await run(roleGuard(['lawyer']), testSession())).toBe(true);
    expect(await run(roleGuard(['owner']), null)).toBe('/no-access');
  });

  it('signedOutGuard and unverifiedGuard keep people on the right page', async () => {
    expect(await run(signedOutGuard, null)).toBe(true);
    expect(await run(signedOutGuard, testSession())).toBe('/today');
    expect(await run(signedOutGuard, testSession({ claims: {} }))).toBe('/onboarding');
    expect(await run(unverifiedGuard, testSession({ emailVerified: false }))).toBe(true);
    expect(await run(unverifiedGuard, null)).toBe(STATUS_ROUTES.signedOut);
    expect(await run(unverifiedGuard, testSession())).toBe('/today');
  });
});

describe('lazyFirebaseAuthPort', () => {
  it('loads the implementation on first use and forwards calls and watchers', async () => {
    const fake = new FakeAuthPort();
    const load = vi.fn(async () => fake as AuthPort);
    const port = lazyFirebaseAuthPort(load);
    expect(load).not.toHaveBeenCalled();
    expect(port.pendingLink()).toBeNull();
    const seen: unknown[] = [];
    const stop = port.watch((s) => seen.push(s?.uid ?? null));
    await new Promise((resolve) => setTimeout(resolve));
    expect(seen).toEqual(['user-jordan']);
    fake.pending = { email: 'a@example.test', method: 'Google' };
    expect(port.pendingLink()).toEqual({ email: 'a@example.test', method: 'Google' });
    await port.signOut();
    expect(seen).toEqual(['user-jordan', null]);
    stop();
    expect(load).toHaveBeenCalledTimes(1);
    // A watcher cancelled before the SDK loads never subscribes.
    const late = lazyFirebaseAuthPort(async () => fake);
    const cancelled: unknown[] = [];
    late.watch((s) => cancelled.push(s))();
    await new Promise((resolve) => setTimeout(resolve));
    expect(cancelled).toEqual([]);
  });
});

describe('authErrorCode', () => {
  it('maps Firebase codes, and the blocking-function refusal', () => {
    const e = (code: string, message = '') => ({ code, message });
    expect(authErrorCode(e('auth/invalid-credential'))).toBe('invalid-credentials');
    expect(authErrorCode(e('auth/too-many-requests'))).toBe('too-many-requests');
    expect(authErrorCode(e('auth/email-already-in-use'))).toBe('email-in-use');
    expect(authErrorCode(e('auth/password-does-not-meet-requirements'))).toBe('weak-password');
    expect(authErrorCode(e('auth/popup-closed-by-user'))).toBe('popup-closed');
    expect(authErrorCode(e('auth/popup-blocked'))).toBe('popup-blocked');
    expect(authErrorCode(e('auth/account-exists-with-different-credential'))).toBe('account-exists');
    expect(authErrorCode(e('auth/invalid-verification-code'))).toBe('invalid-code');
    expect(authErrorCode(e('auth/expired-action-code'))).toBe('expired-code');
    expect(authErrorCode(e('auth/requires-recent-login'))).toBe('requires-recent-login');
    expect(authErrorCode(e('auth/network-request-failed'))).toBe('network');
    expect(
      authErrorCode(
        e('auth/internal-error', 'BLOCKING_FUNCTION_ERROR_RESPONSE : ((SIGNUP_CLOSED: Sign-up is by invitation only))'),
      ),
    ).toBe('signup-closed');
    expect(authErrorCode(e('auth/something-else'))).toBe('unknown');
    expect(authErrorCode(null)).toBe('unknown');
  });
});
