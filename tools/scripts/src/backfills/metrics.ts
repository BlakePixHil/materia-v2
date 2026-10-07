import { deleteApp, initializeApp } from 'firebase-admin/app';
import { FieldPath, getFirestore, type Firestore } from 'firebase-admin/firestore';

import * as D from '@materia/domain';

import { unwrap } from '../seed/interop.ts';

// Namespace import: the workspace lib loads as CommonJS under tsx, so named imports don't resolve.
const domain = unwrap(D);

/**
 * `materia-scripts backfill-metrics --project <id> --from YYYY-MM|earliest [--org <orgId>] [--dry-run]`
 * (INS-01, ADR-048): restates the practice metrics rollups from the start of the financial year
 * containing `--from` to today, from the records themselves. Run it after a migration (MIG), when
 * an org's time zone or FY start changes, or after the metric definitions change. `--from earliest`
 * starts each org at the FY of its earliest dated figure, so a migrated practice's history (its
 * legacy billing by billing date, MIG-09) reaches Insights however far back it goes.
 *
 * For each org it reads every matter, time entry, disbursement, deadline, invoice and credit note
 * (and each record's ledger), works out what each adds, and then:
 * - rewrites every day, month and FY document from that FY start on (and their member documents)
 *   with what the records add up to, and zeroes their shards;
 * - recomputes the snapshot figures it can (active matters, overdue deadlines, aged debtors,
 *   Clerk's metering) as of each period's end, up to yesterday; WIP is only known now, so past
 *   WIP figures are kept and yesterday's is taken from the matters;
 * - rewrites each record's ledger: earlier days keep what was counted (their documents aren't
 *   touched), later days hold the new count, so the sync triggers carry on from it.
 *
 * Records of destroyed matters are left out (CORE-19). It writes whole documents, so run it when
 * the practice is quiet; the nightly `metrics-recompute` reconciles the current month after it.
 * Idempotent: a second run writes the same figures. Logs counts only, never names. There is no
 * `--down`: every figure it writes is derived from the records, so running it again (or the
 * nightly recompute) is the undo. On dev, the `dev-script` workflow runs it
 * (`backfill-metrics`, args `--from 2025-07`).
 */

type Data = Record<string, unknown>;
type Source = { kind: D.MetricsSourceKind; matterId: string; sourceId: string; data: Data };

export interface MetricsDoc {
  /** The full path (`orgs/o1/metrics/month-2026-10`). */
  path: string;
  data: Data;
}

/** What the backfill needs from Firestore, so a test can run it against a fake. */
export interface MetricsBackfillStore {
  /** The ids of orgs that aren't deleted. */
  orgs(): Promise<string[]>;
  get(path: string): Promise<Data | null>;
  getAll(paths: readonly string[]): Promise<(Data | null)[]>;
  /** Every document in a collection (`orgs/o1/matters`). */
  collection(path: string): Promise<MetricsDoc[]>;
  /** Every document of a collection group with this `orgId` (time entries, disbursements, deadlines). */
  group(name: string, orgId: string): Promise<MetricsDoc[]>;
  /** Every document of a collection group under a path (`byMember` and `shards` under `orgs/o1/metrics`). */
  groupUnder(name: string, prefix: string): Promise<MetricsDoc[]>;
  /** Replaces each document (`set` without merge; null deletes it), in batches. */
  write(writes: readonly MetricsWrite[]): Promise<void>;
}

export interface MetricsWrite {
  path: string;
  data: Data | null;
}

export interface MetricsBackfillReport {
  orgs: number;
  records: number;
  ledgers: number;
  documents: number;
  shards: number;
}

const SYSTEM = 'system';
const str = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
/** JSON with sorted keys, so equal figures compare equal whatever order they were written in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Data)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value ?? null);
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const FIGURE_FIELDS = ['period', 'uid', 'values', 'snapshotOn'] as const;
const sameFigures = (a: Data, b: Data) => FIGURE_FIELDS.every((field) => same(a[field], b[field]));

/** `--from earliest`: each org from the FY of its earliest dated figure. */
export const FROM_EARLIEST = 'earliest';

/** The earliest day any of the contributions counts a figure on, if any. */
export function earliestDay(contributions: readonly D.MetricContribution[]): D.DateOnly | undefined {
  let earliest: D.DateOnly | undefined;
  for (const contribution of contributions)
    for (const cell of Object.keys(contribution)) {
      const date = domain.parseMetricCell(cell)?.date;
      if (date && (!earliest || date < earliest)) earliest = date;
    }
  return earliest;
}

/** The first day of the FY containing `YYYY-MM`. */
export function restateFrom(month: string, fyStartMonth: number): D.DateOnly {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('--from is a month: YYYY-MM');
  const year = domain.fyStartYear(domain.dateOnly(`${month}-01`), fyStartMonth);
  return domain.dateOnly(`${year}-${String(fyStartMonth).padStart(2, '0')}-01`);
}

