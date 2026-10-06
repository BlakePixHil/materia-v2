import {
  isSnapshotKey,
  memberMetricsKey,
  METRIC_PERIOD_RE,
  metricsContribution,
  rollupMetrics,
  type MetricContribution,
  type MetricsSourceKind,
  type MetricValues,
  type StageVisit,
} from '@materia/domain';

/**
 * Test helpers for the INS-01 rollups, shared by the unit tests (in-memory Firestore) and the
 * emulator integration test: an org's figures as stored, and the same figures worked out from
 * its records from scratch. Both take every document of a store, by path.
 */

type Data = Record<string, unknown>;

/** The figures in a store: period documents with their shards summed, and member documents, without snapshots. */
export function storedMetrics(docs: ReadonlyMap<string, Data>, orgId: string): Map<string, MetricValues> {
  const out = new Map<string, MetricValues>();
  for (const [path, data] of docs) {
    const parts = path.split('/');
    if (parts[0] !== 'orgs' || parts[1] !== orgId || parts[2] !== 'metrics' || !METRIC_PERIOD_RE.test(parts[3] ?? ''))
      continue;
    if (parts.length !== 4 && parts.length !== 6) continue;
    const period = parts[3] as string;
    const key = parts[4] === 'byMember' ? memberMetricsKey(period, parts[5] as string) : period;
    const values = out.get(key) ?? {};
    for (const [name, value] of Object.entries((data['values'] as Data | undefined) ?? {})) {
      if (typeof value !== 'number' || isSnapshotKey(name)) continue;
      values[name] = (values[name] ?? 0) + value;
      if (values[name] === 0) Reflect.deleteProperty(values, name);
    }
    out.set(key, values);
  }
  return new Map([...out].filter(([, values]) => Object.keys(values).length));
}

const RECORD_KINDS: Record<string, MetricsSourceKind> = {
  timeEntries: 'time',
  disbursements: 'disbursement',
  deadlines: 'deadline',
};

/** What every record of the org adds up to, worked out from scratch. */
export function recordMetrics(
  docs: ReadonlyMap<string, Data>,
  orgId: string,
  options: { timeZone: string; fyStartMonth?: number },
): Map<string, MetricValues> {
  const org = `orgs/${orgId}`;
  const contributions: MetricContribution[] = [];
  for (const [path, data] of docs) {
    const parts = path.split('/');
    if (parts[0] !== 'orgs' || parts[1] !== orgId) continue;
    let kind: MetricsSourceKind | undefined;
    let matterId: unknown;
    if (parts.length === 4 && parts[2] === 'matters') [kind, matterId] = ['matter', parts[3]];
    else if (parts.length === 6 && parts[2] === 'matters' && RECORD_KINDS[parts[4] as string])
      [kind, matterId] = [RECORD_KINDS[parts[4] as string], parts[3]];
    else if (parts.length === 4 && parts[2] === 'invoices') [kind, matterId] = ['invoice', data['matterId']];
    else if (parts.length === 4 && parts[2] === 'creditNotes') [kind, matterId] = ['creditNote', data['matterId']];
    if (!kind) continue;
    const matter = docs.get(`${org}/matters/${String(matterId)}`);
    if (!matter || matter['destroyedAt']) continue;
    const referrerId = matter['referrerContactId'];
    const ledger = docs.get(`${org}/matters/${String(matterId)}/metrics/matter-${String(matterId)}`);
    contributions.push(
      metricsContribution(kind, data, {
        matter,
        referrer: typeof referrerId === 'string' ? (docs.get(`${org}/contacts/${referrerId}`) ?? null) : null,
        timeZone: options.timeZone,
        stages: kind === 'matter' ? (ledger?.['stages'] as StageVisit[] | undefined) : undefined,
      }),
    );
  }
  return new Map(
    [...rollupMetrics(contributions, options.fyStartMonth ?? 7)].filter(([, values]) => Object.keys(values).length),
  );
}

/** A figures map as a plain object in key order, for readable diffs. */
export const sortedMetrics = (map: ReadonlyMap<string, MetricValues>) =>
  Object.fromEntries([...map].sort(([a], [b]) => a.localeCompare(b)));
