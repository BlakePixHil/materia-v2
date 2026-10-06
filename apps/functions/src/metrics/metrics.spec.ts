import type { DocumentSnapshot } from 'firebase-admin/firestore';

import { recomputeAllOrgs, recomputeOrgMetrics } from './recompute';
import { metricsWrites, resetMetricsCaches } from './shared';
import { syncMetrics } from './sync';
import { recordMetrics, sortedMetrics, storedMetrics } from './testing';
import {
  onContactDefinition,
  onCreditNoteDefinition,
  onDeadlineDefinition,
  onDisbursementDefinition,
  onInvoiceDefinition,
  onMatterDefinition,
  onTimeEntryDefinition,
} from './triggers';
import { createLog } from '../core/log';
import type { TriggerContext, TriggerDefinition } from '../core/trigger';
import { memoryFirestore } from '../orgs/testing';
import { FakeClock } from '../ports/fakes';

/** Unit tests for the INS-01 metrics rollups (ADR-048). Every person, matter and amount is fictional. */

type Data = Record<string, unknown>;

const ORG = 'org-metrics';
const O = `orgs/${ORG}`;
const M = `${O}/matters/m1`;
const TZ = 'Australia/Melbourne';
// 14:00 on Tuesday 6 October 2026 in Melbourne.
const NOW = new Date('2026-10-06T03:00:00Z');
const meta = { createdBy: 'u0', updatedBy: 'u0', schemaVersion: 1 };
/** 10:00 Melbourne on the day. */
const at = (day: string) => new Date(`${day}T10:00:00+10:00`);

const matter = (extra: Data = {}): Data => ({
  ...meta,
  number: 'M-2026-0001',
  type: 'probate',
  status: 'open',
  createdAt: at('2026-01-12'),
  deletedAt: null,
  ...extra,
});
const timeEntry = (extra: Data = {}): Data => ({
  ...meta,
  orgId: ORG,
  matterId: 'm1',
  uid: 'u1',
  date: '2026-10-05',
  minutes: 60,
  amountCents: 40_000,
  billable: true,
  status: 'draft',
  deletedAt: null,
  ...extra,
});

async function world(initial: Record<string, Data> = {}, options: { members?: number } = {}) {
  resetMetricsCaches();
  const members = Object.fromEntries(
    Array.from({ length: options.members ?? 3 }, (_, i) => [
      `${O}/members/u${i}`,
      { ...meta, role: 'lawyer', status: 'active' },
    ]),
  );
  const store = memoryFirestore({
    [O]: { name: 'Harbour & Vine Legal', timezone: TZ, fy: { startMonth: 7 } },
    ...members,
    [M]: matter(),
    ...initial,
  });
  const clock = new FakeClock(NOW);
  const lines: { severity: string; message: string; entry: Data }[] = [];
  const log = createLog({ fn: 'test' }, (severity, message, entry) => void lines.push({ severity, message, entry }));
  let draws = 0;
  const deps = { db: store.db, clock, log, random: () => (draws++ % 10) / 10 };
  const ctx = (params: Record<string, string>) =>
    ({
      eventId: 'e1',
      time: NOW,
      params: { orgId: ORG, ...params },
      log,
      clock,
      db: store.db,
    }) as unknown as TriggerContext;
  const snap = (path: string) => store.docs.get(path);
  /** Writes a document and runs a trigger on the change, as the deployed function would. */
  const fire = async (def: TriggerDefinition, path: string, data: Data | null, params: Record<string, string>) => {
    const before = store.docs.get(path);
    if (data) await store.db.doc(path).set(data);
    else await store.db.doc(path).delete();
    const after = store.docs.get(path);
    await def.handler({ before: fakeSnap(before), after: fakeSnap(after) }, ctx(params));
  };
  // Every matter already counted, as its trigger would have.
  for (const path of [...store.docs.keys()].filter((p) => /^orgs\/[^/]+\/matters\/[^/]+$/.test(p))) {
    const matterId = path.split('/')[3] as string;
    await syncMetrics(deps, ORG, { kind: 'matter', matterId, sourceId: matterId });
  }
  return { ...store, clock, log, lines, deps, ctx, snap, fire };
}

