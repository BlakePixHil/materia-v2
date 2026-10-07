import { randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';

import type { Timestamp } from 'firebase-admin/firestore';
import { PDFDocument } from 'pdf-lib';

import {
  integrationDocId,
  OffboardMemberInput,
  ORG_PURGE_QUEUE,
  orgDeletionCertificatePath,
  TIMER_DOC_ID,
  type Role,
} from '@materia/domain';

import { cancelDeletionDefinition, requestDeletionDefinition } from './deletion';
import { acceptInviteDefinition } from './invites';
import { offboardingPlanDefinition, offboardMemberDefinition, personalTasksCsv } from './offboarding';
import { deletionCertificatePdf, purgeOrg, queueDueDeletions, type PurgeDeps } from './purge';
import { hashToken } from './shared';
import { memoryAuth, memoryFirestore, type FakeUser } from './testing';
import { clearRetentionCache } from '../audit/retention';
import { deleteAccountDefinition } from '../auth/delete-account';
import { createLog } from '../core/log';
import { MemoryFiles } from '../documents/testing';
import { FakeClock, FakeKms, FakeMail, FakeTaskQueue, fakePorts } from '../ports/fakes';

/**
 * Unit tests for SEC-05's practice deletion, offboarding and account deletion, against an
 * in-memory Firestore, Auth and bucket. Every person, practice and matter is fictional.
 */

const ORG = 'org-a';
const OTHER = 'org-b';
const NOW = new Date('2026-10-06T23:00:00Z');
const DAY = 86_400_000;
type Data = Record<string, unknown>;

const people: FakeUser[] = ['owner', 'admin', 'lawyer', 'paralegal', 'readonly'].map((uid) => ({
  uid,
  email: `${uid}@example.test`,
  displayName: `${uid} Fictional`,
}));
const meta = { createdAt: NOW, createdBy: 'seed', updatedAt: NOW, updatedBy: 'seed', schemaVersion: 1 };
const member = (role: Role, status = 'active') => ({ ...meta, role, status, displayName: `${role} Fictional` });
const user = (uid: string, orgIds: string[]) => ({
  email: `${uid}@example.test`,
  displayName: `${uid} Fictional`,
  orgIds,
  activeOrgId: orgIds[0] ?? null,
  memberships: {},
});
const task = (matterId: string, status: string, assigneeUid = 'lawyer') => ({
  ...meta,
  orgId: ORG,
  matterId,
  title: `Fictional task on ${matterId}`,
  status,
  assigneeUid,
  order: 1,
});
const deadline = (matterId: string, status: string, privileged: boolean) => ({
  ...meta,
  orgId: ORG,
  matterId,
  title: 'File the inventory',
  status,
  dueDate: '2026-11-01',
  assigneeUid: 'lawyer',
  privileged,
});
const matter = (extra: Data = {}) => ({
  ...meta,
  number: '0041',
  title: 'Estate of Fictional Smith',
  status: 'open',
  privileged: false,
  responsibleUid: 'lawyer',
  teamUids: ['lawyer'],
  ...extra,
});

function world(extra: Record<string, Data> = {}) {
  const store = memoryFirestore({
    [`orgs/${ORG}`]: { ...meta, name: 'Fictional Bayside Legal', timezone: 'Australia/Melbourne', retentionYears: 7 },
    [`orgs/${ORG}/members/owner`]: member('owner'),
    [`orgs/${ORG}/members/admin`]: member('admin'),
    [`orgs/${ORG}/members/lawyer`]: member('lawyer'),
    [`orgs/${ORG}/members/paralegal`]: member('paralegal'),
    [`orgs/${ORG}/members/readonly`]: member('readonly'),
    [`orgs/${OTHER}`]: { ...meta, name: 'Fictional Other Practice' },
    [`orgs/${OTHER}/members/lawyer`]: member('lawyer'),
    'users/owner': user('owner', [ORG]),
    'users/admin': user('admin', [ORG]),
    'users/lawyer': user('lawyer', [ORG, OTHER]),
    'users/paralegal': user('paralegal', [ORG]),
    'users/readonly': user('readonly', [ORG]),
    [`orgs/${ORG}/matters/m1`]: matter(),
    [`orgs/${ORG}/matters/m2`]: matter({ number: '0042', privileged: true }),
    [`orgs/${ORG}/matters/m3`]: matter({ number: '0043', status: 'closed' }),
    [`orgs/${ORG}/matters/m1/tasks/t1`]: task('m1', 'todo'),
    [`orgs/${ORG}/matters/m2/tasks/t2`]: task('m2', 'in_progress'),
    [`orgs/${ORG}/matters/m1/tasks/t3`]: task('m1', 'done'),
    [`orgs/${ORG}/matters/m1/tasks/t4`]: task('m1', 'todo', 'paralegal'),
    [`orgs/${ORG}/matters/m1/deadlines/d1`]: deadline('m1', 'upcoming', false),
    [`orgs/${ORG}/matters/m2/deadlines/d2`]: deadline('m2', 'blocked', true),
    [`orgs/${ORG}/matters/m1/deadlines/d3`]: deadline('m1', 'done', false),
    [`orgs/${ORG}/members/lawyer/tasks/p1`]: {
      ...task('m1', 'todo'),
      matterId: null,
      title: 'Renew practising certificate',
      checklist: [
        { id: 'c1', text: 'Pay fee', done: true },
        { id: 'c2', text: 'CPD', done: false },
      ],
      dueDate: '2026-12-01',
    },
    [`orgs/${ORG}/members/lawyer/tasks/p2`]: { ...task('m1', 'done'), matterId: null, title: '=Formula looking title' },
    [`users/lawyer/timer/${TIMER_DOC_ID}`]: {
      orgId: ORG,
      matterId: 'm1',
      startedAt: new Date(NOW.getTime() - 90 * 60_000),
      accumulatedMs: 0,
      running: true,
    },
    [`users/lawyer/recent/m1`]: { orgId: ORG, matterId: 'm1' },
    [`users/lawyer/recent/m9`]: { orgId: OTHER, matterId: 'm9' },
    [`users/lawyer/views/v1`]: { orgId: ORG, name: 'Mine' },
    ...extra,
  });
  const auth = memoryAuth(people);
  const clock = new FakeClock(NOW);
  const mail = new FakeMail();
  const tasks = new FakeTaskQueue();
  const oauthKms = new FakeKms('fake-kms/oauth-tokens/cryptoKeyVersions/1');
  const files = new MemoryFiles();
  const log = createLog({ fn: 'test' }, () => undefined);
  const ports = fakePorts({ mail, tasks, clock, oauthKms });

  const ctx = <T>(uid: string, role: Role, input: T) => ({
    input,
    uid,
    orgId: ORG,
    role,
    token: {},
    requestId: randomUUID(),
    log,
    clock,
    db: store.db,
    ports,
    auth: () => auth.auth,
  });
  const doc = (path: string) => store.docs.get(path);
  const paths = (prefix: string) => [...store.docs.keys()].filter((path) => path.startsWith(prefix));
  const audits = () => paths(`orgs/${ORG}/audit/`).map((path) => doc(path) as Data);
  const notifications = () =>
    [...store.docs.entries()]
      .filter(([path]) => path.includes('/notifications/'))
      .map(([path, data]): Data & { path: string } => ({ ...data, path }));
  return { ...store, auth, clock, mail, tasks, files, log, ports, oauthKms, ctx, doc, paths, audits, notifications };
}
type World = ReturnType<typeof world>;

const fail = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

beforeEach(() => clearRetentionCache());

describe('orgs-requestDeletion and orgs-cancelDeletion', () => {
  const request = (w: World, confirmation = 'Fictional Bayside Legal') =>
    requestDeletionDefinition.handler(w.ctx('owner', 'owner', { requestId: randomUUID(), confirmation }) as never);
  const cancel = (w: World) =>
    cancelDeletionDefinition.handler(w.ctx('owner', 'owner', { requestId: randomUUID() }) as never);

  it('needs the practice’s name typed', async () => {
    const w = world();
    expect(await fail(request(w, 'Fictional Bayside'))).toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { fields: { confirmation: [expect.any(String)] } },
    });
    expect(w.doc(`orgs/${ORG}`)?.['deletionScheduledAt']).toBeUndefined();
    // Case, spacing and curly quotes don't matter.
    expect(await request(w, '  fictional   BAYSIDE legal ')).toEqual({
      deletionScheduledAt: new Date(NOW.getTime() + 30 * DAY).toISOString(),
    });
  });

  it('schedules the deletion 30 days out, tells every member and audits it; asking again answers the same date', async () => {
    const w = world();
    const result = await request(w);
    const at = new Date(NOW.getTime() + 30 * DAY);
    expect(result).toEqual({ deletionScheduledAt: at.toISOString() });
    const org = w.doc(`orgs/${ORG}`) as Data;
    expect((org['deletionScheduledAt'] as Timestamp).toDate()).toEqual(at);
    expect(org['deletionRequestedBy']).toBe('owner');
    const told = w.notifications().filter((n) => n['kind'] === 'org_deletion');
    expect(told.map((n) => n['recipientUid']).sort()).toEqual(['admin', 'lawyer', 'owner', 'paralegal', 'readonly']);
    expect(told[0]).toMatchObject({
      title: 'Fictional Bayside Legal will be deleted on 6 November 2026',
      link: '/settings/data',
    });
    expect(w.audits()).toContainEqual(expect.objectContaining({ action: 'org.deletion_requested' }));
    w.clock.advance(DAY);
    expect(await request(w)).toEqual(result);
  });

  it('is refused while a legal hold is on, on the practice or any matter', async () => {
    const onOrg = world({ [`orgs/${ORG}`]: { ...meta, name: 'Fictional Bayside Legal', legalHold: { on: true } } });
    expect(await fail(request(onOrg))).toMatchObject({ code: 'LEGAL_HOLD', details: { scope: 'org' } });
    const onMatter = world({
      [`orgs/${ORG}/matters/m3`]: matter({ status: 'closed', legalHold: { on: true, reason: 'Fictional dispute' } }),
    });
    expect(await fail(request(onMatter))).toMatchObject({ code: 'LEGAL_HOLD', details: { matterId: 'm3' } });
    expect(onMatter.doc(`orgs/${ORG}`)?.['deletionScheduledAt']).toBeUndefined();
    const released = world({ [`orgs/${ORG}/matters/m3`]: matter({ legalHold: { on: false } }) });
    expect(await request(released)).toHaveProperty('deletionScheduledAt');
  });

  it('is refused while an export is still being written, until it finishes or goes silent', async () => {
    const job = (status: string, heartbeatAt: Date) => ({
      ...meta,
      type: 'org.export',
      status,
      target: { kind: 'export', name: 'Export' },
      heartbeatAt,
    });
    const running = world({ [`orgs/${ORG}/jobs/j1`]: job('running', NOW) });
    expect(await fail(request(running))).toMatchObject({ code: 'EXPORT_RUNNING', details: { jobId: 'j1' } });
    const silent = world({ [`orgs/${ORG}/jobs/j1`]: job('running', new Date(NOW.getTime() - 3 * 60 * 60_000)) });
    expect(await request(silent)).toHaveProperty('deletionScheduledAt');
    const done = world({ [`orgs/${ORG}/jobs/j1`]: job('succeeded', NOW) });
    expect(await request(done)).toHaveProperty('deletionScheduledAt');
  });

  it('cancels during the grace period, telling everyone, but not once the deletion has started', async () => {
    const w = world();
    expect(await cancel(w)).toEqual({ cancelled: false });
    await request(w);
    expect(await cancel(w)).toEqual({ cancelled: true });
    expect(w.doc(`orgs/${ORG}`)).not.toHaveProperty('deletionScheduledAt');
    expect(w.doc(`orgs/${ORG}`)).not.toHaveProperty('deletionRequestedBy');
    // The cancellation replaces the scheduled notice for each member (the same key).
    const told = w.notifications().filter((n) => n['recipientUid'] === 'admin');
    expect(told).toEqual([expect.objectContaining({ title: 'Fictional Bayside Legal won’t be deleted' })]);
    expect(w.audits()).toContainEqual(expect.objectContaining({ action: 'org.deletion_cancelled' }));
    await request(w);
    await w.db.doc(`deletedOrgs/${ORG}`).set({ orgId: ORG, status: 'purging' });
    expect(await fail(cancel(w))).toMatchObject({
      code: 'FAILED_PRECONDITION',
      details: { reason: 'deletion_started' },
    });
  });
});

