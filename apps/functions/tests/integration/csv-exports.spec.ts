import { randomUUID } from 'node:crypto';

import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App } from 'firebase-admin/app';
import { getFirestore as getAdminFirestore, type Firestore } from 'firebase-admin/firestore';
import { getStorage as getAdminStorage } from 'firebase-admin/storage';

import { contactDerivedFields, type Contact, type CreateExportResult, type Role } from '@materia/domain';

import { runCallable, type CallableDefinition, type CallableDeps } from '../../src/core/callable';
import { firestoreIdempotency } from '../../src/core/idempotency';
import { createLog } from '../../src/core/log';
import { cachedMemberLookup } from '../../src/core/members';
import { storageFiles } from '../../src/documents/files';
import { createExportDefinition } from '../../src/exports/create';
import { runExport } from '../../src/exports/run';
import { runOrgWeeklyReports } from '../../src/notifications/weekly-report';
import { FakeClock, FakeMail, FakeTaskQueue, fakePorts } from '../../src/ports/fakes';

/**
 * INS-03 against the emulators' Firestore and Storage: `exports-create` writes a small list export
 * straight to the bucket (UTF-8 with a BOM, privileged matters left out), and `exports-run`
 * streams a queued one page by page in the list's order with formulas defused, tells the member
 * it's ready, and discards it if they lost access meanwhile. The weekly practice report goes
 * once at 07:00 on Monday, org time, with a fake clock and fake mail. Every name is fictional.
 */
const PROJECT_ID = 'demo-materia';
const BUCKET = `${PROJECT_ID}.appspot.com`;
const ORG = 'org-csv-exports';
const M = `orgs/${ORG}/matters`;

let admin: App;
let db: Firestore;

const uidOf = (role: Role) => `ins3-${role}`;
const now = () => new Date();
const meta = () => ({ createdAt: now(), createdBy: 'seed', updatedAt: now(), updatedBy: 'seed', schemaVersion: 1 });
const bucket = () => getAdminStorage(admin).bucket(BUCKET);
const read = async (path: string) => (await bucket().file(path).download())[0].toString('utf8');
const exists = async (path: string) => (await bucket().file(path).exists())[0];
const files = () => storageFiles(BUCKET);
const log = createLog({ fn: 'csv-exports-integration' }, () => undefined);

function create(role: Role, data: Record<string, unknown>): Promise<CreateExportResult> {
  const clock = { now };
  const deps: CallableDeps = {
    db: () => db,
    clock,
    ports: () => fakePorts(),
    memberLookup: cachedMemberLookup(() => db, clock),
    idempotency: firestoreIdempotency(() => db, clock),
    sink: () => undefined,
  };
  return runCallable(
    createExportDefinition(files, () => BUCKET) as unknown as CallableDefinition<never, CreateExportResult>,
    {
      data: { requestId: randomUUID(), ...data },
      auth: { uid: uidOf(role), token: { orgId: ORG, role, auth_time: Math.floor(Date.now() / 1000) - 30 } },
    },
    deps,
  );
}

const member = (role: Role, displayName: string) => ({ ...meta(), role, status: 'active', displayName });
const matter = (number: string, extra: Record<string, unknown> = {}) => ({
  ...meta(),
  number,
  title: `Estate of Fictional Heron ${number}`,
  type: 'probate',
  status: 'open',
  jurisdiction: 'VIC',
  responsibleUid: uidOf('lawyer'),
  teamUids: [],
  clientContactIds: [],
  labels: [],
  search: ['estate', 'heron'],
  privileged: false,
  wipCents: 0,
  deletedAt: null,
  ...extra,
});
const contact = (familyName: string, extra: Record<string, unknown> = {}) => {
  const fields = {
    ...meta(),
    kind: 'person',
    givenNames: 'Fictional',
    familyName,
    emails: [],
    phones: [],
    addresses: [],
    tags: [],
    matterRoles: [],
    ...extra,
  };
  // The server-owned fields as `contacts-onWrite` derives them, so the trigger doesn't rewrite
  // `sortName` while an export is paging on it (a moved key skips a row).
  return { ...fields, ...contactDerivedFields(fields as Partial<Contact>) };
};

async function seed(paths: Record<string, Record<string, unknown>>) {
  const entries = Object.entries(paths);
  for (let i = 0; i < entries.length; i += 450) {
    const batch = db.batch();
    for (const [path, data] of entries.slice(i, i + 450)) batch.set(db.doc(path), data);
    await batch.commit();
  }
}

