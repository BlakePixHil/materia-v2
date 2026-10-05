import type { ClientErrorReport, LogClientErrorInput } from '@materia/domain';

import type { ErrorReporter } from '../error-handler';

/** Errors one session reports per minute; the rest are dropped (the server enforces it too). */
const PER_MINUTE = 20;
/** Errors are batched for this long before one call. */
const BATCH_MS = 2000;

export interface ClientErrorReporterOptions {
  /** Scrubs and sends a batch (loaded lazily, so the initial bundle stays small). */
  send: (input: LogClientErrorInput) => Promise<unknown>;
  version: string;
  now?: () => number;
  route?: () => string;
  userAgent?: string;
  sessionId?: string;
}

/**
 * The ErrorHandler's reporter in the app (FND-21): queues unexpected errors, at most 20 a minute
 * per session, and sends them in batches to `system-logClientError`. Scrubbing happens in `send`,
 * before anything leaves the browser. A failed send is dropped silently: reporting must never
 * cause more errors.
 */
export function clientErrorReporter(options: ClientErrorReporterOptions): ErrorReporter {
  const now = options.now ?? Date.now;
  const route = options.route ?? (() => location.pathname);
  const userAgent = options.userAgent ?? navigator.userAgent;
  const sessionId = options.sessionId ?? crypto.randomUUID();
  let queue: ClientErrorReport[] = [];
  let minute = -1;
  let taken = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    timer = undefined;
    const errors = queue;
    queue = [];
    if (errors.length) options.send({ sessionId, errors }).catch(() => undefined);
  };

  return (error) => {
    const at = Math.floor(now() / 60_000);
    if (at !== minute) [minute, taken] = [at, 0];
    if (++taken > PER_MINUTE) return;
    const e = error instanceof Error ? error : null;
    queue.push({
      message: e ? `${e.name}: ${e.message}` : String(error),
      ...(e?.stack ? { stack: e.stack } : {}),
      route: route(),
      version: options.version,
      userAgent,
    });
    timer ??= setTimeout(flush, BATCH_MS);
  };
}
