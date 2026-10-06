import * as D from '@materia/domain';

import {
  backfillMetrics,
  parseArgs,
  restateFrom,
  type MetricsBackfillStore,
  type MetricsDoc,
  type MetricsWrite,
} from './metrics.ts';
import { unwrap } from '../seed/interop.ts';

const domain = unwrap(D);

/** The metrics backfill (INS-01) on a migrated practice, against an in-memory store. Everything is fictional. */

type Data = Record<string, unknown>;

class FakeStore implements MetricsBackfillStore {
  readonly docs = new Map<string, Data>();
  writes = 0;

  set(path: string, data: Data): void {
    this.docs.set(path, data);
  }

  private list(match: (path: string) => boolean): MetricsDoc[] {
    return [...this.docs.keys()]
      .filter(match)
      .sort()
      .map((path) => ({ path, data: structuredClone(this.docs.get(path) as Data) }));
  }

  async orgs() {
    return this.list((path) => path.split('/').length === 2 && path.startsWith('orgs/'))
      .filter((doc) => !doc.data['deletedAt'])
      .map((doc) => doc.path.split('/')[1] as string);
  }
  async get(path: string) {
    return this.docs.get(path) ?? null;
  }
  async getAll(paths: readonly string[]) {
    return paths.map((path) => this.docs.get(path) ?? null);
  }
  async collection(path: string) {
    const depth = path.split('/').length + 1;
    return this.list((doc) => doc.startsWith(`${path}/`) && doc.split('/').length === depth);
  }
  async group(name: string, orgId: string) {
    return this.list((path) => path.split('/').at(-2) === name && this.docs.get(path)?.['orgId'] === orgId);
  }
  async groupUnder(name: string, prefix: string) {
    return this.list((path) => path.startsWith(`${prefix}/`) && path.split('/').at(-2) === name);
  }
  async write(writes: readonly MetricsWrite[]) {
    for (const { path, data } of writes) {
      this.writes++;
      if (data) this.docs.set(path, structuredClone(data));
      else this.docs.delete(path);
    }
  }
}

const ORG = 'org-legacy';
const O = `orgs/${ORG}`;
const TZ = 'Australia/Melbourne';
const NOW = new Date('2026-10-06T03:00:00Z');
const at = (day: string) => new Date(`${day}T10:00:00+10:00`);
const meta = { createdBy: 'migration', updatedBy: 'migration', schemaVersion: 1 };

