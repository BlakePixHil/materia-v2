import { computed, DestroyRef, inject, Injectable, InjectionToken, signal } from '@angular/core';

import { DataLifecycle, setFirestoreCacheMode } from '@materia/data-access';

import { AUTH_PORT, type AuthPersistence, type AuthSession, type SignInOutcome } from './auth-port';

/** The signed-in person and their active org, as the shell shows them. */
export interface SessionUser {
  uid: string;
  displayName: string;
  email: string;
  orgId: string | null;
  orgName: string | null;
}

/**
 * Where a session stands. Guards send people to the step they're missing:
 * signed out → sign in; unverified email → verify; MFA required but missing → enrol; no org → onboarding.
 */
export type AuthStatus = 'loading' | 'signedOut' | 'needsVerification' | 'needsMfa' | 'needsOrg' | 'ready';

export function statusOf(session: AuthSession | null | undefined, mfaRequired: boolean): AuthStatus {
  if (session === undefined) return 'loading';
  if (session === null) return 'signedOut';
  // Federated accounts (Google) are verified by the provider; password accounts verify by email.
  if (!session.emailVerified && session.providerIds.includes('password')) return 'needsVerification';
  if (mfaRequired && !session.mfaEnrolled) return 'needsMfa';
  if (!session.claims.orgId) return 'needsOrg';
  return 'ready';
}

/**
 * Clean-up run on sign-out. The data layer (FND-19) stops every listener, resets stores, then
 * terminates Firestore and clears its IndexedDB cache.
 */
export type SignOutCleanup = () => void | Promise<void>;
export const SIGN_OUT_CLEANUP = new InjectionToken<SignOutCleanup[]>('SIGN_OUT_CLEANUP', {
  factory: () => {
    const data = inject(DataLifecycle);
    return [() => data.signOut()];
  },
});

/** A shared-computer sign-in (session persistence) keeps Firestore's cache in memory only (FND-19). */
function useCacheFor(persistence: AuthPersistence): void {
  setFirestoreCacheMode(persistence === 'session' ? 'memory' : 'persistent');
}

/** Per-user browser state that mustn't survive sign-out on a shared computer. */
const USER_STORAGE_KEYS = [
  'materia.commands.recent',
  'materia.matters.view',
  'materia.matters.layout',
  'materia.matters.swimlanes',
  'materia.matter.eventsView',
];

/**
 * Deletes Firestore's IndexedDB caches (`firestore/…` databases), so nothing cached survives
 * sign-out even if a Firestore instance was never terminated cleanly.
 */
export async function clearFirestoreCaches(idb: IDBFactory | undefined = globalThis.indexedDB): Promise<string[]> {
  if (!idb?.databases) return [];
  const names = (await idb.databases()).map((db) => db.name ?? '').filter((name) => name.startsWith('firestore/'));
  await Promise.all(
    names.map(
      (name) =>
        new Promise<void>((resolve) => {
          const request = idb.deleteDatabase(name);
          request.onsuccess = request.onerror = request.onblocked = () => resolve();
        }),
    ),
  );
  return names;
}

/**
 * The auth signal store (FND-16): the session from Identity Platform, its status, and the auth
 * actions the screens call. `AUTH_PORT` hides the Firebase SDK, which loads lazily.
 */
@Injectable({ providedIn: 'root' })
export class AuthState {
  private readonly port = inject(AUTH_PORT);
  private readonly cleanups = inject(SIGN_OUT_CLEANUP);
  private readonly sessionSignal = signal<AuthSession | null | undefined>(undefined);
  private readonly readyWaiters: (() => void)[] = [];