const RECORD_GROUPS = [
  ['time', 'timeEntries'],
  ['disbursement', 'disbursements'],
  ['deadline', 'deadlines'],
] as const;

async function loadSources(store: MetricsBackfillStore, orgId: string) {
  const org = `orgs/${orgId}`;
  const [matters, invoices, creditNotes, ...groups] = await Promise.all([
    store.collection(`${org}/matters`),
    store.collection(`${org}/invoices`),
    store.collection(`${org}/creditNotes`),
    ...RECORD_GROUPS.map(([, group]) => store.group(group, orgId)),
  ]);
  const live = new Map<string, Data>();
  for (const doc of matters) if (!doc.data['destroyedAt']) live.set(doc.path.split('/')[3] as string, doc.data);
  const sources: Source[] = [...live].map(([id, data]) => ({ kind: 'matter', matterId: id, sourceId: id, data }));
  const add = (kind: D.MetricsSourceKind, docs: readonly MetricsDoc[], matterOf: (doc: MetricsDoc) => unknown) => {
    for (const doc of docs) {
      const matterId = matterOf(doc);
      // Records of destroyed or missing matters are never counted (CORE-19).
      if (typeof matterId === 'string' && live.has(matterId))
        sources.push({ kind, matterId, sourceId: doc.path.split('/').at(-1) as string, data: doc.data });
    }
  };
  RECORD_GROUPS.forEach(([kind], i) => add(kind, groups[i] ?? [], (doc) => doc.path.split('/')[3]));
  add('invoice', invoices, (doc) => doc.data['matterId']);
  add('creditNote', creditNotes, (doc) => doc.data['matterId']);
  return { matters: live, sources };
}

const ledgerPath = (orgId: string, source: Source) =>
  `orgs/${orgId}/matters/${source.matterId}/metrics/${source.kind}-${source.sourceId}`;

const meta = (existing: Data | null | undefined, now: Date) => ({
  createdAt: existing?.['createdAt'] ?? now,
  createdBy: existing?.['createdBy'] ?? SYSTEM,
  updatedAt: now,
  updatedBy: SYSTEM,
  schemaVersion: 1,
});