/** A practice as the legacy migration (MIG) leaves it: years of matters and time, no rollups yet. */
function migrated(): FakeStore {
  const store = new FakeStore();
  store.set(O, { name: 'Bellarine Estates Law', timezone: TZ, fy: { startMonth: 7 } });
  store.set('orgs/org-other', { name: 'Elsewhere Legal', fy: { startMonth: 7 } });
  store.set('orgs/org-gone', { name: 'Closed Practice', deletedAt: NOW });
  store.set(`${O}/contacts/c-acct`, { referrerMeta: { industry: 'accountant' } });
  // Closed in FY2024, with legacy billing: before the restated years.
  store.set(`${O}/matters/m-old`, {
    ...meta,
    type: 'probate',
    status: 'closed',
    createdAt: at('2023-08-01'),
    closedAt: at('2024-05-01'),
    legacyBilling: { billingTotal: 4400, billingDate: '2024-05-02' },
    migratedFrom: 'legacy',
  });
  // Opened in FY2025, referred, granted, distributed and closed in FY2026.
  store.set(`${O}/matters/m-probate`, {
    ...meta,
    type: 'probate',
    status: 'closed',
    createdAt: at('2025-03-03'),
    closedAt: at('2026-02-27'),
    referrerContactId: 'c-acct',
    estate: { grantDate: '2025-09-15' },
    closing: { finalDistributionRecorded: true },
    stageId: 'distribution',
    stageEnteredOn: '2025-11-01',
    legacyBilling: { billingTotal: '2,750.00', billingDate: '2025-10-10' },
  });
  store.set(`${O}/matters/m-will`, {
    ...meta,
    type: 'will',
    status: 'open',
    createdAt: at('2026-07-20'),
    wipCents: 90_000,
  });
  store.set(`${O}/matters/m-destroyed`, { type: 'will', status: 'closed', destroyedAt: at('2026-01-01') });
  const time = (matter: string, id: string, date: string, extra: Data = {}) =>
    store.set(`${O}/matters/${matter}/timeEntries/${id}`, {
      ...meta,
      orgId: ORG,
      matterId: matter,
      uid: 'u-ellis',
      date,
      minutes: 60,
      amountCents: 40_000,
      billable: true,
      status: 'billed',
      ...extra,
    });
  time('m-old', 't1', '2024-02-01');
  time('m-probate', 't2', '2025-06-30');
  time('m-probate', 't3', '2025-07-01', { uid: 'u-park', billable: false, amountCents: 0, status: 'final' });
  time('m-will', 't4', '2026-10-05', { status: 'draft' });
  time('m-destroyed', 't5', '2025-08-01');
  store.set(`${O}/matters/m-probate/deadlines/dl1`, {
    ...meta,
    orgId: ORG,
    status: 'done',
    dueDate: '2025-08-20',
    critical: true,
    resolution: { on: '2025-08-22' },
  });
  store.set(`${O}/matters/m-will/deadlines/dl2`, { ...meta, orgId: ORG, status: 'upcoming', dueDate: '2026-09-30' });
  store.set(`${O}/matters/m-will/disbursements/d1`, {
    ...meta,
    orgId: ORG,
    date: '2026-08-01',
    amountExGstCents: 12_000,
    status: 'unbilled',
  });
  store.set(`${O}/invoices/i1`, {
    ...meta,
    matterId: 'm-probate',
    status: 'paid',
    issueDate: '2025-10-01',
    subtotalCents: 80_000,
    gstCents: 8_000,
    lines: [{ kind: 'time', amountExGstCents: 80_000 }],
    payments: [{ id: 'p1', date: '2025-10-20', amountCents: 88_000 }],
  });
  store.set(`${O}/creditNotes/cn1`, {
    ...meta,
    matterId: 'm-probate',
    issueDate: '2025-11-03',
    subtotalCents: 5_000,
    gstCents: 500,
    lines: [],
  });
  // Earlier rollups: stale figures, a shard, a member document, Clerk's metering and a debtors report.
  store.set(`${O}/metrics/fy-2024`, { period: 'fy-2024', values: { 'time.minutes': 1 }, ...meta });
  store.set(`${O}/metrics/month-2025-10`, {
    period: 'month-2025-10',
    values: { 'time.minutes': 999, 'wip.timeCents': 5 },
    ...meta,
  });
  store.set(`${O}/metrics/month-2025-10/shards/3`, {
    period: 'month-2025-10',
    shard: 3,
    values: { 'billing.invoices': 4 },
    ...meta,
  });
  store.set(`${O}/metrics/fy-2024/shards/1`, {
    period: 'fy-2024',
    shard: 1,
    values: { 'billing.invoices': 2 },
    ...meta,
  });
  store.set(`${O}/metrics/day-2025-08-01/byMember/u-gone`, {
    period: 'day-2025-08-01',
    uid: 'u-gone',
    values: { 'time.minutes': 9 },
    ...meta,
  });
  store.set(`${O}/metrics/clerk-2026-09`, {
    period: 'clerk-2026-09',
    values: { tokens: 300, 'user.u-ellis.tokens': 300 },
  });
  store.set(`${O}/metrics/clerk-2026-10`, { period: 'clerk-2026-10', values: { tokens: 200 } });
  store.set(`${O}/metrics/debtors-2026-10-06`, { period: 'debtors-2026-10-06', values: { totalCents: 33_000 } });
  // A ledger from before: its earlier days stay counted as they were.
  store.set(`${O}/matters/m-probate/metrics/time-t2`, {
    orgId: ORG,
    matterId: 'm-probate',
    kind: 'time',
    sourceId: 't2',
    counted: { '2025-06-30': { 'time.minutes': 30 }, '2025-07-01': { 'time.minutes': 30 } },
  });
  return store;
}

/** The counted figures in a store from `from` on (shards summed, snapshots left out). */
function rollups(store: FakeStore, from: string): Map<string, D.MetricValues> {
  const out = new Map<string, D.MetricValues>();
  for (const [path, data] of store.docs) {
    const parts = path.split('/');
    if (parts[1] !== ORG || parts[2] !== 'metrics' || !domain.METRIC_PERIOD_RE.test(parts[3] ?? '')) continue;
    const range = domain.metricPeriodRange(parts[3] as string, 7);
    if (!range || range.start < from) continue;
    const key =
      parts[4] === 'byMember' ? domain.memberMetricsKey(parts[3] as string, parts[5] as string) : (parts[3] as string);
    const values = out.get(key) ?? {};
    for (const [name, value] of Object.entries((data['values'] as Data) ?? {}))
      if (typeof value === 'number' && !domain.isSnapshotKey(name)) values[name] = (values[name] ?? 0) + value;
    out.set(key, Object.fromEntries(Object.entries(values).filter(([, value]) => value !== 0)));
  }
  return new Map([...out].filter(([, values]) => Object.keys(values).length));
}

