import { computed, inject, Injectable, signal } from '@angular/core';
import { Router, type CanActivateFn, type UrlTree } from '@angular/router';

import { TERMS_VERSION, termsAcceptanceNeeded, termsAskedIn } from '@materia/domain';

import { environment } from '../../../environments/environment';
import { AuthState } from '../auth/auth-state';
import { SessionPolicy } from '../auth/session-policy';

/** Where an owner accepts the terms (SEC-01). */
export const ACCEPT_TERMS_PATH = '/accept-terms';

/** A same-site path to go on to, never the acceptance page itself (no open redirects). */
export function termsReturnUrl(value: string | null | undefined): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith(ACCEPT_TERMS_PATH)) return null;
  return value;
}

/**
 * Whether the signed-in person must accept the terms of service before using the app (SEC-01):
 * owners, while their org hasn't accepted `TERMS_VERSION`. Admins and everyone else are never
 * blocked. The accepted version comes from the org document `SessionPolicy` already follows, so the
 * check adds no read. An acceptance made in this tab counts at once, before that listener catches up.
 * In prod nobody is asked until the terms are signed off (`termsAskedIn`).
 */
@Injectable({ providedIn: 'root' })
export class TermsState {
  private readonly auth = inject(AuthState);
  private readonly policy = inject(SessionPolicy);
  private readonly acceptedHere = signal<{ orgId: string; version: string } | null>(null);

  /** False while the org document is loading or can't be read: the app doesn't block on it. */
  readonly needed = computed(() => {
    if (!termsAskedIn(environment.name)) return false;
    const security = this.policy.security();
    // `undefined` is "not known" (loading, or a port that doesn't report it).
    if (!security || security.termsAcceptedVersion === undefined) return false;
    const { orgId, role } = this.auth.claims();
    const here = this.acceptedHere();
    if (here && here.orgId === orgId && here.version === TERMS_VERSION) return false;
    return termsAcceptanceNeeded(role, security.termsAcceptedVersion);
  });

  /** Records that this tab's owner accepted `version` for the active org. */
  markAccepted(version: string): void {
    const orgId = this.auth.claims().orgId;
    if (orgId) this.acceptedHere.set({ orgId, version });
  }
}

/** The app shell: an owner whose org hasn't accepted the current terms accepts them first. */
export const termsGuard: CanActivateFn = async (_route, state): Promise<true | UrlTree> => {
  const auth = inject(AuthState);
  const policy = inject(SessionPolicy);
  const terms = inject(TermsState);
  const router = inject(Router);
  await auth.whenReady();
  // Everyone else, and the steps before an org (the shell's other guard sends them on), go through.
  if (auth.status() !== 'ready' || auth.claims().role !== 'owner') return true;
  await policy.whenLoaded();
  if (!terms.needed()) return true;
  const returnUrl = termsReturnUrl(state.url);
  return router.createUrlTree([ACCEPT_TERMS_PATH], {
    queryParams: returnUrl && returnUrl !== '/' ? { returnUrl } : {},
  });
};

/** The acceptance page: only while it's needed; otherwise on to where the person was going. */
export const acceptTermsGuard: CanActivateFn = async (route): Promise<true | UrlTree> => {
  const auth = inject(AuthState);
  const policy = inject(SessionPolicy);
  const terms = inject(TermsState);
  const router = inject(Router);
  await auth.whenReady();
  await policy.whenLoaded();
  if (terms.needed()) return true;
  return router.parseUrl(termsReturnUrl(route.queryParamMap.get('returnUrl')) ?? '/');
};
