import { DomainError, isErrorCode, type ErrorCode } from '@materia/domain';

/**
 * What users see for each error code from a callable (FND-15). Plain, specific and actionable:
 * say what happened and what to do. Never show the server message, which is for developers.
 */
export const ERROR_COPY: Record<ErrorCode, string> = {
  UNAUTHENTICATED: 'Your session has ended. Sign in again to continue.',
  REAUTH_REQUIRED: 'For your security, confirm it’s you by signing in again.',
  MFA_REQUIRED: 'Your practice requires two-step sign-in. Set it up, then sign in again.',
  SESSION_EXPIRED: 'Your sign-in has expired. Sign in again to continue.',
  SESSION_REVOKED: 'You were signed out of this device. Sign in again to continue.',
  ORG_CLAIM_MISSING: 'Your account isn’t linked to a practice yet. Ask your practice admin for an invite.',
  ORG_CLAIM_MISMATCH: 'You switched practices in another tab. Refreshing your access…',
  MEMBER_INACTIVE: 'Your access to this practice has been paused. Contact your practice admin.',
  ACCESS_REVOKED: 'Your access to this changed. Ask a practice admin if you think it’s wrong.',
  PERMISSION_DENIED: 'Your role can’t do this. Ask a practice admin if you need access.',
  APP_CHECK_FAILED: 'We couldn’t verify this browser. Reload the page and try again.',
  INVALID_ARGUMENT: 'Some details need fixing. Check the highlighted fields.',
  REQUEST_ID_REQUIRED: 'Something went wrong sending this request. Reload the page and try again.',
  NOT_FOUND: 'We couldn’t find that. It may have been deleted or moved.',
  ALREADY_EXISTS: 'That already exists.',
  CONFLICT: 'Someone else changed this while you were editing. Reload to see the latest version.',
  REQUEST_IN_PROGRESS: 'Still working on your last request. Try again in a moment.',
  FAILED_PRECONDITION: 'This can’t be done in the current state.',
  FEATURE_DISABLED: 'This feature isn’t turned on for your practice yet.',
  RATE_LIMITED: 'Too many requests. Wait a minute and try again.',
  UNAVAILABLE: 'This service is temporarily unavailable. Try again shortly.',
  CLERK_DISABLED: 'Clerk isn’t turned on for your practice.',
  CLERK_RATE_LIMITED: 'You’ve asked Clerk a lot in the last few minutes. Wait a little and try again.',
  CLERK_BUDGET_EXCEEDED: 'Your practice has used this month’s Clerk allowance. An admin can raise it in settings.',
  CLERK_BUSY: 'Clerk is busy. Try again in a moment.',
  CLERK_UNAVAILABLE: 'Clerk is unavailable right now. You can carry on without it.',
  CLERK_KEY_INVALID:
    'Anthropic rejected your practice’s API key. An owner or admin can add a new key in Settings → Clerk.',
  PDF_ENCRYPTED: 'One of the PDFs is password-protected. Remove the password and upload it again.',
  PDF_INVALID: 'One of the PDFs is damaged or isn’t a PDF. Upload a fresh copy and try again.',
  JOB_TIMEOUT: 'This took too long and was stopped. Try again.',
  INVITE_EMAIL_MISMATCH:
    'This invite was sent to a different email. Sign in with the invited email, or ask for a new invite.',
  INVITE_EXPIRED: 'This invite has expired. Ask for a new invite.',
  INVITE_INVALID: 'This invite link isn’t valid any more. Ask for a new invite.',
  INVITE_LIMIT: 'Your practice has 50 pending invites. Revoke some before sending more.',
  MATTER_INVALID_TRANSITION: 'The matter can’t move to that status from where it is now.',
  MATTER_STAGE_REQUIREMENTS:
    'That stage needs more first: record the missing key facts and events, and finish the tasks it lists.',
  LAST_CLIENT: 'A matter needs at least one client. Add another client before removing this one.',
  TEMPLATE_STAGE_MAPPING_REQUIRED:
    'Some matters are in a stage this version removes. Choose where those matters should move, then publish again.',
  ALREADY_MEMBER: 'This person is already a member of the practice.',
  LAST_OWNER: 'A practice needs at least one owner. Make someone else an owner first.',
  EMAIL_NOT_VERIFIED: 'Confirm your email first, then try again.',
  INTERNAL: 'Something went wrong on our side. Try again, and contact support if it keeps happening.',
};

/** The error code of a `DomainError` (from the data layer) or a raw callable error (`details.code`), or INTERNAL. */
export function errorCodeOf(error: unknown): ErrorCode {
  if (error instanceof DomainError) return error.code;
  const code = (error as { details?: { code?: unknown } } | null)?.details?.code;
  return isErrorCode(code) ? code : 'INTERNAL';
}

/** CLERK_DISABLED because the practice hasn't added its own Anthropic key (AI-02a). */
export const CLERK_KEY_MISSING_COPY =
  'Clerk needs your practice’s Anthropic API key. An owner or admin can add it in Settings → Clerk.';

/** User-facing copy for any error thrown by a callable. */
export function errorCopy(error: unknown): string {
  const code = errorCodeOf(error);
  if (
    code === 'CLERK_DISABLED' &&
    (error as { details?: { switch?: unknown } } | null)?.details?.switch === 'org.byok.missing'
  )
    return CLERK_KEY_MISSING_COPY;
  return ERROR_COPY[code];
}

/** ORG_CLAIM_MISMATCH means: refresh the ID token and retry the call once. */
export function shouldRefreshTokenAndRetry(error: unknown): boolean {
  return errorCodeOf(error) === 'ORG_CLAIM_MISMATCH';
}
