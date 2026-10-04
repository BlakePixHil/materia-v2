import { computed, Injectable, signal } from '@angular/core';
import { inject } from '@angular/core';
import type { CanMatchFn } from '@angular/router';
import { Router } from '@angular/router';

/** The signed-in person and their active org. */
export interface SessionUser {
  uid: string;
  displayName: string;
  email: string;
  orgId: string | null;
  orgName: string | null;
}

/**
 * Stub auth state (FND-12): a fictional signed-in user so the shell can be built and tested.
 * FND-16 replaces it with Identity Platform; keep this interface.
 */
@Injectable({ providedIn: 'root' })
export class AuthState {
  readonly user = signal<SessionUser | null>({
    uid: 'user-jordan',
    displayName: 'Jordan Price',
    email: 'lawyer@harbourvine.example',
    orgId: 'org-harbour-vine',
    orgName: 'Harbour & Vine Legal',
  });
  readonly signedIn = computed(() => this.user() !== null);
  readonly orgScoped = computed(() => !!this.user()?.orgId);
}

/** The shell's routes need a signed-in user with an active org; otherwise sign in or onboard. */
export const orgScopedGuard: CanMatchFn = () => {
  const auth = inject(AuthState);
  const router = inject(Router);
  if (!auth.signedIn()) return router.parseUrl('/auth/sign-in');
  if (!auth.orgScoped()) return router.parseUrl('/onboarding');
  return true;
};
