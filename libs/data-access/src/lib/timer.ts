import { inject, InjectionToken } from '@angular/core';
import type { DocumentData, DocumentSnapshot } from 'firebase/firestore';

import {
  TIMER_CALLABLES,
  TIMER_DOC_ID,
  Timer,
  type StopTimerInput,
  type StopTimerResult,
  type TimerForgottenReason,
} from '@materia/domain';

import type { CallableClient } from './callable-client';
import { toDomainError } from './errors';
import { FirestoreClient, type FirestoreSource } from './firestore/firestore-client';

/*
 * The global timer's data (BILL-02): `users/{uid}/timer/current`, read and written through the
 * full SDK directly (a transaction keeps it to one timer, and starts and resumes stamp the
 * server's time), and the `time-stopTimer` callable. Small enough for the initial bundle: the SDK
 * itself loads lazily (ADR-024).
 */

/** The timer as the app reads it. Dates are the server's (estimated locally while a write is pending). */
export interface TimerState {
  orgId: string;
  matterId: string;
  matterNumber: string;
  taskId?: string | undefined;
  startedAt: Date | null;
  accumulatedMs: number;
  running: boolean;
  narrativeDraft: string;
  lastHeartbeatAt: Date | null;
  clientStarted: boolean;
  needsReview?: boolean | undefined;
  forgotten?: { reason: TimerForgottenReason; at: Date } | undefined;
  forgottenSeenAt?: Date | undefined;
}

/** One answer from the listener. */
export interface TimerSnapshot {
  timer: TimerState | null;
  /** A local write hasn't reached the server yet (its server times are estimates). */
  pending: boolean;
  fromCache: boolean;
}

/** What starting a timer needs. */
export interface TimerStart {
  orgId: string;
  matterId: string;
  matterNumber: string;
  taskId?: string | undefined;
  narrativeDraft?: string | undefined;
}

/** A change to the timer. `'server'` stamps the server's time; a Date is the device's clock (offline). */
export interface TimerPatch {
  running?: boolean;
  accumulatedMs?: number;
  startedAt?: 'server' | Date;
  clientStarted?: boolean;
  narrativeDraft?: string;
  taskId?: string;
  needsReview?: boolean;
  forgottenSeenAt?: 'server';
}

export type TimerStartOutcome = { started: true } | { started: false; current: TimerState };

/** The timer's storage. `TIMER_PORT` is the Firestore one; tests provide a fake. */
export interface TimerPort {
  /** Listens to the timer; returns the unsubscribe. */
  watch(uid: string, next: (snapshot: TimerSnapshot) => void, error: (error: unknown) => void): () => void;
  /**
   * Starts a timer unless one exists (then returns it). Online, in a transaction, so two tabs or
   * devices pressing start together end with one. `offline` writes a client-time start
   * (`clientStarted`) to the local cache instead, synced on reconnect; the caller checks first that
   * there's no timer in its cache.
   */
  start(uid: string, start: TimerStart, options: { offline: boolean; now: Date }): Promise<TimerStartOutcome>;
  /**
   * Updates it, stamping `lastHeartbeatAt` (and the meta) with the server's time. Applied locally at
   * once; the promise settles when the server has it (offline, on reconnect), so don't block on it.
   */
  update(uid: string, patch: TimerPatch): Promise<void>;
  /** Deletes it (discard); settles like `update`. */
  discard(uid: string): Promise<void>;
}

const asDate = (value: unknown): Date | null =>
  value instanceof Date ? value : ((value as { toDate?: () => Date } | null | undefined)?.toDate?.() ?? null);

/** A stored timer, read loosely (a bad field falls back rather than failing the shell). */
export function readTimer(data: Record<string, unknown> | undefined | null): TimerState | null {
  if (!data || typeof data['matterId'] !== 'string') return null;
  const forgotten = data['forgotten'] as { reason?: unknown; at?: unknown } | undefined;
  const forgottenAt = asDate(forgotten?.at);
  return {
    orgId: String(data['orgId'] ?? ''),
    matterId: data['matterId'],
    matterNumber: String(data['matterNumber'] ?? data['matterId']),
    taskId: typeof data['taskId'] === 'string' ? data['taskId'] : undefined,
    startedAt: asDate(data['startedAt']),
    accumulatedMs: typeof data['accumulatedMs'] === 'number' ? data['accumulatedMs'] : 0,
    running: data['running'] === true,
    narrativeDraft: typeof data['narrativeDraft'] === 'string' ? data['narrativeDraft'] : '',
    lastHeartbeatAt: asDate(data['lastHeartbeatAt']),
    clientStarted: data['clientStarted'] === true,
    needsReview: typeof data['needsReview'] === 'boolean' ? data['needsReview'] : undefined,
    forgotten:
      forgottenAt && (forgotten?.reason === 'long' || forgotten?.reason === 'midnight')
        ? { reason: forgotten.reason, at: forgottenAt }
        : undefined,
    forgottenSeenAt: asDate(data['forgottenSeenAt']) ?? undefined,
  };
}

