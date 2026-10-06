import { randomUUID } from 'node:crypto';

import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

import { createLog } from '../../src/core/log';
import { runTrigger, type TriggerDefinition, type TriggerDeps } from '../../src/core/trigger';
import { recomputeOrgMetrics } from '../../src/metrics/recompute';
import { resetMetricsCaches, type MetricsDeps } from '../../src/metrics/shared';
import { recordMetrics, sortedMetrics, storedMetrics } from '../../src/metrics/testing';
import {
  onContactDefinition,
  onCreditNoteDefinition,
  onDeadlineDefinition,
  onDisbursementDefinition,
  onInvoiceDefinition,
  onMatterDefinition,
  onTimeEntryDefinition,
} from '../../src/metrics/triggers';
import { FakeClock } from '../../src/ports/fakes';

/**
 * INS-01 acceptance tests on the Firestore emulator (ADR-048): the metrics-* triggers' handlers run
 * in-process, through runTrigger, on real Firestore (transactions, increments, `set` with `merge`
 * on dotted keys, count queries, collection-group reads), after random writes across the FY
 * boundary; then the stored figures must equal the records added up from scratch, and the nightly
 * recompute must find nothing to correct. A project of its own, so the Functions emulator's
 * deployed triggers (which watch demo-materia) don't race these runs. Everything is fictional.
 */
const PROJECT_ID = 'demo-materia-metrics';
const TZ = 'Australia/Melbourne';
// 15:00 on Wednesday 1 July 2026 in Melbourne: yesterday was the last day of FY 2025-26, so the
// recompute's window (June and July) spans the boundary.
const NOW = new Date('2026-07-01T05:00:00Z');
const DAYS = ['2026-06-01', '2026-06-15', '2026-06-29', '2026-06-30', '2026-07-01', '2026-07-02', '2026-07-31'];
const meta = { createdBy: 'seed', updatedBy: 'seed', schemaVersion: 1 };
/** 10:00 Melbourne on the day. */
const at = (day: string) => new Date(`${day}T10:00:00+10:00`);

type Data = Record<string, unknown>;

let admin: App;
let db: Firestore;
const clock = new FakeClock(NOW);
const log = createLog({ fn: 'metrics-integration' }, () => undefined);
const failures: string[] = [];
const triggerDeps: TriggerDeps = {
  db: () => db,
  clock,
  ports: () => ({}) as never,
  sink: (severity, message, entry) => {
    if (severity === 'error') failures.push(`${message}: ${JSON.stringify(entry)}`);
  },
};
const deps = (): MetricsDeps => ({ db, clock, log });

/** Writes a document, then runs a trigger's handler on the change, as the deployed function would. */
async function fire(def: TriggerDefinition, path: string, data: Data | null, params: Record<string, string>) {
  const before = await db.doc(path).get();
  if (data) await db.doc(path).set(data);
  else await db.doc(path).delete();
  const after = await db.doc(path).get();
  const change = { before: before.exists ? before : undefined, after: after.exists ? after : undefined };
  const outcome = await runTrigger(def, { id: randomUUID(), params, change }, triggerDeps);
  expect(outcome, failures.join('\n')).toBe('ran');
}

/** Every document of the org (and its matters' subcollections), by path. */
async function dump(orgId: string): Promise<Map<string, Data>> {
  const docs = new Map<string, Data>();
  const add = (snap: FirebaseFirestore.QuerySnapshot) => {
    for (const doc of snap.docs) docs.set(doc.ref.path, doc.data());
  };
  const org = `orgs/${orgId}`;
  const [matters, invoices, creditNotes, contacts, metrics] = await Promise.all(
    ['matters', 'invoices', 'creditNotes', 'contacts', 'metrics'].map((name) => db.collection(`${org}/${name}`).get()),
  );
  for (const snap of [matters, invoices, creditNotes, contacts, metrics]) add(snap as FirebaseFirestore.QuerySnapshot);
  await Promise.all(
    (matters?.docs ?? []).flatMap((matter) =>
      ['timeEntries', 'disbursements', 'deadlines', 'metrics'].map(async (name) =>
        add(await matter.ref.collection(name).get()),
      ),
    ),
  );
  await Promise.all(
    (metrics?.docs ?? []).flatMap((period) =>
      ['byMember', 'shards'].map(async (name) => add(await period.ref.collection(name).get())),
    ),
  );
  return docs;
}

async function expectConsistent(orgId: string, label = '') {
  const docs = await dump(orgId);
  expect(sortedMetrics(storedMetrics(docs, orgId)), label).toEqual(
    sortedMetrics(recordMetrics(docs, orgId, { timeZone: TZ })),
  );
}