/** Restates one org's rollups from `from` (an FY start) on. */
export async function backfillOrgMetrics(
  store: MetricsBackfillStore,
  orgId: string,
  fromMonth: string,
  options: { now: Date; dryRun?: boolean },
): Promise<Omit<MetricsBackfillReport, 'orgs'> & { from: D.DateOnly }> {
  const org = (await store.get(`orgs/${orgId}`)) ?? {};
  const timeZone = str(org['timezone']) ?? domain.DEFAULT_ORG_TIMEZONE;
  const startMonth = (org['fy'] as { startMonth?: unknown } | undefined)?.startMonth;
  const fyStartMonth = typeof startMonth === 'number' && startMonth >= 1 && startMonth <= 12 ? startMonth : 7;
  const today = domain.dateOnlyAt(options.now, timeZone);
  const yesterday = domain.addDays(today, -1);

  const { matters, sources } = await loadSources(store, orgId);
  const referrerIds = [...new Set([...matters.values()].map((m) => str(m['referrerContactId'])).filter(Boolean))];
  const referrerPaths = referrerIds.map((id) => `orgs/${orgId}/contacts/${id}`);
  const ledgerPaths = sources.map((source) => ledgerPath(orgId, source));
  const [referrerRows, ledgerRows] = await Promise.all([store.getAll(referrerPaths), store.getAll(ledgerPaths)]);
  const referrers = new Map(referrerPaths.map((path, i) => [path, referrerRows[i] ?? null]));

  // What each record adds, on every day it counts.
  const contributions = sources.map((source, i) => {
    const ledger = ledgerRows[i];
    const matter = matters.get(source.matterId);
    const referrerId = str(matter?.['referrerContactId']);
    const previousStages = ledger?.['stages'] as D.StageVisit[] | undefined;
    const stages = source.kind === 'matter' ? domain.nextStageHistory(previousStages, source.data, today) : undefined;
    const fresh = domain.metricsContribution(source.kind, source.data, {
      matter,
      referrer: referrerId ? (referrers.get(`orgs/${orgId}/contacts/${referrerId}`) ?? null) : null,
      timeZone,
      stages,
    });
    return { fresh, stages, previousStages };
  });
  const start =
    fromMonth === FROM_EARLIEST
      ? (earliestDay(contributions.map((c) => c.fresh)) ?? today).slice(0, 7)
      : fromMonth;
  const from = restateFrom(start, fyStartMonth);
  const fromOn = (day: D.DateOnly) => day >= from;
  const before = (day: D.DateOnly) => day < from;

  // Each record's figures from `from` on, and its ledger.
  const restated: D.MetricContribution[] = [];
  const writes: MetricsWrite[] = [];
  let ledgers = 0;
  sources.forEach((source, i) => {
    const ledger = ledgerRows[i];
    const { fresh, stages, previousStages } = contributions[i] as (typeof contributions)[number];
    const recent = domain.filterContribution(fresh, fromOn);
    restated.push(recent);
    const counted = {
      ...domain.filterContribution((ledger?.['counted'] as D.MetricContribution | undefined) ?? {}, before),
      ...recent,
    };
    if (domain.isEmptyContribution(counted) && !stages?.length) {
      if (ledger) {
        writes.push({ path: ledgerPaths[i] as string, data: null });
        ledgers++;
      }
      return;
    }
    if (same(ledger?.['counted'], counted) && domain.sameStages(previousStages, stages)) return;
    writes.push({
      path: ledgerPaths[i] as string,
      data: {
        orgId,
        matterId: source.matterId,
        kind: source.kind,
        sourceId: source.sourceId,
        counted,
        ...(stages?.length ? { stages } : {}),
        ...meta(ledger, options.now),
      },
    });
    ledgers++;
  });

  // The period documents from `from` on: what the records add up to, plus the snapshot figures.
  const expected = domain.rollupMetrics(restated, fyStartMonth);
  const prefix = `orgs/${orgId}/metrics`;
  const [periodDocs, memberDocs, shardDocs] = await Promise.all([
    store.collection(prefix),
    store.groupUnder('byMember', prefix),
    store.groupUnder('shards', prefix),
  ]);
  const inRange = (period: string) => {
    const range = domain.metricPeriodRange(period, fyStartMonth);
    return !!range && range.start >= from;
  };
  const existing = new Map<string, Data>();
  for (const doc of [...periodDocs, ...memberDocs]) {
    const key = doc.path.slice(prefix.length + 1);
    if (inRange(domain.splitMetricsKey(key).period)) existing.set(key, doc.data);
  }
  const extra = new Map(periodDocs.map((doc) => [doc.path.slice(prefix.length + 1), doc.data]));
  const allMatters = [...matters.values()];
  const deadlines = sources.filter((source) => source.kind === 'deadline').map((source) => source.data);
  const snapshotOf = (period: string): { values: D.MetricValues; asOf: D.DateOnly } | null => {
    const range = domain.metricPeriodRange(period, fyStartMonth);
    if (!range || range.start > yesterday) return null;
    const asOf = range.end < yesterday ? range.end : yesterday;
    const debtors = (extra.get(`debtors-${domain.addDays(asOf, 1)}`) ?? extra.get(`debtors-${asOf}`))?.['values'];
    const clerk: (Data | undefined)[] = [];
    if (!period.startsWith('day-'))
      for (let month = range.start; month <= asOf; month = domain.addMonths(month, 1))
        clerk.push(extra.get(`clerk-${month.slice(0, 7)}`)?.['values'] as Data | undefined);
    const values = domain.snapshotMetrics({
      matters: allMatters,
      deadlines,
      asOf,
      timeZone,
      wip: asOf === yesterday,
      clerk,
      debtors: debtors as Data | undefined,
    });
    return { values, asOf };
  };
  // Every day, month and FY up to yesterday gets its snapshot, even without counted figures.
  const periods = from <= yesterday ? domain.metricPeriodsBetween(from, yesterday, fyStartMonth) : [];
  let documents = 0;
  for (const key of new Set([...periods, ...expected.keys(), ...existing.keys()])) {
    const { period, uid } = domain.splitMetricsKey(key);
    const current = existing.get(key);
    const values: D.MetricValues = { ...(expected.get(key) ?? {}) };
    let snapshotOn = current?.['snapshotOn'];
    if (!uid) {
      // Past WIP can't be worked out again: keep it.
      for (const [name, value] of Object.entries((current?.['values'] as Data | undefined) ?? {}))
        if (name.startsWith('wip.') && typeof value === 'number') values[name] = value;
      const snapshot = snapshotOf(period);
      if (snapshot) {
        Object.assign(values, snapshot.values);
        snapshotOn = snapshot.asOf;
      }
    }
    const data: Data = {
      period,
      ...(uid ? { uid } : {}),
      values,
      ...(!uid && typeof snapshotOn === 'string' ? { snapshotOn } : {}),
      ...meta(current, options.now),
    };
    if (current && sameFigures(current, data)) continue;
    writes.push({ path: `${prefix}/${key}`, data });
    documents++;
  }
  let shards = 0;
  for (const doc of shardDocs) {
    const period = doc.path.slice(prefix.length + 1).split('/')[0] as string;
    const values = (doc.data['values'] as Data | undefined) ?? {};
    if (!inRange(period) || !Object.keys(values).length) continue;
    writes.push({ path: doc.path, data: { ...doc.data, values: {}, updatedAt: options.now, updatedBy: SYSTEM } });
    shards++;
  }
  if (!options.dryRun && writes.length) await store.write(writes);
  return { records: sources.length, ledgers, documents, shards, from };
}