describe('orgs-purge', () => {
  /** A recursive delete over the in-memory store, as `firestoreDeleteTree` does with Firestore. */
  const purgeDeps = (w: World): PurgeDeps => ({
    db: w.db,
    files: w.files,
    clock: w.clock,
    log: w.log,
    ports: w.ports,
    auth: () => w.auth.auth,
    deleteTree: async (path) => {
      const gone = [...w.docs.keys()].filter((doc) => doc === path || doc.startsWith(`${path}/`));
      for (const doc of gone) w.docs.delete(doc);
      return gone.length;
    },
  });

  async function scheduled(extra: Record<string, Data> = {}) {
    const w = world(extra);
    await requestDeletionDefinition.handler(
      w.ctx('owner', 'owner', { requestId: randomUUID(), confirmation: 'Fictional Bayside Legal' }) as never,
    );
    const id = integrationDocId('microsoft', 'lawyer');
    const tokenPath = `orgs/${ORG}/integrations/${id}`;
    const { ciphertext } = await w.oauthKms.encrypt('fictional-refresh-token', tokenPath);
    await w.db.doc(tokenPath).set({ provider: 'microsoft', uid: 'lawyer', encryptedRefreshToken: ciphertext });
    w.files.put(`orgs/${ORG}/matters/m1/documents/d1/v1`, 'fictional will');
    w.files.put(`orgs/${ORG}/matters/m1/documents/d1/v1/renditions/preview.pdf`, 'preview');
    w.files.put(`orgs/${ORG}/templates/letterhead.docx`, 'template');
    w.files.put(`orgs/${OTHER}/matters/m9/documents/d9/v1`, 'not ours');
    return w;
  }

  async function runAll(w: World) {
    const outcomes: string[] = [];
    for (let i = 0; i < 20; i++) {
      const step = await purgeOrg(purgeDeps(w), ORG);
      outcomes.push(step.outcome);
      if (step.nextInMs === null) break;
      w.clock.advance(step.nextInMs);
    }
    return outcomes;
  }

  it('does nothing before the grace period ends', async () => {
    const w = await scheduled();
    w.clock.advance(29 * DAY);
    expect(await purgeOrg(purgeDeps(w), ORG)).toEqual({ outcome: 'not_due', nextInMs: null });
    expect(w.doc(`deletedOrgs/${ORG}`)).toBeUndefined();
  });

  it('deletes everything of the practice, step by step, leaving only the tombstone and certificate', async () => {
    const w = await scheduled();
    w.clock.advance(30 * DAY + 1000);
    const outcomes = await runAll(w);
    expect(outcomes).toEqual(['marked', 'integrations', 'storage', 'firestore', 'users', 'verified', 'certificate']);

    // Nothing under the practice, in Firestore or Storage; the other practice untouched.
    expect(w.paths(`orgs/${ORG}/`)).toEqual([]);
    expect(w.doc(`orgs/${ORG}`)).toBeUndefined();
    expect([...w.files.objects.keys()].filter((path) => path.startsWith(`orgs/${ORG}/`))).toEqual([]);
    expect(w.doc(`orgs/${OTHER}`)).toBeDefined();
    expect(w.files.objects.has(`orgs/${OTHER}/matters/m9/documents/d9/v1`)).toBe(true);
    // No record anywhere names the practice, but the tombstone and the certificate.
    const naming = [...w.docs.entries()].filter(
      ([path, data]) => !path.startsWith('deletedOrgs/') && JSON.stringify(data).includes(`"${ORG}"`),
    );
    expect(naming).toEqual([]);
    // People keep their other practices.
    expect(w.doc('users/lawyer/recent/m9')).toBeDefined();
    expect(w.doc('users/lawyer/recent/m1')).toBeUndefined();
    expect(w.doc('users/lawyer/views/v1')).toBeUndefined();
    expect(w.doc(`users/lawyer/timer/${TIMER_DOC_ID}`)).toBeUndefined();
    expect(w.doc('users/lawyer')).toMatchObject({ orgIds: [OTHER], activeOrgId: OTHER });
    expect(w.auth.records.get('lawyer')?.customClaims).toMatchObject({ orgs: { [OTHER]: 'lawyer' } });
    expect(w.doc('users/owner')).toMatchObject({ orgIds: [], activeOrgId: null });

    const tomb = w.doc(`deletedOrgs/${ORG}`) as Data;
    expect(tomb).toMatchObject({
      orgId: ORG,
      name: 'Fictional Bayside Legal',
      status: 'deleted',
      stage: 'certificate',
      ownerUids: ['owner'],
      counts: { integrations: 1, members: 5 },
    });
    expect(tomb).not.toHaveProperty('memberUids');
    expect((tomb['counts'] as Data)['records']).toBeGreaterThan(15);
    expect((tomb['counts'] as Data)['files']).toBe(3);
    const certificatePath = orgDeletionCertificatePath(ORG, String(tomb['certificateId']));
    expect(tomb['certificate']).toMatchObject({ storagePath: certificatePath });
    const pdf = w.files.objects.get(certificatePath)?.data as Buffer;
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await PDFDocument.load(pdf)).getTitle()).toBe(`Certificate of deletion ${String(tomb['certificateId'])}`);

    // The owners get it by email; the provider's token was revoked.
    expect(w.mail.sent).toHaveLength(1);
    expect(w.mail.sent[0]).toMatchObject({
      to: 'owner@example.test',
      template: 'notification',
      attachments: [expect.objectContaining({ contentType: 'application/pdf' })],
    });
    // A repeat does nothing.
    expect(await purgeOrg(purgeDeps(w), ORG)).toEqual({ outcome: 'deleted', nextInMs: null });
  });

  it('cancels the deletion when a legal hold was placed during the grace period, and tells the owners', async () => {
    const w = await scheduled();
    await w.db.doc(`orgs/${ORG}/matters/m2`).update({ legalHold: { on: true } });
    w.clock.advance(31 * DAY);
    expect(await purgeOrg(purgeDeps(w), ORG)).toEqual({ outcome: 'blocked', nextInMs: null });
    expect(w.doc(`deletedOrgs/${ORG}`)).toBeUndefined();
    expect(w.doc(`orgs/${ORG}`)).not.toHaveProperty('deletionScheduledAt');
    expect(w.paths(`orgs/${ORG}/matters/`).length).toBeGreaterThan(0);
    expect(w.audits()).toContainEqual(
      expect.objectContaining({ action: 'org.deletion_blocked', data: expect.objectContaining({ matterId: 'm2' }) }),
    );
    const owner = w.notifications().filter((n) => n['recipientUid'] === 'owner');
    expect(owner).toContainEqual(
      expect.objectContaining({
        kind: 'org_deletion',
        title: 'Fictional Bayside Legal wasn’t deleted: a legal hold is on',
      }),
    );
    expect(w.notifications().filter((n) => String(n['title']).includes('legal hold'))).toHaveLength(1);
  });

  it('waits for an export still being written', async () => {
    const w = await scheduled();
    w.clock.advance(31 * DAY);
    await w.db.doc(`orgs/${ORG}/jobs/j1`).set({
      type: 'org.export',
      status: 'running',
      target: { kind: 'export', name: 'x' },
      heartbeatAt: w.clock.now(),
    });
    expect(await purgeOrg(purgeDeps(w), ORG)).toEqual({ outcome: 'postponed', nextInMs: 60 * 60_000 });
    expect(w.doc(`deletedOrgs/${ORG}`)).toBeUndefined();
  });

  it('a cancelled deletion is not due', async () => {
    const w = await scheduled();
    await cancelDeletionDefinition.handler(w.ctx('owner', 'owner', { requestId: randomUUID() }) as never);
    w.clock.advance(31 * DAY);
    expect(await purgeOrg(purgeDeps(w), ORG)).toEqual({ outcome: 'not_due', nextInMs: null });
  });

  it('the daily sweep queues due deletions and resumes stopped ones', async () => {
    const w = await scheduled({ [`deletedOrgs/org-old`]: { orgId: 'org-old', status: 'purging' } });
    expect(await queueDueDeletions({ db: w.db, clock: w.clock, log: w.log, ports: w.ports })).toEqual({
      due: 0,
      resumed: 1,
    });
    w.clock.advance(30 * DAY);
    w.tasks.queued.length = 0;
    expect(await queueDueDeletions({ db: w.db, clock: w.clock, log: w.log, ports: w.ports })).toEqual({
      due: 1,
      resumed: 1,
    });
    expect(w.tasks.queued.map((task) => [task.queue, task.payload['orgId']])).toEqual([
      [ORG_PURGE_QUEUE, ORG],
      [ORG_PURGE_QUEUE, 'org-old'],
    ]);
  });

  it('states on the certificate how long backups keep copies', async () => {
    const bytes = await deletionCertificatePdf({
      certificateId: 'odc-0123456789ab',
      orgId: ORG,
      name: 'Fictional Bayside Legal – Zoë & Co',
      requestedBy: 'Olive Fictional',
      requestedAt: NOW,
      scheduledFor: new Date(NOW.getTime() + 30 * DAY),
      purgeStartedAt: new Date(NOW.getTime() + 30 * DAY),
      deletedAt: new Date(NOW.getTime() + 30 * DAY + 3_600_000),
      counts: { records: 120, files: 12, integrations: 1, members: 4 },
      timeZone: 'Australia/Melbourne',
    });
    // pdf-lib writes text as hex strings, in compressed content streams.
    const raw = Buffer.from(bytes).toString('latin1');
    const text = [...raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)]
      .map((match) => inflateSync(Buffer.from(match[1] ?? '', 'latin1')).toString('latin1'))
      .join('\n')
      .toUpperCase();
    const hex = (value: string) => Buffer.from(value, 'latin1').toString('hex').toUpperCase();
    expect(text).toContain(hex('Backups taken before the deletion'));
    expect(text).toContain(hex('daily backups after 7 days'));
    expect(text).toContain(hex('monthly exports after 400 days'));
    expect(text).toContain(hex('within about 13 months'));
    expect(text).toContain(hex('Fictional Bayside Legal - Zoe & Co'));
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });
});

