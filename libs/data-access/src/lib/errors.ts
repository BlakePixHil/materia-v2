import { DomainError, isErrorCode, type ErrorCode } from '@materia/domain';

/** Where an error came from: the same raw code means different things for a read and a write. */
export type ErrorSource = 'read' | 'write' | 'callable';

/** Firestore and Functions client codes (`permission-denied`, `functions/unavailable`) as domain codes. */
const STATUS_CODES: Record<string, ErrorCode> = {
  unauthenticated: 'UNAUTHENTICATED',
  'permission-denied': 'PERMISSION_DENIED',
  'invalid-argument': 'INVALID_ARGUMENT',
  'not-found': 'NOT_FOUND',
  'already-exists': 'ALREADY_EXISTS',
  aborted: 'CONFLICT',
  'failed-precondition': 'FAILED_PRECONDITION',
  'resource-exhausted': 'RATE_LIMITED',
  unavailable: 'UNAVAILABLE',
  'deadline-exceeded': 'UNAVAILABLE',
  cancelled: 'UNAVAILABLE',
};

/**
 * Turns anything the Firebase SDKs throw into a `DomainError`, so feature code sees one error type
 * with a stable code (and `error-copy.ts` has copy for it):
 * - a callable's `HttpsError` carries the domain code in `details.code` (FND-15);
 * - a refused read means the person's access changed under them (`ACCESS_REVOKED`);
 * - other SDK codes map by status; anything unknown is `INTERNAL`.
 * Messages are for developers; the original error is kept as `cause`.
 */
export function toDomainError(error: unknown, source: ErrorSource = 'read'): DomainError {
  if (error instanceof DomainError) return error;
  const raw = error as { code?: unknown; message?: unknown; details?: { code?: unknown } } | null;
  const message = typeof raw?.message === 'string' ? raw.message : 'Request failed';
  const detailCode = raw?.details?.code;
  let result: DomainError;
  const issues = (error as { issues?: { path: PropertyKey[]; message: string }[] } | null)?.issues;
  if (Array.isArray(issues) && issues.every((issue) => Array.isArray(issue?.path))) {
    // A zod validation error: the input failed the domain schema before it left the browser.
    const fields: Record<string, string[]> = {};
    for (const issue of issues) (fields[issue.path.map(String).join('.')] ??= []).push(issue.message);
    result = new DomainError('INVALID_ARGUMENT', 'Invalid input', { fields });
  } else if (isErrorCode(detailCode)) {
    result = new DomainError(detailCode, message, raw?.details as Record<string, unknown>);
  } else {
    const status = typeof raw?.code === 'string' ? raw.code.replace(/^(functions|firestore)\//, '') : '';
    let code = STATUS_CODES[status] ?? 'INTERNAL';
    if (code === 'PERMISSION_DENIED' && source === 'read') code = 'ACCESS_REVOKED';
    result = new DomainError(code, message);
  }
  (result as { cause?: unknown }).cause = error;
  return result;
}

/** Errors worth retrying with the same request id: the server may not have seen the request. */
export function isTransient(error: DomainError): boolean {
  return error.code === 'UNAVAILABLE' || error.code === 'REQUEST_IN_PROGRESS';
}

/**
 * A callable that wasn't sent because the browser is offline: callables need a connection (ADR-020).
 * Feature code shows "Needs connection" for it (`isOfflineError`).
 */
export function offlineError(): DomainError {
  return new DomainError('UNAVAILABLE', 'Not sent: the browser is offline', { offline: true });
}

/** True for `offlineError()`: the call never left the browser. */
export function isOfflineError(error: unknown): boolean {
  return error instanceof DomainError && error.code === 'UNAVAILABLE' && error.details?.['offline'] === true;
}