/** Restates every org (or one); with `dryRun`, counts what it would write. */
export async function backfillMetrics(
  store: MetricsBackfillStore,
  options: { from: string; org?: string; now?: Date; dryRun?: boolean; log?: (line: string) => void },
): Promise<MetricsBackfillReport> {
  const orgs = options.org ? [options.org] : await store.orgs();
  const report: MetricsBackfillReport = { orgs: 0, records: 0, ledgers: 0, documents: 0, shards: 0 };
  for (const orgId of orgs) {
    const counts = await backfillOrgMetrics(store, orgId, options.from, {
      now: options.now ?? new Date(),
      ...(options.dryRun ? { dryRun: true } : {}),
    });
    report.orgs++;
    report.records += counts.records;
    report.ledgers += counts.ledgers;
    report.documents += counts.documents;
    report.shards += counts.shards;
    const verb = options.dryRun ? 'to write' : 'written';
    options.log?.(
      `${orgId} (from ${counts.from}): ${counts.records} records, ${counts.ledgers} ledgers, ${counts.documents} documents and ${counts.shards} shards ${verb}`,
    );
  }
  return report;
}

const WRITE_BATCH = 400;

/** The Admin SDK store: collection-group reads by org or by path, batched writes (null deletes). */
export function adminStore(db: Firestore): MetricsBackfillStore {
  const docs = (snap: FirebaseFirestore.QuerySnapshot) =>
    snap.docs.map((doc) => ({ path: doc.ref.path, data: doc.data() as Data }));
  return {
    async orgs() {
      const snap = await db.collection('orgs').get();
      return snap.docs.filter((doc) => !doc.get('deletedAt')).map((doc) => doc.id);
    },
    async get(path) {
      const snap = await db.doc(path).get();
      return snap.exists ? (snap.data() as Data) : null;
    },
    async getAll(paths) {
      const out: (Data | null)[] = [];
      for (let start = 0; start < paths.length; start += 300) {
        const chunk = paths.slice(start, start + 300);
        const snaps = await db.getAll(...chunk.map((path) => db.doc(path)));
        out.push(...snaps.map((snap) => (snap.exists ? (snap.data() as Data) : null)));
      }
      return out;
    },
    async collection(path) {
      return docs(await db.collection(path).get());
    },
    async group(name, orgId) {
      return docs(await db.collectionGroup(name).where('orgId', '==', orgId).get());
    },
    async groupUnder(name, prefix) {
      // A collection group's documents under `{prefix}/{period}/`, by full document path: period
      // ids and uids sort between "!" and "~".
      const snap = await db
        .collectionGroup(name)
        .orderBy(FieldPath.documentId())
        .startAt(`${prefix}/!/${name}/!`)
        .endAt(`${prefix}/~/${name}/~`)
        .get();
      return docs(snap);
    },
    async write(writes) {
      for (let start = 0; start < writes.length; start += WRITE_BATCH) {
        const batch = db.batch();
        for (const { path, data } of writes.slice(start, start + WRITE_BATCH)) {
          if (data) batch.set(db.doc(path), data);
          else batch.delete(db.doc(path));
        }
        await batch.commit();
      }
    },
  };
}

export function parseArgs(argv: string[]): { project: string; from: string; org?: string; dryRun: boolean } {
  const value = (name: string) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const project = value('project') ?? process.env['GCLOUD_PROJECT'];
  const from = value('from');
  const usage =
    'Usage: materia-scripts backfill-metrics --project <id> --from YYYY-MM|earliest [--org <orgId>] [--dry-run]';
  if (!project || !from) throw new Error(usage);
  if (from !== FROM_EARLIEST) restateFrom(from, 7);
  const org = value('org');
  return { project, from, ...(org ? { org } : {}), dryRun: argv.includes('--dry-run') };
}

export async function main(argv: string[] = []): Promise<void> {
  const { project, from, org, dryRun } = parseArgs(argv);
  const app = initializeApp({ projectId: project }, `backfill-metrics-${Date.now()}`);
  try {
    await backfillMetrics(adminStore(getFirestore(app)), {
      from,
      ...(org ? { org } : {}),
      dryRun,
      log: (line) => console.log(line),
    });
  } finally {
    await deleteApp(app);
  }
}
