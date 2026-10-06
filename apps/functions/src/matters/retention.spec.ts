import { randomUUID } from 'node:crypto';

import { Timestamp } from 'firebase-admin/firestore';
import { PDFDocument } from 'pdf-lib';

import type { Role } from '@materia/domain';

import { applyRetentionChange, archiveOrg } from './archive';
import { closeDefinition, closingChecklistDefinition } from './closing';
import {
  approveDestructionDefinition,
  certificatePdf,
  destroyMatter,
  destructionCertificateUrlDefinition,
  queueOrg,
} from './destruction';
import { reopenDefinition, setLegalHoldDefinition } from './reopen';
import { clearRetentionCache } from '../audit/retention';
import { clearFlagCaches, setRemoteFlagLoader } from '../core/flags';
import { createLog } from '../core/log';
import { MemoryFiles } from '../documents/testing';
import { memoryFirestore } from '../orgs/testing';
import { FakeClock, FakeTaskQueue, fakePorts } from '../ports/fakes';

/** Unit tests for matter closing and retention (CORE-19). Every practice and person is fictional. */

const ORG = 'org-r';
const M = `orgs/${ORG}/matters`;
const Q = `orgs/${ORG}/destructionQueue`;
const SC = `orgs/${ORG}/safeCustody`;
/** A will matter's testator party and contact (CORE-17a). */
const TESTATOR = {
  [`${M}/m1/parties/testator-c-will`]: { contactId: 'c-will', role: 'testator', deletedAt: null },
  [`orgs/${ORG}/contacts/c-will`]: { kind: 'person', givenNames: 'Fictional', familyName: 'Quill', deletedAt: null },
};
const SAFE = { site: 'Geelong office', cabinet: 'Safe 2', slot: '14' };
const meta = { createdBy: 'seed', updatedBy: 'seed', schemaVersion: 1 };
const NOW = '2026-10-05T01:00:00.000Z';

const matter = (extra: Record<string, unknown> = {}) => ({
  ...meta,
  number: 'M-2026-0001',
  title: 'Estate of Fictional Quill',
  type: 'probate',
  status: 'open',
  privileged: false,
  relatedMatterIds: [],
  deletedAt: null,
  ...extra,
});

function world(
  initial: Record<string, Record<string, unknown>> = {},
  at = NOW,
  orgExtra: Record<string, unknown> = {},
) {
  const store = memoryFirestore({
    [`orgs/${ORG}`]: {
      name: 'Fictional Harbour Legal',
      retentionYears: 7,
      timezone: 'Australia/Melbourne',
      ...orgExtra,
    },
    [`orgs/${ORG}/members/user-admin`]: { ...meta, role: 'admin', status: 'active', displayName: 'Ada Admin' },
    [`${M}/m1`]: matter(),
    ...initial,
  });
  const clock = new FakeClock(new Date(at));
  const tasks = new FakeTaskQueue();
  const ports = fakePorts({ tasks });
  const log = createLog({ fn: 'test' }, () => undefined);
  const ctx = <T>(input: T, role: Role = 'lawyer', token: Record<string, unknown> = {}) => ({
    input,
    uid: `user-${role}`,
    orgId: ORG,
    role,
    token,
    requestId: randomUUID(),
    log,
    clock,
    db: store.db,
    ports,
    auth: () => {
      throw new Error('no auth here');
    },
  });
  const doc = (path: string) => store.docs.get(path);
  const audits = (action: string) =>
    [...store.docs.entries()]
      .filter(([path, data]) => path.startsWith(`orgs/${ORG}/audit/`) && data['action'] === action)
      .map(([, data]) => data);
  const answers = { originals: 'returned', closingLetterSent: true, finalDistributionRecorded: true };
  const close = (input: Record<string, unknown> = {}, role: Role = 'lawyer') =>
    closeDefinition.handler(
      ctx(
        { requestId: randomUUID(), matterId: 'm1', reason: 'Estate finalised', checklist: answers, ...input },
        role,
      ) as never,
    );
  return { ...store, clock, tasks, ports, log, ctx, doc, audits, close, answers };
}

const failureOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; details?: Record<string, unknown> };
  }
  throw new Error('expected a failure');
};

beforeEach(() => {
  clearRetentionCache();
  setRemoteFlagLoader(async () => ({}));
});
afterEach(() => clearFlagCaches());

