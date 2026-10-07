import { computed, DestroyRef, effect, inject, Injectable, InjectionToken, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';

import { OrgContext, TENANCY_PORT, type SessionSecurity } from '@materia/data-access';
import { mfaEnforced, sessionExpired, sessionRevoked, type ResolvedSecurity } from '@materia/domain';

import { AuthState } from './auth-state';

/** Why the app ended a session itself (SEC-04); the signed-out page explains each. */
export type SessionEndReason = 'idle' | 'expired' | 'revoked' | 'mfa';

/** The current time in ms (tests replace it). */
export const SESSION_NOW = new InjectionToken<() => number>('SESSION_NOW', { factory: () => () => Date.now() });

/** How long a guard waits for the policy before letting the server and rules decide. */
export const POLICY_WAIT_MS = 4000;

/** setTimeout's longest delay; longer waits are re-armed. */
const MAX_TIMER_MS = 2_147_000_000;

/**
 * The org's security policy for this sign-in (SEC-04), from `orgs/{orgId}.security` and the
 * member's `sessionsValidAfter`:
 *
 * - sets `AuthState.mfaRequired` once the org requires MFA and the grace period is over, so the
 *   guards send a member without it to set it up; until then `mfaGraceUntil` drives a banner;
 * - ends the session ("signed out" page) when it is older than the org allows, was signed out
 *   everywhere, or predates the second factor the org now requires. The rules and callables refuse
 *   such a sign-in anyway; this says why instead of showing errors.
 */
@Injectable({ providedIn: 'root' })
export class SessionPolicy {
  private readonly auth = inject(AuthState);
  private readonly context = inject(OrgContext);
  private readonly router = inject(Router);
  private readonly port = inject(TENANCY_PORT, { optional: true });
  private readonly clock = inject(SESSION_NOW);

  /** `undefined` while loading (or without an org), null when it couldn't be read. */
  readonly security = signal<SessionSecurity | null | undefined>(undefined);
  readonly policy = computed<ResolvedSecurity | null>(() => this.security()?.policy ?? null);
  /** When the practice is to be deleted (SEC-05); null when it isn't. It is read-only until then. */
  readonly deletionScheduledAt = computed<Date | null>(() => this.security()?.deletionScheduledAt ?? null);
  /** Re-evaluated when a time boundary (grace end, session expiry) passes. */
  private readonly now = signal(this.clock());
  /** Off while this tab signs out everywhere else and confirms it's them again. */
  private readonly paused = signal(false);
  readonly checksPaused = this.paused.asReadonly();
  private ending = false;
  private drivingMfa = false;
  private readonly waiters: (() => void)[] = [];

  /** The member whose policy applies: from the auth session, none while signing out. */
  private readonly target = computed(
    () => {
      const session = this.auth.session();
      const orgId = session?.claims.orgId;
      return session && orgId && !this.auth.signingOut() ? { uid: session.uid, orgId } : null;
    },
    { equal: (a, b) => a?.uid === b?.uid && a?.orgId === b?.orgId },
  );

  readonly mfaEnforced = computed(() => {
    const policy = this.policy();
    return !!policy && mfaEnforced(policy, this.now());
  });

  /** When MFA becomes mandatory for this person (they haven't set it up), during the grace period. */
  readonly mfaGraceUntil = computed<Date | null>(() => {
    const policy = this.policy();
    const session = this.auth.session();
    if (!policy?.mfaRequired || !session || session.mfaEnrolled || this.mfaEnforced()) return null;
    return policy.mfaEnforceAfter;
  });

  /** Why this sign-in can't go on, or null. */
  readonly endReason = computed<Exclude<SessionEndReason, 'idle'> | null>(() => {
    const security = this.security();
    const session = this.auth.session();
    if (!security || !session || this.paused()) return null;
    const now = this.now();
    if (sessionRevoked(session.authTime, security.validAfter)) return 'revoked';
    if (sessionExpired(session.authTime, security.policy, now)) return 'expired';
    // Set up during the grace period, but this sign-in didn't use it: sign in again with it.
    if (this.mfaEnforced() && session.mfaEnrolled && session.secondFactor === false) return 'mfa';
    return null;
  });

  constructor() {
    const destroyRef = inject(DestroyRef);
    // Follows the signed-in member's org from the auth session (the guards wait on it before
    // OrgContext is set), and again after OrgContext restarts every listener (`generation`).
    let followed: string | null = null;
    effect((onCleanup) => {
      const target = this.target();
      this.context.generation();
      const key = target && `${target.uid}/${target.orgId}`;
      if (key !== followed) this.security.set(undefined);
      followed = key;
      const port = this.port;
      if (!target || !port?.watchSecurity) {
        this.release();
        return;
      }
      const watch = port.watchSecurity.bind(port);
      // Untracked: a port may call back at once, inside this effect.
      const stop = untracked(() =>
        watch(target.orgId, target.uid, (security) =>
          untracked(() => {
            this.security.set(security);
            // Before the guards waiting on it go on, not when the effect below next runs.
            this.syncMfaRequired();
            this.release();
          }),
        ),
      );
      onCleanup(stop);
    });

    // MFA becoming mandatory mid-session (the grace period ending, or none given): set it up now.
    effect(() => {
      if (this.auth.status() !== 'needsMfa') return;
      const url = untracked(() => this.router.url);
      if (!url.startsWith('/auth/')) void untracked(() => this.router.navigateByUrl('/auth/mfa/enrol'));
    });

    effect(() => this.syncMfaRequired());

    // Wakes at the next boundary: the end of the grace period or of the session.
    effect((onCleanup) => {
      const policy = this.policy();
      const session = this.auth.session();
      const now = this.now();
      const boundaries = [
        policy?.mfaRequired ? policy.mfaEnforceAfter?.getTime() : undefined,
        policy && session ? session.authTime + policy.maxSessionDays * 86_400_000 + 1 : undefined,
      ].filter((at): at is number => at !== undefined && at > now);
      if (!boundaries.length) return;
      const timer = setTimeout(() => this.now.set(this.clock()), Math.min(Math.min(...boundaries) - now, MAX_TIMER_MS));
      onCleanup(() => clearTimeout(timer));
    });

    effect(() => {
      const reason = this.endReason();
      if (reason && !untracked(this.paused) && !untracked(this.auth.signingOut)) void this.end(reason);
    });
    destroyRef.onDestroy(() => this.release());
  }

  /** Resolves once the policy is known (or there's none to wait for), or after `POLICY_WAIT_MS`. */
  whenLoaded(): Promise<void> {
    if (this.security() !== undefined || !this.target() || !this.port?.watchSecurity) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, POLICY_WAIT_MS);
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * Runs `work` with the session checks paused: signing out everywhere else revokes this tab's
   * sign-in too, until it confirms it's them again.
   */
  async withChecksPaused<T>(work: () => Promise<T>): Promise<T> {
    this.paused.set(true);
    try {
      return await work();
    } finally {
      this.paused.set(false);
    }
  }

  /** Signs out and shows why (`/auth/signed-out?reason=`). */
  async end(reason: SessionEndReason): Promise<void> {
    if (this.ending) return;
    this.ending = true;
    try {
      await this.auth.signOut().catch(() => undefined);
      await this.router.navigateByUrl(`/auth/signed-out?reason=${reason}`);
    } finally {
      this.ending = false;
    }
  }

  /** Drives `mfaRequired` once a policy has loaded (and clears it after, when there's none). */
  private syncMfaRequired(): void {
    const loaded = this.security() !== undefined;
    if (!loaded && !this.drivingMfa) return;
    this.drivingMfa = loaded;
    this.auth.mfaRequired.set(loaded && this.mfaEnforced());
  }

  private release(): void {
    for (const resolve of this.waiters.splice(0)) resolve();
  }
}
