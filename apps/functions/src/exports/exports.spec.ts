import type { HttpsError } from 'firebase-functions/v2/https';

import { EXPORT_INLINE_MAX_ROWS, type ExportJobInput, type ExportKind, type Role } from '@materia/domain';

import { exportLines, writeExport, type ExportScope } from './build';
import { createExportDefinition, RUN_EXPORT_QUEUE } from './create';
import { RUN_EXPORT_ATTEMPTS, runExport } from './run';
import { runCallable, type CallableDeps } from '../core/callable';
import { createLog } from '../core/log';
import { MemoryFiles } from '../documents/testing';
import { memoryFirestore } from '../orgs/testing';
import { FakeClock, FakeSignedUrls, FakeTaskQueue, fakePorts } from '../ports/fakes';

/** Unit tests for the list exports (INS-03). Every person, matter and figure is fictional. */

const ORG = 'org-x';
const M = `orgs/${ORG}/matters`;
// 10:00 on Tuesday 6 October 2026 in Melbourne.
const NOW = new Date('2026-10-05T23:00:00Z');
const REQUEST_ID = '9b1d2c3e-4f5a-4b6c-8d7e-0f1a2b3c4d5e';

type Data = Record<string, unknown>;
const meta = { createdAt: NOW, createdBy: 'seed', updatedAt: NOW, updatedBy: 'seed', schemaVersion: 1 };
const member = (role: Role, displayName: string, extra: Data = {}) => ({
  ...meta,
  role,
  status: 'active',
  displayName,
  ...extra,
});
const matter = (number: string, extra: Data = {}) => ({
  ...meta,
  createdAt: new Date('2026-07-01T01:00:00Z'),
  number,
  title: `Estate of Fictional ${number}`,
  type: 'probate',
  status: 'open',
  jurisdiction: 'VIC',
  responsibleUid: 'user-lawyer',
  teamUids: [],
  clientContactIds: ['c1'],
  labels: [],
  search: ['estate', 'fictional'],
  privileged: false,
  wipCents: 13200,
  ...extra,
});
const entry = (matterId: string, date: string, extra: Data = {}) => ({
  ...meta,
  orgId: ORG,
  matterId,
  uid: 'user-lawyer',
  date,
  minutes: 18,
  units: 3,
  rateCents: 44000,
  amountCents: 13200,
  narrative: 'Perusing the will',
  billable: true,
  status: 'final',
  ...extra,
});
const deadline = (matterId: string, dueDate: string, extra: Data = {}) => ({
  ...meta,
  orgId: ORG,
  matterId,
  title: 'File the inventory',
  kind: 'court',
  critical: false,
  status: 'upcoming',
  dueDate,
  assigneeUid: 'user-lawyer',
  privileged: false,
  ...extra,
});