const RECORD_KINDS: Partial<Record<string, D.MetricsSourceKind>> = {
  timeEntries: 'time',
  deadlines: 'deadline',
  disbursements: 'disbursement',
  invoices: 'invoice',
  creditNotes: 'creditNote',
};

/** What the records add up to from `from` on, worked out independently. */
function fromRecords(store: FakeStore, from: D.DateOnly): Map<string, D.MetricValues> {
  const contributions: D.MetricContribution[] = [];
  const matter = (id: string) => store.docs.get(`${O}/matters/${id}`);
  const referrer = store.docs.get(`${O}/contacts/c-acct`);
  for (const [path, data] of store.docs) {
    const parts = path.split('/');
    if (parts[1] !== ORG) continue;
    const kind: D.MetricsSourceKind | undefined =
      parts.length === 4 && parts[2] === 'matters'
        ? 'matter'
        : parts.length === 6
          ? RECORD_KINDS[parts[4] as string]
          : parts.length === 4
            ? RECORD_KINDS[parts[2] as string]
            : undefined;
    if (!kind) continue;
    const matterId = kind === 'invoice' || kind === 'creditNote' ? String(data['matterId']) : (parts[3] as string);
    const m = matter(matterId);
    if (!m || m['destroyedAt']) continue;
    const stages =
      kind === 'matter' ? domain.nextStageHistory(undefined, data, domain.dateOnly('2026-10-06')) : undefined;
    contributions.push(
      domain.filterContribution(
        domain.metricsContribution(kind, data, {
          matter: m,
          referrer: m['referrerContactId'] ? referrer : null,
          timeZone: TZ,
          stages,
        }),
        (day) => day >= from,
      ),
    );
  }
  return domain.rollupMetrics(contributions, 7);
}

const sorted = (map: Map<string, D.MetricValues>) =>
  Object.fromEntries([...map].sort(([a], [b]) => a.localeCompare(b)));

describe('restateFrom', () => {
  it('rounds the month back to the start of its financial year', () => {
    expect(restateFrom('2025-09', 7)).toBe('2025-07-01');
    expect(restateFrom('2026-06', 7)).toBe('2025-07-01');
    expect(restateFrom('2026-07', 7)).toBe('2026-07-01');
    expect(restateFrom('2026-03', 1)).toBe('2026-01-01');
    expect(() => restateFrom('2026-13', 7)).toThrow('--from is a month');
  });
});

