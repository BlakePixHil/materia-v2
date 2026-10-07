import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import {
  onDocumentCreated,
  onDocumentDeleted,
  onDocumentUpdated,
  onDocumentWritten,
  type Change,
  type DocumentSnapshot,
  type FirestoreEvent,
} from 'firebase-functions/v2/firestore';

import { REGION } from '../config';
import type { Clock, Ports } from '../ports';
import { adminDb } from './admin';
import { createLog, errorReportFields, functionsSink, type Log, type LogSink } from './log';
import { cachedPurgeLookup, type PurgeLookup } from './purge-guard';
import { ports, systemClock } from '../ports/container';

const GUARD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type TriggerKind = 'written' | 'created' | 'updated' | 'deleted';

export interface TriggerContext {
  eventId: string;
  /** When the write happened (the event time, not the client's clock). */
  time: Date;
  params: Record<string, string>;
  log: Log;
  clock: Clock;
  db: Firestore;
  ports: Ports;
}

/** What the handler gets: before/after snapshots (either may be undefined). */
export interface TriggerChange {
  before: DocumentSnapshot | undefined;
  after: DocumentSnapshot | undefined;
}

export interface TriggerDefinition {
  name: string;
  /** Document path pattern, e.g. `orgs/{orgId}/matters/{matterId}`. */
  document: string;
  on: TriggerKind;
  handler: (change: TriggerChange, ctx: TriggerContext) => void | Promise<void>;
}

export interface TriggerDeps {
  db: () => Firestore;
  clock: Clock;
  ports: () => Ports;
  sink: LogSink;
  /** Whether the event's practice is being deleted (SEC-05); unit tests may omit it. */
  purging?: PurgeLookup;
}

/** The parts of a Firestore event the wrapper reads. */
export interface TriggerEvent {
  id: string;
  /** RFC 3339 event time; the clock's now when absent. */
  time?: string | undefined;
  params: Record<string, string>;
  change: TriggerChange;
}

/**
 * Runs a trigger handler once per event id: `eventGuards/{fn}-{eventId}` is created first, so a
 * redelivered event is skipped. An event in a practice being deleted (its `deletedOrgs` tombstone
 * exists, SEC-05) is skipped before that. The guard is per function because every trigger on the same write
 * gets the same event id (a document write runs `documents-onWrite`, `documents-onIngestChange`
 * and `audit-onMatterWrite`); a guard on the id alone let the first of them skip the others.
 * Retries are off; a failure is logged as a dead letter (with ids only) and not rethrown.
 */
export async function runTrigger(
  def: TriggerDefinition,
  event: TriggerEvent,
  deps: TriggerDeps,
): Promise<'ran' | 'duplicate' | 'failed' | 'purging'> {
  const log = createLog({ fn: def.name, eventId: event.id, orgId: event.params['orgId'] ?? null }, deps.sink);
  const db = deps.db();
  const orgId = event.params['orgId'];
  if (orgId && deps.purging && (await deps.purging(orgId))) {
    log.info('skipped: the practice is being deleted');
    return 'purging';
  }
  try {
    await db.doc(eventGuardPath(def.name, event.id)).create({
      fn: def.name,
      expiresAt: Timestamp.fromMillis(deps.clock.now().getTime() + GUARD_TTL_MS),
    });
  } catch (error) {
    if ((error as { code?: number | string }).code === 6 || (error as { code?: string }).code === 'already-exists') {
      log.info('duplicate event skipped');
      return 'duplicate';
    }
    throw error;
  }
  try {
    await def.handler(event.change, {
      eventId: event.id,
      time: event.time ? new Date(event.time) : deps.clock.now(),
      params: event.params,
      log,
      clock: deps.clock,
      db,
      ports: deps.ports(),
    });
    log.info('ok');
    return 'ran';
  } catch (error) {
    log.error('dead-letter', {
      deadLetter: true,
      document: def.document,
      params: event.params,
      ...errorReportFields(error),
    });
    return 'failed';
  }
}

/** The idempotency guard of one function's run for one event. */
export const eventGuardPath = (fn: string, eventId: string) => `eventGuards/${fn}-${eventId}`;

let purging: PurgeLookup | undefined;
/** One tombstone lookup per instance, shared by its triggers and queues. */
export const purgeLookup = (): PurgeLookup => (purging ??= cachedPurgeLookup(adminDb, systemClock));

const triggerDeps = (): TriggerDeps => ({
  db: adminDb,
  clock: systemClock,
  ports,
  sink: functionsSink,
  purging: purgeLookup(),
});

type AnyEvent = FirestoreEvent<Change<DocumentSnapshot> | DocumentSnapshot | undefined, Record<string, string>>;

export function toChange(kind: TriggerKind, data: AnyEvent['data']): TriggerChange {
  if (!data) return { before: undefined, after: undefined };
  if (kind === 'created') return { before: undefined, after: data as DocumentSnapshot };
  if (kind === 'deleted') return { before: data as DocumentSnapshot, after: undefined };
  const change = data as Change<DocumentSnapshot>;
  return {
    before: change.before.exists ? change.before : undefined,
    after: change.after.exists ? change.after : undefined,
  };
}

/** A Firestore trigger with logging, an event-id idempotency guard, no retries and a dead-letter log. */
export function defineTrigger(def: TriggerDefinition) {
  const options = { document: def.document, region: REGION, retry: false };
  const run = (event: AnyEvent) =>
    runTrigger(
      def,
      { id: event.id, time: event.time, params: event.params, change: toChange(def.on, event.data) },
      triggerDeps(),
    ).then(() => undefined);
  switch (def.on) {
    case 'created':
      return onDocumentCreated(options, run);
    case 'updated':
      return onDocumentUpdated(options, run);
    case 'deleted':
      return onDocumentDeleted(options, run);
    default:
      return onDocumentWritten(options, run);
  }
}
