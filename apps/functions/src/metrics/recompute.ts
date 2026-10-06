import { FieldValue, type DocumentSnapshot, type Firestore } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';

import {
  addDays,
  addMetricValues,
  addMonths,
  dateOnly,
  dateOnlyAt,
  diffContributions,
  fyStartYear,
  instantOf,
  isEmptyContribution,
  isSnapshotKey,
  memberMetricsKey,
  metricPeriods,
  metricPeriodsBetween,
  metricsContribution,
  nextStageHistory,
  rollupMetrics,
  sameStages,
  snapshotMetrics,
  splitMetricsKey,
  subtractMetricValues,
  sumMetricShards,
  type DateOnly,
  type MetricContribution,
  type MetricValues,
  type StageVisit,
} from '@materia/domain';

import {
  ensureMetricsDocs,
  increments,
  ledgerPath,
  metricsConfig,
  metricsPath,
  metricsWrites,
  SYSTEM,
  valuesOf,
  type MetricsConfig,
  type MetricsDeps,
  type MetricsSource,
} from './shared';
import { syncMetrics } from './sync';
import { REGION } from '../config';
import { adminDb } from '../core/admin';
import { orgClock } from '../core/emulator-clock';
import { createLog, functionsSink } from '../core/log';
import { systemClock } from '../ports/container';

/**
 * `metrics-recompute` (INS-01, ADR-048): every night it works out yesterday's month and the current
 * month again from the records themselves and makes the rollups match.
 *
 * 1. Loads the records with figures in the window: every matter, and the time, disbursements,
 *    deadlines, invoices and credit notes dated in it (invoices also when written since it began,
 *    for payments).
 * 2. Re-syncs each record whose ledger differs from what it should count (a missed or failed
 *    trigger), which fixes every period it touches, not only the window's.
 * 3. Compares the window's day and month documents (shards included, member documents too) with
 *    the figures the records add up to, and corrects any difference; a month's correction also
 *    goes to its FY. Each correction is logged as drift (`metrics drift corrected`, counted by the
 *    `metrics_drift` log metric). A document written while the run was reading is left to the
 *    next night.
 * 4. Folds the window's shards back into their period documents.
 * 5. Writes yesterday's snapshot figures (WIP, active matters, overdue deadlines, aged debtors,
 *    Clerk's metering) to its day, month and FY documents.
 */

type Data = Record<string, unknown>;

const DEADLINE_STATUSES = ['upcoming', 'done', 'missed', 'waived'];
const READ_CHUNK = 300;
const WRITE_CHUNK = 400;
const PERIOD_CONCURRENCY = 8;

export interface RecomputeOutcome {
  from: DateOnly;
  to: DateOnly;
  records: number;
  resynced: number;
  /** Day, month, FY and member documents corrected. */
  corrected: number;
  /** Documents written while the run was reading, left to the next night. */
  busy: number;
  folded: number;
  snapshotOn: DateOnly;
}

interface Loaded extends MetricsSource {
  data: Data;
}

const str = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
const matterIdOf = (path: string) => path.split('/')[3] as string;

async function getAllChunked(db: Firestore, paths: readonly string[]): Promise<Map<string, Data>> {
  const found = new Map<string, Data>();
  for (let start = 0; start < paths.length; start += READ_CHUNK) {
    const chunk = paths.slice(start, start + READ_CHUNK);
    if (!chunk.length) continue;
    const snaps = await db.getAll(...chunk.map((path) => db.doc(path)));
    snaps.forEach((snap, i) => {
      if (snap.exists) found.set(chunk[i] as string, snap.data() as Data);
    });
  }
  return found;
}