function fakeSnap(data: Data | undefined): DocumentSnapshot | undefined {
  if (!data) return undefined;
  return {
    exists: true,
    data: () => ({ ...data }),
    get: (field: string) => field.split('.').reduce<unknown>((value, key) => (value as Data | undefined)?.[key], data),
  } as unknown as DocumentSnapshot;
}

type World = Awaited<ReturnType<typeof world>>;

const actual = (docs: Map<string, Data>) => storedMetrics(docs, ORG);
const expected = (docs: Map<string, Data>) => recordMetrics(docs, ORG, { timeZone: TZ });
const sorted = sortedMetrics;
const expectConsistent = (w: World) => expect(sorted(actual(w.docs))).toEqual(sorted(expected(w.docs)));

describe('syncMetrics', () => {
  it('counts a time entry on its day, month and FY, for the org and its author, once', async () => {
    const w = await world({ [`${M}/timeEntries/t1`]: timeEntry() });
    expect(await syncMetrics(w.deps, ORG, { kind: 'time', matterId: 'm1', sourceId: 't1' })).toBe('synced');
    expect(w.snap(`${O}/metrics/day-2026-10-05`)).toMatchObject({
      period: 'day-2026-10-05',
      createdBy: 'system',
      schemaVersion: 1,
      values: { 'time.minutes': 60, 'time.billable.minutes': 60, 'time.type.probate.minutes': 60 },
    });
    expect(w.snap(`${O}/metrics/month-2026-10/byMember/u1`)).toMatchObject({
      period: 'month-2026-10',
      uid: 'u1',
      values: { 'time.minutes': 60, 'time.valueCents': 40_000 },
    });
    expect(w.snap(`${O}/metrics/fy-2026`)?.['values']).toMatchObject({ 'time.entries': 1 });
    expect(w.snap(`${M}/metrics/time-t1`)).toMatchObject({ kind: 'time', sourceId: 't1', matterId: 'm1' });

    // A redelivered or late event changes nothing.
    expect(await syncMetrics(w.deps, ORG, { kind: 'time', matterId: 'm1', sourceId: 't1' })).toBe('unchanged');
    expectConsistent(w);
  });

  it('moves a back-dated entry out of one FY and into the other across 30 June / 1 July', async () => {
    const w = await world({ [`${M}/timeEntries/t1`]: timeEntry({ date: '2026-07-01' }) });
    await w.fire(onTimeEntryDefinition, `${M}/timeEntries/t1`, timeEntry({ date: '2026-07-01' }), {
      matterId: 'm1',
      recordId: 't1',
    });
    expect(w.snap(`${O}/metrics/fy-2026`)?.['values']).toMatchObject({ 'time.minutes': 60 });
    await w.fire(onTimeEntryDefinition, `${M}/timeEntries/t1`, timeEntry({ date: '2026-06-30' }), {
      matterId: 'm1',
      recordId: 't1',
    });
    expect(w.snap(`${O}/metrics/fy-2026`)?.['values']).toMatchObject({ 'time.minutes': 0 });
    expect(w.snap(`${O}/metrics/fy-2025`)?.['values']).toMatchObject({ 'time.minutes': 60 });
    expect(w.snap(`${O}/metrics/month-2026-06/byMember/u1`)?.['values']).toMatchObject({ 'time.minutes': 60 });
    expect(w.snap(`${O}/metrics/day-2026-07-01`)?.['values']).toMatchObject({ 'time.minutes': 0 });
    expectConsistent(w);
  });

  it('takes a deleted record back out and drops its ledger', async () => {
    const w = await world({ [`${M}/timeEntries/t1`]: timeEntry() });
    await syncMetrics(w.deps, ORG, { kind: 'time', matterId: 'm1', sourceId: 't1' });
    await w.fire(onTimeEntryDefinition, `${M}/timeEntries/t1`, null, { matterId: 'm1', recordId: 't1' });
    expect(w.snap(`${O}/metrics/month-2026-10`)?.['values']).toMatchObject({ 'time.minutes': 0 });
    expect(w.snap(`${M}/metrics/time-t1`)).toBeUndefined();
    expectConsistent(w);
  });

  it("leaves a destroyed matter's figures where they were counted, and skips orphans", async () => {
    const w = await world({ [`${M}/timeEntries/t1`]: timeEntry() });
    await syncMetrics(w.deps, ORG, { kind: 'time', matterId: 'm1', sourceId: 't1' });
    await syncMetrics(w.deps, ORG, { kind: 'matter', matterId: 'm1', sourceId: 'm1' });
    await w.db.doc(M).set({ ...matter(), destroyedAt: NOW, deletedAt: NOW });
    await w.db.doc(`${M}/timeEntries/t1`).delete();
    expect(await syncMetrics(w.deps, ORG, { kind: 'time', matterId: 'm1', sourceId: 't1' })).toBe('skipped');
    expect(await syncMetrics(w.deps, ORG, { kind: 'matter', matterId: 'm1', sourceId: 'm1' })).toBe('skipped');
    expect(w.snap(`${O}/metrics/month-2026-10`)?.['values']).toMatchObject({ 'time.minutes': 60 });
    expect(w.snap(`${O}/metrics/month-2026-01`)?.['values']).toMatchObject({ 'matters.opened': 1 });
    expect(await syncMetrics(w.deps, ORG, { kind: 'time', matterId: 'gone', sourceId: 't9' })).toBe('skipped');
  });

  it('writes org figures to shards once the org has more than 20 active members, never member figures', async () => {
    const w = await world(
      { [`${M}/timeEntries/t1`]: timeEntry(), [`${M}/timeEntries/t2`]: timeEntry({ minutes: 30 }) },
      { members: 21 },
    );
    await syncMetrics(w.deps, ORG, { kind: 'time', matterId: 'm1', sourceId: 't1' });
    await syncMetrics(w.deps, ORG, { kind: 'time', matterId: 'm1', sourceId: 't2' });
    const shards = [...w.docs.keys()].filter((path) => path.startsWith(`${O}/metrics/month-2026-10/shards/`));
    // Shard 0 took the matter's own figures (January).
    expect(shards).toEqual([`${O}/metrics/month-2026-10/shards/1`, `${O}/metrics/month-2026-10/shards/2`]);
    // The period document exists (so it's listed) but holds no figures until the nightly fold.
    expect(w.snap(`${O}/metrics/month-2026-10`)).toMatchObject({ period: 'month-2026-10', values: {} });
    expect(w.snap(`${O}/metrics/month-2026-10/shards/2`)).toMatchObject({ period: 'month-2026-10', shard: 2 });
    expect(w.snap(`${O}/metrics/month-2026-10/byMember/u1`)?.['values']).toMatchObject({ 'time.minutes': 90 });
    expectConsistent(w);
  });

  it('does not shard at 20 active members', async () => {
    const w = await world({ [`${M}/timeEntries/t1`]: timeEntry() }, { members: 20 });
    await syncMetrics(w.deps, ORG, { kind: 'time', matterId: 'm1', sourceId: 't1' });
    expect([...w.docs.keys()].some((path) => path.includes('/shards/'))).toBe(false);
    expect(metricsWrites(ORG, new Map([['day-2026-10-05', { a: 1 }]]), 10, () => 0.999)[0]?.path).toBe(
      `${O}/metrics/day-2026-10-05/shards/9`,
    );
  });
});

