import { randomUUID } from 'node:crypto';

import { getAuth, type Auth } from 'firebase-admin/auth';
import type { Firestore } from 'firebase-admin/firestore';
import type { SecretParam } from 'firebase-functions/params';
import { onCall, type CallableFunction, type CallableRequest } from 'firebase-functions/v2/https';
import type { MemoryOption } from 'firebase-functions/v2/options';
import * as z from 'zod';

import { DomainError, ROLES, type Role } from '@materia/domain';

import { REGION } from '../config';
import type { Clock, Ports } from '../ports';
import { adminApp, adminDb } from './admin';
import { isEmulator } from './env';
import { toHttpsError } from './errors';
import { firestoreIdempotency, type IdempotencyStore } from './idempotency';
import { createLog, functionsSink, type Log, type LogSink } from './log';
import { cachedMemberLookup, type MemberLookup } from './members';
import { ports, systemClock } from '../ports/container';

/** What every handler receives. */
export interface CallableContext<TInput> {
  input: TInput;
  uid: string;
  orgId: string;
  role: Role;
  /** The decoded ID token (for `requireRecentLogin` and other claims). */
  token: Record<string, unknown>;
  requestId: string;
  log: Log;
  clock: Clock;
  db: Firestore;
  ports: Ports;
  /** The Admin Auth client, created on first use (claims, token revocation). */
  auth: () => Auth;
}

export interface CallableDefinition<TSchema extends z.ZodType, TOutput> {
  /** Log name, matching the deployed name (`group-name`). */
  name: string;
  input: TSchema;
  output?: z.ZodType<TOutput>;
  /** Roles allowed to call (usually `PERMISSIONS['<action>']`). */
  roles: readonly Role[];
  /** Enforce App Check (default true; never enforced in the emulator). */
  appCheck?: boolean;
  /** Spend the App Check token (replay protection) for sensitive calls. */
  consumeAppCheckToken?: boolean;
  /** Requires a UUID `requestId` in the input; a repeat call returns the stored result. */
  idempotent?: boolean;
  secrets?: SecretParam[];
  memory?: MemoryOption;
  timeoutSeconds?: number;
  handler: (ctx: CallableContext<z.output<TSchema>>) => TOutput | Promise<TOutput>;
}

export interface CallableDeps {
  db: () => Firestore;
  clock: Clock;
  ports: () => Ports;
  memberLookup: MemberLookup;
  idempotency: IdempotencyStore;
  sink: LogSink;
  /** Admin Auth; handlers that never touch Auth don't need it (unit tests omit it). */
  auth?: () => Auth;
}

/** The request fields the wrapper reads (a subset of `CallableRequest`). */
export type CallableInput = Pick<CallableRequest, 'data'> & {
  auth?: { uid: string; token: Record<string, unknown> } | undefined;
};

const RequestIdSchema = z.uuid();

function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/**
 * The callable pipeline, separated from `onCall` so it can be tested directly:
 * authenticate → claims → role → active member → validate → idempotency → handler → output.
 */