describe('offboarding', () => {
  const plan = (w: World, uid = 'lawyer') =>
    offboardingPlanDefinition.handler(w.ctx('admin', 'admin', { uid }) as never);
  const offboard = (w: World, input: Partial<Data>, as: Role = 'admin') =>
    offboardMemberDefinition(() => w.files).handler(
      w.ctx(
        as,
        as,
        OffboardMemberInput.parse({ requestId: randomUUID(), uid: 'lawyer', personalTasks: 'export', ...input }),
      ) as never,
    );

  it('counts what the member leaves behind', async () => {
    const w = world();
    const id = integrationDocId('microsoft', 'lawyer');
    await w.db.doc(`orgs/${ORG}/integrations/${id}`).set({ provider: 'microsoft', uid: 'lawyer' });
    expect(await plan(w)).toEqual({
      uid: 'lawyer',
      tasks: 2,
      deadlines: 2,
      matters: 2,
      privileged: { tasks: true, deadlines: true, matters: true },
      personalTasks: 2,
      timer: true,
      integrations: 1,
    });
    expect(await plan(w, 'paralegal')).toMatchObject({
      tasks: 1,
      deadlines: 0,
      matters: 0,
      timer: false,
      privileged: { tasks: false },
    });
    expect(await fail(plan(w, 'nobody'))).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('needs someone for each kind of work, active, not read-only, and able to see privileged work', async () => {
    const w = world();
    expect(await fail(offboard(w, { reassign: {} }))).toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: {
        fields: {
          'reassign.tasks': [expect.any(String)],
          'reassign.deadlines': [expect.any(String)],
          'reassign.matters': [expect.any(String)],
        },
      },
    });
    expect(
      await fail(offboard(w, { reassign: { tasks: 'paralegal', deadlines: 'readonly', matters: 'lawyer' } })),
    ).toMatchObject({
      details: {
        fields: {
          'reassign.tasks': ['Some of this is privileged: choose someone who can see privileged matters'],
          'reassign.deadlines': ['Choose an active member who isn’t leaving'],
          'reassign.matters': ['Choose an active member who isn’t leaving'],
        },
      },
    });
    // Nothing changed.
    expect(w.doc(`orgs/${ORG}/members/lawyer`)).toMatchObject({ status: 'active' });
    expect(w.doc(`orgs/${ORG}/matters/m1/tasks/t1`)).toMatchObject({ assigneeUid: 'lawyer' });
  });

  it('hands on the work, saves the timer, exports the personal tasks to the admin and removes the member', async () => {
    const w = world();
    const id = integrationDocId('microsoft', 'lawyer');
    const tokenPath = `orgs/${ORG}/integrations/${id}`;
    const { ciphertext } = await w.oauthKms.encrypt('fictional-refresh-token', tokenPath);
    await w.db.doc(tokenPath).set({ provider: 'microsoft', uid: 'lawyer', encryptedRefreshToken: ciphertext });

    const result = await offboard(w, { reassign: { tasks: 'admin', deadlines: 'owner', matters: 'admin' } });
    expect(result).toMatchObject({
      ok: true,
      moved: { tasks: 2, deadlines: 2, matters: 2 },
      personalTasks: { choice: 'export', count: 2, exportJobId: expect.any(String) },
      timer: 'saved',
      integrationsRemoved: 1,
    });

    expect(w.doc(`orgs/${ORG}/matters/m1/tasks/t1`)).toMatchObject({ assigneeUid: 'admin', updatedBy: 'admin' });
    expect(w.doc(`orgs/${ORG}/matters/m2/tasks/t2`)).toMatchObject({ assigneeUid: 'admin' });
    expect(w.doc(`orgs/${ORG}/matters/m1/tasks/t3`)).toMatchObject({ assigneeUid: 'lawyer' });
    expect(w.doc(`orgs/${ORG}/matters/m1/tasks/t4`)).toMatchObject({ assigneeUid: 'paralegal' });
    expect(w.doc(`orgs/${ORG}/matters/m1/deadlines/d1`)).toMatchObject({ assigneeUid: 'owner' });
    expect(w.doc(`orgs/${ORG}/matters/m2/deadlines/d2`)).toMatchObject({ assigneeUid: 'owner' });
    expect(w.doc(`orgs/${ORG}/matters/m1/deadlines/d3`)).toMatchObject({ assigneeUid: 'lawyer' });
    expect(w.doc(`orgs/${ORG}/matters/m1`)).toMatchObject({ responsibleUid: 'admin', teamUids: ['lawyer', 'admin'] });
    expect(w.doc(`orgs/${ORG}/matters/m3`)).toMatchObject({ responsibleUid: 'lawyer' });

    // 90 minutes of timer, saved as a draft entry on its matter.
    const entries = w.paths(`orgs/${ORG}/matters/m1/timeEntries/`).map((path) => w.doc(path) as Data);
    expect(entries).toEqual([
      expect.objectContaining({ uid: 'lawyer', minutes: 90, status: 'draft', source: 'timer', createdBy: 'admin' }),
    ]);
    expect(w.doc(`users/lawyer/timer/${TIMER_DOC_ID}`)).toBeUndefined();

    // The personal tasks: a CSV export for the admin, then gone.
    expect(w.paths(`orgs/${ORG}/members/lawyer/tasks/`)).toEqual([]);
    const jobId = String((result as { personalTasks: { exportJobId: string } }).personalTasks.exportJobId);
    expect(w.doc(`orgs/${ORG}/jobs/${jobId}`)).toMatchObject({
      type: 'csv.export',
      status: 'succeeded',
      createdBy: 'admin',
      target: { kind: 'export', name: 'Personal tasks of lawyer Fictional 2026-10-07' },
      output: { storagePath: `orgs/${ORG}/exports/${jobId}.csv`, rows: 2 },
    });
    const csv = w.files.objects.get(`orgs/${ORG}/exports/${jobId}.csv`)?.data.toString('utf8') ?? '';
    expect(csv).toContain('Renew practising certificate,todo,');
    expect(csv).toContain('1 of 2 done');
    expect(csv).toContain("'=Formula looking title");
    const ready = w.notifications().find((n) => n['kind'] === 'export_ready');
    expect(ready).toMatchObject({ exportId: jobId, link: `/exports/${jobId}` });
    expect(ready?.['recipientUid']).toBe('admin');

    // Removed, as orgs-removeMember does; their other practice stays.
    expect(w.doc(`orgs/${ORG}/members/lawyer`)).toMatchObject({ status: 'removed' });
    expect(w.auth.revoked).toEqual(['lawyer']);
    expect(w.auth.records.get('lawyer')?.customClaims).toMatchObject({ orgs: { [OTHER]: 'lawyer' } });
    expect(w.doc(tokenPath)).toBeUndefined();
    expect(w.audits()).toContainEqual(
      expect.objectContaining({
        action: 'member.offboarded',
        entity: expect.objectContaining({ path: `orgs/${ORG}/members/lawyer` }),
      }),
    );
  });

  it('deletes the personal tasks without an export when asked, and needs no one for no work', async () => {
    const w = world();
    const result = await offboard(w, { uid: 'paralegal', personalTasks: 'delete', reassign: { tasks: 'admin' } });
    expect(result).toMatchObject({
      moved: { tasks: 1, deadlines: 0, matters: 0 },
      personalTasks: { choice: 'delete', count: 0 },
      timer: 'none',
    });
    expect(w.paths(`orgs/${ORG}/jobs/`)).toEqual([]);
    const lawyer = await offboard(w, {
      personalTasks: 'delete',
      reassign: { tasks: 'admin', deadlines: 'admin', matters: 'owner' },
    });
    expect(lawyer).toMatchObject({ personalTasks: { choice: 'delete', count: 2 } });
    expect(w.paths(`orgs/${ORG}/members/lawyer/tasks/`)).toEqual([]);
    expect(w.paths(`orgs/${ORG}/jobs/`)).toEqual([]);
  });

  it('only an owner offboards an owner', async () => {
    const w = world({ [`orgs/${ORG}/members/owner2`]: member('owner'), 'users/owner2': user('owner2', [ORG]) });
    w.auth.records.set('owner2', { uid: 'owner2', email: 'owner2@example.test', emailVerified: true });
    expect(await fail(offboard(w, { uid: 'owner2', personalTasks: 'delete' }))).toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(await offboard(w, { uid: 'owner2', personalTasks: 'delete' }, 'owner')).toMatchObject({ ok: true });
  });

  it('writes the personal tasks CSV with a byte-order mark and defused formulas', () => {
    const csv = personalTasksCsv([{ title: '@SUM(A1)', status: 'todo', priority: 'high', createdAt: NOW }]);
    expect(csv.startsWith('﻿Title,Status,Priority,Due date,Group,Description,Checklist,Created\r\n')).toBe(true);
    expect(csv).toContain("'@SUM(A1),todo,high,,,,,2026-10-06");
  });
});