beforeAll(async () => {
  admin = initializeAdminApp({ projectId: PROJECT_ID, storageBucket: BUCKET }, 'csv-exports-integration-admin');
  db = getAdminFirestore(admin);
  await db.recursiveDelete(db.doc(`orgs/${ORG}`));
  await seed({
    [`orgs/${ORG}`]: { ...meta(), name: 'Fictional Heron Legal', timezone: 'Australia/Melbourne' },
    [`orgs/${ORG}/members/${uidOf('owner')}`]: member('owner', 'Olive Fictional'),
    [`orgs/${ORG}/members/${uidOf('lawyer')}`]: member('lawyer', 'Ben Fictional'),
    [`orgs/${ORG}/members/${uidOf('paralegal')}`]: member('paralegal', 'Pat Fictional'),
    [`users/${uidOf('owner')}`]: {
      ...meta(),
      email: 'olive.heron@example.com',
      prefs: { notifications: { email: true, push: false, digestHour: 7, weeklyReport: true } },
    },
    [`users/${uidOf('lawyer')}`]: { ...meta(), email: 'ben.heron@example.com' },
    [`${M}/m1`]: matter('0002', { wipCents: 44000 }),
    [`${M}/m2`]: matter('0001', { privileged: true, title: 'Privileged heron dispute', wipCents: 88000 }),
    [`${M}/m3`]: matter('0003', { deletedAt: now() }),
  });
});

afterAll(async () => {
  await deleteAdminApp(admin);
});

describe('exports-create', () => {
  it('writes a small export straight to the bucket, privileged matters left out', async () => {
    const result = await create('lawyer', { kind: 'matters', filters: { status: ['open'] } });
    expect(result).toMatchObject({ status: 'succeeded', rows: 1 });
    const job = (await db.doc(`orgs/${ORG}/jobs/${result.jobId}`).get()).data();
    expect(job).toMatchObject({ type: 'csv.export', status: 'succeeded', output: { rows: 1 } });
    const csv = await read(`orgs/${ORG}/exports/${result.jobId}.csv`);
    expect(csv.startsWith('\uFEFFMatter,Title,')).toBe(true);
    const lines = csv.slice(1).trimEnd().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^"0002",Estate of Fictional Heron 0002,/);
    expect(csv).not.toContain('Privileged heron');

    const audit = await db.collection(`orgs/${ORG}/audit`).where('action', '==', 'export.created').get();
    expect(audit.docs.map((doc) => doc.get('data'))).toContainEqual({
      kind: 'matters',
      filters: ['status'],
      includePrivileged: false,
      background: false,
    });
  });

  it('includes privileged matters when a lawyer asks, in matter-number order', async () => {
    const result = await create('lawyer', { kind: 'matters', includePrivileged: true });
    const csv = await read(`orgs/${ORG}/exports/${result.jobId}.csv`);
    expect(
      csv
        .slice(1)
        .trimEnd()
        .split('\r\n')
        .slice(1)
        .map((line) => line.split(',')[0]),
    ).toEqual(['"0001"', '"0002"']);
  });
});