function world(extra: Record<string, Data> = {}) {
  const store = memoryFirestore({
    [`orgs/${ORG}`]: { name: 'Fictional Harbour Legal', timezone: 'Australia/Melbourne', billing: { unitMinutes: 6 } },
    [`orgs/${ORG}/members/user-owner`]: member('owner', 'Olive Owner'),
    [`orgs/${ORG}/members/user-lawyer`]: member('lawyer', 'Ben Lawyer'),
    [`orgs/${ORG}/members/user-paralegal`]: member('paralegal', 'Pat Paralegal'),
    [`orgs/${ORG}/members/user-readonly`]: member('readonly', 'Rory Readonly'),
    [`orgs/${ORG}/contacts/c1`]: {
      ...meta,
      kind: 'person',
      givenNames: 'Ada',
      familyName: 'Fictional',
      sortName: 'fictional ada',
      emails: [{ type: 'personal', address: 'ada.fictional@example.com' }],
      phones: [{ type: 'mobile', number: '+61412345678' }],
      addresses: [],
      tags: ['executor'],
      matterRoles: ['client'],
    },
    [`orgs/${ORG}/contacts/c2`]: {
      ...meta,
      kind: 'organisation',
      orgName: '=Evil Pty Ltd',
      sortName: 'evil pty ltd',
      emails: [],
      phones: [],
      addresses: [],
      tags: [],
      matterRoles: [],
    },
    [`orgs/${ORG}/contacts/c3`]: { ...meta, kind: 'person', givenNames: 'Gone', mergedInto: 'c1', tags: [] },
    [`${M}/m1`]: matter('0041'),
    [`${M}/m2`]: matter('0042', { privileged: true, title: 'Privileged dispute' }),
    [`${M}/m3`]: matter('0043', { deletedAt: NOW }),
    [`${M}/m4`]: matter('0044', { status: 'closed', closedAt: new Date('2026-09-01T00:00:00Z'), wipCents: 0 }),
    [`${M}/m1/timeEntries/t1`]: entry('m1', '2026-10-01', { narrative: '=HYPERLINK("x")' }),
    [`${M}/m1/timeEntries/t2`]: entry('m1', '2026-10-02', { status: 'draft' }),
    [`${M}/m2/timeEntries/t3`]: entry('m2', '2026-10-02'),
    [`${M}/m1/timeEntries/t4`]: entry('m1', '2026-09-01'),
    [`orgs/${ORG}/invoices/i1`]: {
      ...meta,
      number: 'INV-0001',
      status: 'issued',
      matterId: 'm1',
      matterNumber: '0041',
      matterTitle: 'Estate of Fictional 0041',
      buyer: { name: 'Ada Fictional' },
      issueDate: '2026-10-01',
      dueDate: '2026-10-15',
      subtotalCents: 12000,
      gstCents: 1200,
      totalCents: 13200,
      payments: [],
    },
    [`orgs/${ORG}/invoices/i2`]: {
      ...meta,
      number: '',
      status: 'draft',
      matterId: 'm2',
      subtotalCents: 0,
      gstCents: 0,
      totalCents: 0,
    },
    [`${M}/m1/deadlines/d1`]: deadline('m1', '2026-10-20', { critical: true }),
    [`${M}/m1/deadlines/d2`]: deadline('m1', '2026-10-21', { assigneeUid: 'user-owner', kind: 'internal' }),
    [`${M}/m2/deadlines/d3`]: deadline('m2', '2026-10-22', { privileged: true }),
    [`${M}/m1/deadlines/d4`]: deadline('m1', '2026-10-23', { status: 'done' }),
    ...extra,
  });
  const clock = new FakeClock(NOW);
  const files = new MemoryFiles();
  const tasks = new FakeTaskQueue();
  const signedUrls = new FakeSignedUrls();
  const logged: { message: string; entry: Data }[] = [];
  const log = createLog(
    { fn: 'test' },
    (_severity, message, logEntry) => void logged.push({ message, entry: logEntry }),
  );
  return { ...store, clock, files, tasks, signedUrls, logged, log };
}

const scope = (w: ReturnType<typeof world>, request: ExportJobInput, role: Role = 'owner', uid = `user-${role}`) =>
  ({
    db: w.db,
    orgId: ORG,
    uid,
    role,
    request,
    timeZone: 'Australia/Melbourne',
    now: NOW,
    today: '2026-10-06',
  }) as ExportScope;

async function lines(w: ReturnType<typeof world>, kind: ExportKind, filters: Data = {}, includePrivileged = false) {
  const out: string[] = [];
  for await (const line of exportLines(scope(w, { kind, filters, includePrivileged }))) out.push(line);
  return out;
}

