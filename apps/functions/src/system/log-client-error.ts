import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';

import {
  CLIENT_ERRORS_PER_MINUTE,
  scrubClientError,
  type ClientErrorReport,
  type LogClientErrorResult,
} from '@materia/domain';

import { REGION } from '../config';
import { adminDb } from '../core/admin';
import { isEmulator } from '../core/env';
import type { Clock } from '../ports';
import { systemClock } from '../ports/container';

/** The batch the web app sends (kept here, not in libs/domain, so zod stays out of the web bundle). */
export const LogClientErrorInputSchema = z.object({
  sessionId: z.string().min(8).max(64),
  errors: z
    .array(
      z.object({
        message: z.string().max(2000),
        stack: z.string().max(12_000).optional(),
        route: z.string().max(500),
        version: z.string().max(100),
        userAgent: z.string().max(500),
      }),
    )
    .min(1)
    .max(CLIENT_ERRORS_PER_MINUTE),
});

/** Reports this instance writes in full each minute before it starts sampling (error storms). */
export const FULL_REPORTS_PER_MINUTE = 50;
/** During a storm, one report in this many is written (marked `sampledOneIn`). */
export const STORM_SAMPLE_RATE = 10;

const ERROR_EVENT_TYPE = 'type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent';

export interface LogClientErrorDeps {
  db: () => Firestore;
  clock: Clock;
  /** Writes one structured entry (firebase-functions logger in production). */
  write: (entry: Record<string, unknown>) => void;
  random: () => number;
}

/** Per-instance storm sampling: the first reports each minute are always kept. */
export class StormSampler {
  private minute = -1;
  private seen = 0;

  constructor(private readonly random: () => number) {}

  /** 0 = drop, 1 = keep in full, n = keep as one sample of n. */
  take(now: number): number {
    const minute = Math.floor(now / 60_000);
    if (minute !== this.minute) {
      this.minute = minute;
      this.seen = 0;
    }
    if (++this.seen <= FULL_REPORTS_PER_MINUTE) return 1;
    return this.random() < 1 / STORM_SAMPLE_RATE ? STORM_SAMPLE_RATE : 0;
  }
}

/**
 * Takes up to `wanted` slots from the session's per-minute allowance (20, as on the client), in
 * `clientErrorLimits/{key}`. Returns how many were granted.
 */
export async function takeSlots(db: Firestore, key: string, wanted: number, now: Date): Promise<number> {
  const ref = db.doc(`clientErrorLimits/${key}`);
  const windowStart = Math.floor(now.getTime() / 60_000) * 60_000;
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data() as { windowStart?: number; count?: number } | undefined;
    const used = data?.windowStart === windowStart ? (data.count ?? 0) : 0;
    const granted = Math.max(0, Math.min(wanted, CLIENT_ERRORS_PER_MINUTE - used));
    tx.set(ref, {
      windowStart,
      count: used + granted,
      updatedAt: FieldValue.serverTimestamp(),
      // Firestore TTL deletes these a day later (infra: monitoring module).
      expiresAt: Timestamp.fromMillis(windowStart + 86_400_000),
    });
    return granted;
  });
}

/** The Error Reporting entry for one (scrubbed) report. Ids only: uid and session, no names. */
export function errorEvent(
  report: ClientErrorReport,
  ids: { uid: string | null; sessionId: string },
  sampledOneIn: number,
) {
  const header = report.message.split('\n')[0] ?? 'Error';
  // Error Reporting groups on the stack; Firefox and Safari stacks start with a frame, not a header.
  const firstLine = report.stack?.split('\n')[0] ?? '';
  const startsWithFrame = /^\s*at\s|@\S*:\d+:\d+\)?\s*$/.test(firstLine);
  const stack = report.stack ? (startsWithFrame ? `${header}\n${report.stack}` : report.stack) : '';
  return {
    severity: 'ERROR',
    '@type': ERROR_EVENT_TYPE,
    message: stack || report.message,
    serviceContext: { service: 'web', version: report.version || 'unknown' },
    context: {
      httpRequest: { url: report.route, userAgent: report.userAgent },
      // Without a parsable stack, Error Reporting needs a location to accept the event.
      reportLocation: { filePath: report.route || '/', lineNumber: 0, functionName: 'web' },
    },
    fn: 'system-logClientError',
    clientError: true,
    route: report.route,
    version: report.version,
    uid: ids.uid,
    sessionId: ids.sessionId,
    ...(sampledOneIn > 1 ? { sampledOneIn } : {}),
  };
}

/**
 * `system-logClientError` (FND-21): the web app's ErrorHandler sends batches of unexpected errors.
 * Each is scrubbed again (the client already did), rate limited per session (20 a minute), sampled
 * during a storm, and written as an Error Reporting event. Signed-out callers can report too (an
 * error on the sign-in page); App Check still applies outside the emulator.
 */
export function createLogClientError(deps: LogClientErrorDeps) {
  const sampler = new StormSampler(deps.random);
  return async (request: Pick<CallableRequest, 'data' | 'auth'>): Promise<LogClientErrorResult> => {
    const parsed = LogClientErrorInputSchema.safeParse(request.data);
    if (!parsed.success) throw new HttpsError('invalid-argument', 'Invalid input', { code: 'INVALID_ARGUMENT' });
    const { sessionId, errors } = parsed.data;
    const uid = request.auth?.uid ?? null;
    const key = `${uid ?? 'anon'}_${sessionId}`.replace(/[^\w-]/g, '_').slice(0, 150);
    const now = deps.clock.now();
    const granted = await takeSlots(deps.db(), key, errors.length, now);
    let accepted = 0;
    for (const report of errors.slice(0, granted)) {
      const sampledOneIn = sampler.take(now.getTime());
      if (!sampledOneIn) continue;
      deps.write(errorEvent(scrubClientError(report), { uid, sessionId }, sampledOneIn));
      accepted++;
    }
    return { accepted, dropped: errors.length - accepted };
  };
}

export const logClientError = onCall(
  {
    region: REGION,
    invoker: 'public',
    enforceAppCheck: !isEmulator(),
    memory: '256MiB',
  },
  createLogClientError({
    db: adminDb,
    clock: systemClock,
    write: (entry) => logger.write(entry as Parameters<typeof logger.write>[0]),
    random: Math.random,
  }),
);
