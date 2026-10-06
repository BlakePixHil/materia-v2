import { randomUUID } from 'node:crypto';

import { Timestamp } from 'firebase-admin/firestore';
import type { HttpsError } from 'firebase-functions/v2/https';

import type { MigrationReviewResult, ResolveMigrationReviewResult, Role } from '@materia/domain';

import { clearFixedReviewCodes } from './clear';
import { resolveReviewDefinition, reviewDefinition } from './review';
import { runCallable, type CallableDefinition, type CallableDeps } from '../core/callable';
import { createLog } from '../core/log';
import type { TriggerChange, TriggerContext } from '../core/trigger';
import { memoryFirestore } from '../orgs/testing';
import { FakeClock, fakePorts } from '../ports/fakes';

/** Unit tests for the migration review queue (MIG-08). Every practice, person and matter is fictional. */

const ORG = 'org-m';
const M = `orgs/${ORG}/matters`;
const NOW = new Date('2026-10-07T00:00:00.000Z');
const LOADED = new Date('2026-10-06T21:00:00.000Z');
const migration = (legacyPath: string) => ({ runId: 'run-1', legacyPath, loadedAt: LOADED });
const meta = { createdBy: 'system', updatedBy: 'system', schemaVersion: 1 };
const matter = (number: string, extra: Record<string, unknown>) => ({
  ...meta,
  number,
  title: 'Estate of Fictional Wren',
  type: 'probate',
  status: 'open',
  privileged: false,
  deletedAt: null,
  migration: migration(`workflows/w/cards/${number}`),
  ...extra,
});

type Data = Record<string, unknown>;

function world(initial: Record<string, Data> = {}) {
  const store = memoryFirestore({
    [`orgs/${ORG}`]: { name: 'Materia Technologies', needsReview: ['org_name_unconfirmed'], migration: migration('u') },
    [`orgs/${ORG}/members/user-owner`]: {
      ...meta,
      role: 'owner',
      status: 'active',
      displayName: 'Tess Fictional',
      budgets: { '2025': 12000000 },
      needsReview: ['budgets_imported'],
      migration: migration('u#member'),
    },
    [`orgs/${ORG}/members/user-lawyer`]: { ...meta, role: 'lawyer', status: 'active', displayName: 'Lee Fictional' },
    [`${M}/m1`]: matter('M-2025-0001', {
      title: 'Untitled matter (imported)',
      needsReview: ['title_missing', 'client_placeholder'],
    }),
    [`${M}/m2`]: matter('M-2025-0002', { needsReview: ['client_from_title', 'swimlane_unknown'] }),
    [`${M}/m3`]: matter('M-2025-0003', { status: 'archived', needsReview: ['client_from_title'] }),
    [`${M}/m4`]: matter('M-2025-0004', { needsReview: ['client_from_title'], reviewed: ['fee_type_missing'] }),
    [`orgs/${ORG}/contacts/c1`]: {
      ...meta,
      kind: 'organisation',
      orgName: 'Unnamed referrer (imported)',
      needsReview: ['referrer_unnamed'],
      migration: migration('referrers/r1'),
    },
    [`${M}/m2/documents/d1`]: {
      ...meta,
      orgId: ORG,
      matterId: 'm2',
      name: 'Will (signed).pdf',
      version: 0,
      needsReview: ['MIG_W_ATTACHMENT_OBJECT_MISSING'],
      migration: migration('attachments/a1'),
    },
    [`orgs/${ORG}/migrations/run-1`]: {
      ...meta,
      runId: 'run-1',
      mode: 'cutover',
      status: 'succeeded',
      startedAt: LOADED,
      counts: { matters: 4, contacts: 1 },
      warnings: [],
    },
    // Another practice's records stay out of this one's queue.
    ['orgs/org-other/matters/x1']: matter('X-1', { needsReview: ['title_missing'] }),
    ['orgs/org-other/matters/x1/documents/dx']: {
      ...meta,
      orgId: 'org-other',
      matterId: 'x1',
      name: 'Other.pdf',
      version: 0,
      needsReview: ['MIG_W_ATTACHMENT_OBJECT_MISSING'],
    },
    ...initial,
  });
  const clock = new FakeClock(NOW);
  const deps = (): CallableDeps => ({
    db: () => store.db,
    clock,
    ports: () => fakePorts(),
    memberLookup: async () => true,
    idempotency: {
      begin: async () => ({ replay: false }),
      complete: async () => undefined,
      abandon: async () => undefined,
    },
    sink: () => undefined,
  });
  const call = <T>(def: CallableDefinition<never, T>, data: Data, role: Role = 'owner') =>
    runCallable(def, { data, auth: { uid: `user-${role}`, token: { orgId: ORG, role } } }, deps());
  const review = (data: Data = {}, role?: Role) =>
    call(reviewDefinition as never, data, role) as Promise<MigrationReviewResult>;
  const resolve = (data: Data, role?: Role) =>
    call(
      resolveReviewDefinition as never,
      { requestId: randomUUID(), ...data },
      role,
    ) as Promise<ResolveMigrationReviewResult>;
  const doc = (path: string) => store.docs.get(path) as Data | undefined;
  const audits = () => [...store.docs.entries()].filter(([path]) => path.startsWith(`orgs/${ORG}/audit/`));
  return { ...store, clock, review, resolve, doc, audits };
}

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return (error as HttpsError).details as Data;
  }
  throw new Error('expected a failure');
};

