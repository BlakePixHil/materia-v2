import { randomUUID } from 'node:crypto';

import type { Auth } from 'firebase-admin/auth';
import { getAuth } from 'firebase-admin/auth';
import type { Firestore } from 'firebase-admin/firestore';
import { onCall, type CallableFunction } from 'firebase-functions/v2/https';
import type { z } from 'zod';

import { DomainError } from '@materia/domain';

import { REGION } from '../config';
import type { Clock } from '../ports';
import { adminApp, adminDb } from './admin';
import { isEmulator } from './env';
import { toHttpsError } from './errors';
import { createLog, functionsSink, type Log, type LogSink } from './log';
import { systemClock } from '../ports/container';

/** Seconds since epoch of the sign-in that minted the token (`auth_time`). */
export type AuthToken = Record<string, unknown> & { auth_time?: number };

/** What a user-level handler receives. */
export interface UserCallableContext<TInput> {
  input: TInput;
  /** Null for callables that allow anonymous calls (`auth: 'optional'`). */
  uid: string | null;
  token: AuthToken | null;
  requestId: string;
  log: Log;
  clock: Clock;
  db: Firestore;
  auth: Auth;
}

/**
 * A callable about the person rather than an org (FND-16): recovery codes, account settings.
 * `defineCallable` requires org claims, which a person without an org doesn't have yet.
 */
export interface UserCallableDefinition<TSchema extends z.ZodType, TOutput> {
  name: string;
  input: TSchema;
  /** `required` (default): signed in. `optional`: for flows before sign-in completes. */
  auth?: 'required' | 'optional';
  /** Require a sign-in within this many minutes (`auth_time`), for sensitive actions. */
  recentLoginMinutes?: number;
  appCheck?: boolean;
  handler: (ctx: UserCallableContext<z.output<TSchema>>) => TOutput | Promise<TOutput>;
}

export interface UserCallableDeps {
  db: () => Firestore;
  auth: () => Auth;
  clock: Clock;
  sink: LogSink;
}

export interface UserCallableRequest {
  data?: unknown;
  auth?: { uid: string; token: Record<string, unknown> } | undefined;
}

/**
 * Throws REAUTH_REQUIRED unless the token comes from a sign-in within `maxAgeMinutes`. The client
 * re-authenticates (password or Google) and retries; SEC-04 reuses this for sensitive actions.
 */
export function requireRecentLogin(token: AuthToken | null, nowMs: number, maxAgeMinutes = 5): void {
  const authTime = typeof token?.auth_time === 'number' ? token.auth_time * 1000 : 0;
  if (nowMs - authTime > maxAgeMinutes * 60_000) {
    throw new DomainError('REAUTH_REQUIRED', `Sign in again (within ${maxAgeMinutes} minutes) to do this`);
  }
}

export async function runUserCallable<TSchema extends z.ZodType, TOutput>(
  def: UserCallableDefinition<TSchema, TOutput>,
  request: UserCallableRequest,
  deps: UserCallableDeps,
): Promise<TOutput> {
  const requestId = randomUUID();
  const uid = request.auth?.uid ?? null;
  const log = createLog({ fn: def.name, requestId, uid }, deps.sink);
  try {
    if ((def.auth ?? 'required') === 'required' && !uid) throw new DomainError('UNAUTHENTICATED', 'Sign in required');
    const token = (request.auth?.token as AuthToken | undefined) ?? null;
    if (def.recentLoginMinutes !== undefined)
      requireRecentLogin(token, deps.clock.now().getTime(), def.recentLoginMinutes);
    const parsed = def.input.safeParse(request.data ?? {});
    if (!parsed.success) throw parsed.error;
    const result = await def.handler({
      input: parsed.data,
      uid,
      token,
      requestId,
      log,
      clock: deps.clock,
      db: deps.db(),
      auth: deps.auth(),
    });
    log.info('ok');
    return result;
  } catch (error) {
    const httpsError = toHttpsError(error, log);
    if (httpsError.code !== 'internal') log.warn('rejected', { code: (httpsError.details as { code?: string })?.code });
    throw httpsError;
  }
}

const userCallableDeps = (): UserCallableDeps => ({
  db: adminDb,
  auth: () => getAuth(adminApp()),
  clock: systemClock,
  sink: functionsSink,
});

export function defineUserCallable<TSchema extends z.ZodType, TOutput>(
  def: UserCallableDefinition<TSchema, TOutput>,
): CallableFunction<z.input<TSchema>, Promise<TOutput>> {
  return onCall({ region: REGION, enforceAppCheck: (def.appCheck ?? true) && !isEmulator() }, (request) =>
    runUserCallable(def, request as UserCallableRequest, userCallableDeps()),
  );
}