async function seedOrg(orgId: string, members: number) {
  await db.recursiveDelete(db.doc(`orgs/${orgId}`));
  const batch = db.batch();
  batch.set(db.doc(`orgs/${orgId}`), { name: 'Fictional Bellarine Legal', timezone: TZ, fy: { startMonth: 7 } });
  for (let i = 0; i < members; i++)
    batch.set(db.doc(`orgs/${orgId}/members/u${i}`), { ...meta, role: 'lawyer', status: 'active' });
  batch.set(db.doc(`orgs/${orgId}/contacts/c1`), { ...meta, referrerMeta: { industry: 'accountant' } });
  batch.set(db.doc(`orgs/${orgId}/contacts/c2`), { ...meta });
  await batch.commit();
  resetMetricsCaches();
}

const matter = (extra: Data = {}): Data => ({
  ...meta,
  number: 'M-2026-0001',
  type: 'probate',
  status: 'open',
  createdAt: at('2026-06-01'),
  deletedAt: null,
  ...extra,
});
const timeEntry = (orgId: string, extra: Data = {}): Data => ({
  ...meta,
  orgId,
  matterId: 'm1',
  uid: 'u1',
  date: '2026-06-30',
  minutes: 60,
  amountCents: 40_000,
  billable: true,
  status: 'final',
  deletedAt: null,
  ...extra,
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
  return { int, pick };
}

/** Random writes to matters, time, disbursements, deadlines, invoices, credit notes and referrers. */
async function randomOps(orgId: string, seed: number, count: number, members: number) {
  const r = prng(seed);
  const org = `orgs/${orgId}`;
  const uids = Array.from({ length: Math.min(members, 4) }, (_, i) => `u${i}`);
  for (let i = 0; i < count; i++) {
    const matterId = r.pick(['m1', 'm2', 'm3']);
    const base = `${org}/matters/${matterId}`;
    const id = `x${r.int(5)}`;
    const deleting = r.int(8) === 0;
    switch (r.int(7)) {
      case 0:
        await fire(
          onTimeEntryDefinition,
          `${base}/timeEntries/${id}`,
          deleting
            ? null
            : timeEntry(orgId, {
                matterId,
                uid: r.pick(uids),
                date: r.pick(DAYS),
                minutes: 6 * (1 + r.int(20)),
                amountCents: 1_000 * r.int(50),
                billable: r.int(3) > 0,
                status: r.pick(['draft', 'final', 'billed', 'written_off']),
                ...(r.int(4) === 0 ? { writeDown: { originalAmountCents: 60_000 } } : {}),
              }),
          { orgId, matterId, recordId: id },
        );
        break;
      case 1:
        await fire(
          onDisbursementDefinition,
          `${base}/disbursements/${id}`,
          deleting
            ? null
            : {
                ...meta,
                orgId,
                date: r.pick(DAYS),
                amountExGstCents: 500 * r.int(40),
                status: r.pick(['unbilled', 'billed', 'written_off']),
                deletedAt: null,
              },
          { orgId, matterId, recordId: id },
        );
        break;
      case 2:
        await fire(
          onDeadlineDefinition,
          `${base}/deadlines/${id}`,
          deleting
            ? null
            : {
                ...meta,
                orgId,
                status: r.pick(['upcoming', 'done', 'missed', 'waived', 'superseded']),
                dueDate: r.pick(DAYS),
                critical: r.int(2) === 0,
                resolution: { on: r.pick(DAYS) },
                ...(r.int(4) === 0 ? { override: { reason: 'Agreed extension' } } : {}),
              },
          { orgId, matterId, recordId: id },
        );
        break;
      case 3:
        await fire(
          onInvoiceDefinition,
          `${org}/invoices/${matterId}-${id}`,
          {
            ...meta,
            matterId,
            status: r.pick(['draft', 'issued', 'part_paid', 'paid', 'void']),
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
          { orgId, recordId: `${matterId}-${id}` },
        );
        break;
      case 4:
        await fire(
          onCreditNoteDefinition,
          `${org}/creditNotes/${matterId}-${id}`,
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
          { orgId, recordId: `${matterId}-${id}` },
        );
        break;
      case 5: {
        const status = r.pick(['lead', 'open', 'on_hold', 'closed', 'archived']);
        await fire(
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
          }),
          { orgId, matterId },
        );
        break;
      }
      default: {
        const contactId = r.pick(['c1', 'c2']);
        await fire(
          onContactDefinition,
          `${org}/contacts/${contactId}`,
          { ...meta, referrerMeta: { industry: r.pick(['accountant', 'financial_planner', 'aged_care']) } },
          { orgId, contactId },
        );
      }
    }
  }
}

/** Three matters, each counted by its trigger. */
async function seedMatters(orgId: string) {
  for (const [matterId, extra] of [
    ['m1', {}],
    ['m2', { referrerContactId: 'c1' }],
    ['m3', { type: 'will' }],
  ] as const)
    await fire(onMatterDefinition, `orgs/${orgId}/matters/${matterId}`, matter(extra), { orgId, matterId });
}

beforeAll(() => {
  admin = initializeApp({ projectId: PROJECT_ID }, 'metrics-integration-admin');
  db = getFirestore(admin);
});

