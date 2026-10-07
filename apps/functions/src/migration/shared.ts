import type { Firestore } from 'firebase-admin/firestore';
import * as z from 'zod';

import { DocIdSchema, MigrationEnrichment, type MigrationEnrichmentPause } from '@materia/domain';

import type { Log } from '../core/log';
import { withDates } from '../docs/store';
import type { FileStore } from '../documents/files';
import type { Clock, Ports } from '../ports';

/**
 * Clerk reading what a legacy migration run loaded (MIG-09, D-21): `migrationEnrichments/{runId}`,
 * driven one step at a time by the `migration-enrich` queue.
 */

export const ENRICH_QUEUE = 'migration-enrich';

/** One step of an enrichment. `seq` is the record's when the step was queued: an older one is stale. */
export const EnrichTaskSchema = z.object({ orgId: DocIdSchema, runId: DocIdSchema, seq: z.number().int().min(0) });
export type EnrichTask = z.infer<typeof EnrichTaskSchema>;

export const enrichmentPath = (orgId: string, runId: string) => `orgs/${orgId}/migrationEnrichments/${runId}`;

/** The task that runs step `seq` (Cloud Tasks makes a task with the same id once). */
export const enrichTaskKey = (task: EnrichTask) => `enrich#${task.orgId}#${task.runId}#${task.seq}`;

/** A document to read: `{matterId}/{docId}`. */
export const documentRef = (matterId: string, docId: string) => `${matterId}/${docId}`;
export function parseDocumentRef(ref: string): { matterId: string; docId: string } {
  const [matterId = '', docId = ''] = ref.split('/');
  return { matterId, docId };
}

/** How long a step works before it hands over to the next (the queue's timeout is 540 s). */
export const STEP_BUDGET_MS = 300_000;
/** Tries at one document or matter before it is passed over. */
export const MAX_ATTEMPTS = 3;
/** How long a failed try waits before the next. */
export const RETRY_DELAY_MS = 60_000;
/** Days an unanswered key-date suggestion stays open (a migration makes many at once). */
export const EVENT_SUGGESTION_TTL_DAYS = 30;

export interface EnrichDeps {
  db: Firestore;
  ports: Ports;
  clock: Clock;
  log: Log;
  files: FileStore;
  /** Milliseconds, for the step's time budget (tests advance it). */
  now?: () => number;
  stepBudgetMs?: number;
}

export type Enrichment = MigrationEnrichment;

/** Reads the record with its defaults; null when there is none, or it doesn't parse. */
export function readEnrichment(data: Record<string, unknown> | undefined): Enrichment | null {
  if (!data) return null;
  const parsed = MigrationEnrichment.schema.safeParse(withDates(data));
  return parsed.success ? parsed.data : null;
}

/** Why the run stopped, for the Settings card and the notification. */
export const PAUSE_TEXT: Record<MigrationEnrichmentPause, string> = {
  allowance: 'it used the allowance you approved',
  budget: 'the practice’s monthly Clerk budget is nearly used',
  clerk_off: 'Clerk, or its suggestions, are switched off for the practice',
};