export async function runCallable<TSchema extends z.ZodType, TOutput>(
  def: CallableDefinition<TSchema, TOutput>,
  request: CallableInput,
  deps: CallableDeps,
): Promise<TOutput> {
  const data = (request.data ?? {}) as Record<string, unknown>;
  const suppliedId = typeof data['requestId'] === 'string' ? data['requestId'] : undefined;
  const requestId = suppliedId ?? randomUUID();
  let log = createLog({ fn: def.name, requestId, uid: request.auth?.uid ?? null }, deps.sink);
  let claimed: { orgId: string; requestId: string } | undefined;

  try {
    if (!request.auth) throw new DomainError('UNAUTHENTICATED', 'Sign in required');
    const { uid, token } = request.auth;
    const orgId = token['orgId'];
    const role = token['role'];
    if (typeof orgId !== 'string' || !orgId || !isRole(role)) {
      throw new DomainError('ORG_CLAIM_MISSING', 'No organisation claim on the token');
    }
    log = log.child({ orgId, role });
    // A stale token after an org switch: the client refreshes its token and retries once.
    if (typeof data['orgId'] === 'string' && data['orgId'] !== orgId) {
      throw new DomainError('ORG_CLAIM_MISMATCH', 'The token is for a different organisation; refresh it and retry');
    }
    if (!def.roles.includes(role)) throw new DomainError('PERMISSION_DENIED', `Role ${role} cannot call ${def.name}`);
    if (!(await deps.memberLookup(orgId, uid))) throw new DomainError('MEMBER_INACTIVE', 'Membership is not active');

    const parsed = def.input.safeParse(data);
    if (!parsed.success) throw parsed.error;

    if (def.idempotent) {
      if (!suppliedId || !RequestIdSchema.safeParse(suppliedId).success) {
        throw new DomainError('REQUEST_ID_REQUIRED', 'requestId (a UUID) is required', {
          fields: { requestId: ['Required UUID'] },
        });
      }
      const begun = await deps.idempotency.begin(orgId, requestId, def.name);
      if (begun.replay) {
        log.info('replayed');
        return begun.result as TOutput;
      }
      claimed = { orgId, requestId };
    }

    const result = await def.handler({
      input: parsed.data,
      uid,
      orgId,
      role,
      token,
      requestId,
      log,
      clock: deps.clock,
      db: deps.db(),
      ports: deps.ports(),
      auth: () => {
        if (!deps.auth) throw new Error('No Auth client in the callable dependencies');
        return deps.auth();
      },
    });
    let output: TOutput = result;
    if (def.output) {
      const checked = def.output.safeParse(result);
      // A bad result is a server bug: log the paths and return INTERNAL, not invalid-argument.
      if (!checked.success) {
        log.error('output validation failed', { paths: checked.error.issues.map((issue) => issue.path.join('.')) });
        throw new Error('Output validation failed');
      }
      output = checked.data;
    }
    if (claimed) await deps.idempotency.complete(claimed.orgId, claimed.requestId, output);
    log.info('ok');
    return output;
  } catch (error) {
    if (claimed) await deps.idempotency.abandon(claimed.orgId, claimed.requestId).catch(() => undefined);
    const httpsError = toHttpsError(error, log);
    if (httpsError.code !== 'internal') log.warn('rejected', { code: (httpsError.details as { code?: string })?.code });
    throw httpsError;
  }
}

let defaultDeps: CallableDeps | undefined;

/** Production dependencies, created on first use (keeps cold starts light). */
export function callableDeps(): CallableDeps {
  defaultDeps ??= {
    db: adminDb,
    clock: systemClock,
    ports,
    memberLookup: cachedMemberLookup(adminDb, systemClock),
    idempotency: firestoreIdempotency(adminDb, systemClock),
    sink: functionsSink,
    auth: () => getAuth(adminApp()),
  };
  return defaultDeps;
}

/**
 * A secure, validated, observable callable (FND-15). Export it from a domain group
 * (`export * as matters from './matters'`) so it deploys as `matters-<name>`.
 */
export function defineCallable<TSchema extends z.ZodType, TOutput>(
  def: CallableDefinition<TSchema, TOutput>,
): CallableFunction<z.input<TSchema>, Promise<TOutput>> {
  return onCall(
    {
      region: REGION,
      // Callables are public at the HTTP layer and check auth and App Check themselves. Explicit,
      // so firebase-tools also sets it when updating a function created without it.
      invoker: 'public',
      // App Check is enforced everywhere except the emulator (no App Check provider there).
      enforceAppCheck: (def.appCheck ?? true) && !isEmulator(),
      consumeAppCheckToken: def.consumeAppCheckToken ?? false,
      ...(def.secrets ? { secrets: def.secrets } : {}),
      ...(def.memory ? { memory: def.memory } : {}),
      ...(def.timeoutSeconds ? { timeoutSeconds: def.timeoutSeconds } : {}),
    },
    (request) => runCallable(def, request as CallableInput, callableDeps()),
  );
}
