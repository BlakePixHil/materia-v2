import { computed, signal, type Signal } from '@angular/core';

import type { DomainError } from '@materia/domain';

import { isTransient, toDomainError } from './errors';

/** How callables reach Functions (the web app's auth port) and how claims are refreshed. */
export interface CallableTransport {
  call<T>(name: string, data: unknown): Promise<T>;
  /** Forces an ID token refresh so new custom claims apply. */
  refreshClaims(): Promise<void>;
}

export interface CallOptions {
  /** Adds a `requestId` so the server runs the action once however often it's retried. */
  idempotent?: boolean;
  /** Re-use this id: the same logical action as an earlier attempt. */
  requestId?: string;
}

export interface CallableClientOptions {
  /** New request ids (tests make them predictable). */
  newId?: () => string;
  /** Waits between retries (tests skip the wait). */
  delay?: (ms: number) => Promise<void>;
  /** Automatic retries of a transient failure, for idempotent calls only. */
  retries?: number;
}

/** A callable bound to one logical action: retrying it re-uses the request id until it succeeds. */
export interface CallableAction<I, O> {
  run(input: I): Promise<O>;
  /** True while a call is in flight (for a pending state on the button). */
  pending: Signal<boolean>;
  error: Signal<DomainError | null>;
  /** The id the next `run` will send (null once an attempt succeeded). */
  requestId(): string | null;
  /** Forgets the pending request id: the next `run` is a new action. */
  reset(): void;
}

const BACKOFF_MS = [250, 1000, 3000];

/**
 * The callable client (FND-19): `call(name, input, { idempotent })`.
 * - Idempotent calls get a `requestId`; every retry of the same logical action sends the same id,
 *   so the server's idempotency record (FND-15) makes a retried write happen once.
 * - Errors become `DomainError`s, using `HttpsError.details.code`.
 * - `ORG_CLAIM_MISMATCH` (the token's org is stale, e.g. just after an org switch) refreshes the
 *   claims and retries once.
 * - Transient failures (`UNAVAILABLE`, `REQUEST_IN_PROGRESS`) retry with backoff, idempotent only.
 * Callables need a connection (ADR-020): offline they fail with `UNAVAILABLE`.
 */
export class CallableClient {
  private readonly inFlight = signal(0);
  private readonly newId: () => string;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly retries: number;

  /** True while any call is in flight. */
  readonly busy = computed(() => this.inFlight() > 0);

  constructor(
    private readonly transport: CallableTransport,
    options: CallableClientOptions = {},
  ) {
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.delay = options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.retries = options.retries ?? BACKOFF_MS.length;
  }

  async call<I extends object, O>(name: string, input: I, options: CallOptions = {}): Promise<O> {
    const requestId = options.idempotent ? (options.requestId ?? this.newId()) : undefined;
    const payload = requestId ? { ...input, requestId } : input;
    let refreshed = false;
    let attempt = 0;
    this.inFlight.update((n) => n + 1);
    try {
      for (;;) {
        try {
          return await this.transport.call<O>(name, payload);
        } catch (raw) {
          const error = toDomainError(raw, 'callable');
          if (error.code === 'ORG_CLAIM_MISMATCH' && !refreshed) {
            // Rejected before the handler ran, so safe to retry even without a request id.
            refreshed = true;
            await this.transport.refreshClaims();
            continue;
          }
          if (requestId && isTransient(error) && attempt < this.retries) {
            await this.delay(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 1000);
            attempt++;
            continue;
          }
          throw error;
        }
      }
    } finally {
      this.inFlight.update((n) => n - 1);
    }
  }

  /** One logical, idempotent action: a failed `run` keeps its request id for the retry. */
  action<I extends object, O>(name: string): CallableAction<I, O> {
    let requestId: string | null = null;
    const pending = signal(false);
    const error = signal<DomainError | null>(null);
    return {
      run: async (input) => {
        requestId ??= this.newId();
        pending.set(true);
        error.set(null);
        try {
          const result = await this.call<I, O>(name, input, { idempotent: true, requestId });
          requestId = null;
          return result;
        } catch (e) {
          error.set(e as DomainError);
          throw e;
        } finally {
          pending.set(false);
        }
      },
      pending: pending.asReadonly(),
      error: error.asReadonly(),
      requestId: () => requestId,
      reset: () => {
        requestId = null;
        error.set(null);
      },
    };
  }
}
