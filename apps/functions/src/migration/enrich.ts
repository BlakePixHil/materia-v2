import { FieldValue, type DocumentReference } from 'firebase-admin/firestore';

import { clerkModelFor } from '@materia/clerk';
import {
  can,
  enrichmentEstimateText,
  MIG_W_DOCUMENT_UNREADABLE,
  reviewedCodes,
  suggestedAllowanceCents,
  UNREADABLE_SKIP_REASONS,
  type DocumentIngest,
  type IngestSkipReason,
  type MigrationEnrichmentEstimate,
  type MigrationEnrichmentPause,
  type Role,
} from '@materia/domain';

import { countDocument, estimateCostCents, listRunWork } from './estimate';
import { extractMatterEvents } from './events';
import { meteredGateway, orgBudgetNearlyUsed, pauseReason, type MeteredGateway } from './meter';
import {
  ENRICH_QUEUE,
  enrichmentPath,
  enrichTaskKey,
  MAX_ATTEMPTS,
  PAUSE_TEXT,
  parseDocumentRef,
  readEnrichment,
  RETRY_DELAY_MS,
  STEP_BUDGET_MS,
  type EnrichDeps,
  type EnrichTask,
  type Enrichment,
} from './shared';
import { clerkContext } from '../clerk/context/service';
import { clerkGateway } from '../clerk/service';
import { isDeleted } from '../contacts/shared';
import { gatewayIngestClerk } from '../documents/ingest/clerk';
import { ingestDocument, markIngestFailed, type IngestTask, type OcrBudget } from '../documents/ingest/pipeline';
import { chunkDocumentText } from '../documents/ingest/text';
import { documentPath, isClean } from '../documents/shared';
import { notify } from '../notifications/notify';

/**
 * The enrichment's driver (MIG-09, D-21): each `migration-enrich` task runs one step of a run's
 * enrichment for up to `STEP_BUDGET_MS`, saving its place after every document or matter, then
 * queues the next step. One step at a time, one document at a time: the migration is read at low
 * priority beside the practice's own work.
 *
 * - `estimate` (status `estimating`): lists what the run loaded and counts its pages (no Clerk
 *   calls), then waits for an owner or admin (`awaiting_approval`), who is told.
 * - `ingest`: each document through AI-04 ingestion, with the run's allowance instead of the daily
 *   OCR budget and no per-document notification. One that fails three times is marked failed;
 *   one Clerk can't read (or that failed) is listed for review (`MIG_W_DOCUMENT_UNREADABLE`).
 * - `events`: each open estate matter's key dates (`events.ts`), read as the person who approved.
 * - `finish`: counts the suggestions waiting on the run's matters and tells the approver and owners.
 *
 * The record's `seq` orders the steps: a step changes nothing unless the record still has the
 * `seq` it was queued with, and its hand-over moves it on, so a duplicate or superseded task (a
 * retry, an approval that resumed the run, a rollback that cancelled it) does nothing. The run
 * pauses when its allowance is used, the org's month is nearly used (`meter.ts`), or Clerk is off.
 */

type Data = Record<string, unknown>;

export type StepOutcome = 'stale' | 'continued' | 'waiting' | 'paused' | 'done';

const ACTIVE = new Set(['estimating', 'running']);
const SYSTEM = 'system';

/** Every OCR page the allowance pays for: the enrichment doesn't take the org's daily pages. */
const ALLOWANCE_OCR: OcrBudget = {
  reserve: async (_orgId, wanted) => wanted,
  refund: async () => undefined,
};

class StaleStep extends Error {
  constructor() {
    super('The enrichment moved on');
    this.name = 'StaleStep';
  }
}

export async function enqueueStep(deps: Pick<EnrichDeps, 'ports'>, task: EnrichTask, delayMs = 0): Promise<void> {
  await deps.ports.tasks.enqueue(ENRICH_QUEUE, task, {
    dedupeKey: enrichTaskKey(task),
    ...(delayMs ? { scheduleTime: new Date(Date.now() + delayMs) } : {}),
  });
}