describe('the sync triggers', () => {
  it('are declared on each record', () => {
    expect(onTimeEntryDefinition).toMatchObject({ name: 'metrics-onTimeEntry', on: 'written' });
    expect(onTimeEntryDefinition.document).toBe('orgs/{orgId}/matters/{matterId}/timeEntries/{recordId}');
    expect(onDisbursementDefinition.document).toBe('orgs/{orgId}/matters/{matterId}/disbursements/{recordId}');
    expect(onDeadlineDefinition.document).toBe('orgs/{orgId}/matters/{matterId}/deadlines/{recordId}');
    expect(onMatterDefinition.document).toBe('orgs/{orgId}/matters/{matterId}');
    expect(onInvoiceDefinition.document).toBe('orgs/{orgId}/invoices/{recordId}');
    expect(onCreditNoteDefinition.document).toBe('orgs/{orgId}/creditNotes/{recordId}');
    expect(onContactDefinition).toMatchObject({ document: 'orgs/{orgId}/contacts/{contactId}', on: 'updated' });
  });

  it('ignore matter writes that change nothing they count', async () => {
    const w = await world();
    await syncMetrics(w.deps, ORG, { kind: 'matter', matterId: 'm1', sourceId: 'm1' });
    expect(w.snap(`${M}/metrics/matter-m1`)).toBeDefined();
    await w.db.doc(`${M}/metrics/matter-m1`).delete();
    await w.fire(onMatterDefinition, M, matter({ wipCents: 5000, lastActivityAt: NOW }), { matterId: 'm1' });
    expect(w.snap(`${M}/metrics/matter-m1`)).toBeUndefined();
  });

  it('relabel time when the matter type changes', async () => {
    const w = await world({ [`${M}/timeEntries/t1`]: timeEntry() });
    await syncMetrics(w.deps, ORG, { kind: 'time', matterId: 'm1', sourceId: 't1' });
    await w.fire(onMatterDefinition, M, matter({ type: 'will' }), { matterId: 'm1' });
    expect(w.snap(`${O}/metrics/month-2026-10`)?.['values']).toMatchObject({
      'time.type.probate.minutes': 0,
      'time.type.will.minutes': 60,
    });
    expectConsistent(w);
  });

  it('move billing between referrers and industries', async () => {
    const invoice = {
      ...meta,
      matterId: 'm1',
      status: 'issued',
      issueDate: '2026-10-02',
      subtotalCents: 100_000,
      gstCents: 10_000,
      lines: [{ kind: 'time', amountExGstCents: 100_000 }],
    };
    const w = await world({
      [`${O}/contacts/c-acct`]: { ...meta, referrerMeta: { industry: 'accountant' } },
      [`${O}/contacts/c-fp`]: { ...meta, referrerMeta: { industry: 'financial_planner' } },
      [M]: matter({ referrerContactId: 'c-acct' }),
    });
    await w.fire(onInvoiceDefinition, `${O}/invoices/i1`, invoice, { recordId: 'i1' });
    await w.fire(
      onCreditNoteDefinition,
      `${O}/creditNotes/cn1`,
      {
        ...meta,
        matterId: 'm1',
        issueDate: '2026-10-03',
        subtotalCents: 10_000,
        gstCents: 1_000,
        lines: [],
      },
      { recordId: 'cn1' },
    );
    expect(w.snap(`${O}/metrics/month-2026-10`)?.['values']).toMatchObject({
      'referrals.referrer.c-acct.billedCents': 100_000,
      'referrals.industry.accountant.creditedCents': 10_000,
    });

    await w.fire(onMatterDefinition, M, matter({ referrerContactId: 'c-fp' }), { matterId: 'm1' });
    expect(w.snap(`${O}/metrics/month-2026-10`)?.['values']).toMatchObject({
      'referrals.referrer.c-acct.billedCents': 0,
      'referrals.referrer.c-fp.billedCents': 100_000,
      'referrals.industry.financial_planner.billedCents': 100_000,
    });
    expectConsistent(w);

    await w.fire(
      onContactDefinition,
      `${O}/contacts/c-fp`,
      { ...meta, referrerMeta: { industry: 'aged_care' } },
      {
        contactId: 'c-fp',
      },
    );
    expect(w.snap(`${O}/metrics/month-2026-10`)?.['values']).toMatchObject({
      'referrals.industry.financial_planner.billedCents': 0,
      'referrals.industry.aged_care.billedCents': 100_000,
      'referrals.industry.aged_care.creditedCents': 10_000,
    });
    expect(w.snap(`${O}/metrics/month-2026-01`)?.['values']).toMatchObject({ 'matters.opened.industry.aged_care': 1 });
    expectConsistent(w);

    // Another contact edit changes nothing.
    const writes = w.docs.size;
    await w.fire(
      onContactDefinition,
      `${O}/contacts/c-fp`,
      { ...meta, referrerMeta: { industry: 'aged_care' }, phone: '03 5555 0101' },
      {
        contactId: 'c-fp',
      },
    );
    expect(w.docs.size).toBe(writes);
  });

  it('count payments when made and drop a voided invoice', async () => {
    const w = await world();
    const issued = {
      ...meta,
      matterId: 'm1',
      status: 'issued',
      issueDate: '2026-09-28',
      subtotalCents: 50_000,
      gstCents: 5_000,
      lines: [],
      payments: [],
    };
    await w.fire(
      onInvoiceDefinition,
      `${O}/invoices/i1`,
      { ...issued, status: 'draft', issueDate: undefined },
      { recordId: 'i1' },
    );
    expect(w.snap(`${M}/metrics/invoice-i1`)).toBeUndefined();
    await w.fire(onInvoiceDefinition, `${O}/invoices/i1`, issued, { recordId: 'i1' });
    const paid = { ...issued, status: 'part_paid', payments: [{ id: 'p1', date: '2026-10-05', amountCents: 20_000 }] };
    await w.fire(onInvoiceDefinition, `${O}/invoices/i1`, paid, { recordId: 'i1' });
    expect(w.snap(`${O}/metrics/month-2026-09`)?.['values']).toMatchObject({ 'billing.invoicedCents': 50_000 });
    expect(w.snap(`${O}/metrics/day-2026-10-05`)?.['values']).toMatchObject({ 'billing.collectedCents': 20_000 });
    await w.fire(onInvoiceDefinition, `${O}/invoices/i1`, { ...paid, status: 'void' }, { recordId: 'i1' });
    expect(w.snap(`${O}/metrics/month-2026-09`)?.['values']).toMatchObject({ 'billing.invoicedCents': 0 });
    expectConsistent(w);
    // An invoice without a matter is nobody's.
    await w.fire(onInvoiceDefinition, `${O}/invoices/i2`, { ...issued, matterId: undefined }, { recordId: 'i2' });
    expect(w.snap(`${M}/metrics/invoice-i2`)).toBeUndefined();
  });

  it("keep a matter's stage history and count each finished stage", async () => {
    const w = await world();
    await w.fire(onMatterDefinition, M, matter({ stageId: 'gathering', stageEnteredOn: '2026-09-01' }), {
      matterId: 'm1',
    });
    await w.fire(onMatterDefinition, M, matter({ stageId: 'grant', stageEnteredOn: '2026-10-01' }), { matterId: 'm1' });
    expect(w.snap(`${M}/metrics/matter-m1`)?.['stages']).toEqual([
      { stageId: 'gathering', enteredOn: '2026-09-01', leftOn: '2026-10-01' },
      { stageId: 'grant', enteredOn: '2026-10-01' },
    ]);
    expect(w.snap(`${O}/metrics/day-2026-10-01`)?.['values']).toMatchObject({ 'stage.probate.gathering.d30': 1 });
    expectConsistent(w);
  });

  it('count disbursements and deadlines', async () => {
    const w = await world();
    await w.fire(
      onDisbursementDefinition,
      `${M}/disbursements/d1`,
      {
        ...meta,
        orgId: ORG,
        date: '2026-10-02',
        amountExGstCents: 12_000,
        status: 'unbilled',
        deletedAt: null,
      },
      { matterId: 'm1', recordId: 'd1' },
    );
    await w.fire(
      onDeadlineDefinition,
      `${M}/deadlines/dl1`,
      {
        ...meta,
        orgId: ORG,
        status: 'done',
        dueDate: '2026-10-02',
        critical: true,
        resolution: { on: '2026-10-03' },
      },
      { matterId: 'm1', recordId: 'dl1' },
    );
    expect(w.snap(`${O}/metrics/day-2026-10-02`)?.['values']).toMatchObject({
      'disbursements.exGstCents': 12_000,
      'deadlines.due': 1,
      'deadlines.critical.metLate': 1,
    });
    expectConsistent(w);
  });
});

