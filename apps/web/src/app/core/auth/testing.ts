import type { Provider } from '@angular/core';

import {
  AUTH_PORT,
  AuthFlowError,
  type AuthPersistence,
  type AuthPort,
  type AuthSession,
  type ReauthMethod,
  type SignInOutcome,
  type TotpEnrolment,
} from './auth-port';

/** A fictional, fully set-up session (verified, org member). */
export function testSession(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    uid: 'user-jordan',
    email: 'lawyer@harbourvine.example',
    displayName: 'Jordan Price',
    emailVerified: true,
    providerIds: ['password'],
    mfaEnrolled: false,
    claims: { orgId: 'org-harbour-vine', role: 'lawyer', orgName: 'Harbour & Vine Legal' },
    authTime: Date.now(),
    ...overrides,
  };
}

/**
 * An in-memory AuthPort for unit tests: `password` is the only valid password, `123456` the only
 * valid MFA code. Set `mfaOnSignIn` to require the challenge.
 */
export class FakeAuthPort implements AuthPort {
  private listeners = new Set<(session: AuthSession | null) => void>();
  readonly calls: { name: string; data: unknown }[] = [];
  mfaOnSignIn = false;
  persistence: AuthPersistence | null = null;
  pending: { email: string; method: string } | null = null;
  callResults: Record<string, unknown> = {};
  nextError: AuthFlowError | null = null;

  constructor(public session: AuthSession | null = testSession()) {}

  emit(session: AuthSession | null): void {
    this.session = session;
    for (const listener of this.listeners) listener(session);
  }

  private fail(): void {
    const error = this.nextError;
    this.nextError = null;
    if (error) throw error;
  }

  watch(callback: (session: AuthSession | null) => void): () => void {
    this.listeners.add(callback);
    queueMicrotask(() => callback(this.session));
    return () => this.listeners.delete(callback);
  }

  async signInWithPassword(email: string, password: string, persistence: AuthPersistence): Promise<SignInOutcome> {
    this.fail();
    this.persistence = persistence;
    if (password !== 'password') throw new AuthFlowError('invalid-credentials');
    if (this.mfaOnSignIn) return { kind: 'mfaRequired' };
    this.emit(testSession({ email, mfaEnrolled: false }));
    return { kind: 'signedIn' };
  }

  async signInWithGoogle(persistence: AuthPersistence): Promise<SignInOutcome> {
    this.fail();
    this.persistence = persistence;
    this.emit(testSession({ providerIds: ['google.com'] }));
    return { kind: 'signedIn' };
  }

  async completeMfa(code: string): Promise<void> {
    this.fail();
    if (code !== '123456') throw new AuthFlowError('invalid-code');
    this.emit(testSession({ mfaEnrolled: true, secondFactor: true }));
  }

  async signUp(email: string, _password: string, displayName: string): Promise<void> {
    this.fail();
    this.emit(testSession({ email, displayName, emailVerified: false, claims: {} }));
  }

  async sendVerificationEmail(): Promise<void> {
    this.fail();
  }

  async reload(): Promise<void> {
    this.fail();
    if (this.session) this.emit({ ...this.session });
  }

  async sendPasswordReset(): Promise<void> {
    this.fail();
  }

  async verifyResetCode(code: string): Promise<string> {
    this.fail();
    if (code !== 'reset-code') throw new AuthFlowError('expired-code');
    return 'lawyer@harbourvine.example';
  }

  async confirmPasswordReset(): Promise<void> {
    this.fail();
  }

  async applyVerificationCode(code: string): Promise<void> {
    this.fail();
    if (code !== 'verify-code') throw new AuthFlowError('invalid-code');
    if (this.session) this.emit({ ...this.session, emailVerified: true });
  }

  async startTotpEnrolment(): Promise<TotpEnrolment> {
    this.fail();
    return {
      secret: 'JBSWY3DPEHPK3PXP',
      uri: 'otpauth://totp/Materia:lawyer@harbourvine.example?secret=JBSWY3DPEHPK3PXP&issuer=Materia',
    };
  }

  async finishTotpEnrolment(code: string): Promise<void> {
    this.fail();
    if (code !== '123456') throw new AuthFlowError('invalid-code');
    if (this.session) this.emit({ ...this.session, mfaEnrolled: true });
  }

  pendingLink(): { email: string; method: string } | null {
    return this.pending;
  }

  async reauthenticateWithPassword(password: string): Promise<void> {
    this.fail();
    if (password !== 'password') throw new AuthFlowError('invalid-credentials');
    if (this.session) this.emit({ ...this.session, authTime: Date.now() });
  }

  async reauthenticate(method: ReauthMethod): Promise<SignInOutcome> {
    this.fail();
    if (method.kind === 'password' && method.password !== 'password') throw new AuthFlowError('invalid-credentials');
    if (this.mfaOnSignIn) return { kind: 'mfaRequired' };
    if (this.session) this.emit({ ...this.session, authTime: Date.now() });
    return { kind: 'signedIn' };
  }

  async refreshClaims(): Promise<void> {
    this.fail();
    if (this.session) this.emit({ ...this.session });
  }

  async call<T>(name: string, data: unknown): Promise<T> {
    this.calls.push({ name, data });
    this.fail();
    return this.callResults[name] as T;
  }

  async signOut(): Promise<void> {
    this.emit(null);
  }
}

/** Provides a FakeAuthPort (returned so tests can drive it). */
export function provideFakeAuth(session: AuthSession | null = testSession()): {
  port: FakeAuthPort;
  providers: Provider[];
} {
  const port = new FakeAuthPort(session);
  return { port, providers: [{ provide: AUTH_PORT, useValue: port }] };
}