/** The step's writes, each only while the record still has the step's `seq`. */
function stepWriter(deps: EnrichDeps, task: EnrichTask, ref: DocumentReference) {
  const write = async (patch: Data, bump: boolean) => {
    await deps.db.runTransaction(async (tx) => {
      const current = await tx.get(ref);
      if (!current.exists || current.get('seq') !== task.seq || !ACTIVE.has(current.get('status')))
        throw new StaleStep();
      tx.update(ref, {
        ...patch,
        ...(bump ? { seq: task.seq + 1 } : {}),
        updatedAt: deps.clock.now(),
        updatedBy: SYSTEM,
      });
    });
  };
  return {
    /** Saves progress; the step goes on. */
    save: (patch: Data) => write(patch, false),
    /** Ends the step: with `next`, the following one is queued (after `delayMs`). */
    async handoff(patch: Data, next: { delayMs?: number } | null) {
      await write(patch, true);
      if (next) await enqueueStep(deps, { ...task, seq: task.seq + 1 }, next.delayMs);
    },
  };
}

type Writer = ReturnType<typeof stepWriter>;

interface Step {
  deps: EnrichDeps;
  task: EnrichTask;
  record: Enrichment;
  writer: Writer;
  started: number;
  elapsed(): number;
  budget: number;
}

/** Runs one step of a run's enrichment. */
export async function runEnrichmentStep(task: EnrichTask, deps: EnrichDeps): Promise<StepOutcome> {
  const now = deps.now ?? Date.now;
  const ref = deps.db.doc(enrichmentPath(task.orgId, task.runId));
  const record = readEnrichment((await ref.get()).data());
  if (!record) return 'stale';
  if (record.seq !== task.seq) {
    // This step handed over but queueing the next failed, so Cloud Tasks retried it: queue it again
    // (a no-op when it exists).
    if (record.seq === task.seq + 1 && ACTIVE.has(record.status)) await enqueueStep(deps, { ...task, seq: record.seq });
    return 'stale';
  }
  if (!ACTIVE.has(record.status)) return 'stale';
  const started = now();
  const step: Step = {
    deps,
    task,
    record,
    writer: stepWriter(deps, task, ref),
    started,
    elapsed: () => now() - started,
    budget: deps.stepBudgetMs ?? STEP_BUDGET_MS,
  };
  try {
    if (record.status === 'estimating') return await estimateStep(step);
    if (record.phase === 'events') return await eventsStep(step);
    if (record.phase === 'finish') return await finishStep(step);
    return await ingestStep(step);
  } catch (error) {
    if (error instanceof StaleStep) {
      deps.log.info('migration enrichment step superseded', { runId: task.runId, seq: task.seq });
      return 'stale';
    }
    throw error;
  }
}

async function orgModel(step: Step): Promise<string> {
  const org = await step.deps.db.doc(`orgs/${step.task.orgId}`).get();
  return clerkModelFor(org.get('settings.clerk.model'));
}

/** Active owners and admins (who approve it) and the approver. */
async function approvers(step: Step, extra: (string | undefined)[] = []): Promise<string[]> {
  const snap = await step.deps.db
    .collection(`orgs/${step.task.orgId}/members`)
    .where('status', '==', 'active')
    .where('role', 'in', ['owner', 'admin'])
    .get();
  return [
    ...new Set(
      [...extra, ...snap.docs.map((doc) => doc.id)].filter((uid): uid is string => typeof uid === 'string' && !!uid),
    ),
  ];
}

async function tell(
  step: Step,
  recipients: string[],
  message: { title: string; body: string; link: string; key: string },
) {
  const { deps, task } = step;
  try {
    await notify(
      { db: deps.db, orgId: task.orgId, clock: deps.clock, log: deps.log, ports: deps.ports },
      { kind: 'system', recipients, ...message },
    );
  } catch (error) {
    deps.log.warn('migration enrichment notification failed', {
      runId: task.runId,
      errorType: error instanceof Error ? error.name : typeof error,
    });
  }
}

// ---------- estimate ----------