/** The records with figures in `from`..`to`, and every live matter. */
async function loadWindow(db: Firestore, orgId: string, from: DateOnly, to: DateOnly, since: Date) {
  const org = `orgs/${orgId}`;
  const inRange = (group: string, field: string) =>
    db.collectionGroup(group).where('orgId', '==', orgId).where(field, '>=', from).where(field, '<=', to).get();
  const [matters, time, disbursements, deadlines, issued, written, creditNotes] = await Promise.all([
    db.collection(`${org}/matters`).get(),
    inRange('timeEntries', 'date'),
    inRange('disbursements', 'date'),
    db
      .collectionGroup('deadlines')
      .where('orgId', '==', orgId)
      .where('status', 'in', DEADLINE_STATUSES)
      .where('dueDate', '>=', from)
      .where('dueDate', '<=', to)
      .get(),
    db.collection(`${org}/invoices`).where('issueDate', '>=', from).where('issueDate', '<=', to).get(),
    db.collection(`${org}/invoices`).where('updatedAt', '>=', since).get(),
    db.collection(`${org}/creditNotes`).where('issueDate', '>=', from).where('issueDate', '<=', to).get(),
  ]);
  const matterData = new Map<string, Data>();
  for (const doc of matters.docs) if (!doc.get('destroyedAt')) matterData.set(doc.id, doc.data() as Data);

  const records: Loaded[] = [...matterData].map(([id, data]) => ({ kind: 'matter', matterId: id, sourceId: id, data }));
  const add = (
    kind: Loaded['kind'],
    docs: readonly DocumentSnapshot[],
    matterOf: (doc: DocumentSnapshot) => unknown,
  ) => {
    for (const doc of docs) {
      const matterId = matterOf(doc);
      // Records of destroyed or missing matters are never counted (CORE-19).
      if (typeof matterId === 'string' && matterData.has(matterId))
        records.push({ kind, matterId, sourceId: doc.id, data: doc.data() as Data });
    }
  };
  add('time', time.docs, (doc) => matterIdOf(doc.ref.path));
  add('disbursement', disbursements.docs, (doc) => matterIdOf(doc.ref.path));
  add('deadline', deadlines.docs, (doc) => matterIdOf(doc.ref.path));
  const invoices = new Map([...issued.docs, ...written.docs].map((doc) => [doc.id, doc]));
  add('invoice', [...invoices.values()], (doc) => doc.get('matterId'));
  add('creditNote', creditNotes.docs, (doc) => doc.get('matterId'));
  return { matters: matterData, records };
}

/** Runs `fn` over `items`, a few at a time. */
async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let start = 0; start < items.length; start += limit)
    out.push(...(await Promise.all(items.slice(start, start + limit).map(fn))));
  return out;
}

const writtenSince = (doc: DocumentSnapshot, since: Date) => {
  const at = instantOf(doc.get('updatedAt'));
  return !!at && at.getTime() > since.getTime();
};

interface PeriodState {
  /** Counted figures by key (`month-2026-10`, `month-2026-10/byMember/{uid}`), shards summed, snapshots left out. */
  actual: Map<string, MetricValues>;
  busy: Set<string>;
  /** Periods with shards holding something, to fold. */
  sharded: string[];
}

async function readPeriods(
  db: Firestore,
  orgId: string,
  periods: readonly string[],
  since: Date,
): Promise<PeriodState> {
  const state: PeriodState = { actual: new Map(), busy: new Set(), sharded: [] };
  const counted = (values: MetricValues) =>
    Object.fromEntries(Object.entries(values).filter(([key]) => !isSnapshotKey(key)));
  await mapLimited(periods, PERIOD_CONCURRENCY, async (period) => {
    const path = metricsPath(orgId, period);
    const [main, shards, members] = await Promise.all([
      db.doc(path).get(),
      db.collection(`${path}/shards`).get(),
      db.collection(`${path}/byMember`).get(),
    ]);
    const shardValues = shards.docs.map((doc) => valuesOf(doc.data() as Data));
    state.actual.set(period, counted(sumMetricShards(valuesOf(main.data() as Data | undefined), shardValues)));
    if (writtenSince(main, since) || shards.docs.some((doc) => writtenSince(doc, since))) state.busy.add(period);
    if (shardValues.some((values) => Object.keys(values).length)) state.sharded.push(period);
    for (const member of members.docs) {
      const key = memberMetricsKey(period, member.id);
      state.actual.set(key, counted(valuesOf(member.data() as Data)));
      if (writtenSince(member, since)) state.busy.add(key);
    }
  });
  return state;
}

/** Applies increments to period and member documents (never shards), in batches. */
async function applyIncrements(
  deps: MetricsDeps,
  orgId: string,
  docs: ReadonlyMap<string, MetricValues>,
  at: Date,
): Promise<void> {
  const { db } = deps;
  const writes = metricsWrites(orgId, docs, 1);
  await ensureMetricsDocs(db, writes, at);
  for (let start = 0; start < writes.length; start += WRITE_CHUNK) {
    const batch = db.batch();
    for (const write of writes.slice(start, start + WRITE_CHUNK))
      batch.set(
        db.doc(write.path),
        { values: increments(write.values), updatedAt: at, updatedBy: SYSTEM },
        { merge: true },
      );
    await batch.commit();
  }
}

