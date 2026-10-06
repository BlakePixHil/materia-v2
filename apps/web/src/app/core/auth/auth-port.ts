import { InjectionToken } from '@angular/core';

import type { Role } from '@materia/domain';

/** The signed-in person as the app sees them (from the Firebase user and ID token). */
export interface AuthSession {
  uid: string;
  email: string | null;
  displayName: string | null;
  emailVerified: boolean;
  /** Linked sign-in methods: `password`, `google.com`. */
  providerIds: readonly string[];
  mfaEnrolled: boolean;
  /** Custom claims set by FND-17. */
  claims: { orgId?: string; role?: Role; orgName?: string };
  /** When this sign-in happened (ms), for re-authentication checks. */
  authTime: number;
  /** Whether this sign-in used a second factor (`firebase.sign_in_second_factor`, SEC-04). */
  secondFactor?: boolean;
}

/** Local persistence by default; session-only on a shared computer. */
export type AuthPersistence = 'local' | 'session';

/** How a person confirms it's them again. */
export type ReauthMethod = { kind: 'google' } | { kind: 'password'; password: string };

export type SignInOutcome = { kind: 'signedIn' } | { kind: 'mfaRequired' };

/** Why an auth flow failed, mapped from Firebase error codes (never shown raw). */
export type AuthErrorCode =
  | 'invalid-credentials'
  | 'too-many-requests'
  | 'email-in-use'
  | 'weak-password'
  | 'signup-closed'
  | 'popup-closed'
  | 'popup-blocked'
  | 'account-exists'
  | 'invalid-code'
  | 'expired-code'
  | 'requires-recent-login'
  | 'network'
  | 'unknown';

export class AuthFlowError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    /** For `account-exists`: the email and the method it already uses. */
    readonly detail: { email?: string; existingMethod?: string } = {},
  ) {
    super(code);
    this.name = 'AuthFlowError';
  }
}

/** What the person should know about each failure: plain and actionable. */
export const AUTH_ERROR_COPY: Record<AuthErrorCode, string> = {
  'invalid-credentials': 'That email and password don’t match. Check them and try again.',
  'too-many-requests': 'Too many attempts. Wait a few minutes, or reset your password.',
  'email-in-use': 'An account with this email already exists. Sign in instead.',
  'weak-password': 'Use at least 12 characters. A short phrase is easier to remember.',
  'signup-closed': 'Sign-up is by invitation only. Ask your practice admin for an invite link.',
  'popup-closed': 'The sign-in window closed before you finished. Try again.',
  'popup-blocked': 'Your browser blocked the sign-in window. Allow pop-ups for Materia and try again.',
  'account-exists': 'This email already has an account with a different sign-in method.',
  'invalid-code': 'That code isn’t right. Check it and try again.',
  'expired-code': 'This link has expired. Request a new one.',
  'requires-recent-login': 'For your security, sign in again to do this.',
  network: 'You seem to be offline. Check your connection and try again.',
  unknown: 'Something went wrong. Try again.',
};

/** A TOTP secret being enrolled: show `uri` as a QR code and `secret` for manual entry. */
export interface TotpEnrolment {
  secret: string;
  uri: string;
}

/**
 * Everything the app needs from Identity Platform (FND-16). The Firebase implementation is loaded
 * lazily (it's large); tests use `FakeAuthPort`.
 */
export interface AuthPort {
  /** Calls back with the current session (null when signed out) now and on every change. */
  watch(callback: (session: AuthSession | null) => void): () => void;
  signInWithPassword(email: string, password: string, persistence: AuthPersistence): Promise<SignInOutcome>;
  signInWithGoogle(persistence: AuthPersistence): Promise<SignInOutcome>;
  /** Answers the MFA challenge from the last sign-in attempt. */
  completeMfa(code: string): Promise<void>;
  signUp(email: string, password: string, displayName: string): Promise<void>;
  sendVerificationEmail(): Promise<void>;
  /** Re-reads the user (after they verify their email in another tab). */
  reload(): Promise<void>;
  sendPasswordReset(email: string): Promise<void>;
  /** Checks a reset link and returns the account's email. */
  verifyResetCode(code: string): Promise<string>;
  confirmPasswordReset(code: string, password: string): Promise<void>;
  applyVerificationCode(code: string): Promise<void>;
  startTotpEnrolment(): Promise<TotpEnrolment>;
  finishTotpEnrolment(code: string): Promise<void>;
  /** A sign-in method waiting to be linked after the person signs in the existing way. */
  pendingLink(): { email: string; method: string } | null;
  reauthenticateWithPassword(password: string): Promise<void>;
  /**
   * Confirms it's still them before a sensitive action (CORE-17): Google again, or their password.
   * `mfaRequired` means answer the challenge with `completeMfa`.
   */
  reauthenticate(method: ReauthMethod): Promise<SignInOutcome>;
  /** Forces a token refresh so new custom claims apply. */
  refreshClaims(): Promise<void>;
  call<T>(name: string, data: unknown): Promise<T>;
  signOut(): Promise<void>;
}

export const AUTH_PORT = new InjectionToken<AuthPort>('AUTH_PORT', {
  providedIn: 'root',
  factory: () => lazyFirebaseAuthPort(),
});

/** Defers loading the Firebase SDK until the first call, keeping it out of the initial bundle. */
export function lazyFirebaseAuthPort(
  load = () => import('./firebase-auth-port').then((m) => m.createFirebaseAuthPort()),
): AuthPort {
  let port: Promise<AuthPort> | undefined;
  const get = () => (port ??= load());
  const proxy = {} as AuthPort;
  const methods: (keyof AuthPort)[] = [
    'signInWithPassword',
    'signInWithGoogle',
    'completeMfa',
    'signUp',
    'sendVerificationEmail',
    'reload',
    'sendPasswordReset',
    'verifyResetCode',
    'confirmPasswordReset',
    'applyVerificationCode',
    'startTotpEnrolment',
    'finishTotpEnrolment',
    'reauthenticateWithPassword',
    'reauthenticate',
    'refreshClaims',
    'call',
    'signOut',
  ];
  for (const method of methods) {
    (proxy as unknown as Record<string, unknown>)[method] = (...args: unknown[]) =>
      get().then((p) => (p[method] as (...a: unknown[]) => unknown)(...args));
  }
  let loaded: AuthPort | undefined;
  proxy.pendingLink = () => loaded?.pendingLink() ?? null;
  proxy.watch = (callback) => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    void get().then((p) => {
      loaded = p;
      if (!cancelled) stop = p.watch(callback);
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  };
  return proxy;
}