describe('matters-closingChecklist', () => {
  it('reports what blocks closing, the date closing would set, and open related matters', async () => {
    const w = world({
      [`${M}/m1`]: matter({ relatedMatterIds: ['m2', 'm3'] }),
      [`${M}/m2`]: matter({ number: 'M-2026-0002', type: 'contest', status: 'open' }),
      [`${M}/m3`]: matter({ number: 'M-2026-0003', status: 'closed' }),
      [`${M}/m1/deadlines/d1`]: { status: 'upcoming', deletedAt: null },
      [`${M}/m1/deadlines/d2`]: { status: 'done', deletedAt: null },
      [`${M}/m1/tasks/t1`]: { status: 'todo', deletedAt: null },
      [`${M}/m1/tasks/t2`]: { status: 'in_progress', deletedAt: new Date() },
    });
    const result = await closingChecklistDefinition.handler(w.ctx({ matterId: 'm1' }) as never);
    expect(result.ready).toBe(false);
    expect(result.blocking).toEqual(['deadlines', 'tasks', 'originals', 'closing_letter', 'final_distribution']);
    expect(result.counts).toEqual({ upcomingDeadlines: 1, openTasks: 1, unbilledWipCents: 0 });
    expect(result.warnings).toEqual([{ kind: 'related_open', matterId: 'm2', number: 'M-2026-0002' }]);
    // 5 October 2026 in Melbourne, plus seven years.
    expect(result).toMatchObject({ destroyAfter: '2033-10-05', holds: [], retentionYears: 7 });
  });
});

describe('matters-close', () => {
  it('blocks while the checklist has items to do', async () => {
    const w = world({ [`${M}/m1/deadlines/d1`]: { status: 'blocked', deletedAt: null } });
    expect(await failureOf(w.close())).toMatchObject({
      code: 'FAILED_PRECONDITION',
      details: { reason: 'closing_checklist', blocking: ['deadlines'] },
    });
    expect(w.doc(`${M}/m1`)?.['status']).toBe('open');
    expect(await failureOf(world().close({ checklist: { closingLetterSent: true } }))).toMatchObject({
      details: { blocking: ['originals', 'final_distribution'] },
    });
  });

  it('blocks on unbilled time and disbursements unless overridden with a reason (CORE-19b)', async () => {
    const w = world({ [`${M}/m1`]: matter({ wipCents: 120_00, disbursementWipCents: 30_00 }) });
    expect(await failureOf(w.close())).toMatchObject({ details: { reason: 'closing_checklist', blocking: ['wip'] } });
    await w.close({ checklistOverrides: { wip: 'Written off: pro bono final letter' } });
    expect(w.doc(`${M}/m1`)).toMatchObject({
      status: 'closed',
      closing: { overrides: { wip: 'Written off: pro bono final letter' } },
    });
  });

  it('closes: closedAt, the reason, the closing record and destroyAfter seven years on; audited', async () => {
    const w = world({ [`${M}/m1/deadlines/d1`]: { status: 'done', nextReminderAt: new Date(), deletedAt: null } });
    await expect(w.close()).resolves.toEqual({
      matterId: 'm1',
      status: 'closed',
      tasksCancelled: 0,
      destroyAfter: '2033-10-05',
      holds: [],
    });
    expect(w.doc(`${M}/m1`)).toMatchObject({
      status: 'closed',
      closeReason: 'Estate finalised',
      destroyAfter: '2033-10-05',
      closing: { originals: 'returned', closingLetterSent: true, finalDistributionRecorded: true, tasksCancelled: 0 },
    });
    expect(w.doc(`${M}/m1`)?.['closedAt']).toBeInstanceOf(Timestamp);
    // Its reminders stop.
    expect(w.doc(`${M}/m1/deadlines/d1`)).not.toHaveProperty('nextReminderAt');
    expect(w.audits('matter.closed')[0]).toMatchObject({ data: { destroyAfter: '2033-10-05', tasksCancelled: 0 } });
  });

  it('bulk-cancels open tasks with a reason, and accepts overrides with reasons', async () => {
    const w = world({
      [`${M}/m1/tasks/t1`]: { status: 'todo', deletedAt: null },
      [`${M}/m1/tasks/t2`]: { status: 'blocked', deletedAt: null },
      [`${M}/m1/tasks/t3`]: { status: 'done', deletedAt: null },
    });
    const result = await w.close({
      checklist: { originals: 'none_held' },
      cancelOpenTasks: { reason: 'Superseded by the final account' },
      checklistOverrides: {
        closing_letter: 'Client collected the file',
        final_distribution: 'No assets to distribute',
      },
    });
    expect(result.tasksCancelled).toBe(2);
    expect(w.doc(`${M}/m1/tasks/t1`)?.['status']).toBe('cancelled');
    expect(w.doc(`${M}/m1/tasks/t2`)?.['status']).toBe('cancelled');
    expect(w.doc(`${M}/m1/tasks/t3`)?.['status']).toBe('done');
    expect(w.doc(`${M}/m1`)?.['closing']).toMatchObject({
      overrides: { closing_letter: 'Client collected the file', final_distribution: 'No assets to distribute' },
      tasksCancelled: 2,
    });
    expect(w.audits('matter.closed')[0]).toMatchObject({
      data: { tasksCancelled: 2, overridden: ['closing_letter', 'final_distribution'] },
    });
  });

  it('sets no destroyAfter for a will in safe custody, a matter with a minor, or a legal hold', async () => {
    const will = world({ [`${M}/m1`]: matter({ type: 'will' }), ...TESTATOR });
    await expect(
      will.close({ checklist: { originals: 'safe_custody', closingLetterSent: true }, safeCustodyLocation: SAFE }),
    ).resolves.toMatchObject({
      destroyAfter: null,
      holds: ['originals_in_custody'],
    });
    expect(will.doc(`${M}/m1`)).not.toHaveProperty('destroyAfter');

    const minor = world({
      [`${M}/m1/parties/beneficiary-c1`]: { contactId: 'c1', role: 'beneficiary', deletedAt: null },
      [`orgs/${ORG}/contacts/c1`]: { kind: 'person', givenNames: 'Fictional', dateOfBirth: '2012-04-01' },
    });
    await expect(minor.close()).resolves.toMatchObject({ destroyAfter: null, holds: ['minor'] });

    const held = world({
      [`${M}/m1`]: matter({ legalHold: { on: true, reason: 'Dispute', by: 'u', at: new Date() } }),
    });
    await expect(held.close()).resolves.toMatchObject({ destroyAfter: null, holds: ['legal_hold'] });
  });

  it('closes only open or on-hold matters, and only for lawyers and above', async () => {
    expect(await failureOf(world({ [`${M}/m1`]: matter({ status: 'lead' }) }).close())).toMatchObject({
      code: 'MATTER_INVALID_TRANSITION',
    });
    await expect(world({ [`${M}/m1`]: matter({ status: 'on_hold' }) }).close()).resolves.toMatchObject({
      status: 'closed',
    });
    expect(closeDefinition.roles).toEqual(['owner', 'admin', 'lawyer']);
  });
});

