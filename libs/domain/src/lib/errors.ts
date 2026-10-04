/**
 * Stable error codes shared by functions and the web app (FND-15). Callables throw `DomainError`;
 * the wrapper maps it to an `HttpsError` with `details.code`, and the UI turns the code into copy
 * (apps/web/src/app/core/error-copy.ts). Never rename a code: clients depend on it.
 */
export const ERROR_CODES = {
  UNAUTHENTICATED: 'unauthenticated',
  /** A sensitive action needs a sign-in within the last few minutes: re-authenticate and retry. */
  REAUTH_REQUIRED: 'unauthenticated',
  ORG_CLAIM_MISSING: 'permission-denied',
  /** The token's org claim is stale (for example just after an org switch): refresh the token and retry once. */
  ORG_CLAIM_MISMATCH: 'failed-precondition',
  MEMBER_INACTIVE: 'permission-denied',
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
  RATE_LIMITED: 'resource-exhausted',
  UNAVAILABLE: 'unavailable',
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