async function estimateStep(step: Step): Promise<StepOutcome> {
  const { deps, task, record, writer } = step;
  let { documents, matters } = record;
  let estimate: MigrationEnrichmentEstimate | undefined = record.estimate;
  let cursor = record.cursor;
  if (!estimate) {
    const work = await listRunWork(deps.db, task.orgId, task.runId);
    ({ documents, matters } = work);
    cursor = 0;
    estimate = {
      documents: documents.length,
      pages: 0,
      ocrPages: 0,
      chars: 0,
      unreadable: 0,
      matters: matters.length,
      costCents: 0,
      model: await orgModel(step),
    };
    await writer.save({ documents, matters, cursor, estimate });
  }
  while (cursor < documents.length) {
    if (step.elapsed() > step.budget) {
      await writer.handoff({ cursor, estimate }, {});
      return 'continued';
    }
    const { matterId, docId } = parseDocumentRef(documents[cursor] ?? '');
    const doc = (await deps.db.doc(documentPath(task.orgId, matterId, docId)).get()).data();
    if (doc) {
      try {
        const counted = await countDocument(deps.files, doc);
        estimate = {
          ...estimate,
          pages: estimate.pages + counted.pages,
          ocrPages: estimate.ocrPages + counted.ocrPages,
          chars: estimate.chars + counted.chars,
          unreadable: estimate.unreadable + (counted.unreadable ? 1 : 0),
        };
      } catch (error) {
        // Counted as unreadable: ingestion will say why.
        estimate = { ...estimate, unreadable: estimate.unreadable + 1 };
        deps.log.warn('migration estimate: document not counted', {
          matterId,
          docId,
          errorType: error instanceof Error ? error.name : typeof error,
        });
      }
    }
    cursor++;
    if (cursor % 20 === 0) await writer.save({ cursor, estimate });
  }

  const model = await orgModel(step);
  estimate = { ...estimate, model, costCents: estimateCostCents(estimate, model) };
  if (!documents.length && !matters.length) {
    await writer.handoff(
      {
        status: 'done',
        phase: 'finish',
        cursor: 0,
        estimate,
        suggestionsWaiting: 0,
        unreadable: 0,
        finishedAt: deps.clock.now(),
      },
      null,
    );
    deps.log.info('migration enrichment: nothing to read', { runId: task.runId });
    return 'done';
  }
  const suggested = suggestedAllowanceCents(estimate.costCents);
  await writer.handoff(
    {
      status: 'awaiting_approval',
      phase: 'ingest',
      cursor: 0,
      attempts: 0,
      estimate,
      suggestedAllowanceCents: suggested,
    },
    null,
  );
  deps.log.info('migration enrichment estimated', { runId: task.runId, ...estimate });
  await tell(step, await approvers(step), {
    title: 'Clerk can read the migrated files',
    body: `${enrichmentEstimateText(estimate)}. Nothing is spent until you approve it in Settings, Clerk and AI.`,
    link: '/settings/clerk',
    key: `migration-enrich-${task.runId}-estimate`,
  });
  return 'waiting';
}

// ---------- shared by the paid phases ----------

async function pause(step: Step, reason: MigrationEnrichmentPause, patch: Data): Promise<StepOutcome> {
  const { deps, task, record } = step;
  await step.writer.handoff({ ...patch, status: 'paused', pausedFor: reason }, null);
  deps.log.info('migration enrichment paused', { runId: task.runId, reason });
  await tell(step, await approvers(step, [record.approvedBy]), {
    title: 'Clerk stopped reading the migrated files',
    body: `It stopped because ${PAUSE_TEXT[reason]}. Resume it in Settings, Clerk and AI.`,
    link: '/settings/clerk',
    key: `migration-enrich-${task.runId}-paused-${task.seq}`,
  });
  return 'paused';
}

function meter(step: Step): MeteredGateway {
  const { deps, record } = step;
  return meteredGateway(deps.gateway ?? clerkGateway({ db: deps.db, ports: deps.ports, clock: deps.clock }), {
    spentMicros: record.spentMicros,
    allowanceMicros: (record.allowanceCents ?? 0) * 10_000,
  });
}

const errorType = (error: unknown) => (error instanceof Error ? error.name : typeof error);

// ---------- ingest ----------

/** Whether a document's ingest ended where a person should look at it: skipped as unreadable, or failed. */
function unreadable(ingest: DocumentIngest | undefined): boolean {
  if (!ingest) return false;
  if (ingest.status === 'failed') return true;
  return ingest.status === 'skipped' && UNREADABLE_SKIP_REASONS.has(ingest.reason as IngestSkipReason);
}

/**
 * Lists the document in the MIG-08 review queue, unless a person has already marked that code
 * reviewed: a later run reading it again doesn't re-open it (D-22). Returns whether it was listed.
 */
