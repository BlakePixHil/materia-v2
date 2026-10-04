import { inject } from '@angular/core';
import { Router, type CanActivateFn, type CanMatchFn, type UrlTree } from '@angular/router';

import type { Role } from '@materia/domain';

import { AuthState, type AuthStatus } from './auth-state';

/** Where each unfinished status sends the person. */
export const STATUS_ROUTES: Record<Exclude<AuthStatus, 'loading' | 'ready'>, string> = {
  signedOut: '/auth/sign-in',
  needsVerification: '/auth/verify-email',
  needsMfa: '/auth/mfa/enrol',
  needsOrg: '/onboarding',
};

type Step = 'signedOut' | 'needsVerification' | 'needsMfa' | 'needsOrg';

/**
 * Builds a guard that lets through statuses past the given steps and redirects the rest. Every
 * `inject()` happens before the first `await`, while the injection context is still active.
 */
function requireSteps(steps: readonly Step[]) {
  return async (): Promise<true | UrlTree> => {
    const auth = inject(AuthState);
    const router = inject(Router);
    await auth.whenReady();
    const status = auth.status();
    const missing = steps.find((step) => step === status);
    if (!missing) return true;
    const returnUrl = router.getCurrentNavigation()?.extractedUrl.toString();
    return router.createUrlTree([STATUS_ROUTES[missing]], {
      queryParams: missing === 'signedOut' && returnUrl && returnUrl !== '/' ? { returnUrl } : {},
    });
  };
}

/** Signed in with a verified email (or a federated account). */
export const authGuard: CanActivateFn & CanMatchFn = requireSteps(['signedOut', 'needsVerification']);

/** MFA enrolled when the org requires it (policy from SEC-04). */
export const mfaGuard: CanActivateFn & CanMatchFn = requireSteps(['signedOut', 'needsVerification', 'needsMfa']);

/** Has an active org; otherwise onboarding (FND-17). */
export const orgGuard: CanActivateFn & CanMatchFn = requireSteps([
  'signedOut',
  'needsVerification',
  'needsMfa',
  'needsOrg',
]);

/** The shell's routes: signed in, verified, MFA where required, with an org. */
export const orgScopedGuard: CanMatchFn = orgGuard;

/** Only these roles; others see "no access". */
export function roleGuard(roles: readonly Role[]): CanActivateFn & CanMatchFn {
  return async () => {
    const auth = inject(AuthState);
    const router = inject(Router);
    await auth.whenReady();
    const role = auth.claims().role;
    return role && roles.includes(role) ? true : router.createUrlTree(['/no-access']);
  };
}

/** Sign-in and sign-up pages: someone already signed in goes on to where they belong. */
export const signedOutGuard: CanActivateFn = async () => {
  const auth = inject(AuthState);
  const router = inject(Router);
  await auth.whenReady();
  const status = auth.status();
  if (status === 'signedOut') return true;
  return router.createUrlTree([status === 'ready' ? '/today' : STATUS_ROUTES[status as Step]]);
};

/** The verify-email page needs a signed-in, unverified person. */
export const unverifiedGuard: CanActivateFn = async () => {
  const auth = inject(AuthState);
  const router = inject(Router);
  await auth.whenReady();
  const status = auth.status();
  if (status === 'needsVerification') return true;
  return router.createUrlTree([status === 'signedOut' ? STATUS_ROUTES.signedOut : '/today']);
};