/** Moves a period's shard figures into its document, in one transaction (shards are zeroed, not deleted). */
async function foldShards(deps: MetricsDeps, orgId: string, period: string, at: Date): Promise<number> {
  const { db } = deps;
  const path = metricsPath(orgId, period);
  await ensureMetricsDocs(db, [{ path, base: { period }, values: {} }], at);
  return db.runTransaction(async (tx) => {
    const shards = await tx.get(db.collection(`${path}/shards`));
    const total = sumMetricShards(
      undefined,
      shards.docs.map((doc) => valuesOf(doc.data() as Data)),
    );
    if (!Object.keys(total).length) return 0;
    tx.set(db.doc(path), { values: increments(total), updatedAt: at, updatedBy: SYSTEM }, { merge: true });
    for (const shard of shards.docs) tx.update(shard.ref, { values: {}, updatedAt: at, updatedBy: SYSTEM });
    return shards.size;
  });
}

/** The FY period a month falls in. */
function fyKeyOf(month: string, fyStartMonth: number): string {
  return `fy-${fyStartYear(dateOnly(`${month.slice(6)}-01`), fyStartMonth)}`;
}

/** An FY's twelve month periods. */
function monthsOf(fy: string, fyStartMonth: number): string[] {
  const start = dateOnly(`${fy.slice(3)}-${String(fyStartMonth).padStart(2, '0')}-01`);
  return Array.from({ length: 12 }, (_, i) => `month-${addMonths(start, i).slice(0, 7)}`);
}

/** Snapshot figures: replaces every snapshot key on the document, removing those no longer there. */
async function writeSnapshot(
  deps: MetricsDeps,
  orgId: string,
  period: string,
  values: MetricValues,
  asOf: DateOnly,
  at: Date,
): Promise<void> {
  const { db } = deps;
  const path = metricsPath(orgId, period);
  await ensureMetricsDocs(db, [{ path, base: { period }, values: {} }], at);
  const current = valuesOf((await db.doc(path).get()).data() as Data | undefined);
  const next: Record<string, unknown> = { ...values };
  for (const key of Object.keys(current)) if (isSnapshotKey(key) && !(key in values)) next[key] = FieldValue.delete();
  // An empty map written with `merge` would clear the document's figures.
  const patch = Object.keys(next).length ? { values: next } : {};
  await db.doc(path).set({ ...patch, snapshotOn: asOf, updatedAt: at, updatedBy: SYSTEM }, { merge: true });
}

/** Snapshot figures for yesterday: the day, its month and its FY (the FY's Clerk figures add up its months). */
async function snapshot(
  deps: MetricsDeps,
  orgId: string,
  config: MetricsConfig,
  asOf: DateOnly,
  today: DateOnly,
  matters: Iterable<Data>,
  windowDeadlines: readonly Data[],
  at: Date,
): Promise<void> {
  const { db } = deps;
  const periods = metricPeriods(asOf, config.fyStartMonth);
  const fyStart = dateOnly(`${periods.fy.slice(3)}-${String(config.fyStartMonth).padStart(2, '0')}-01`);
  const clerkMonths: string[] = [];
  for (let month = fyStart; month <= asOf; month = addMonths(month, 1)) clerkMonths.push(`clerk-${month.slice(0, 7)}`);
  const [upcoming, docs] = await Promise.all([
    db
      .collectionGroup('deadlines')
      .where('orgId', '==', orgId)
      .where('status', '==', 'upcoming')
      .where('dueDate', '<=', asOf)
      .get(),
    getAllChunked(db, [
      metricsPath(orgId, `debtors-${today}`),
      metricsPath(orgId, `debtors-${asOf}`),
      ...clerkMonths.map((period) => metricsPath(orgId, period)),
    ]),
  ]);
  // Deadlines resolved since yesterday were still overdue at its end.
  const deadlines = [
    ...upcoming.docs.map((doc) => doc.data() as Data),
    ...windowDeadlines.filter((d) => d['status'] !== 'upcoming'),
  ];
  const debtors = (docs.get(metricsPath(orgId, `debtors-${today}`)) ??
    docs.get(metricsPath(orgId, `debtors-${asOf}`)))?.['values'] as Data | undefined;
  const clerkOf = (period: string) => docs.get(metricsPath(orgId, period))?.['values'] as Data | undefined;
  const input = { matters: [...matters], deadlines, asOf, timeZone: config.timeZone, wip: true, debtors };
  const common = snapshotMetrics(input);
  const clerkMonth = snapshotMetrics({ ...input, clerk: [clerkOf(`clerk-${asOf.slice(0, 7)}`)] });
  const clerkFy = snapshotMetrics({ ...input, clerk: clerkMonths.map(clerkOf) });
  await writeSnapshot(deps, orgId, periods.day, common, asOf, at);
  await writeSnapshot(deps, orgId, periods.month, clerkMonth, asOf, at);
  await writeSnapshot(deps, orgId, periods.fy, clerkFy, asOf, at);
}

