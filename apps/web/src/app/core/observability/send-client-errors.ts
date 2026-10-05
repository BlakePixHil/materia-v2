import type { CallableClient } from '@materia/data-access';
import { scrubClientError, type LogClientErrorInput, type LogClientErrorResult } from '@materia/domain';

/** Scrubs a batch of client errors (PII never leaves the browser) and sends it. Loaded lazily. */
export function sendClientErrors(client: CallableClient, input: LogClientErrorInput): Promise<LogClientErrorResult> {
  return client.call<LogClientErrorInput, LogClientErrorResult>('system-logClientError', {
    sessionId: input.sessionId,
    errors: input.errors.map(scrubClientError),
  });
}