async function flagUnreadable(ref: DocumentReference): Promise<boolean> {
  if (reviewedCodes((await ref.get()).data()).includes(MIG_W_DOCUMENT_UNREADABLE)) return false;
  await ref.update({ needsReview: FieldValue.arrayUnion(MIG_W_DOCUMENT_UNREADABLE) });
  return true;
}

async function ingestStep(step: Step): Promise<StepOutcome> {
  const { deps, task, record, writer } = step;
  const gateway = meter(step);
  const clerk = gatewayIngestClerk(gateway, (orgId) => ({
    orgId,
    uid: SYSTEM,
    // As AI-04 ingestion does: Clerk calls need a role with clerk.use, and this runs for the org.
    role: 'admin',
    requestId: `migration-enrich-${task.runId}`,
    log: deps.log,
    clock: deps.clock,
  }));
  const progress = { ...record.progress };
  let cursor = record.cursor;
  let attempts = record.attempts;
  let flagged = record.unreadable ?? 0;
  const state = () => ({ cursor, attempts, progress, unreadable: flagged, spentMicros: gateway.spentMicros() });

  while (cursor < record.documents.length) {
    if (step.elapsed() > step.budget) {
      await writer.handoff(state(), {});
      return 'continued';
    }
    if (await orgBudgetNearlyUsed(deps.db, task.orgId, deps.clock.now())) return pause(step, 'budget', state());
    const { matterId, docId } = parseDocumentRef(record.documents[cursor] ?? '');
    const ref = deps.db.doc(documentPath(task.orgId, matterId, docId));
    const doc = (await ref.get()).data();
    const version = Number(doc?.['version'] ?? 0);
    if (!doc || isDeleted(doc) || !isClean(doc) || version < 1) {
      progress.skipped++;
    } else {
      const ingestTask: IngestTask = { orgId: task.orgId, matterId, docId, version };
      try {
        const outcome = await ingestDocument(ingestTask, {
          db: deps.db,
          files: deps.files,
          embedding: deps.ports.embedding,
          clerk,
          tasks: deps.ports.tasks,
          clock: deps.clock,
          log: deps.log,
          ...(deps.now ? { now: deps.now } : {}),
          timeBudgetMs: Math.max(60_000, step.budget - step.elapsed()),
          ocrBudget: ALLOWANCE_OCR,
          // The next step picks the document up at its checkpoint.
          continueLater: async () => undefined,
          notifySuggestions: false,
        });
        if (outcome === 'continued' || outcome === 'queued') {
          await writer.handoff(state(), {});
          return 'continued';
        }
        const ingest = (await ref.get()).get('ingest') as DocumentIngest | undefined;
        if (ingest?.status === 'done') progress.read++;
        else progress.skipped++;
        if (unreadable(ingest) && (await flagUnreadable(ref))) flagged++;
      } catch (error) {
        const reason = pauseReason(error);
        if (reason) return pause(step, reason, state());
        attempts++;
        deps.log.warn('migration ingest failed', { matterId, docId, attempt: attempts, errorType: errorType(error) });
        if (attempts < MAX_ATTEMPTS) {
          await writer.handoff(state(), { delayMs: RETRY_DELAY_MS });
          return 'continued';
        }
        await markIngestFailed(deps.db, ingestTask, error, deps.clock.now());
        if (await flagUnreadable(ref)) flagged++;
        progress.failed++;
      }
    }
    cursor++;
    attempts = 0;
    await writer.save(state());
  }
  await writer.handoff({ ...state(), phase: 'events', cursor: 0, attempts: 0 }, {});
  return 'continued';
}

// ---------- events ----------

/** Clerk reads the matters as the person who approved (an active owner when they've gone). */
async function reader(step: Step): Promise<{ uid: string; role: Role } | null> {
  const { deps, task, record } = step;
  if (record.approvedBy) {
    const member = (await deps.db.doc(`orgs/${task.orgId}/members/${record.approvedBy}`).get()).data();
    const role = member?.['role'] as Role | undefined;
    if (member?.['status'] === 'active' && role && can(role, 'clerk.use')) return { uid: record.approvedBy, role };
  }
  const owners = await deps.db
    .collection(`orgs/${task.orgId}/members`)
    .where('status', '==', 'active')
    .where('role', '==', 'owner')
    .limit(1)
    .get();
  const owner = owners.docs[0];
  return owner ? { uid: owner.id, role: 'owner' } : null;
}

