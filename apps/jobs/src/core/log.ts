import type { Log } from './types';

type Severity = 'INFO' | 'WARNING' | 'ERROR';

/**
 * Structured JSON lines on stdout, which Cloud Logging parses (ADR-018). Fields are ids, counts and
 * codes only: never names, document text or template data.
 */
export function createLog(
  base: Record<string, unknown>,
  write: (line: string) => void = (line) => process.stdout.write(line + '\n'),
): Log {
  const emit =
    (severity: Severity) =>
    (message: string, fields: Record<string, unknown> = {}) =>
      write(JSON.stringify({ severity, message, ...base, ...fields }));
  return { info: emit('INFO'), warn: emit('WARNING'), error: emit('ERROR') };
}
