import { buildWriteEntry, expiryFor, type DocData } from './entry';
import { retentionYears } from './retention';
import { migrationRunOf } from '../core/migration';
import { defineTrigger, type TriggerChange, type TriggerContext, type TriggerDefinition } from '../core/trigger';

/** Run statuses during which the migration tool deletes what runs loaded (MIG-06). */
const DELETING_STATUSES = ['running', 'rolling_back'];

/**
 * Whether a delete is the migration tool's (MIG-06), which records one entry for all of them: a
 * migrated document deleted while its run is rolled back (or after its record went with the
 * org), or while a delta run is deleting what legacy deleted (`--apply-deletes`).
 */
export async function isMigrationDelete(change: TriggerChange, ctx: TriggerContext, orgId: string): Promise<boolean> {
  if (change.after) return false;
  const runId = migrationRunOf(change.before?.data());
  if (!runId) return false;
  const runs = ctx.db.collection(`orgs/${orgId}/migrations`);
  const run = await runs.doc(runId).get();
  if (!run.exists || run.get('status') === 'rolling_back' || run.get('status') === 'rolled_back') return true;
  return !(await runs.where('status', 'in', DELETING_STATUSES).limit(1).get()).empty;
}

/**
 * Writes one audit entry for a document write, with the event id as its id: a redelivered event
 * finds the entry already there (the trigger wrapper's event guard catches most repeats first).
 */
export async function recordWrite(
  change: TriggerChange,
  ctx: TriggerContext,
): Promise<'written' | 'skipped' | 'duplicate'> {
  const snapshot = change.after ?? change.before;
  if (!snapshot) return 'skipped';
  const orgId = ctx.params['orgId'] as string;
  if (await isMigrationDelete(change, ctx, orgId)) {
    ctx.log.debug('not audited', { reason: 'migration delete' });
    return 'skipped';
  }
  const years = await retentionYears(ctx.db, orgId, ctx.clock.now().getTime());
  const result = buildWriteEntry({
    path: snapshot.ref.path,
    before: change.before?.data() as DocData | undefined,
    after: change.after?.data() as DocData | undefined,
    at: ctx.time,
    expireAt: expiryFor(ctx.time, years),
  });
  if ('skip' in result) {
    ctx.log.debug('not audited', { reason: result.skip });
    return 'skipped';
  }
  try {
    await ctx.db.doc(`orgs/${orgId}/audit/${ctx.eventId}`).create(result.entry);
  } catch (error) {
    const code = (error as { code?: number | string }).code;
    if (code === 6 || code === 'already-exists') return 'duplicate';
    throw error;
  }
  ctx.log.info('audited', {
    action: result.entry['action'],
    collection: (result.entry['entity'] as { collection?: string }).collection,
  });
  return 'written';
}

export const onOrgWriteDefinition: TriggerDefinition = {
  name: 'audit-onOrgWrite',
  document: 'orgs/{orgId}/{collection}/{docId}',
  on: 'written',
  handler: async (change, ctx) => void (await recordWrite(change, ctx)),
};

export const onMatterWriteDefinition: TriggerDefinition = {
  name: 'audit-onMatterWrite',
  document: 'orgs/{orgId}/matters/{matterId}/{sub}/{docId}',
  on: 'written',
  handler: async (change, ctx) => void (await recordWrite(change, ctx)),
};

/** `audit-onOrgWrite`: every org-level document (matters, contacts, invoices, members…). */
export const onOrgWrite = defineTrigger(onOrgWriteDefinition);
/** `audit-onMatterWrite`: every matter subcollection document (tasks, deadlines, notes, time…). */
export const onMatterWrite = defineTrigger(onMatterWriteDefinition);