const countOf = (result: MigrationReviewResult, code: string) => result.codes.find((c) => c.code === code);

describe('migration-review', () => {
  it('counts every code open and reviewed in this practice, and lists the records', async () => {
    const w = world();
    const result = await w.review();
    expect(countOf(result, 'client_from_title')).toEqual({ code: 'client_from_title', open: 3, reviewed: 0 });
    expect(countOf(result, 'fee_type_missing')).toEqual({ code: 'fee_type_missing', open: 0, reviewed: 1 });
    expect(countOf(result, 'org_name_unconfirmed')).toMatchObject({ open: 1 });
    expect(countOf(result, 'MIG_W_ATTACHMENT_OBJECT_MISSING')).toMatchObject({ open: 1 });
    expect(countOf(result, 'title_missing')).toMatchObject({ open: 1 });
    // m1 ×2, m2 ×2, m3, m4, the referrer, the org, the member's budgets and the document.
    expect(result).toMatchObject({ open: 10, reviewed: 1, percent: 9, more: false, reviewedAt: null });
    expect(result.items.map((item) => item.path).sort()).toEqual(
      [
        `orgs/${ORG}`,
        `orgs/${ORG}/contacts/c1`,
        `orgs/${ORG}/members/user-owner`,
        `${M}/m1`,
        `${M}/m2`,
        `${M}/m2/documents/d1`,
        `${M}/m3`,
        `${M}/m4`,
      ].sort(),
    );
    expect(result.items.find((item) => item.id === 'm1')).toEqual({
      path: `${M}/m1`,
      entity: 'matter',
      id: 'm1',
      matterId: 'm1',
      title: 'Untitled matter (imported)',
      detail: 'M-2025-0001',
      codes: ['title_missing', 'client_placeholder'],
    });
    expect(result.items.find((item) => item.id === 'm3')).toMatchObject({ readOnly: true });
    expect(result.items.find((item) => item.id === 'd1')).toMatchObject({
      entity: 'document',
      matterId: 'm2',
      title: 'Will (signed).pdf',
    });
    expect(result.items.find((item) => item.id === 'c1')).toMatchObject({ title: 'Unnamed referrer (imported)' });
    expect(result.items.find((item) => item.entity === 'org')).toMatchObject({ title: 'Materia Technologies' });
  });

  it('filters by code, pages by the limit, and gives counts only with limit 0', async () => {
    const w = world();
    const one = await w.review({ code: 'client_from_title', limit: 2 });
    expect(one.items).toHaveLength(2);
    expect(one.more).toBe(true);
    expect(one.items.every((item) => item.codes.includes('client_from_title'))).toBe(true);
    const counts = await w.review({ limit: 0 });
    expect(counts).toMatchObject({ items: [], more: true, open: 10 });
  });

  it('is for owners and admins', async () => {
    const w = world();
    expect(await failure(w.review({}, 'lawyer'))).toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(w.review({}, 'admin')).resolves.toMatchObject({ open: 10 });
  });

  it('marks the runs reviewed once nothing is open', async () => {
    const w = world({
      [`orgs/${ORG}`]: { name: 'Fictional Bayside Legal' },
      [`orgs/${ORG}/members/user-owner`]: { ...meta, role: 'owner', status: 'active', displayName: 'Tess' },
      [`${M}/m1`]: matter('M-1', { reviewed: ['title_missing'] }),
      [`${M}/m2`]: matter('M-2', {}),
      [`${M}/m3`]: matter('M-3', {}),
      [`${M}/m4`]: matter('M-4', {}),
      [`orgs/${ORG}/contacts/c1`]: { ...meta, kind: 'organisation', orgName: 'Fictional Referrals' },
      [`${M}/m2/documents/d1`]: { ...meta, orgId: ORG, matterId: 'm2', name: 'Will.pdf', version: 1 },
      [`orgs/${ORG}/migrations/rolled`]: {
        runId: 'rolled',
        status: 'rolled_back',
        startedAt: new Date('2026-10-01T00:00:00Z'),
      },
    });
    const result = await w.review();
    expect(result).toMatchObject({ open: 0, reviewed: 1, percent: 100, reviewedAt: NOW.toISOString() });
    expect(w.doc(`orgs/${ORG}/migrations/run-1`)).toMatchObject({
      reviewedAt: Timestamp.fromDate(NOW),
      reviewedBy: 'user-owner',
    });
    // A rolled-back run isn't stamped.
    expect(w.doc(`orgs/${ORG}/migrations/rolled`)?.['reviewedAt']).toBeUndefined();
  });
});

