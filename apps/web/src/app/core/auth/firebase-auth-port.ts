import { FirebaseError } from 'firebase/app';
import {
  applyActionCode,
  browserLocalPersistence,
  browserPopupRedirectResolver,
  browserSessionPersistence,
  confirmPasswordReset,
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getMultiFactorResolver,
  getRedirectResult,
  GoogleAuthProvider,
  indexedDBLocalPersistence,
  initializeAuth,
  linkWithCredential,
  multiFactor,
  onIdTokenChanged,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  EmailAuthProvider,
  sendEmailVerification,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  TotpMultiFactorGenerator,
  updateProfile,
  verifyPasswordResetCode,
  type Auth,
  type AuthCredential,
  type MultiFactorError,
  type MultiFactorResolver,
  type PopupRedirectResolver,
  type TotpSecret,
  type User,
  type UserCredential,
} from 'firebase/auth';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';

import type { Role } from '@materia/domain';

import {
  AuthFlowError,
  type AuthErrorCode,
  type AuthPersistence,
  type AuthPort,
  type AuthSession,
  type SignInOutcome,
} from './auth-port';
import { readCachedSession, saveCachedSession } from './session-cache';
import { environment } from '../../../environments/environment';
import { firebaseApp } from '../firebase-app';

const REGION = 'australia-southeast1';
const ISSUER = 'Materia';

/** Maps Firebase errors to the app's codes. Blocking-function refusals carry SIGNUP_CLOSED. */
export function authErrorCode(error: unknown): AuthErrorCode {
  const code = error instanceof FirebaseError ? error.code : (error as { code?: string } | null)?.code;
  const message = (error as { message?: string } | null)?.message ?? '';
  if (message.includes('SIGNUP_CLOSED')) return 'signup-closed';
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
    case 'auth/invalid-email':
    case 'auth/invalid-login-credentials':
      return 'invalid-credentials';
    case 'auth/too-many-requests':
      return 'too-many-requests';
    case 'auth/email-already-in-use':
      return 'email-in-use';
    case 'auth/weak-password':
    case 'auth/password-does-not-meet-requirements':
      return 'weak-password';
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return 'popup-closed';
    case 'auth/popup-blocked':
    case 'auth/operation-not-supported-in-this-environment':
      return 'popup-blocked';
    case 'auth/account-exists-with-different-credential':
      return 'account-exists';
    case 'auth/invalid-verification-code':
    case 'auth/invalid-action-code':
    case 'auth/totp-challenge-timeout':
      return 'invalid-code';
    case 'auth/expired-action-code':
      return 'expired-code';
    case 'auth/requires-recent-login':
      return 'requires-recent-login';
    case 'auth/network-request-failed':
      return 'network';
    default:
      return 'unknown';
  }
}

const METHOD_NAMES: Record<string, string> = {
  password: 'email and password',
  'google.com': 'Google',
  'microsoft.com': 'Microsoft',
};

async function toSession(user: User): Promise<AuthSession> {
  const token = await user.getIdTokenResult();
  const claims = token.claims as { orgId?: unknown; role?: unknown; orgName?: unknown };
  return {
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
    emailVerified: user.emailVerified,
    providerIds: user.providerData.map((p) => p.providerId),
    mfaEnrolled: multiFactor(user).enrolledFactors.length > 0,
    claims: {
      ...(typeof claims.orgId === 'string' ? { orgId: claims.orgId } : {}),
      ...(typeof claims.role === 'string' ? { role: claims.role as Role } : {}),
      ...(typeof claims.orgName === 'string' ? { orgName: claims.orgName } : {}),
    },
    authTime: Date.parse(token.authTime),
    secondFactor: !!token.signInSecondFactor,
  };
}

/** The members of Firebase's pop-up helper that Auth calls (its published types mark them internal). */
export interface PopupHelper {
  readonly _shouldInitProactively: boolean;
  _initialize(auth: Auth): Promise<unknown>;
}

/**
 * Firebase's helper for the Google sign-in pop-up and redirect (Google's gapi script and a frame
 * from the auth domain), loaded on phones and in Safari when a screen that offers Google shows
 * (`prepare`) instead of as Auth starts. There, Firebase loads it as Auth starts so the pop-up can
 * open as soon as it's tapped, and restores the session only once the frame is ready: every
 * start-up of a signed-in phone waited for two more sites (MOB-02b, ADR-056). Elsewhere it loads on
 * first use, as before. Auth makes one instance of the class, kept as `latest`.
 */
