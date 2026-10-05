import { HttpsError } from 'firebase-functions/v2/https';
import { ZodError } from 'zod';

import { DomainError, type FieldErrors } from '@materia/domain';

import { errorReportFields, type Log } from './log';

/** Zod issues as field errors, keyed by dotted path ('' for the root). */
export function fieldErrors(error: ZodError): FieldErrors {
  const fields: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.map(String).join('.');
    (fields[key] ??= []).push(issue.message);
  }
  return fields;
}

/**
 * Maps anything a handler throws to an HttpsError. DomainErrors keep their status, message and
 * `details.code`; zod errors become INVALID_ARGUMENT with field paths; anything else is logged and
 * returned as a bare INTERNAL error, so nothing leaks to the client.
 */
export function toHttpsError(error: unknown, log: Log): HttpsError {
  if (error instanceof HttpsError) return error;
  if (error instanceof DomainError) {
    return new HttpsError(error.status, error.message, { ...error.details, code: error.code });
  }
  if (error instanceof ZodError) {
    return new HttpsError('invalid-argument', 'Invalid input', {
      code: 'INVALID_ARGUMENT',
      fields: fieldErrors(error),
    });
  }
  // Log the type and stack only (Error Reporting picks it up): messages can contain personal data.
  log.error('unhandled error', errorReportFields(error));
  return new HttpsError('internal', 'Internal error', { code: 'INTERNAL' });
}