describe('the CSV of each list', () => {
  it('matters: live ones, privileged left out unless asked, filters applied', async () => {
    const w = world();
    expect(await lines(w, 'matters')).toMatchInlineSnapshot(`
      [
        "Matter,Title,Type,Status,Clients,Responsible,Jurisdiction,Opened,Closed,Next deadline,Next deadline due,WIP time,WIP disbursements,Outstanding,Labels,Privileged",
        ""0041",Estate of Fictional 0041,probate,Open,Ada Fictional,Ben Lawyer,VIC,2026-07-01,,,,132.00,0.00,0.00,,No",
        ""0044",Estate of Fictional 0044,probate,Closed,Ada Fictional,Ben Lawyer,VIC,2026-07-01,2026-09-01,,,0.00,0.00,0.00,,No",
      ]
    `);
    expect((await lines(w, 'matters', {}, true)).map((line) => line.split(',')[0])).toEqual([
      'Matter',
      '"0041"',
      '"0042"',
      '"0044"',
    ]);
    expect(await lines(w, 'matters', { status: ['closed'] })).toHaveLength(2);
  });

  it('contacts: merged ones left out, formulas defused, phones kept as text', async () => {
    const w = world();
    expect(await lines(w, 'contacts')).toMatchInlineSnapshot(`
      [
        "Name,Kind,Given names,Family name,Organisation,ABN,Email,Other emails,Phone,Other phones,Address,Tags,Referrer,Roles in matters",
        "Ada Fictional,person,Ada,Fictional,,,ada.fictional@example.com,,"0412 345 678",,,executor,No,client",
        "'=Evil Pty Ltd,organisation,,,'=Evil Pty Ltd,,,,,,,,No,",
      ]
    `);
    expect(await lines(w, 'contacts', { kind: 'person' })).toHaveLength(2);
  });

  it('time entries: the date range, on live matters the member may see', async () => {
    const w = world();
    expect(await lines(w, 'time', { from: '2026-10-01', to: '2026-10-31' })).toMatchInlineSnapshot(`
      [
        "Date,Matter,Matter title,Person,Narrative,Minutes,Units,Hours,Rate,Amount,Billable,Status,Written down from,Write-down reason",
        "2026-10-01,"0041",Estate of Fictional 0041,Ben Lawyer,"'=HYPERLINK(""x"")",18,3,0.30,440.00,132.00,Yes,final,,",
        "2026-10-02,"0041",Estate of Fictional 0041,Ben Lawyer,Perusing the will,18,3,0.30,440.00,132.00,Yes,draft,,",
      ]
    `);
    expect(await lines(w, 'time', { from: '2026-10-01', to: '2026-10-31', status: 'draft' })).toHaveLength(2);
    expect(await lines(w, 'time', { from: '2026-10-01', to: '2026-10-31' }, true)).toHaveLength(4);
  });

  it('invoices: by status, privileged matters’ left out', async () => {
    const w = world();
    expect(await lines(w, 'invoices')).toMatchInlineSnapshot(`
      [
        "Invoice,Status,Matter,Matter title,To,Issued,Due,Subtotal ex GST,GST,Total,Credited,Paid,Owing,Paid from trust",
        ""INV-0001",issued,"0041",Estate of Fictional 0041,Ada Fictional,2026-10-01,2026-10-15,120.00,12.00,132.00,0.00,0.00,132.00,No",
      ]
    `);
    expect(await lines(w, 'invoices', { status: 'draft' }, true)).toHaveLength(2);
  });

  it('deadlines: upcoming ones, the screen’s filters applied', async () => {
    const w = world();
    expect(await lines(w, 'deadlines')).toMatchInlineSnapshot(`
      [
        "Due,Time,Deadline,Kind,Critical,Matter,Matter title,Jurisdiction,Assignee",
        "2026-10-20,,File the inventory,court,Yes,"0041",Estate of Fictional 0041,VIC,Ben Lawyer",
        "2026-10-21,,File the inventory,internal,No,"0041",Estate of Fictional 0041,VIC,Olive Owner",
      ]
    `);
    expect(await lines(w, 'deadlines', { critical: true })).toHaveLength(2);
    const mine = [];
    for await (const line of exportLines(
      scope(w, { kind: 'deadlines', filters: { mine: true }, includePrivileged: false }, 'lawyer'),
    ))
      mine.push(line);
    expect(mine).toHaveLength(2);
  });

  it('writes UTF-8 with a byte-order mark and CRLF lines, page by page', async () => {
    const w = world();
    const file = await writeExport(
      w.files,
      scope(w, { kind: 'matters', filters: {}, includePrivileged: true }),
      'job1',
      {
        pageSize: 1,
      },
    );
    const bytes = (await w.files.read('orgs/org-x/exports/job1.csv')) as Buffer;
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = bytes.toString('utf8');
    expect(text.slice(1).split('\r\n')).toHaveLength(5); // header, 3 rows, then the final line ending
    expect(file).toMatchObject({ storagePath: 'orgs/org-x/exports/job1.csv', rows: 3, sizeBytes: bytes.length });
    expect(w.files.objects.get(file.storagePath)?.object.contentType).toBe('text/csv; charset=utf-8');
  });
});