/** A small seeded generator, so a failing sequence can be replayed. */
function prng(seed: number) {
  let state = seed;
  const next = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(items: readonly T[]): T => items[int(items.length)] as T;
  return { int, pick, next };
}

const DAYS = [
  '2026-06-29',
  '2026-06-30',
  '2026-07-01',
  '2026-07-02',
  '2026-09-30',
  '2026-10-01',
  '2026-10-05',
  '2026-10-06',
];

/** Random writes to matters, time, disbursements, deadlines, invoices, credit notes and referrers, each through its trigger. */
async function randomOps(w: World, seed: number, count: number) {
  const r = prng(seed);
  const matters = ['m1', 'm2', 'm3'];
  let lastOp: unknown;
  for (let i = 0; i < count; i++) {
    const matterId = r.pick(matters);
    const base = `${O}/matters/${matterId}`;
    const id = `x${r.int(6)}`;
    const deleting = r.int(8) === 0;
    const op = r.int(7);
    lastOp = [op, matterId, id, deleting];
    switch (op) {
      case 0:
        await w.fire(
          onTimeEntryDefinition,
          `${base}/timeEntries/${id}`,
          deleting
            ? null
            : timeEntry({
                matterId,
                uid: r.pick(['u0', 'u1', 'u2']),
                date: r.pick(DAYS),
                minutes: 6 * (1 + r.int(20)),
                amountCents: 1_000 * r.int(50),
                billable: r.int(3) > 0,
                status: r.pick(['draft', 'final', 'billed', 'written_off']),
                ...(r.int(4) === 0 ? { writeDown: { originalAmountCents: 60_000 } } : {}),
              }),
          { matterId, recordId: id },
        );
        break;
      case 1:
        await w.fire(
          onDisbursementDefinition,
          `${base}/disbursements/${id}`,
          deleting
            ? null
            : {
                ...meta,
                orgId: ORG,
                date: r.pick(DAYS),
                amountExGstCents: 500 * r.int(40),
                status: r.pick(['unbilled', 'billed', 'written_off']),
                deletedAt: null,
              },
          { matterId, recordId: id },
        );
        break;
      case 2:
        await w.fire(
          onDeadlineDefinition,
          `${base}/deadlines/${id}`,
          deleting
            ? null
            : {
                ...meta,
                orgId: ORG,
                status: r.pick(['upcoming', 'done', 'missed', 'waived', 'superseded']),
                dueDate: r.pick(DAYS),
                critical: r.int(2) === 0,
                resolution: { on: r.pick(DAYS) },
                ...(r.int(4) === 0 ? { override: { reason: 'Agreed extension' } } : {}),
              },
          { matterId, recordId: id },
        );
        break;
      case 3: {
        const status = r.pick(['draft', 'issued', 'part_paid', 'paid', 'void']);
        await w.fire(
          onInvoiceDefinition,
          `${O}/invoices/${matterId}-${id}`,
          {
            ...meta,
            matterId,
            status,
            updatedAt: NOW,
            issueDate: r.pick(DAYS),
            subtotalCents: 10_000 * (1 + r.int(9)),
            gstCents: 1_000,
            lines: [{ kind: 'disbursement', amountExGstCents: 2_000 }],
            payments: [
              { id: 'p1', date: r.pick(DAYS), amountCents: 5_000 },
              {
                id: 'p2',
                date: r.pick(DAYS),
                amountCents: 1_000,
                kind: 'refund',
                ...(r.int(2) ? { reversedAt: NOW } : {}),
              },
            ],
          },
          { recordId: `${matterId}-${id}` },
        );
        break;
      }
      case 4:
        await w.fire(
          onCreditNoteDefinition,
          `${O}/creditNotes/${matterId}-${id}`,
          deleting
            ? null
            : {
                ...meta,
                matterId,
                issueDate: r.pick(DAYS),
                subtotalCents: 2_000 * (1 + r.int(5)),
                gstCents: 200,
                lines: [],
              },
          { recordId: `${matterId}-${id}` },
        );
        break;
      case 5: {
        const status = r.pick(['lead', 'open', 'on_hold', 'closed', 'archived']);
        await w.fire(
          onMatterDefinition,
          base,
          matter({
            type: r.pick(['probate', 'will', 'admin']),
            status,
            createdAt: at(r.pick(DAYS)),
            ...(status === 'closed' || status === 'archived' ? { closedAt: at(r.pick(DAYS)) } : {}),
            estate: { grantDate: r.pick(DAYS) },
            closing: { finalDistributionRecorded: r.int(2) === 0 },
            stageId: r.pick(['intake', 'grant', 'distribution']),
            stageEnteredOn: r.pick(DAYS),
            ...(r.int(2) ? { referrerContactId: r.pick(['c1', 'c2']) } : { referralSource: 'website' }),
            ...(r.int(3) === 0 ? { legacyBilling: { billingTotal: 1234.5, billingDate: r.pick(DAYS) } } : {}),
            ...(r.int(10) === 0 ? { deletedAt: NOW } : {}),
          }),
          { matterId },
        );
        break;
      }
      default: {
        const contactId = r.pick(['c1', 'c2']);
        await w.fire(
          onContactDefinition,
          `${O}/contacts/${contactId}`,
          {
            ...meta,
            referrerMeta: { industry: r.pick(['accountant', 'financial_planner', 'aged_care']) },
          },
          { contactId },
        );
      }
    }
    // Checked after every write, so a failure names the write that broke it.
    expect(sorted(actual(w.docs)), `after write ${i}: ${JSON.stringify(lastOp)}`).toEqual(sorted(expected(w.docs)));
  }
}

