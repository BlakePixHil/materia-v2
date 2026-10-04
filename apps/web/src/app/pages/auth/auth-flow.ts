import { Router } from '@angular/router';

import { AuthFlowError, AUTH_ERROR_COPY } from '../../core/auth/auth-port';
import type { AuthState } from '../../core/auth/auth-state';
import { STATUS_ROUTES } from '../../core/auth/guards';
import { errorCodeOf, errorCopy } from '../../core/error-copy';

/** Copy for an auth or callable failure. Never the raw message. */
export function authErrorMessage(error: unknown): string {
  if (error instanceof AuthFlowError) return AUTH_ERROR_COPY[error.code];
  if (errorCodeOf(error) !== 'INTERNAL') return errorCopy(error);
  return AUTH_ERROR_COPY.unknown;
}

/** A same-site path to return to after sign-in, or null (no open redirects). */
export function safeReturnUrl(value: string | null | undefined): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/auth')) return null;
  return value;
}

/** After a successful sign-in step: the next unfinished step, else where they were going. */
export async function continueAfterSignIn(auth: AuthState, router: Router, returnUrl: string | null): Promise<void> {
  const status = auth.status();
  if (status === 'ready') {
    await router.navigateByUrl(safeReturnUrl(returnUrl) ?? '/today');
  } else if (status !== 'loading' && status !== 'signedOut') {
    await router.navigateByUrl(STATUS_ROUTES[status]);
  }
}