const deps = (w: ReturnType<typeof world>): CallableDeps => ({
  db: () => w.db,
  clock: w.clock,
  ports: () => fakePorts({ tasks: w.tasks, signedUrls: w.signedUrls, clock: w.clock }),
  memberLookup: async () => true,
  idempotency: {
    begin: async () => ({ replay: false }),
    complete: async () => undefined,
    abandon: async () => undefined,
  },
  sink: () => undefined,
});

describe('exports-create', () => {
  const call = (w: ReturnType<typeof world>, data: Data, role: Role = 'owner', authAgoSeconds = 60) =>
    runCallable(
      createExportDefinition(
        () => w.files,
        () => 'test-bucket',
      ),
      {
        data: { requestId: REQUEST_ID, ...data },
        auth: {
          uid: `user-${role}`,
          token: { orgId: ORG, role, auth_time: NOW.getTime() / 1000 - authAgoSeconds },
        },
      },
      deps(w),
    ).catch((error: unknown) => error as HttpsError);
  const jobs = (w: ReturnType<typeof world>) =>
    [...w.docs.entries()]
      .filter(([path]) => path.startsWith(`orgs/${ORG}/jobs/`))
      .map(([path, data]) => ({ path, data }));
  const audits = (w: ReturnType<typeof world>) =>
    [...w.docs.entries()].filter(([path]) => path.startsWith(`orgs/${ORG}/audit/`)).map(([, data]) => data);

  it('writes a small export now, as a succeeded export job, and returns its download link', async () => {
    const w = world();
    const result = await call(w, { kind: 'contacts', filters: { query: 'ada' } });
    expect(result).toMatchObject({ status: 'succeeded', rows: 1, fileName: 'Contacts 2026-10-06.csv' });
    const [job] = jobs(w);
    expect(job?.data).toMatchObject({
      type: 'csv.export',
      status: 'succeeded',
      createdBy: 'user-owner',
      target: { kind: 'export', name: 'Contacts 2026-10-06' },
      output: { storagePath: `orgs/${ORG}/exports/${job?.path.split('/').at(-1)}.csv`, rows: 1 },
    });
    expect(w.signedUrls.signed[0]).toMatchObject({ contentType: 'text/csv; charset=utf-8' });
    expect(audits(w)).toEqual([
      expect.objectContaining({
        action: 'export.created',
        data: { kind: 'contacts', filters: ['query'], includePrivileged: false, background: false },
      }),
    ]);
    expect(JSON.stringify(audits(w))).not.toContain('ada');
  });

  it('queues a large export for the background', async () => {
    const extra: Record<string, Data> = {};
    for (let i = 0; i <= EXPORT_INLINE_MAX_ROWS; i++) extra[`orgs/${ORG}/contacts/bulk-${i}`] = { kind: 'person' };
    const w = world(extra);
    const result = await call(w, { kind: 'contacts' });
    expect(result).toMatchObject({ status: 'queued' });
    const [job] = jobs(w);
    expect(job?.data).toMatchObject({ status: 'queued', progress: { total: EXPORT_INLINE_MAX_ROWS + 4 } });
    expect(w.tasks.queued).toEqual([
      {
        queue: RUN_EXPORT_QUEUE,
        payload: { orgId: ORG, jobId: job?.path.split('/').at(-1) },
        options: { dedupeKey: `export-${job?.path.split('/').at(-1)}` },
      },
    ]);
    expect(w.files.objects.size).toBe(0);
  });

  it('includes privileged matters only for lawyers and above who ask', async () => {
    const w = world();
    await call(w, { kind: 'matters', includePrivileged: true }, 'paralegal');
    await call(w, { kind: 'matters', includePrivileged: true }, 'lawyer');
    const [lawyer, para] = jobs(w).sort((a, b) =>
      String(a.data['createdBy']).localeCompare(String(b.data['createdBy'])),
    );
    expect(lawyer?.data).toMatchObject({
      createdBy: 'user-lawyer',
      input: { includePrivileged: true },
      output: { rows: 3 },
    });
    expect(para?.data).toMatchObject({
      createdBy: 'user-paralegal',
      input: { includePrivileged: false },
      output: { rows: 2 },
    });
  });

  it('refuses read-only members, and lists their role can’t export', async () => {
    const w = world();
    expect(await call(w, { kind: 'matters' }, 'readonly')).toMatchObject({ code: 'permission-denied' });
    expect(await call(w, { kind: 'invoices' }, 'paralegal')).toMatchObject({ code: 'permission-denied' });
    expect(jobs(w)).toEqual([]);
  });

  it('needs a recent sign-in', async () => {
    const w = world();
    const error = (await call(w, { kind: 'contacts' }, 'owner', 60 * 60)) as HttpsError;
    expect(error.details).toMatchObject({ code: 'REAUTH_REQUIRED' });
    expect(jobs(w)).toEqual([]);
  });
});

