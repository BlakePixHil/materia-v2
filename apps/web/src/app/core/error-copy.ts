import { isErrorCode, type ErrorCode } from '@materia/domain';

/**
 * What users see for each error code from a callable (FND-15). Plain, specific and actionable:
 * say what happened and what to do. Never show the server message, which is for developers.
 */
export const ERROR_COPY: Record<ErrorCode, string> = {
  UNAUTHENTICATED: 'Your session has ended. Sign in again to continue.',
  REAUTH_REQUIRED: 'For your security, confirm it’s you by signing in again.',
  ORG_CLAIM_MISSING: 'Your account isn’t linked to a practice yet. Ask your practice admin for an invite.',
  ORG_CLAIM_MISMATCH: 'You switched practices in another tab. Refreshing your access…',
  MEMBER_INACTIVE: 'Your access to this practice has been paused. Contact your practice admin.',
  PERMISSION_DENIED: 'Your role can’t do this. Ask a practice admin if you need access.',
  APP_CHECK_FAILED: 'We couldn’t verify this browser. Reload the page and try again.',
  INVALID_ARGUMENT: 'Some details need fixing. Check the highlighted fields.',
  REQUEST_ID_REQUIRED: 'Something went wrong sending this request. Reload the page and try again.',
  NOT_FOUND: 'We couldn’t find that. It may have been deleted or moved.',
  ALREADY_EXISTS: 'That already exists.',
  CONFLICT: 'Someone else changed this while you were editing. Reload to see the latest version.',
  REQUEST_IN_PROGRESS: 'Still working on your last request. Try again in a moment.',
  FAILED_PRECONDITION: 'This can’t be done in the current state.',
  RATE_LIMITED: 'Too many requests. Wait a minute and try again.',
  UNAVAILABLE: 'This service is temporarily unavailable. Try again shortly.',
  INTERNAL: 'Something went wrong on our side. Try again, and contact support if it keeps happening.',
};

/** The error code carried by a callable error (`details.code`), or INTERNAL. */
export function errorCodeOf(error: unknown): ErrorCode {
  const code = (error as { details?: { code?: unknown } } | null)?.details?.code;
  return isErrorCode(code) ? code : 'INTERNAL';
}

/** User-facing copy for any error thrown by a callable. */
export function errorCopy(error: unknown): string {
  return ERROR_COPY[errorCodeOf(error)];
}

/** ORG_CLAIM_MISMATCH means: refresh the ID token and retry the call once. */
export function shouldRefreshTokenAndRetry(error: unknown): boolean {
  return errorCodeOf(error) === 'ORG_CLAIM_MISMATCH';
}