describe('matters-reopen and legal holds', () => {
  const closed = (extra: Record<string, unknown> = {}) =>
    matter({
      status: 'closed',
      closedAt: new Date('2019-03-01T00:00:00Z'),
      destroyAfter: '2026-03-01',
      closing: {
        originals: 'returned',
        closingLetterSent: true,
        finalDistributionRecorded: true,
        tasksCancelled: 0,
        holds: [],
      },
      ...extra,
    });

  it('reopens a closed or archived matter, clears destroyAfter and cancels its queued destruction', async () => {
    for (const status of ['closed', 'archived']) {
      const w = world({ [`${M}/m1`]: closed({ status }), [`${Q}/m1`]: { status: 'pending' } });
      await expect(
        reopenDefinition.handler(w.ctx({ requestId: randomUUID(), matterId: 'm1', reason: 'More assets' }) as never),
      ).resolves.toEqual({ matterId: 'm1', status: 'open' });
      const doc = w.doc(`${M}/m1`);
      expect(doc?.['status']).toBe('open');
      for (const field of ['destroyAfter', 'closedAt', 'closing', 'archivedAt']) expect(doc).not.toHaveProperty(field);
      expect(w.doc(`${Q}/m1`)).toMatchObject({ status: 'cancelled', cancelledReason: 'reopened' });
      expect(w.audits('matter.reopened')[0]).toMatchObject({ data: { from: status, reason: 'More assets' } });
    }
    const open = world();
    expect(
      await failureOf(
        reopenDefinition.handler(open.ctx({ requestId: randomUUID(), matterId: 'm1', reason: 'x' }) as never),
      ),
    ).toMatchObject({ code: 'MATTER_INVALID_TRANSITION' });
  });

  it('refuses to reopen while the matter is being destroyed', async () => {
    const w = world({ [`${M}/m1`]: closed(), [`${Q}/m1`]: { status: 'destroying' } });
    expect(
      await failureOf(
        reopenDefinition.handler(w.ctx({ requestId: randomUUID(), matterId: 'm1', reason: 'x' }) as never),
      ),
    ).toMatchObject({ code: 'FAILED_PRECONDITION', details: { reason: 'destruction_in_progress' } });
  });

  it('a legal hold blocks destruction; releasing it recomputes destroyAfter', async () => {
    const w = world({ [`${M}/m1`]: closed(), [`${Q}/m1`]: { status: 'approved' } });
    const hold = (on: boolean) =>
      setLegalHoldDefinition.handler(
        w.ctx(
          { requestId: randomUUID(), matterId: 'm1', on, reason: 'Family provision claim threatened' },
          'admin',
        ) as never,
      );
    await expect(hold(true)).resolves.toMatchObject({ on: true, destroyAfter: null, holds: ['legal_hold'] });
    expect(w.doc(`${M}/m1`)).toMatchObject({
      legalHold: { on: true, by: 'user-admin' },
      closing: { holds: ['legal_hold'] },
    });
    expect(w.doc(`${M}/m1`)).not.toHaveProperty('destroyAfter');
    expect(w.doc(`${Q}/m1`)).toMatchObject({ status: 'cancelled', cancelledReason: 'legal_hold' });

    await expect(hold(false)).resolves.toMatchObject({ on: false, destroyAfter: '2026-03-01', holds: [] });
    expect(w.doc(`${M}/m1`)).toMatchObject({ legalHold: { on: false }, destroyAfter: '2026-03-01' });
    expect(w.audits('matter.legal_hold_placed')).toHaveLength(1);
    expect(w.audits('matter.legal_hold_released')).toHaveLength(1);
    expect(setLegalHoldDefinition.roles).toEqual(['owner', 'admin']);
  });
});