/**
 * Loads the window's records, works out what each should count, and re-syncs those whose ledger
 * says otherwise. `startedAt` is when the reading began: a document written after it may hold
 * figures the records read here don't.
 */
async function loadAndResync(
  deps: MetricsDeps,
  orgId: string,
  config: MetricsConfig,
  window: { from: DateOnly; to: DateOnly; since: Date; today: DateOnly },
) {
  const { db } = deps;
  const startedAt = deps.clock.now();
  const { matters, records } = await loadWindow(db, orgId, window.from, window.to, window.since);
  const referrerIds = [...new Set([...matters.values()].map((m) => str(m['referrerContactId'])).filter(Boolean))];
  const [referrers, ledgers] = await Promise.all([
    getAllChunked(
      db,
      referrerIds.map((id) => `orgs/${orgId}/contacts/${id}`),
    ),
    getAllChunked(
      db,
      records.map((record) => ledgerPath(orgId, record)),
    ),
  ]);
  const fresh: MetricContribution[] = [];
  let resynced = 0;
  for (const record of records) {
    const matter = matters.get(record.matterId);
    const referrerId = str(matter?.['referrerContactId']);
    const ledger = ledgers.get(ledgerPath(orgId, record));
    const previousStages = ledger?.['stages'] as StageVisit[] | undefined;
    const stages = record.kind === 'matter' ? nextStageHistory(previousStages, record.data, window.today) : undefined;
    const contribution = metricsContribution(record.kind, record.data, {
      matter,
      referrer: referrerId ? (referrers.get(`orgs/${orgId}/contacts/${referrerId}`) ?? null) : null,
      timeZone: config.timeZone,
      stages,
    });
    fresh.push(contribution);
    const stale =
      !isEmptyContribution(diffContributions(contribution, (ledger?.['counted'] as MetricContribution) ?? {})) ||
      (record.kind === 'matter' && !sameStages(stages, previousStages));
    if (stale && (await syncMetrics(deps, orgId, record, { config })) === 'synced') resynced++;
  }
  return { matters, records, fresh, resynced, startedAt };
}

/**
 * Recomputes one org's window (yesterday's month through the end of this month, org time zone),
 * corrects drift and writes yesterday's snapshot. Safe to run at any time and more than once.
 */