afterAll(async () => {
  await deleteApp(admin);
});

describe('metrics rollups on Firestore (INS-01)', () => {
  it('after random writes across the FY boundary, the rollups equal the records added up, and the recompute agrees', async () => {
    const orgId = 'org-metrics-random';
    await seedOrg(orgId, 3);
    await seedMatters(orgId);
    await randomOps(orgId, 11, 80, 3);
    await expectConsistent(orgId, 'after the writes');

    clock.advance(1000);
    const outcome = await recomputeOrgMetrics(deps(), orgId);
    expect(outcome).toMatchObject({ from: '2026-06-01', to: '2026-07-31', resynced: 0, corrected: 0, busy: 0 });
    await expectConsistent(orgId, 'after the recompute');
  }, 180_000);

  it('counts 30 June in FY 2025-26 and 1 July in FY 2026-27, and moves an entry across', async () => {
    const orgId = 'org-metrics-fy';
    await seedOrg(orgId, 3);
    await seedMatters(orgId);
    const path = `orgs/${orgId}/matters/m1/timeEntries/t1`;
    const params = { orgId, matterId: 'm1', recordId: 't1' };
    const minutes = async (period: string) =>
      ((await db.doc(`orgs/${orgId}/metrics/${period}`).get()).get('values') as Data | undefined)?.['time.minutes'] ??
      0;

    await fire(onTimeEntryDefinition, path, timeEntry(orgId, { date: '2026-06-30', minutes: 90 }), params);
    expect(await minutes('fy-2025')).toBe(90);
    expect(await minutes('month-2026-06')).toBe(90);
    expect(await minutes('fy-2026')).toBe(0);

    await fire(onTimeEntryDefinition, path, timeEntry(orgId, { date: '2026-07-01', minutes: 90 }), params);
    expect(await minutes('fy-2025')).toBe(0);
    expect(await minutes('day-2026-06-30')).toBe(0);
    expect(await minutes('fy-2026')).toBe(90);
    expect(await minutes('day-2026-07-01')).toBe(90);
    expect(await minutes('month-2026-07/byMember/u1')).toBe(90);

    // Delivered again: the ledger already says so, and nothing moves.
    const snap = await db.doc(path).get();
    await runTrigger(
      onTimeEntryDefinition,
      { id: randomUUID(), params, change: { before: snap, after: snap } },
      triggerDeps,
    );
    expect(await minutes('fy-2026')).toBe(90);
    await expectConsistent(orgId);
  }, 60_000);

  it('the recompute re-syncs a missed write and corrects drift, once', async () => {
    const orgId = 'org-metrics-drift';
    await seedOrg(orgId, 3);
    await seedMatters(orgId);
    await fire(onTimeEntryDefinition, `orgs/${orgId}/matters/m1/timeEntries/t1`, timeEntry(orgId), {
      orgId,
      matterId: 'm1',
      recordId: 't1',
    });
    // A trigger that never ran, and figures no record explains.
    await db
      .doc(`orgs/${orgId}/matters/m2/timeEntries/t2`)
      .set(timeEntry(orgId, { matterId: 'm2', date: '2026-07-01' }));
    await db.doc(`orgs/${orgId}/metrics/day-2026-06-30`).set({ values: { 'time.minutes': 999 } }, { merge: true });
    await db.doc(`orgs/${orgId}/metrics/fy-2025`).set({ values: { 'time.entries': 5 } }, { merge: true });

    clock.advance(1000);
    const first = await recomputeOrgMetrics(deps(), orgId);
    expect(first.resynced).toBe(1);
    expect(first.corrected).toBeGreaterThanOrEqual(2);
    await expectConsistent(orgId);

    clock.advance(1000);
    expect(await recomputeOrgMetrics(deps(), orgId)).toMatchObject({ resynced: 0, corrected: 0 });
  }, 60_000);

  it('shards an org of more than 20 members, sums the shards on read and folds them nightly', async () => {
    const orgId = 'org-metrics-large';
    await seedOrg(orgId, 21);
    await seedMatters(orgId);
    await randomOps(orgId, 5, 30, 21);
    const shards = await db.collectionGroup('shards').where('period', '==', 'month-2026-06').get();
    expect(shards.docs.filter((doc) => doc.ref.path.startsWith(`orgs/${orgId}/`)).length).toBeGreaterThan(1);
    await expectConsistent(orgId, 'with shards');

    clock.advance(1000);
    const outcome = await recomputeOrgMetrics(deps(), orgId);
    expect(outcome).toMatchObject({ resynced: 0, corrected: 0 });
    expect(outcome.folded).toBeGreaterThan(0);
    const june = await db.collection(`orgs/${orgId}/metrics/month-2026-06/shards`).get();
    for (const shard of june.docs) expect(shard.get('values')).toEqual({});
    await expectConsistent(orgId, 'after folding');
  }, 180_000);
});
