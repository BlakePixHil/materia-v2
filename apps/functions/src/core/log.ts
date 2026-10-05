import { logger as functionsLogger } from 'firebase-functions';

import { redact } from './redact';

/** Fields every log line carries (ids only, never personal data). */
export interface LogContext {
  fn: string;
  requestId?: string;
  orgId?: string | null;
  uid?: string | null;
  [key: string]: unknown;
}

export type Severity = 'debug' | 'info' | 'warn' | 'error';

export interface Log {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  /** A log with extra context fields. */
  child(context: Partial<LogContext>): Log;
}

export type LogSink = (severity: Severity, message: string, entry: Record<string, unknown>) => void;

/** Writes structured JSON through firebase-functions/logger (Cloud Logging picks up the fields). */
export const functionsSink: LogSink = (severity, message, entry) => functionsLogger[severity](message, entry);

/**
 * A structured logger. Every entry includes the context and `durationMs` since the logger was
 * created; data is redacted before it is written.
 */
export function createLog(context: LogContext, sink: LogSink = functionsSink, started: number = Date.now()): Log {
  const write =
    (severity: Severity) =>
    (message: string, data: Record<string, unknown> = {}) =>
      sink(severity, message, {
        ...(redact(data) as Record<string, unknown>),
        ...context,
        durationMs: Date.now() - started,
      });
  return {
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    child: (extra) => createLog({ ...context, ...extra } as LogContext, sink, started),
  };
}

/**
 * Fields that put an unexpected error in Error Reporting (FND-21): an ERROR entry whose
 * `stack_trace` is a Node stack. The message line is withheld (library messages can contain personal
 * data); the type and frames are enough to group and locate the error.
 */
export function errorReportFields(error: unknown): { errorType: string; stack_trace?: string } {
  const errorType = error instanceof Error ? error.name : typeof error;
  const frames = error instanceof Error ? (error.stack?.split('\n').slice(1, 11).join('\n') ?? '') : '';
  return frames ? { errorType, stack_trace: `${errorType}: message withheld\n${frames}` } : { errorType };
}