describe('a practice waiting to be deleted takes no one new', () => {
  it('refuses an invite into it', async () => {
    const token = 'fictional-invite-token';
    const w = world({
      [`orgs/${ORG}/invites/i1`]: {
        email: 'invitee@example.test',
        role: 'lawyer',
        tokenHash: hashToken(token),
        status: 'pending',
        expiresAt: new Date(NOW.getTime() + DAY),
        invitedBy: 'owner',
      },
    });
    w.auth.records.set('invitee', { uid: 'invitee', email: 'invitee@example.test', emailVerified: true });
    await w.db.doc(`orgs/${ORG}`).update({ deletionScheduledAt: new Date(NOW.getTime() + 30 * DAY) });
    const ctx = {
      input: { requestId: randomUUID(), inviteId: 'i1', token },
      uid: 'invitee',
      token: null,
      requestId: randomUUID(),
      log: w.log,
      clock: w.clock,
      db: w.db,
      auth: w.auth.auth,
    };
    expect(await fail(acceptInviteDefinition.handler(ctx as never))).toMatchObject({
      code: 'INVITE_INVALID',
      details: { reason: 'org_deleting' },
    });
    expect(w.doc(`orgs/${ORG}/members/invitee`)).toBeUndefined();
  });
});

describe('auth-deleteAccount', () => {
  function account(uid: string, token: Data | null = null) {
    const w = world({
      'users/solo': user('solo', []),
      'users/solo/views/v1': { name: 'Mine' },
      'users/solo/devices/d1': { token: 'x' },
    });
    w.auth.records.set('solo', { uid: 'solo', email: 'solo@example.test', emailVerified: true });
    const deleted: string[] = [];
    Object.assign(w.auth.auth, { deleteUser: async (id: string) => void deleted.push(id) });
    Object.assign(w.db, {
      recursiveDelete: async (ref: { path: string }) => {
        for (const path of [...w.docs.keys()])
          if (path === ref.path || path.startsWith(`${ref.path}/`)) w.docs.delete(path);
      },
    });
    w.files.put('users/solo/avatar.png', 'png');
    w.files.put('users/solos/avatar.png', 'someone else');
    const run = (confirmation = 'DELETE') =>
      deleteAccountDefinition(() => w.files).handler({
        input: { confirmation },
        uid,
        token: token as never,
        requestId: randomUUID(),
        log: w.log,
        clock: w.clock,
        db: w.db,
        auth: w.auth.auth,
      });
    return { w, run, deleted };
  }

  it('deletes the profile, its files and the sign-in of someone in no practice', async () => {
    const { w, run, deleted } = account('solo');
    expect(await fail(run('delete me'))).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await run('delete')).toEqual({ deleted: true });
    expect(w.paths('users/solo/')).toEqual([]);
    expect(w.doc('users/solo')).toBeUndefined();
    expect(w.files.objects.has('users/solo/avatar.png')).toBe(false);
    expect(w.files.objects.has('users/solos/avatar.png')).toBe(true);
    expect(deleted).toEqual(['solo']);
  });

  it('is refused for someone still in a practice', async () => {
    const { w, run, deleted } = account('lawyer');
    expect(await fail(run())).toMatchObject({ code: 'ACCOUNT_HAS_ORGS', details: { orgs: 2 } });
    expect(w.doc('users/lawyer')).toBeDefined();
    expect(deleted).toEqual([]);
  });

  it('checks the member documents, not just the profile', async () => {
    const { w, run } = account('admin', { orgs: { [ORG]: 'admin' } });
    await w.db.doc('users/admin').update({ orgIds: [] });
    expect(await fail(run())).toMatchObject({ code: 'ACCOUNT_HAS_ORGS', details: { orgs: 1 } });
  });
});