export function onDemandPopups(firebasePopups: new () => PopupHelper) {
  return class OnDemandPopups extends firebasePopups {
    static latest: OnDemandPopups | undefined;

    constructor() {
      super();
      OnDemandPopups.latest = this;
    }

    override get _shouldInitProactively(): boolean {
      return false;
    }

    /** Loads the helper where Firebase would have loaded it as Auth started. */
    prepare(auth: Auth): Promise<void> {
      if (!Reflect.get(firebasePopups.prototype, '_shouldInitProactively', this)) return Promise.resolve();
      // A failed load is retried on the next prepare or by the pop-up itself.
      return Promise.resolve()
        .then(() => this._initialize(auth))
        .then(
          () => undefined,
          () => undefined,
        );
    }
  };
}

/** The Identity Platform implementation of AuthPort (FND-16), connected to the emulators locally. */
export function createFirebaseAuthPort(): AuthPort {
  const app = firebaseApp();
  // getAuth's persistence and pop-up helper, the helper loaded on demand. Firebase's Node build
  // (unit tests) has no helper, and getAuth there starts Auth without one.
  const popups =
    typeof browserPopupRedirectResolver === 'function'
      ? onDemandPopups(browserPopupRedirectResolver as unknown as new () => PopupHelper)
      : undefined;
  const auth: Auth = initializeAuth(app, {
    persistence: [indexedDBLocalPersistence, browserLocalPersistence, browserSessionPersistence],
    ...(popups && { popupRedirectResolver: popups as unknown as PopupRedirectResolver }),
  });
  const functions = getFunctions(app, REGION);
  if (environment.useEmulators) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  }

  let resolver: MultiFactorResolver | null = null;
  let pending: { credential: AuthCredential; email: string; method: string } | null = null;
  let totpSecret: TotpSecret | null = null;
  const listeners = new Set<(session: AuthSession | null) => void>();
  let current: AuthSession | null | undefined;

  const publish = async (user: User | null) => {
    current = user ? await toSession(user) : null;
    // Before the listeners: a start-up drawn from the old one reloads on this one (MAT-177).
    saveCachedSession(current);
    for (const listener of listeners) listener(current);
  };
  const preparePopups = () => popups?.latest?.prepare(auth) ?? Promise.resolve();
  onIdTokenChanged(auth, (user) => {
    void publish(user);
    // Signed out: the sign-in screen, which offers Google, is next.
    if (!user) void preparePopups();
  });

  const failure = (error: unknown): never => {
    const code = authErrorCode(error);
    if (code === 'account-exists') {
      const credential = GoogleAuthProvider.credentialFromError(error as FirebaseError);
      const email = ((error as FirebaseError).customData?.['email'] as string | undefined) ?? '';
      if (credential)
        pending = { credential, email, method: METHOD_NAMES[credential.providerId] ?? credential.providerId };
      throw new AuthFlowError(code, { email, existingMethod: 'email and password' });
    }
    throw new AuthFlowError(code);
  };

  /** Links a pending method after a successful sign-in, then reports the outcome. */
  const signedIn = async (credential: UserCredential): Promise<SignInOutcome> => {
    if (pending && credential.user.email?.toLowerCase() === pending.email.toLowerCase()) {
      await linkWithCredential(credential.user, pending.credential).catch(() => undefined);
      pending = null;
      await publish(auth.currentUser);
    }
    return { kind: 'signedIn' };
  };

  const attempt = async (run: () => Promise<UserCredential>): Promise<SignInOutcome> => {
    try {
      return await signedIn(await run());
    } catch (error) {
      if ((error as FirebaseError).code === 'auth/multi-factor-auth-required') {
        resolver = getMultiFactorResolver(auth, error as MultiFactorError);
        return { kind: 'mfaRequired' };
      }
      return failure(error);
    }
  };

  // "Stay signed in" uses IndexedDB, getAuth's default. Moving the user to localStorage instead made
  // every newly opened tab migrate it back and delete the localStorage copy, which signed the
  // first tab out.
  const persist = (persistence: AuthPersistence) =>
    setPersistence(auth, persistence === 'session' ? browserSessionPersistence : indexedDBLocalPersistence);

  // Finishes a redirect sign-in (the fallback when pop-ups are blocked).
  void getRedirectResult(auth)
    .then((result) => (result ? signedIn(result) : undefined))
    .catch(() => undefined);

  const run = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof AuthFlowError) throw error;
      return failure(error);
    }
  };

  const requireUser = (): User => {
    if (!auth.currentUser) throw new AuthFlowError('requires-recent-login');
    return auth.currentUser;
  };

  return {
    cachedSession: readCachedSession,
    watch(callback) {
      listeners.add(callback);
      if (current !== undefined) callback(current);
      return () => listeners.delete(callback);
    },
    async signInWithPassword(email, password, persistence) {
      await persist(persistence);
      return attempt(() => signInWithEmailAndPassword(auth, email.trim(), password));
    },
    async signInWithGoogle(persistence) {
      await persist(persistence);
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      try {
        return await attempt(() => signInWithPopup(auth, provider));
      } catch (error) {
        // Mobile Safari and in-app browsers block pop-ups: fall back to a full-page redirect.
        if ((error as AuthFlowError).code === 'popup-blocked') {
          await signInWithRedirect(auth, provider);
          return { kind: 'signedIn' };
        }
        throw error;
      }
    },
    completeMfa: (code) =>
      run(async () => {
        const hint = resolver?.hints.find((h) => h.factorId === TotpMultiFactorGenerator.FACTOR_ID);
        if (!resolver || !hint) throw new AuthFlowError('expired-code');
        await signedIn(
          await resolver.resolveSignIn(TotpMultiFactorGenerator.assertionForSignIn(hint.uid, code.replace(/\s/g, ''))),
        );
        resolver = null;
      }),
    signUp: (email, password, displayName) =>
      run(async () => {
        const credential = await createUserWithEmailAndPassword(auth, email.trim(), password);
        await updateProfile(credential.user, { displayName: displayName.trim() });
        await sendEmailVerification(credential.user);
        await credential.user.getIdToken(true);
        await publish(auth.currentUser);
      }),
    sendVerificationEmail: () => run(() => sendEmailVerification(requireUser())),
    reload: () =>
      run(async () => {
        const user = requireUser();
        await user.reload();
        await user.getIdToken(true);
        await publish(auth.currentUser);
      }),
    sendPasswordReset: (email) =>
      run(async () => {
        // Never reveal whether the account exists: unknown emails look like success.
        await sendPasswordResetEmail(auth, email.trim()).catch((error: unknown) => {
          if (authErrorCode(error) !== 'invalid-credentials') throw error;
        });
      }),
    verifyResetCode: (code) => run(() => verifyPasswordResetCode(auth, code)),
    confirmPasswordReset: (code, password) => run(() => confirmPasswordReset(auth, code, password)),
    applyVerificationCode: (code) =>
      run(async () => {
        await applyActionCode(auth, code);
        if (auth.currentUser) {
          await auth.currentUser.reload();
          await auth.currentUser.getIdToken(true);
          await publish(auth.currentUser);
        }
      }),
    startTotpEnrolment: () =>
      run(async () => {
        const user = requireUser();
        totpSecret = await TotpMultiFactorGenerator.generateSecret(await multiFactor(user).getSession());
        return { secret: totpSecret.secretKey, uri: totpSecret.generateQrCodeUrl(user.email ?? user.uid, ISSUER) };
      }),
    finishTotpEnrolment: (code) =>
      run(async () => {
        if (!totpSecret) throw new AuthFlowError('expired-code');
        await multiFactor(requireUser()).enroll(
          TotpMultiFactorGenerator.assertionForEnrollment(totpSecret, code.replace(/\s/g, '')),
          'Authenticator app',
        );
        totpSecret = null;
        await publish(auth.currentUser);
      }),
    pendingLink: () => (pending ? { email: pending.email, method: pending.method } : null),
    preparePopups,
    reauthenticateWithPassword: (password) =>
      run(async () => {
        const user = requireUser();
        await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email ?? '', password));
        await user.getIdToken(true);
        await publish(auth.currentUser);
      }),
    async reauthenticate(method) {
      const user = requireUser();
      const outcome = await attempt(() =>
        method.kind === 'google'
          ? reauthenticateWithPopup(user, new GoogleAuthProvider())
          : reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email ?? '', method.password)),
      );
      if (outcome.kind === 'signedIn') {
        await user.getIdToken(true);
        await publish(auth.currentUser);
      }
      return outcome;
    },
    refreshClaims: () =>
      run(async () => {
        await requireUser().getIdToken(true);
        await publish(auth.currentUser);
      }),
    async call<T>(name: string, data: unknown): Promise<T> {
      return (await httpsCallable<unknown, T>(functions, name)(data)).data;
    },
    signOut: () =>
      run(async () => {
        resolver = null;
        pending = null;
        totpSecret = null;
        await signOut(auth);
      }),
  };
}
