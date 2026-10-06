/**
 * Stable error codes shared by functions and the web app (FND-15). Callables throw `DomainError`;
 * the wrapper maps it to an `HttpsError` with `details.code`, and the UI turns the code into copy
 * (apps/web/src/app/core/error-copy.ts). Never rename a code: clients depend on it.
 */
export const ERROR_CODES = {
  UNAUTHENTICATED: 'unauthenticated',
  /** A sensitive action needs a sign-in within the last few minutes: re-authenticate and retry. */
  REAUTH_REQUIRED: 'unauthenticated',
  /** The org requires MFA (SEC-04) and this sign-in didn't use a second factor: set one up and sign in again. */
  MFA_REQUIRED: 'permission-denied',
  /** The sign-in is older than the org's session length (SEC-04): sign in again. */
  SESSION_EXPIRED: 'unauthenticated',
  /** The person was signed out everywhere (SEC-04) after this sign-in: sign in again. */
  SESSION_REVOKED: 'unauthenticated',
  ORG_CLAIM_MISSING: 'permission-denied',
  /** The token's org claim is stale (for example just after an org switch): refresh the token and retry once. */
  ORG_CLAIM_MISMATCH: 'failed-precondition',
  MEMBER_INACTIVE: 'permission-denied',
  /** A live read was refused after a role change or removal (FND-19): route to the no-access page, don't retry. */
  ACCESS_REVOKED: 'permission-denied',
  PERMISSION_DENIED: 'permission-denied',
  APP_CHECK_FAILED: 'unauthenticated',
  INVALID_ARGUMENT: 'invalid-argument',
  REQUEST_ID_REQUIRED: 'invalid-argument',
  NOT_FOUND: 'not-found',
  ALREADY_EXISTS: 'already-exists',
  CONFLICT: 'aborted',
  /** Another call with the same idempotency key is still running: retry shortly. */
  REQUEST_IN_PROGRESS: 'aborted',
  FAILED_PRECONDITION: 'failed-precondition',
  /** A server-enforced feature flag is off for this org (FND-23). */
  FEATURE_DISABLED: 'failed-precondition',
  RATE_LIMITED: 'resource-exhausted',
  UNAVAILABLE: 'unavailable',
  /** Clerk is switched off: the global or per-feature flag, or the org's own setting (AI-02). */
  CLERK_DISABLED: 'failed-precondition',
  /** This person has made too many Clerk requests recently (per-user window, AI-02). */
  CLERK_RATE_LIMITED: 'resource-exhausted',
  /** The org has used its monthly Clerk token budget (AI-02). */
  CLERK_BUDGET_EXCEEDED: 'resource-exhausted',
  /** The model provider is rate-limiting us: "Clerk is busy" (ADR-011a). */
  CLERK_BUSY: 'resource-exhausted',
  /** The provider and every fallback model failed: use the manual path (ADR-011a). */
  CLERK_UNAVAILABLE: 'unavailable',
  /** Anthropic rejected the org's API key (when saved, or a stored one): an admin must replace it (AI-02a). */
  CLERK_KEY_INVALID: 'failed-precondition',
  /** An input PDF needs a password to open (FND-24). */
  PDF_ENCRYPTED: 'failed-precondition',
  /** An input PDF is damaged beyond repair, or is not a PDF (FND-24). */
  PDF_INVALID: 'invalid-argument',
  /** A background job ran out of time; it can be retried (FND-24). */
  JOB_TIMEOUT: 'deadline-exceeded',
  /** The invite was sent to a different email than the signed-in account's verified email (FND-17). */
  INVITE_EMAIL_MISMATCH: 'permission-denied',
  /** The invite is older than seven days: ask for a new one. */
  INVITE_EXPIRED: 'failed-precondition',
  /** The invite link is wrong, revoked or already used by someone else. */
  INVITE_INVALID: 'not-found',
  /** The org already has the maximum number of pending invites. */
  INVITE_LIMIT: 'resource-exhausted',
  /** The person is already a member of the org. */
  ALREADY_MEMBER: 'already-exists',
  /** The change would leave the org without an active owner. */
  LAST_OWNER: 'failed-precondition',
  /** The account's email must be verified first. */
  EMAIL_NOT_VERIFIED: 'failed-precondition',
  /** The matter can't move from its current status to the requested one (CORE-03). */
  MATTER_INVALID_TRANSITION: 'failed-precondition',
  /** A forward stage move needs key facts that aren't recorded; `details.requirements` lists them (CORE-06). */
  MATTER_STAGE_REQUIREMENTS: 'failed-precondition',
  /** A matter must keep at least one client party (CORE-06). */
  LAST_CLIENT: 'failed-precondition',
  /**
   * Publishing a template version drops stages that matters are in: map each to a stage of the new
   * version (`details.stages` lists them, CORE-07).
   */
  TEMPLATE_STAGE_MAPPING_REQUIRED: 'failed-precondition',
  /** The matter is closed or archived, so it can't be changed until it is reopened (AI-07). */
  MATTER_CLOSED: 'failed-precondition',
  /**
   * A Clerk suggestion's sources changed since it was proposed (AI-07): `details.changed` lists what,
   * `details.basis` is the basis to accept it against after a re-review.
   */
  SUGGESTION_STALE: 'failed-precondition',
  /** A Clerk suggestion was already accepted, dismissed or expired (AI-07): `details.status`. */
  ALREADY_RESOLVED: 'failed-precondition',
  /** No accept handler is registered for this suggestion kind yet (AI-07): `details.kind`. */
  SUGGESTION_UNSUPPORTED: 'failed-precondition',
  INTERNAL: 'internal',
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;
/** The gRPC-style status a code maps to (the `HttpsError` code). */
export type ErrorStatus = (typeof ERROR_CODES)[ErrorCode];

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERROR_CODES, value);
}

/** Field-level problems, by dotted path (`lines.0.amountCents`). */
export type FieldErrors = Record<string, string[]>;

export interface DomainErrorDetails {
  fields?: FieldErrors;
  [key: string]: unknown;
}

/**
 * An expected failure with a stable code. The message is for logs and developers; users see copy
 * keyed by `code`. Details must not contain personal information.
 */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly details: DomainErrorDetails | undefined;

  constructor(code: ErrorCode, message: string = code, details?: DomainErrorDetails) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }

  get status(): ErrorStatus {
    return ERROR_CODES[this.code];
  }
}