describe('a background export', () => {
  // Over 5,000 rows goes to the queue (unit-tested); here the queue's run pages through a few
  // contacts two at a time, so the emulator's own ordering and cursors are what's checked.
  const BULK = 5;
  beforeAll(async () => {
    const contacts: Record<string, Record<string, unknown>> = {};
    // Written in reverse, so the file's order comes from the query, not from the writes.
    for (let i = BULK - 1; i >= 0; i--) contacts[`orgs/${ORG}/contacts/bulk-${i}`] = contact(`heron ${i}`);
    contacts[`orgs/${ORG}/contacts/evil`] = contact('aaa evil', { givenNames: '=cmd|calc', familyName: '' });
    await seed(contacts);
  });

  const queue = async (role: Role) => {
    const jobId = `job-${role}-${randomUUID().slice(0, 8)}`;
    await db.doc(`orgs/${ORG}/jobs/${jobId}`).set({
      ...meta(),
      createdBy: uidOf(role),
      type: 'csv.export',
      input: { kind: 'contacts', filters: {}, includePrivileged: false },
      target: { kind: 'export', name: 'Contacts 2026-10-06' },
      status: 'queued',
      progress: { done: 0, total: BULK + 1, stage: 'exporting' },
      warnings: [],
      attempts: 0,
    });
    return jobId;
  };
  const run = (jobId: string) =>
    runExport(
      {
        db,
        files: files(),
        clock: new FakeClock(now()),
        log,
        ports: { tasks: new FakeTaskQueue() },
        attempt: 0,
        pageSize: 2,
      },
      { orgId: ORG, jobId },
    );

  it('streams page by page in the list’s order and tells the member it’s ready', async () => {
    const jobId = await queue('owner');
    expect(await run(jobId)).toBe('succeeded');

    const path = `orgs/${ORG}/exports/${jobId}.csv`;
    const lines = (await read(path)).slice(1).trimEnd().split('\r\n');
    expect(lines.slice(1).map((line) => line.split(',')[0])).toEqual([
      `'=cmd|calc`,
      ...Array.from({ length: BULK }, (_, i) => `Fictional heron ${i}`),
    ]);
    expect((await db.doc(`orgs/${ORG}/jobs/${jobId}`).get()).data()).toMatchObject({
      status: 'succeeded',
      progress: { done: BULK + 1 },
      output: { storagePath: path, rows: BULK + 1 },
    });
    expect((await db.doc(`orgs/${ORG}/notifications/export-${jobId}`).get()).data()).toMatchObject({
      kind: 'export_ready',
      recipientUid: uidOf('owner'),
      link: `/exports/${jobId}`,
    });
    // A repeated delivery of the task changes nothing.
    expect(await run(jobId)).toBe('skipped');
  });

  it('is discarded when the member lost access while it ran', async () => {
    const jobId = await queue('paralegal');
    await db.doc(`orgs/${ORG}/members/${uidOf('paralegal')}`).update({ status: 'removed' });
    expect(await run(jobId)).toBe('discarded');
    expect(await exists(`orgs/${ORG}/exports/${jobId}.csv`)).toBe(false);
    expect((await db.doc(`orgs/${ORG}/jobs/${jobId}`).get()).data()).toMatchObject({
      status: 'failed',
      error: { code: 'PERMISSION_DENIED' },
    });
  });
});

describe('the weekly practice report', () => {
  it('goes to opted-in owners once, at 07:00 on Monday in the org’s time zone', async () => {
    // Monday 12 October 2026 in Melbourne (UTC+11).
    const monday = '2026-10-12';
    await seed({
      [`orgs/${ORG}/metrics/day-2026-10-06`]: { values: { 'billing.invoicedCents': 220000 } },
      [`orgs/${ORG}/metrics/day-2026-10-06/shards/1`]: { values: { 'billing.invoicedCents': 11000 } },
      [`${M}/m1/deadlines/heron-critical`]: {
        ...meta(),
        orgId: ORG,
        matterId: 'm1',
        title: 'Fictional critical deadline',
        status: 'upcoming',
        critical: true,
        dueDate: '2026-10-14',
      },
      [`${M}/m3/deadlines/heron-deleted-matter`]: {
        ...meta(),
        orgId: ORG,
        matterId: 'm3',
        title: 'On a deleted matter',
        status: 'upcoming',
        critical: true,
        dueDate: '2026-10-14',
      },
    });
    const org = (await db.doc(`orgs/${ORG}`).get()).data() ?? {};
    const mail = new FakeMail();
    const clock = new FakeClock(new Date('2026-10-11T19:59:00Z'));
    const deps = { db, clock, ports: { mail }, log };

    expect(await runOrgWeeklyReports(deps, ORG, org)).toEqual({});
    clock.set(new Date('2026-10-11T20:00:00Z'));
    expect(await runOrgWeeklyReports(deps, ORG, org)).toEqual({ sent: 1 });
    clock.set(new Date('2026-10-11T20:15:00Z'));
    expect(await runOrgWeeklyReports(deps, ORG, org)).toEqual({});

    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({
      to: 'olive.heron@example.com',
      template: 'weekly_report',
      idempotencyKey: `weekly-${uidOf('owner')}-${monday}`,
      model: {
        criticalLabel: '1 critical deadline due this week',
        topMatters: [
          expect.objectContaining({ number: '0001', wip: '$880.00' }),
          expect.objectContaining({ number: '0002', wip: '$440.00' }),
        ],
      },
    });
    const stats = (mail.sent[0]?.model as { stats: { label: string; value: string }[] }).stats;
    expect(stats[0]).toEqual({ label: 'Billed (ex GST)', value: '$2,310.00' });
    expect(JSON.stringify(mail.sent[0])).not.toContain('Fictional critical deadline');
    expect((await db.doc(`orgs/${ORG}/digests/weekly-${uidOf('owner')}-${monday}`).get()).get('status')).toBe('sent');
  });
});