describe('matters-archiveClosed', () => {
  it('archives matters closed 90 or more days ago (org time zone) and leaves the rest', async () => {
    const w = world({
      // 7 July 2026 in Melbourne is 90 days before 5 October.
      [`${M}/old`]: matter({ status: 'closed', closedAt: new Date('2026-07-06T15:00:00Z') }),
      [`${M}/recent`]: matter({ status: 'closed', closedAt: new Date('2026-07-07T15:00:00Z') }),
      [`${M}/gone`]: matter({ status: 'closed', closedAt: new Date('2026-01-01T00:00:00Z'), deletedAt: new Date() }),
    });
    await expect(archiveOrg(w.db, ORG, w.clock, w.log)).resolves.toEqual(['old']);
    expect(w.doc(`${M}/old`)).toMatchObject({ status: 'archived', updatedBy: 'system' });
    expect(w.doc(`${M}/old`)?.['archivedAt']).toBeInstanceOf(Timestamp);
    expect(w.doc(`${M}/recent`)?.['status']).toBe('closed');
    expect(w.doc(`${M}/gone`)?.['status']).toBe('closed');
  });
});

describe('retention policy changes', () => {
  it('moves destroyAfter later, never earlier, and cancels a queued destruction no longer due', async () => {
    const w = world(
      {
        [`${M}/a`]: matter({
          status: 'archived',
          closedAt: new Date('2019-03-01T00:00:00Z'),
          destroyAfter: '2026-03-01',
        }),
        [`${M}/b`]: matter({
          status: 'closed',
          closedAt: new Date('2026-09-01T00:00:00Z'),
          destroyAfter: '2033-09-01',
        }),
        [`${M}/held`]: matter({ status: 'closed', closedAt: new Date('2026-09-01T00:00:00Z') }),
        [`${Q}/a`]: { status: 'pending' },
      },
      NOW,
      { retentionYears: 10 },
    );
    await expect(applyRetentionChange(w.db, ORG, w.clock.now(), w.log)).resolves.toEqual(['a', 'b']);
    expect(w.doc(`${M}/a`)?.['destroyAfter']).toBe('2029-03-01');
    expect(w.doc(`${M}/b`)?.['destroyAfter']).toBe('2036-09-01');
    expect(w.doc(`${M}/held`)).not.toHaveProperty('destroyAfter');
    expect(w.doc(`${Q}/a`)).toMatchObject({ status: 'cancelled', cancelledReason: 'not_due' });

    // Shorter again: nothing moves.
    await w.db.doc(`orgs/${ORG}`).update({ retentionYears: 3 });
    await expect(applyRetentionChange(w.db, ORG, w.clock.now(), w.log)).resolves.toEqual([]);
    expect(w.doc(`${M}/b`)?.['destroyAfter']).toBe('2036-09-01');
  });
});