describe('backfillMetrics on a migrated practice', () => {
  it('restates every period from the FY start on from the records, and leaves earlier ones alone', async () => {
    const store = migrated();
    const report = await backfillMetrics(store, { from: '2025-09', org: ORG, now: NOW });
    expect(report).toMatchObject({ orgs: 1, records: 12, shards: 1 });

    expect(sorted(rollups(store, '2025-07-01'))).toEqual(sorted(fromRecords(store, domain.dateOnly('2025-07-01'))));
    // 30 June 2025 is FY2024's last day, before the restated years; 1 July starts FY2025.
    expect((store.docs.get(`${O}/metrics/day-2025-07-01/byMember/u-park`)?.['values'] as Data)['time.minutes']).toBe(
      60,
    );
    expect(store.docs.get(`${O}/metrics/day-2025-06-30`)).toBeUndefined();
    expect(store.docs.get(`${O}/metrics/fy-2024`)?.['values']).toEqual({ 'time.minutes': 1 });
    expect(store.docs.get(`${O}/metrics/fy-2024/shards/1`)?.['values']).toEqual({ 'billing.invoices': 2 });
    expect(store.docs.get(`${O}/metrics/month-2025-10/shards/3`)?.['values']).toEqual({});
    // The member who left keeps a document, emptied.
    expect(store.docs.get(`${O}/metrics/day-2025-08-01/byMember/u-gone`)?.['values']).toEqual({});

    const fy = store.docs.get(`${O}/metrics/fy-2025`)?.['values'] as Data;
    expect(fy).toMatchObject({
      'legacy.billedCents': 275_000,
      'cycle.probate.instructionsToGrant.d196': 1,
      'cycle.probate.grantToDistribution.d165': 1,
      'matters.closed.referrer.c-acct': 1,
      'referrals.industry.accountant.billedCents': 80_000,
      'billing.collectedCents': 88_000,
      'deadlines.critical.metLate': 1,
    });
    // The destroyed matter's time isn't counted.
    expect(store.docs.get(`${O}/metrics/day-2025-08-01`)?.['values']).not.toHaveProperty('time.minutes');
  });

  it('works out the snapshot figures at each period end, keeping past WIP', async () => {
    const store = migrated();
    await backfillMetrics(store, { from: '2025-07', org: ORG, now: NOW });
    expect(store.docs.get(`${O}/metrics/month-2025-12`)).toMatchObject({
      snapshotOn: '2025-12-31',
      values: { 'active.matters': 1, 'active.matters.type.probate': 1, 'overdue.deadlines': 0 },
    });
    // Kept from before: WIP can't be worked out for a past month.
    expect((store.docs.get(`${O}/metrics/month-2025-10`)?.['values'] as Data)['wip.timeCents']).toBe(5);
    expect(store.docs.get(`${O}/metrics/day-2026-10-05`)).toMatchObject({
      snapshotOn: '2026-10-05',
      values: { 'wip.timeCents': 90_000, 'active.matters': 1, 'overdue.deadlines': 1, 'debtors.totalCents': 33_000 },
    });
    const month = store.docs.get(`${O}/metrics/month-2026-09`)?.['values'] as Data;
    expect(month['clerk.tokens']).toBe(300);
    expect(month).not.toHaveProperty('clerk.user.u-ellis.tokens');
    expect((store.docs.get(`${O}/metrics/fy-2026`)?.['values'] as Data)['clerk.tokens']).toBe(500);
    // Today has no snapshot yet; the nightly run takes it tomorrow.
    expect(store.docs.get(`${O}/metrics/day-2026-10-06`)).toBeUndefined();
  });

  it("keeps a ledger's earlier days and counts the rest afresh, so the triggers carry on from it", async () => {
    const store = migrated();
    await backfillMetrics(store, { from: '2025-07', org: ORG, now: NOW });
    expect(store.docs.get(`${O}/matters/m-probate/metrics/time-t2`)?.['counted']).toEqual({
      '2025-06-30': { 'time.minutes': 30 },
    });
    expect(store.docs.get(`${O}/matters/m-probate/metrics/time-t3`)).toMatchObject({
      kind: 'time',
      counted: { '2025-07-01': expect.objectContaining({ 'time.minutes': 60 }) },
    });
    expect(store.docs.get(`${O}/matters/m-probate/metrics/matter-m-probate`)?.['stages']).toEqual([
      { stageId: 'distribution', enteredOn: '2025-11-01' },
    ]);
    expect(store.docs.get(`${O}/matters/m-destroyed/metrics/time-t5`)).toBeUndefined();
  });

  it('writes nothing the second time, and nothing on a dry run', async () => {
    const store = migrated();
    const dry = await backfillMetrics(store, { from: '2025-07', org: ORG, now: NOW, dryRun: true });
    expect(store.writes).toBe(0);
    expect(dry.documents).toBeGreaterThan(400);
    const log: string[] = [];
    await backfillMetrics(store, { from: '2025-07', now: NOW, log: (line) => log.push(line) });
    expect(log).toEqual([
      expect.stringMatching(/^org-legacy: 12 records, \d+ ledgers, \d+ documents and 1 shards written$/),
      expect.stringMatching(/^org-other: 0 records/),
    ]);
    expect(log.join('\n')).not.toMatch(/Bellarine|Ellis/);
    const again = await backfillMetrics(store, { from: '2025-07', org: ORG, now: NOW });
    expect(again).toMatchObject({ ledgers: 0, documents: 0, shards: 0 });
  });
});

describe('parseArgs', () => {
  it('needs a project and a month', () => {
    expect(parseArgs(['--project', 'materia-v2-dev', '--from', '2025-07'])).toEqual({
      project: 'materia-v2-dev',
      from: '2025-07',
      dryRun: false,
    });
    expect(parseArgs(['--project', 'p', '--from', '2025-07', '--org', 'o1', '--dry-run'])).toEqual({
      project: 'p',
      from: '2025-07',
      org: 'o1',
      dryRun: true,
    });
    expect(() => parseArgs(['--project', 'p'])).toThrow('Usage');
    expect(() => parseArgs(['--project', 'p', '--from', 'July'])).toThrow('--from is a month');
  });
});
