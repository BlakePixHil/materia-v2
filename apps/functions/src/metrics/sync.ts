import {
  dateOnlyAt,
  diffContributions,
  isEmptyContribution,
  metricsContribution,
  nextStageHistory,
  rollupMetrics,
  sameStages,
  type MetricContribution,
  type StageVisit,
} from '@materia/domain';

import {
  ensureMetricsDocs,
  increments,
  ledgerPath,
  metricsConfig,
  metricsWrites,
  sourcePath,
  SYSTEM,
  type MetricsConfig,
  type MetricsDeps,
  type MetricsSource,
} from './shared';

type Data = Record<string, unknown>;

export type SyncOutcome = 'synced' | 'unchanged' | 'skipped';

const str = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

/**
 * Brings one record's figures up to date (INS-01, ADR-048). Reads its matter and the matter's
 * referrer contact first; then, in a transaction on the record and its ledger
 * (`matters/{matterId}/metrics/{kind}-{id}`), works out what the record should add now, applies
 * the difference from what the ledger says was counted to the day, month and FY documents (and
 * the member documents) as server increments, and stores the new count. A repeated, late or
 * out-of-order event finds nothing to change; a deleted record takes its figures back out.
 *
 * A destroyed matter's figures stay where they were counted (CORE-19), and a record whose matter
 * is gone is skipped.
 */
export async function syncMetrics(
  deps: MetricsDeps,
  orgId: string,
  source: MetricsSource,
  options: { config?: MetricsConfig } = {},
): Promise<SyncOutcome> {
  const { db, clock } = deps;
  const now = clock.now();
  const config = options.config ?? (await metricsConfig(db, orgId, now.getTime()));
  const matter = (await db.doc(`orgs/${orgId}/matters/${source.matterId}`).get()).data() as Data | undefined;
  if (matter?.['destroyedAt'] || (!matter && source.kind !== 'matter')) return 'skipped';
  const referrerId =
    source.kind === 'time' || source.kind === 'disbursement' || source.kind === 'deadline'
      ? undefined
      : str(matter?.['referrerContactId']);
  const referrer = referrerId
    ? (((await db.doc(`orgs/${orgId}/contacts/${referrerId}`).get()).data() as Data | undefined) ?? null)
    : null;
  const today = dateOnlyAt(now, config.timeZone);
  const sourceRef = db.doc(sourcePath(orgId, source));
  const ledgerRef = db.doc(ledgerPath(orgId, source));

  return db.runTransaction(async (tx) => {
    const [current, ledger] = await tx.getAll(sourceRef, ledgerRef);
    const record = current?.exists ? (current.data() as Data) : undefined;
    // CORE-19: a matter destroyed since it was read keeps its figures too.
    if (source.kind === 'matter' && record?.['destroyedAt']) return 'skipped';
    const counted = (ledger?.get('counted') as MetricContribution | undefined) ?? {};
    const previousStages = ledger?.get('stages') as StageVisit[] | undefined;
    const stages = source.kind === 'matter' ? nextStageHistory(previousStages, record, today) : undefined;
    const next = metricsContribution(source.kind, record, {
      matter: source.kind === 'matter' ? record : matter,
      referrer,
      timeZone: config.timeZone,
      stages,
    });
    const delta = diffContributions(next, counted);
    const stagesChanged = source.kind === 'matter' && !sameStages(stages, previousStages);
    if (isEmptyContribution(delta) && !stagesChanged) return 'unchanged';

    const writes = metricsWrites(orgId, rollupMetrics([delta], config.fyStartMonth), config.shards, deps.random);
    await ensureMetricsDocs(db, writes, now);
    for (const write of writes) {
      tx.set(
        db.doc(write.path),
        { values: increments(write.values), updatedAt: now, updatedBy: SYSTEM },
        { merge: true },
      );
    }
    if (isEmptyContribution(next) && !stages?.length) {
      if (ledger?.exists) tx.delete(ledgerRef);
    } else {
      tx.set(ledgerRef, {
        orgId,
        matterId: source.matterId,
        kind: source.kind,
        sourceId: source.sourceId,
        counted: next,
        ...(stages?.length ? { stages } : {}),
        createdAt: ledger?.get('createdAt') ?? now,
        createdBy: SYSTEM,
        updatedAt: now,
        updatedBy: SYSTEM,
        schemaVersion: 1,
      });
    }
    return 'synced';
  });
}

/** Re-syncs every record of a kind on one matter (its time after a type change; its billing after a referrer change). */
export async function resyncMatterRecords(
  deps: MetricsDeps,
  orgId: string,
  matterId: string,
  kinds: readonly ('time' | 'invoice' | 'creditNote')[],
): Promise<number> {
  const { db } = deps;
  const config = await metricsConfig(db, orgId, deps.clock.now().getTime());
  let synced = 0;
  for (const kind of kinds) {
    const snap =
      kind === 'time'
        ? await db.collection(`orgs/${orgId}/matters/${matterId}/timeEntries`).get()
        : await db
            .collection(`orgs/${orgId}/${kind === 'invoice' ? 'invoices' : 'creditNotes'}`)
            .where('matterId', '==', matterId)
            .get();
    for (const doc of snap.docs) {
      if ((await syncMetrics(deps, orgId, { kind, matterId, sourceId: doc.id }, { config })) === 'synced') synced++;
    }
  }
  return synced;
}