  /** `undefined` while loading, `null` when signed out. */
  readonly session = this.sessionSignal.asReadonly();
  /** Whether the org requires MFA. SEC-04 sets it from the org's security policy. */
  readonly mfaRequired = signal(false);
  readonly status = computed(() => statusOf(this.sessionSignal(), this.mfaRequired()));
  readonly claims = computed(() => this.sessionSignal()?.claims ?? {});
  readonly activeOrgId = computed(() => this.sessionSignal()?.claims.orgId ?? null);
  readonly user = computed<SessionUser | null>(() => {
    const session = this.sessionSignal();
    if (!session) return null;
    return {
      uid: session.uid,
      displayName: session.displayName || session.email || 'Account',
      email: session.email ?? '',
      orgId: session.claims.orgId ?? null,
      orgName: session.claims.orgName ?? null,
    };
  });
  readonly signedIn = computed(() => !!this.sessionSignal());
  /** True from this tab's sign-out until the next sign-in (so a sign-out from another tab can be told apart). */
  readonly signingOut = signal(false);
  readonly orgScoped = computed(() => !!this.activeOrgId());

  constructor() {
    const stop = this.port.watch((session) => {
      this.sessionSignal.set(session);
      // Stays set until the next sign-in, so the session ending (which the port may report after
      // signOut resolves) still reads as this tab's own sign-out.
      if (session) this.signingOut.set(false);
      for (const resolve of this.readyWaiters.splice(0)) resolve();
    });
    inject(DestroyRef).onDestroy(stop);
  }

  /** Resolves once the first session state is known. */
  whenReady(): Promise<void> {
    if (this.sessionSignal() !== undefined) return Promise.resolve();
    return new Promise((resolve) => this.readyWaiters.push(resolve));
  }

  signInWithPassword(email: string, password: string, persistence: AuthPersistence = 'local'): Promise<SignInOutcome> {
    useCacheFor(persistence);
    return this.port.signInWithPassword(email, password, persistence);
  }

  signInWithGoogle(persistence: AuthPersistence = 'local'): Promise<SignInOutcome> {
    useCacheFor(persistence);
    return this.port.signInWithGoogle(persistence);
  }

  completeMfa(code: string): Promise<void> {
    return this.port.completeMfa(code);
  }

  signUp(email: string, password: string, displayName: string): Promise<void> {
    return this.port.signUp(email, password, displayName);
  }

  sendVerificationEmail(): Promise<void> {
    return this.port.sendVerificationEmail();
  }

  reload(): Promise<void> {
    return this.port.reload();
  }

  /** Forces a token refresh so new claims (org, role) apply; listeners restart on the new session. */
  refreshClaims(): Promise<void> {
    return this.port.refreshClaims();
  }

  /** Whether the current sign-in is recent enough for a sensitive action. */
  isRecentLogin(maxAgeMinutes = 5, now = Date.now()): boolean {
    const session = this.sessionSignal();
    return !!session && now - session.authTime <= maxAgeMinutes * 60_000;
  }

  /**
   * Signs out and leaves nothing behind: features clean up (listeners, stores, Firestore), cached
   * Firestore data and per-user storage are deleted, then Identity Platform signs out.
   */
  async signOut(): Promise<void> {
    this.signingOut.set(true);
    try {
      await this.cleanUp();
      await this.port.signOut();
    } catch (error) {
      this.signingOut.set(false);
      throw error;
    }
  }

  /**
   * Everything sign-out removes from this tab: features clean up, then any Firestore cache left in
   * IndexedDB and per-user storage are deleted. Also run when another tab signs out.
   */
  async cleanUp(): Promise<void> {
    for (const cleanup of this.cleanups) {
      try {
        await cleanup();
      } catch {
        // One failing clean-up must not keep the person signed in.
      }
    }
    await clearFirestoreCaches().catch(() => undefined);
    for (const key of USER_STORAGE_KEYS) {
      try {
        globalThis.localStorage?.removeItem(key);
      } catch {
        // Storage may be unavailable.
      }
    }
  }

  /** For screens that need a port method directly (enrolment, reset links, callables). */
  get api() {
    return this.port;
  }
}