describe('exports-run', () => {
  const queued = (w: ReturnType<typeof world>, input: ExportJobInput, createdBy = 'user-lawyer') =>
    w.db.doc(`orgs/${ORG}/jobs/job-big`).set({
      ...meta,
      createdBy,
      type: 'csv.export',
      input,
      target: { kind: 'export', name: 'Time entries 2026-10-06' },
      status: 'queued',
      progress: { done: 0, total: 6000, stage: 'exporting' },
      warnings: [],
      attempts: 0,
    });
  const run = (w: ReturnType<typeof world>, attempt = 0) =>
    runExport(
      { db: w.db, files: w.files, clock: w.clock, log: w.log, ports: { tasks: w.tasks }, attempt, pageSize: 1 },
      { orgId: ORG, jobId: 'job-big' },
    );
  const job = (w: ReturnType<typeof world>) => w.docs.get(`orgs/${ORG}/jobs/job-big`) as Data;
  const TIME: ExportJobInput = {
    kind: 'time',
    filters: { from: '2026-10-01', to: '2026-10-31' },
    includePrivileged: false,
  };

  it('streams the file, marks the job succeeded and tells the member it is ready', async () => {
    const w = world();
    await queued(w, TIME);
    expect(await run(w)).toBe('succeeded');
    expect(job(w)).toMatchObject({
      status: 'succeeded',
      attempts: 1,
      output: { storagePath: `orgs/${ORG}/exports/job-big.csv`, rows: 2 },
    });
    const notification = w.docs.get(`orgs/${ORG}/notifications/export-job-big`);
    expect(notification).toMatchObject({
      kind: 'export_ready',
      exportId: 'job-big',
      recipientUid: 'user-lawyer',
      link: '/exports/job-big',
    });
    expect(w.tasks.queued.map((task) => task.queue)).toContain('notifications-deliver');
    expect(JSON.stringify(w.logged)).not.toContain('Perusing');
    // A second delivery of the task does nothing.
    expect(await run(w)).toBe('skipped');
  });

  it('discards the file when the member lost access while it ran', async () => {
    const w = world();
    await queued(w, { ...TIME, includePrivileged: true });
    // Demoted to paralegal: no longer allowed time entries, or privileged rows.
    await w.db.doc(`orgs/${ORG}/members/user-lawyer`).update({ role: 'paralegal' });
    expect(await run(w)).toBe('discarded');
    expect(job(w)).toMatchObject({ status: 'failed', error: { code: 'PERMISSION_DENIED', retryable: false } });
    expect(w.files.objects.size).toBe(0);
  });

  it('retries a failure, then marks the job failed on the last attempt', async () => {
    const w = world();
    await queued(w, TIME);
    w.files.writeStream = async () => {
      throw new Error('storage down');
    };
    await expect(run(w, 0)).rejects.toThrow('storage down');
    expect(job(w)).toMatchObject({ status: 'running' });
    expect(await run(w, RUN_EXPORT_ATTEMPTS - 1)).toBe('failed');
    expect(job(w)).toMatchObject({ status: 'failed', error: { code: 'UNAVAILABLE', retryable: true } });
  });
});