export async function recomputeOrgMetrics(deps: MetricsDeps, orgId: string): Promise<RecomputeOutcome> {
  const { db, log } = deps;
  const config = await metricsConfig(db, orgId, deps.clock.now().getTime(), true);
  const today = dateOnlyAt((await orgClock(db, orgId, deps.clock)).now(), config.timeZone);
  const yesterday = addDays(today, -1);
  const from = dateOnly(`${yesterday.slice(0, 7)}-01`);
  const to = addDays(addMonths(dateOnly(`${today.slice(0, 7)}-01`), 1), -1);
  // Invoices written since the window began may hold payments dated in it (a day early, for time zones).
  const since = new Date(Date.parse(`${addDays(from, -1)}T00:00:00Z`));

  // 1 and 2, twice when anything was re-synced: the second pass reads the records again, so the
  // comparison starts from what the re-syncs left (their writes would otherwise look like activity).
  let pass = await loadAndResync(deps, orgId, config, { from, to, since, today });
  let resynced = pass.resynced;
  if (pass.resynced) {
    pass = await loadAndResync(deps, orgId, config, { from, to, since, today });
    resynced += pass.resynced;
  }
  const { matters, records, fresh, startedAt: readFrom } = pass;

  // 3. The window's days and months against what the records add up to; then each FY the window
  // touches against the sum of its months (which is what an FY is).
  const windowPeriods = metricPeriodsBetween(from, to, config.fyStartMonth).filter((p) => !p.startsWith('fy-'));
  const inWindow = new Set(windowPeriods);
  const fys = [
    ...new Set(windowPeriods.filter((p) => p.startsWith('month-')).map((p) => fyKeyOf(p, config.fyStartMonth))),
  ];
  const fyMonths = new Map(fys.map((fy) => [fy, monthsOf(fy, config.fyStartMonth)]));
  const otherMonths = [...fyMonths.values()].flat().filter((month) => !inWindow.has(month));
  const expected = rollupMetrics(fresh, config.fyStartMonth, (period) => inWindow.has(period));
  const state = await readPeriods(db, orgId, [...windowPeriods, ...otherMonths, ...fys], readFrom);
  const busy = (key: string) => state.busy.has(key) || state.busy.has(splitMetricsKey(key).period);
  const corrections = new Map<string, MetricValues>();
  for (const key of new Set([...expected.keys(), ...state.actual.keys()])) {
    if (!inWindow.has(splitMetricsKey(key).period) || busy(key)) continue;
    const drift = subtractMetricValues(expected.get(key) ?? {}, state.actual.get(key) ?? {});
    if (Object.keys(drift).length) corrections.set(key, drift);
  }
  for (const [fy, months] of fyMonths) {
    if (busy(fy) || months.some((month) => state.busy.has(month))) continue;
    const sums = new Map<string, MetricValues>();
    for (const [key, values] of [...state.actual, ...corrections]) {
      const { period, uid } = splitMetricsKey(key);
      if (!months.includes(period)) continue;
      const target = uid ? memberMetricsKey(fy, uid) : fy;
      sums.set(target, addMetricValues(sums.get(target) ?? {}, values));
    }
    const fyKeys = [...state.actual.keys()].filter((key) => splitMetricsKey(key).period === fy);
    for (const key of new Set([...sums.keys(), ...fyKeys])) {
      if (busy(key)) continue;
      const drift = subtractMetricValues(sums.get(key) ?? {}, state.actual.get(key) ?? {});
      if (Object.keys(drift).length) corrections.set(key, drift);
    }
  }
  const now = deps.clock.now();
  if (corrections.size) {
    await applyIncrements(deps, orgId, corrections, now);
    log.warn('metrics drift corrected', {
      orgId,
      alert: 'metrics_drift',
      keys: corrections.size,
      periods: [...corrections.keys()].slice(0, 20),
    });
  }

  // 4. Shards back into their documents.
  let folded = 0;
  for (const period of state.sharded) folded += await foldShards(deps, orgId, period, now);

  // 5. Yesterday's snapshot.
  const windowDeadlines = records.filter((record) => record.kind === 'deadline').map((record) => record.data);
  await snapshot(deps, orgId, config, yesterday, today, matters.values(), windowDeadlines, now);

  const outcome: RecomputeOutcome = {
    from,
    to,
    records: records.length,
    resynced,
    corrected: corrections.size,
    busy: state.busy.size,
    folded,
    snapshotOn: yesterday,
  };
  log.info('metrics recomputed', { orgId, ...outcome });
  return outcome;
}

/** Recomputes every live org; one org's failure doesn't stop the others. */
export async function recomputeAllOrgs(deps: MetricsDeps): Promise<number> {
  const orgs = await deps.db.collection('orgs').get();
  let done = 0;
  for (const org of orgs.docs) {
    if (org.get('deletedAt')) continue;
    try {
      await recomputeOrgMetrics(deps, org.id);
      done++;
    } catch (error) {
      deps.log.error('metrics recompute failed', {
        orgId: org.id,
        errorType: error instanceof Error ? error.name : typeof error,
      });
    }
  }
  return done;
}

/** `metrics-recompute` (INS-01): nightly at 02:00 Melbourne time (every org is Victorian in the MVP); logs "ok". */
export const recompute = onSchedule(
  {
    schedule: '0 2 * * *',
    timeZone: 'Australia/Melbourne',
    region: REGION,
    retryCount: 0,
    timeoutSeconds: 1800,
    memory: '1GiB',
  },
  async () => {
    const log = createLog({ fn: 'metrics-recompute' }, functionsSink);
    const orgs = await recomputeAllOrgs({ db: adminDb(), clock: systemClock, log });
    log.info('ok', { orgs });
  },
);