describe('migration-resolveReview', () => {
  it('moves the named codes to reviewed, skips codes already gone, and audits once', async () => {
    const w = world();
    const result = await w.resolve({
      items: [
        { path: `${M}/m1`, code: 'client_placeholder' },
        { path: `${M}/m2`, code: 'client_from_title' },
        { path: `${M}/m2`, code: 'swimlane_unknown' },
        { path: `${M}/m4`, code: 'fee_type_missing' },
      ],
    });
    expect(result).toMatchObject({ resolved: 3, skipped: 1, open: 7, reviewed: 4, percent: 36, reviewedAt: null });
    expect(w.doc(`${M}/m1`)).toMatchObject({ needsReview: ['title_missing'], reviewed: ['client_placeholder'] });
    expect(w.doc(`${M}/m2`)?.['needsReview']).toBeUndefined();
    expect(w.doc(`${M}/m2`)?.['reviewed']).toEqual(['client_from_title', 'swimlane_unknown']);
    // A review isn't an edit: the record's updatedAt stays the load's.
    expect(w.doc(`${M}/m2`)?.['updatedBy']).toBe('system');
    const entries = w.audits().map(([, entry]) => entry as Data);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'migration.reviewed',
      entity: { path: `orgs/${ORG}/migrations/run-1` },
      data: { resolved: 3, all: false },
    });
  });

  it('marks every record with a code reviewed, and the org’s own', async () => {
    const w = world();
    expect(await w.resolve({ code: 'client_from_title' })).toMatchObject({ resolved: 3, open: 7 });
    for (const id of ['m2', 'm3', 'm4']) expect(w.doc(`${M}/${id}`)?.['reviewed']).toContain('client_from_title');
    // Another practice's records are untouched.
    expect(w.doc('orgs/org-other/matters/x1')?.['needsReview']).toEqual(['title_missing']);
    expect(await w.resolve({ code: 'org_name_unconfirmed' })).toMatchObject({ resolved: 1 });
    expect(w.doc(`orgs/${ORG}`)).toMatchObject({ reviewed: ['org_name_unconfirmed'] });
    expect(await w.resolve({ code: 'MIG_W_ATTACHMENT_OBJECT_MISSING' })).toMatchObject({ resolved: 1 });
    expect(w.doc('orgs/org-other/matters/x1/documents/dx')?.['needsReview']).toEqual([
      'MIG_W_ATTACHMENT_OBJECT_MISSING',
    ]);
  });

  it('marks the import reviewed when the last code goes', async () => {
    const w = world();
    for (const code of [
      'title_missing',
      'client_placeholder',
      'client_from_title',
      'swimlane_unknown',
      'referrer_unnamed',
      'org_name_unconfirmed',
      'budgets_imported',
    ]) {
      await w.resolve({ code });
    }
    const last = await w.resolve({
      items: [{ path: `${M}/m2/documents/d1`, code: 'MIG_W_ATTACHMENT_OBJECT_MISSING' }],
    });
    expect(last).toMatchObject({ open: 0, percent: 100, reviewedAt: NOW.toISOString() });
    expect(w.doc(`orgs/${ORG}/migrations/run-1`)).toMatchObject({ reviewedBy: 'user-owner' });
  });

  it('refuses records outside the practice or codes the record can’t take', async () => {
    const w = world();
    for (const item of [
      { path: 'orgs/org-other/matters/x1', code: 'title_missing' },
      { path: `orgs/${ORG}/contacts/c1`, code: 'title_missing' },
      { path: `orgs/${ORG}/invoices/i1`, code: 'title_missing' },
      { path: `${M}/m1/notes/n1`, code: 'title_missing' },
    ]) {
      expect(await failure(w.resolve({ items: [item] })), item.path).toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
    expect(w.doc('orgs/org-other/matters/x1')?.['needsReview']).toEqual(['title_missing']);
  });

  it('is for owners and admins, with a request id', async () => {
    const w = world();
    const items = [{ path: `${M}/m1`, code: 'title_missing' }];
    expect(await failure(w.resolve({ items }, 'lawyer'))).toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(await failure(w.resolve({ items, requestId: undefined }))).toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

describe('clearFixedReviewCodes', () => {
  const PATH = `${M}/m1`;
  const trigger = async (w: ReturnType<typeof world>, before: Data | undefined, patch: Data) => {
    w.docs.set(PATH, { ...(w.doc(PATH) ?? {}), ...patch });
    const after = w.doc(PATH);
    const change = {
      before: before ? { ref: { path: PATH }, data: () => before } : undefined,
      after: after ? { ref: { path: PATH }, data: () => after } : undefined,
    } as unknown as TriggerChange;
    const ctx = {
      eventId: 'e1',
      time: NOW,
      params: { orgId: ORG, matterId: 'm1' },
      log: createLog({ fn: 'test' }, () => undefined),
      clock: w.clock,
      db: w.db,
      ports: fakePorts(),
    } as unknown as TriggerContext;
    return clearFixedReviewCodes(change, ctx);
  };

  it('clears the code a person’s edit put right, and only that one', async () => {
    const w = world();
    const before = w.doc(PATH) as Data;
    expect(await trigger(w, before, { title: 'Estate of Fictional Finch', updatedBy: 'user-owner' })).toEqual([
      'title_missing',
    ]);
    expect(w.doc(PATH)).toMatchObject({ needsReview: ['client_placeholder'], reviewed: ['title_missing'] });
    // Its own write (the codes moved) changes nothing a code names: no loop.
    const moved = w.doc(PATH) as Data;
    expect(await trigger(w, moved, {})).toEqual([]);
  });

  it('clears every code once the record is deleted', async () => {
    const w = world();
    const before = w.doc(PATH) as Data;
    expect(await trigger(w, before, { deletedAt: NOW })).toEqual(['title_missing', 'client_placeholder']);
    expect(w.doc(PATH)?.['needsReview']).toBeUndefined();
  });

  it('leaves the migration’s own writes, creates and destroyed matters alone', async () => {
    const w = world();
    const before = w.doc(PATH) as Data;
    const reload = { title: 'Untitled (again)', migration: { ...migration('x'), loadedAt: NOW } };
    expect(await trigger(w, before, reload)).toEqual([]);
    expect(await trigger(w, undefined, { title: 'Estate of Fictional Finch' })).toEqual([]);
    const now = w.doc(PATH) as Data;
    expect(await trigger(w, now, { title: 'Destroyed', destroyedAt: NOW })).toEqual([]);
    expect(w.doc(PATH)?.['needsReview']).toEqual(['title_missing', 'client_placeholder']);
  });
});