/** The Firestore timer port on the app's one SDK instance. */
export function firestoreTimerPort(source: FirestoreSource): TimerPort {
  const ref = async (uid: string) => {
    const handle = await source.get();
    return { handle, ref: handle.sdk.doc(handle.db, `users/${uid}/timer/${TIMER_DOC_ID}`) };
  };
  // Counted for sign-out's "You have unsynced changes" until the server has them.
  const tracked = <T>(write: Promise<T>) => source.track?.(write) ?? write;
  const read = (snap: DocumentSnapshot<DocumentData>) =>
    snap.exists() ? readTimer(snap.data({ serverTimestamps: 'estimate' })) : null;
  return {
    watch(uid, next, error) {
      let stopped = false;
      let unsubscribe: (() => void) | undefined;
      ref(uid).then(
        ({ handle, ref: docRef }) => {
          if (stopped) return;
          unsubscribe = handle.sdk.onSnapshot(
            docRef,
            { includeMetadataChanges: true },
            (snap) =>
              next({ timer: read(snap), pending: snap.metadata.hasPendingWrites, fromCache: snap.metadata.fromCache }),
            error,
          );
        },
        (e: unknown) => {
          if (!stopped) error(e);
        },
      );
      return () => {
        stopped = true;
        unsubscribe?.();
      };
    },

    async start(uid, start, options) {
      const { handle, ref: docRef } = await ref(uid);
      const { sdk } = handle;
      const now = sdk.serverTimestamp();
      const data = (startedAt: unknown, clientStarted: boolean) => ({
        orgId: start.orgId,
        matterId: start.matterId,
        matterNumber: start.matterNumber.slice(0, 64),
        ...(start.taskId ? { taskId: start.taskId } : {}),
        startedAt,
        accumulatedMs: 0,
        running: true,
        narrativeDraft: start.narrativeDraft ?? '',
        lastHeartbeatAt: now,
        ...(clientStarted ? { clientStarted: true } : {}),
        createdAt: now,
        createdBy: uid,
        updatedAt: now,
        updatedBy: uid,
        schemaVersion: Timer.version,
      });
      try {
        if (options.offline) {
          // The caller checks the timer it has (from the listener's cache) first. Not awaited: offline it resolves only once the server has it.
          void tracked(sdk.setDoc(docRef, data(options.now, true))).catch(() => undefined);
          return { started: true };
        }
        return await sdk.runTransaction(handle.db, async (tx) => {
          const current = read(await tx.get(docRef));
          if (current) return { started: false, current } as const;
          tx.set(docRef, data(now, false));
          return { started: true } as const;
        });
      } catch (error) {
        throw toDomainError(error, 'write');
      }
    },

    async update(uid, patch) {
      const { handle, ref: docRef } = await ref(uid);
      const { sdk } = handle;
      const now = sdk.serverTimestamp();
      const { startedAt, forgottenSeenAt, ...rest } = patch;
      try {
        await tracked(
          sdk.updateDoc(docRef, {
            ...rest,
            ...(startedAt ? { startedAt: startedAt === 'server' ? now : startedAt } : {}),
            ...(forgottenSeenAt ? { forgottenSeenAt: now } : {}),
            lastHeartbeatAt: now,
            updatedAt: now,
            updatedBy: uid,
          }),
        );
      } catch (error) {
        throw toDomainError(error, 'write');
      }
    },

    async discard(uid) {
      const { handle, ref: docRef } = await ref(uid);
      try {
        await tracked(handle.sdk.deleteDoc(docRef));
      } catch (error) {
        throw toDomainError(error, 'write');
      }
    },
  };
}

/** The timer's storage: the full-SDK Firestore by default. */
export const TIMER_PORT = new InjectionToken<TimerPort>('TIMER_PORT', {
  providedIn: 'root',
  factory: () => firestoreTimerPort(inject(FirestoreClient)),
});

type Input<T> = Omit<T, 'requestId'>;

/** The timer's callable (BILL-02). */
export interface TimerCallables {
  /** `time-stopTimer` (time.record; idempotent): saves the timer as draft entries and deletes it. */
  stop(input: Input<StopTimerInput>, options?: { requestId?: string }): Promise<StopTimerResult>;
}

export function timerCallables(client: Pick<CallableClient, 'call'>): TimerCallables {
  return {
    stop: (input, options = {}) =>
      client.call<Input<StopTimerInput>, StopTimerResult>(TIMER_CALLABLES.stop, input, {
        idempotent: true,
        ...options,
      }),
  };
}