describe('incremental sync equals recompute (property)', () => {
  it.each([1, 7, 42])(
    'after random writes (seed %i), the rollups equal the records added up from scratch',
    async (seed) => {
      const w = await world(
        {
          [`${O}/matters/m2`]: matter({ referrerContactId: 'c1' }),
          [`${O}/matters/m3`]: matter({ type: 'will' }),
          [`${O}/contacts/c1`]: { ...meta, referrerMeta: { industry: 'accountant' } },
          [`${O}/contacts/c2`]: { ...meta },
        },
        { members: seed === 7 ? 25 : 3 },
      );
      await randomOps(w, seed, 150);
      expectConsistent(w);

      // The nightly recompute finds nothing to correct, and folds any shards.
      const outcome = await recomputeOrgMetrics(w.deps, ORG);
      expect(outcome).toMatchObject({ resynced: 0, corrected: 0 });
      expect(w.lines.some((line) => line.message === 'metrics drift corrected')).toBe(false);
      expectConsistent(w);
      if (seed === 7) {
        expect(outcome.folded).toBeGreaterThan(0);
        for (const [path, data] of w.docs)
          if (path.includes('/month-2026-10/shards/')) expect(data['values']).toEqual({});
      }
    },
  );
});

describe('recomputeOrgMetrics', () => {
  it('re-syncs records a failed trigger missed, corrects drift in the window and its FY, and logs it', async () => {
    const w = await world({ [`${M}/timeEntries/t1`]: timeEntry() });
    await syncMetrics(w.deps, ORG, { kind: 'time', matterId: 'm1', sourceId: 't1' });
    await syncMetrics(w.deps, ORG, { kind: 'matter', matterId: 'm1', sourceId: 'm1' });
    // A missed trigger: written without a sync.
    await w.db.doc(`${M}/timeEntries/t2`).set(timeEntry({ date: '2026-10-01', minutes: 30 }));
    // Drift: figures in the window's documents that no record explains.
    const values = (path: string) => w.snap(path)?.['values'] as Data;
    await w.db.doc(`${O}/metrics/day-2026-10-05`).set({ values: { 'time.minutes': 999 } }, { merge: true });
    await w.db.doc(`${O}/metrics/month-2026-10/byMember/u1`).set({ values: { 'time.minutes': 1 } }, { merge: true });
    await w.db.doc(`${O}/metrics/month-2026-10`).set({ values: { junk: 3 } }, { merge: true });
    await w.db.doc(`${O}/metrics/fy-2026`).set({ values: { 'time.entries': 7 } }, { merge: true });
    w.clock.advance(1000);

    const outcome = await recomputeOrgMetrics(w.deps, ORG);
    expect(outcome).toMatchObject({ from: '2026-10-01', to: '2026-10-31', resynced: 1, snapshotOn: '2026-10-05' });
    expect(outcome.corrected).toBeGreaterThanOrEqual(4);
    expect(values(`${O}/metrics/day-2026-10-05`)['time.minutes']).toBe(60);
    expect(values(`${O}/metrics/month-2026-10/byMember/u1`)['time.minutes']).toBe(90);
    expect(values(`${O}/metrics/fy-2026`)['time.entries']).toBe(2);
    expectConsistent(w);
    const drift = w.lines.find((line) => line.message === 'metrics drift corrected');
    expect(drift).toMatchObject({ severity: 'warn', entry: { orgId: ORG, alert: 'metrics_drift' } });

    // A second run finds nothing.
    w.clock.advance(1000);
    expect(await recomputeOrgMetrics(w.deps, ORG)).toMatchObject({ resynced: 0, corrected: 0 });
  });

  it('leaves documents written while it reads to the next night', async () => {
    const w = await world({ [`${M}/timeEntries/t1`]: timeEntry() });
    await syncMetrics(w.deps, ORG, { kind: 'time', matterId: 'm1', sourceId: 't1' });
    // Written "later" than the run starts.
    await w.db
      .doc(`${O}/metrics/day-2026-10-05`)
      .set({ values: { 'time.minutes': 5 }, updatedAt: new Date(NOW.getTime() + 60_000) }, { merge: true });
    const outcome = await recomputeOrgMetrics(w.deps, ORG);
    expect(outcome.busy).toBeGreaterThan(0);
    expect((w.snap(`${O}/metrics/day-2026-10-05`)?.['values'] as Data)['time.minutes']).toBe(5);
  });

  it("writes yesterday's snapshot to its day, month and FY, replacing the last one", async () => {
    const w = await world({
      [M]: matter({ wipCents: 120_000, disbursementWipCents: 3_000 }),
      [`${O}/matters/m2`]: matter({ type: 'will', status: 'closed', closedAt: at('2026-10-02') }),
      [`${M}/deadlines/dl1`]: { ...meta, orgId: ORG, status: 'upcoming', dueDate: '2026-10-01', critical: true },
      [`${M}/deadlines/dl2`]: {
        ...meta,
        orgId: ORG,
        status: 'done',
        dueDate: '2026-10-02',
        resolution: { on: '2026-10-06' },
      },
      [`${O}/metrics/clerk-2026-10`]: { period: 'clerk-2026-10', values: { tokens: 500, 'user.u1.tokens': 500 } },
      [`${O}/metrics/clerk-2026-07`]: { period: 'clerk-2026-07', values: { tokens: 100 } },
      [`${O}/metrics/debtors-2026-10-06`]: { period: 'debtors-2026-10-06', values: { totalCents: 77_000 } },
      [`${O}/metrics/month-2026-10`]: { period: 'month-2026-10', values: { 'active.matters.type.admin': 4 } },
    });
    await recomputeOrgMetrics(w.deps, ORG);
    expect(w.snap(`${O}/metrics/day-2026-10-05`)).toMatchObject({
      snapshotOn: '2026-10-05',
      values: {
        'wip.timeCents': 120_000,
        'wip.disbursementsCents': 3_000,
        'active.matters': 1,
        'active.matters.type.probate': 1,
        'overdue.deadlines': 2,
        'overdue.deadlines.critical': 1,
        'debtors.totalCents': 77_000,
      },
    });
    const month = w.snap(`${O}/metrics/month-2026-10`)?.['values'] as Data;
    expect(month).toMatchObject({ 'clerk.tokens': 500, 'active.matters': 1 });
    expect(month['clerk.user.u1.tokens']).toBeUndefined();
    expect(month['active.matters.type.admin']).toBeUndefined();
    expect((w.snap(`${O}/metrics/fy-2026`)?.['values'] as Data)['clerk.tokens']).toBe(600);
  });

  it('runs every live org and carries on past a failure', async () => {
    const w = await world({
      'orgs/org-gone': { name: 'Closed Practice', deletedAt: NOW },
      'orgs/org-broken': { name: 'Broken Practice', fy: { startMonth: 7 } },
    });
    const broken = { ...w.deps, db: w.db };
    const original = w.db.collection.bind(w.db);
    // The broken org's matters can't be read.
    (w.db as unknown as { collection: (path: string) => unknown }).collection = (path: string) => {
      if (path === 'orgs/org-broken/matters') throw new Error('unavailable');
      return original(path);
    };
    expect(await recomputeAllOrgs(broken)).toBe(1);
    expect(
      w.lines.some((line) => line.message === 'metrics recompute failed' && line.entry['orgId'] === 'org-broken'),
    ).toBe(true);
  });
});
