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
import { firestoreIdempotency, userRequestPath, type IdempotencyStore } from './idempotency';
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
  /** Requires a UUID `requestId` in the input; a repeat call by the same person returns the stored result. */
  idempotent?: boolean;
  appCheck?: boolean;
  handler: (ctx: UserCallableContext<z.output<TSchema>>) => TOutput | Promise<TOutput>;
}

export interface UserCallableDeps {
  db: () => Firestore;
  auth: () => Auth;
  clock: Clock;
  sink: LogSink;
  /** Per-person idempotency (`users/{uid}/requests`); required by `idempotent` definitions. */
  idempotency?: IdempotencyStore;
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
  const data = (request.data ?? {}) as Record<string, unknown>;
  const suppliedId = typeof data['requestId'] === 'string' ? data['requestId'] : undefined;
  const requestId = suppliedId ?? randomUUID();
  const uid = request.auth?.uid ?? null;
  const log = createLog({ fn: def.name, requestId, uid }, deps.sink);
  let claimed: { uid: string; store: IdempotencyStore } | undefined;
  try {
    if ((def.auth ?? 'required') === 'required' && !uid) throw new DomainError('UNAUTHENTICATED', 'Sign in required');
    const token = (request.auth?.token as AuthToken | undefined) ?? null;
    if (def.recentLoginMinutes !== undefined)
      requireRecentLogin(token, deps.clock.now().getTime(), def.recentLoginMinutes);
    const parsed = def.input.safeParse(request.data ?? {});
    if (!parsed.success) throw parsed.error;
    if (def.idempotent) {
      if (!uid || !deps.idempotency) throw new Error(`${def.name}: idempotent user callables need a uid and a store`);
      if (!suppliedId) {
        throw new DomainError('REQUEST_ID_REQUIRED', 'requestId (a UUID) is required', {
          fields: { requestId: ['Required UUID'] },
        });
      }
      const begun = await deps.idempotency.begin(uid, requestId, def.name);
      if (begun.replay) {
        log.info('replayed');
        return begun.result as TOutput;
      }
      claimed = { uid, store: deps.idempotency };
    }
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
    if (claimed) await claimed.store.complete(claimed.uid, requestId, result);
    log.info('ok');
    return result;
  } catch (error) {
    if (claimed) await claimed.store.abandon(claimed.uid, requestId).catch(() => undefined);
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
  idempotency: firestoreIdempotency(adminDb, systemClock, userRequestPath),
});

export function defineUserCallable<TSchema extends z.ZodType, TOutput>(
  def: UserCallableDefinition<TSchema, TOutput>,
): CallableFunction<z.input<TSchema>, Promise<TOutput>> {
  return onCall({ region: REGION, enforceAppCheck: (def.appCheck ?? true) && !isEmulator() }, (request) =>
    runUserCallable(def, request as UserCallableRequest, userCallableDeps()),
  );
}