describe('destruction', () => {
  const due = () =>
    matter({
      status: 'archived',
      closedAt: new Date('2019-03-01T00:00:00Z'),
      destroyAfter: '2026-03-01',
      createdAt: new Date('2018-02-01T00:00:00Z'),
    });
  const flagOn = () => setRemoteFlagLoader(async () => ({ 'matters.destruction': true }));
  const recent = (w: ReturnType<typeof world>) => ({ auth_time: Math.floor(w.clock.now().getTime() / 1000) - 60 });
  const approve = (w: ReturnType<typeof world>, confirmation = 'M-2026-0001', token = recent(w)) =>
    approveDestructionDefinition.handler(
      w.ctx({ requestId: randomUUID(), matterId: 'm1', confirmation }, 'admin', token) as never,
    );

  it('queues due matters monthly only while the flag is on, and not held or recent ones', async () => {
    const w = world({
      [`${M}/m1`]: due(),
      [`${M}/held`]: { ...due(), legalHold: { on: true, reason: 'Claim', by: 'u', at: new Date() } },
      [`${M}/later`]: { ...due(), destroyAfter: '2030-01-01' },
    });
    await expect(queueOrg(w.db, ORG, w.clock, w.log)).resolves.toEqual([]);
    flagOn();
    await expect(queueOrg(w.db, ORG, w.clock, w.log)).resolves.toEqual(['m1']);
    expect(w.doc(`${Q}/m1`)).toMatchObject({ status: 'pending', number: 'M-2026-0001', destroyAfter: '2026-03-01' });
    // Running again changes nothing.
    await expect(queueOrg(w.db, ORG, w.clock, w.log)).resolves.toEqual([]);
  });

  it('approval needs the flag, a recent sign-in and the matter number typed', async () => {
    const w = world({ [`${M}/m1`]: due(), [`${Q}/m1`]: { status: 'pending' } });
    expect(await failureOf(approve(w))).toMatchObject({ code: 'FEATURE_DISABLED' });
    flagOn();
    // defineCallable refuses an older sign-in with REAUTH_REQUIRED (SEC-04).
    expect(approveDestructionDefinition.recentLoginMinutes).toBe(5);
    expect(await failureOf(approve(w, 'M-2026-9999'))).toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(approve(w, ' m-2026-0001 ')).resolves.toEqual({ matterId: 'm1', status: 'approved' });
    expect(w.doc(`${Q}/m1`)).toMatchObject({ status: 'approved', approvedBy: 'user-admin' });
    expect(w.tasks.queued).toEqual([
      {
        queue: 'matters-destroy',
        payload: { orgId: ORG, matterId: 'm1' },
        options: { dedupeKey: `destroy:${ORG}:m1` },
      },
    ]);
    expect(w.audits('matter.destruction_approved')).toHaveLength(1);
    expect(await failureOf(approve(w))).toMatchObject({ details: { reason: 'not_pending' } });
  });

  it('cancels instead when the matter is no longer due', async () => {
    flagOn();
    const w = world({ [`${M}/m1`]: { ...due(), status: 'open' }, [`${Q}/m1`]: { status: 'pending' } });
    expect(await failureOf(approve(w))).toMatchObject({ details: { reason: 'not_due' } });
    expect(w.doc(`${Q}/m1`)).toMatchObject({ status: 'cancelled', cancelledReason: 'not_due' });
  });

  it('deletes the records, files, Clerk threads and notifications; keeps a tombstone, the audit and a certificate', async () => {
    const w = world({
      [`${M}/m1`]: due(),
      [`${M}/m1/documents/doc1`]: { name: 'Will.pdf' },
      [`${M}/m1/documents/doc1/chunks/c1`]: { text: 'Fictional chunk' },
      [`${M}/m1/notes/n1`]: { bodyMd: 'Fictional note' },
      [`${M}/m1/notes/n1/revisions/r1`]: { bodyMd: 'Earlier' },
      [`${M}/m1/tasks/t1`]: { title: 'Fictional task' },
      [`${M}/m2`]: matter({ number: 'M-2026-0002' }),
      [`${M}/m2/notes/n9`]: { bodyMd: 'Another matter' },
      [`orgs/${ORG}/clerkThreads/th1`]: { matterId: 'm1', title: 'About the estate' },
      [`orgs/${ORG}/clerkThreads/th1/messages/x1`]: { text: 'Question' },
      [`orgs/${ORG}/clerkThreads/th2`]: { matterId: 'm2', title: 'Other' },
      [`orgs/${ORG}/notifications/nt1`]: { matterId: 'm1', title: 'Task assigned' },
      [`orgs/${ORG}/trustSnapshots/m1`]: { matterId: 'm1', balanceCents: 0, asAt: '2026-01-31' },
      [`orgs/${ORG}/trustSnapshots/m2`]: { matterId: 'm2', balanceCents: 1_000, asAt: '2026-01-31' },
      [`orgs/${ORG}/audit/a1`]: { action: 'update', entity: { path: `${M}/m1` } },
      [`${Q}/m1`]: {
        status: 'approved',
        title: 'Estate of Fictional Quill',
        approvedBy: 'user-admin',
        approvedAt: new Date('2026-10-05T00:30:00Z'),
      },
    });
    const files = new MemoryFiles();
    files.put(`${M}/m1/documents/doc1/v1`, 'pdf bytes');
    files.put(`${M}/m1/documents/doc1/v1.preview.pdf`, 'preview');
    files.put(`${M}/m2/documents/doc9/v1`, 'other matter');
    const deps = { db: w.db, files, clock: w.clock, log: w.log };

    await expect(destroyMatter(deps, ORG, 'm1')).resolves.toBe('certificate');

    const remaining = [...w.docs.keys()];
    expect(remaining.filter((path) => path.startsWith(`${M}/m1/`))).toEqual([]);
    expect(remaining).toContain(`${M}/m2/notes/n9`);
    expect(remaining).not.toContain(`orgs/${ORG}/clerkThreads/th1`);
    expect(remaining).not.toContain(`orgs/${ORG}/clerkThreads/th1/messages/x1`);
    expect(remaining).toContain(`orgs/${ORG}/clerkThreads/th2`);
    expect(remaining).not.toContain(`orgs/${ORG}/notifications/nt1`);
    expect(remaining).not.toContain(`orgs/${ORG}/trustSnapshots/m1`);
    expect(remaining).toContain(`orgs/${ORG}/trustSnapshots/m2`);
    expect(remaining).toContain(`orgs/${ORG}/audit/a1`);
    expect([...files.objects.keys()].filter((path) => path.startsWith(`${M}/m1/`))).toEqual([]);
    expect(files.objects.has(`${M}/m2/documents/doc9/v1`)).toBe(true);

    const tombstone = w.doc(`${M}/m1`);
    expect(Object.keys(tombstone ?? {}).sort()).toEqual(
      [
        'certificateId',
        'closedAt',
        'createdAt',
        'createdBy',
        'deletedAt',
        'deletedBy',
        'destroyAfter',
        'destroyedAt',
        'destroyedBy',
        'number',
        'privileged',
        'schemaVersion',
        'status',
        'type',
        'updatedAt',
        'updatedBy',
      ].sort(),
    );
    expect(tombstone).toMatchObject({ number: 'M-2026-0001', destroyedBy: 'user-admin', certificateId: 'dc-m1' });

    const counts = { files: 2, documents: 1, records: 9 };
    expect(w.doc(`${Q}/m1`)).toMatchObject({
      status: 'destroyed',
      stage: 'certificate',
      certificateId: 'dc-m1',
      counts,
    });
    expect(w.doc(`${Q}/m1`)).not.toHaveProperty('title');
    expect(w.doc(`orgs/${ORG}/destructionCertificates/dc-m1`)).toMatchObject({
      matterId: 'm1',
      number: 'M-2026-0001',
      approvedBy: 'user-admin',
      counts,
      storagePath: `orgs/${ORG}/certificates/dc-m1.pdf`,
    });
    const pdf = await PDFDocument.load((await files.read(`orgs/${ORG}/certificates/dc-m1.pdf`)) as Buffer);
    expect(pdf.getPageCount()).toBe(1);
    expect(w.audits('matter.destroyed')[0]).toMatchObject({
      actor: { uid: 'user-admin' },
      data: { certificateId: 'dc-m1' },
    });

    // A repeat (a duplicate task) does nothing more.
    await expect(destroyMatter(deps, ORG, 'm1')).resolves.toBe('certificate');
    expect(w.audits('matter.destroyed')).toHaveLength(1);
  });

  it('resumes a destruction that failed part-way, and issues the certificate only at the end', async () => {
    const w = world({
      [`${M}/m1`]: due(),
      [`${M}/m1/notes/n1`]: { bodyMd: 'Fictional note' },
      [`${Q}/m1`]: { status: 'approved', approvedBy: 'user-admin', approvedAt: new Date() },
    });
    const files = new MemoryFiles();
    files.put(`${M}/m1/documents/doc1/v1`, 'pdf');
    let failWrites = true;
    const flaky = Object.assign(Object.create(files) as MemoryFiles, {
      write: async (...args: Parameters<MemoryFiles['write']>) => {
        if (failWrites) throw new Error('Storage unavailable');
        return files.write(...args);
      },
    });
    const deps = { db: w.db, files: flaky, clock: w.clock, log: w.log };
    await expect(destroyMatter(deps, ORG, 'm1')).rejects.toThrow('Storage unavailable');
    expect(w.doc(`${Q}/m1`)).toMatchObject({ status: 'destroying', stage: 'references' });
    expect(w.doc(`orgs/${ORG}/destructionCertificates/dc-m1`)).toBeUndefined();
    expect(w.doc(`${M}/m1/notes/n1`)).toBeUndefined();

    failWrites = false;
    await expect(destroyMatter(deps, ORG, 'm1')).resolves.toBe('certificate');
    expect(w.doc(`${Q}/m1`)).toMatchObject({ status: 'destroyed', counts: { files: 1, documents: 0, records: 1 } });
    expect(w.doc(`orgs/${ORG}/destructionCertificates/dc-m1`)).toBeDefined();
  });

  it('keeps the title on the tombstone when the org says so, and skips cancelled entries', async () => {
    const w = world(
      { [`${M}/m1`]: due(), [`${Q}/m1`]: { status: 'approved', approvedBy: 'user-admin', approvedAt: new Date() } },
      NOW,
      { destructionKeepsTitle: true },
    );
    await destroyMatter({ db: w.db, files: new MemoryFiles(), clock: w.clock, log: w.log }, ORG, 'm1');
    expect(w.doc(`${M}/m1`)?.['title']).toBe('Estate of Fictional Quill');

    const cancelled = world({ [`${M}/m1`]: due(), [`${Q}/m1`]: { status: 'cancelled' } });
    await expect(
      destroyMatter(
        { db: cancelled.db, files: new MemoryFiles(), clock: cancelled.clock, log: cancelled.log },
        ORG,
        'm1',
      ),
    ).resolves.toBeNull();
    expect(cancelled.doc(`${M}/m1`)?.['title']).toBe('Estate of Fictional Quill');
  });

  it('renders a one-page certificate, and signs a short download link for it', async () => {
    const bytes = await certificatePdf({
      certificateId: 'dc-m1',
      practice: 'Fictional Harbour Legal',
      number: 'M-2026-0001',
      title: 'Estate of Fictional Nguyễn',
      type: 'probate',
      closedOn: '2019-03-01' as never,
      destroyAfter: '2026-03-01' as never,
      approvedBy: 'Ada Admin',
      approvedAt: new Date('2026-10-05T00:30:00Z'),
      destroyedAt: new Date('2026-10-05T01:00:00Z'),
      counts: { files: 2, documents: 1, records: 8 },
      timeZone: 'Australia/Melbourne',
    });
    expect((await PDFDocument.load(bytes)).getTitle()).toBe('Certificate of destruction M-2026-0001');

    const w = world({
      [`orgs/${ORG}/destructionCertificates/dc-m1`]: { storagePath: `orgs/${ORG}/certificates/dc-m1.pdf` },
    });
    const definition = destructionCertificateUrlDefinition(() => 'files-bucket');
    const result = await definition.handler(w.ctx({ certificateId: 'dc-m1' }, 'admin') as never);
    expect(result.url).toContain('files-bucket');
    expect(definition.roles).toEqual(['owner', 'admin']);
    expect(await failureOf(definition.handler(w.ctx({ certificateId: 'dc-x' }, 'admin') as never))).toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('closing a will into safe custody (CORE-17a)', () => {
  const intoCustody = { checklist: { originals: 'safe_custody', closingLetterSent: true } };
  const packets = (w: ReturnType<typeof world>) =>
    [...w.docs.entries()].filter(([path]) => path.startsWith(`${SC}/`)).map(([path, data]) => ({ path, data }));
  const willWorld = (extra: Record<string, Record<string, unknown>> = {}) =>
    world({
      [`${M}/m1`]: matter({ type: 'will', responsibleUid: 'user-admin' }),
      ...TESTATOR,
      ...extra,
    });

  it('creates a numbered packet for the testator at the location given, linked to the matter', async () => {
    const w = willWorld();
    const result = await w.close({ ...intoCustody, safeCustodyLocation: SAFE });
    const [packet] = packets(w);
    expect(result.packet).toEqual({ id: packet?.path.split('/').pop(), packetNo: 'SC-000001', created: true });
    expect(packet?.data).toMatchObject({
      packetNo: 'SC-000001',
      testatorContactId: 'c-will',
      testatorName: 'Fictional Quill',
      responsibleUid: 'user-admin',
      matterId: 'm1',
      items: [{ kind: 'will', description: 'Original will (matter M-2026-0001)' }],
      location: SAFE,
      receivedOn: '2026-10-05',
      status: 'held',
      movements: [
        expect.objectContaining({ kind: 'in', reason: 'Original will received on closing matter M-2026-0001' }),
      ],
    });
    expect(w.doc(`orgs/${ORG}/counters/safe-custody`)).toMatchObject({ next: 2 });
    expect(w.doc(`${M}/m1`)?.['closing']).toMatchObject({
      safeCustody: { packetNo: 'SC-000001', created: true },
    });
    expect(w.audits('matter.closed')[0]?.['data']).toMatchObject({ safeCustody: { packetNo: 'SC-000001' } });
  });

  it('adds the will to the testator’s packet still in custody, once', async () => {
    const w = willWorld({
      [`${SC}/p-old`]: {
        packetNo: 'SC-000007',
        testatorContactId: 'c-will',
        status: 'out',
        items: [{ kind: 'poa', description: 'Power of attorney' }],
        movements: [],
        location: { site: 'Geelong office', cabinet: 'Safe 1', slot: '' },
        deletedAt: null,
      },
      [`${SC}/p-gone`]: { packetNo: 'SC-000002', testatorContactId: 'c-will', status: 'released', items: [] },
    });
    await expect(w.close(intoCustody)).resolves.toMatchObject({
      packet: { id: 'p-old', packetNo: 'SC-000007', created: false },
    });
    expect(w.doc(`${SC}/p-old`)).toMatchObject({
      matterId: 'm1',
      items: [{ kind: 'poa' }, { kind: 'will', description: 'Original will (matter M-2026-0001)' }],
      movements: [
        expect.objectContaining({ kind: 'in', location: { site: 'Geelong office', cabinet: 'Safe 1', slot: '' } }),
      ],
    });
    expect(packets(w)).toHaveLength(2);

    // Reopened and closed again: the packet already holds this matter's will.
    w.docs.set(`${M}/m1`, { ...w.doc(`${M}/m1`), status: 'open' });
    await w.close(intoCustody);
    expect((w.doc(`${SC}/p-old`)?.['items'] as unknown[]).length).toBe(2);
    expect(packets(w)).toHaveLength(2);
  });

  it('needs a testator party, and a location for a new packet', async () => {
    const none = world({ [`${M}/m1`]: matter({ type: 'will' }) });
    expect(await failureOf(none.close(intoCustody))).toMatchObject({
      code: 'FAILED_PRECONDITION',
      details: { reason: 'safe_custody_testator' },
    });
    const noLocation = willWorld();
    expect(await failureOf(noLocation.close(intoCustody))).toMatchObject({
      details: { reason: 'safe_custody_location' },
    });
    expect(noLocation.doc(`${M}/m1`)?.['status']).toBe('open');
    expect(packets(noLocation)).toEqual([]);
  });

  it('leaves safe custody alone for originals returned, and for other matter types', async () => {
    const returned = willWorld();
    await returned.close({ checklist: { originals: 'returned', closingLetterSent: true } });
    expect(packets(returned)).toEqual([]);
    const probate = world({ ...TESTATOR });
    await probate.close({ checklist: { ...probate.answers, originals: 'safe_custody' } });
    expect(packets(probate)).toEqual([]);
  });

  it('tells the checklist where the will would go', async () => {
    const w = willWorld({
      [`${SC}/p-old`]: {
        packetNo: 'SC-000007',
        testatorContactId: 'c-will',
        status: 'held',
        items: [],
        deletedAt: null,
      },
    });
    const result = await closingChecklistDefinition.handler(w.ctx({ matterId: 'm1' }) as never);
    expect(result.safeCustody).toEqual({
      testator: { contactId: 'c-will', name: 'Fictional Quill' },
      packet: { id: 'p-old', packetNo: 'SC-000007' },
    });
    const fresh = await closingChecklistDefinition.handler(willWorld().ctx({ matterId: 'm1' }) as never);
    expect(fresh.safeCustody).toEqual({ testator: { contactId: 'c-will', name: 'Fictional Quill' }, packet: null });
    const probate = await closingChecklistDefinition.handler(world().ctx({ matterId: 'm1' }) as never);
    expect(probate).not.toHaveProperty('safeCustody');
  });
});