/** Errors that mean this matter can't be read (gone, closed since, no longer visible): passed over. */
const PASS_OVER = new Set(['NOT_FOUND', 'PERMISSION_DENIED', 'FAILED_PRECONDITION', 'INVALID_ARGUMENT']);

async function eventsStep(step: Step): Promise<StepOutcome> {
  const { deps, task, record, writer } = step;
  const gateway = meter(step);
  const progress = { ...record.progress };
  let cursor = record.cursor;
  let attempts = record.attempts;
  const state = () => ({ cursor, attempts, progress, spentMicros: gateway.spentMicros() });
  const who = record.matters.length > cursor ? await reader(step) : null;
  if (record.matters.length > cursor && !who) return pause(step, 'clerk_off', state());
  const context = clerkContext({ db: deps.db, embedding: deps.ports.embedding });
  const text = chunkDocumentText(deps.db);

  while (cursor < record.matters.length && who) {
    if (step.elapsed() > step.budget) {
      await writer.handoff(state(), {});
      return 'continued';
    }
    if (await orgBudgetNearlyUsed(deps.db, task.orgId, deps.clock.now())) return pause(step, 'budget', state());
    const matterId = record.matters[cursor] ?? '';
    try {
      const result = await extractMatterEvents(
        { db: deps.db, gateway, context, text, clock: deps.clock, log: deps.log },
        {
          orgId: task.orgId,
          uid: who.uid,
          role: who.role,
          requestId: `migration-enrich-${task.runId}-${matterId}`,
          log: deps.log,
          clock: deps.clock,
        },
        matterId,
      );
      progress.events += result.created;
      progress.mattersRead++;
    } catch (error) {
      const reason = pauseReason(error);
      if (reason) return pause(step, reason, state());
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'string' && PASS_OVER.has(code)) {
        deps.log.info('migration key dates: matter passed over', { matterId, code });
        progress.mattersRead++;
      } else {
        attempts++;
        deps.log.warn('migration key dates failed', { matterId, attempt: attempts, errorType: errorType(error) });
        if (attempts < MAX_ATTEMPTS) {
          await writer.handoff(state(), { delayMs: RETRY_DELAY_MS });
          return 'continued';
        }
        progress.mattersRead++;
      }
    }
    cursor++;
    attempts = 0;
    await writer.save(state());
  }
  await writer.handoff({ ...state(), phase: 'finish', cursor: 0, attempts: 0 }, {});
  return 'continued';
}

// ---------- finish ----------

async function finishStep(step: Step): Promise<StepOutcome> {
  const { deps, task, record, writer } = step;
  const matterIds = [
    ...new Set([...record.documents.map((ref) => parseDocumentRef(ref).matterId), ...record.matters]),
  ].filter(Boolean);
  let waiting = 0;
  for (const matterId of matterIds) {
    const snap = await deps.db
      .collection(`orgs/${task.orgId}/matters/${matterId}/suggestions`)
      .where('status', '==', 'proposed')
      .count()
      .get();
    waiting += snap.data().count;
  }
  const unreadableCount = record.unreadable ?? 0;
  await writer.handoff(
    { status: 'done', suggestionsWaiting: waiting, unreadable: unreadableCount, finishedAt: deps.clock.now() },
    null,
  );
  const { read, events } = record.progress;
  deps.log.info('migration enrichment done', {
    runId: task.runId,
    ...record.progress,
    waiting,
    unreadable: unreadableCount,
  });
  const documents = `${read.toLocaleString('en-AU')} ${read === 1 ? 'document' : 'documents'} read`;
  const dates = `${events.toLocaleString('en-AU')} key ${events === 1 ? 'date' : 'dates'} found`;
  const review = `${waiting.toLocaleString('en-AU')} ${waiting === 1 ? 'suggestion is' : 'suggestions are'} waiting for review`;
  const unread = unreadableCount
    ? ` ${unreadableCount.toLocaleString('en-AU')} ${unreadableCount === 1 ? 'document' : 'documents'} couldn’t be read and ${unreadableCount === 1 ? 'is' : 'are'} listed for migration review.`
    : '';
  await tell(step, await approvers(step, [record.approvedBy]), {
    title: 'Clerk has read the migrated files',
    body: `${documents} and ${dates}: ${review}.${unread}`,
    link: '/inbox',
    key: `migration-enrich-${task.runId}-done`,
  });
  return 'done';
}
