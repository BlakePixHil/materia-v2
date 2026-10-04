import { randomUUID } from 'node:crypto';

import type { HttpsError } from 'firebase-functions/v2/https';

import { Notification, type ConflictHit, type Role } from '@materia/domain';
import {
  buildConflictFixture,
  CONFLICT_CONTACTS as C,
  CONFLICT_MATTERS as M,
  CONFLICT_SCENARIOS,
} from '@materia/test-utils';

import { determineDefinition } from './determine';
import { recheckParty } from './on-party-added';
import { runDefinition } from './run';
import { findConflictHits } from './shared';
import { clearRetentionCache } from '../audit/retention';
import { runCallable, type CallableDeps } from '../core/callable';
import { clearFlagCaches, setRemoteFlagLoader } from '../core/flags';
import { createLog } from '../core/log';
import type { TriggerChange, TriggerContext } from '../core/trigger';
import { memoryFirestore } from '../orgs/testing';
import { FakeClock, fakePorts } from '../ports/fakes';

/** Unit tests for the conflict functions (CORE-02). All people, firms and matters are fictional. */

const ORG = 'org-cf';
const NOW = new Date('2026-10-04T01:00:00.000Z');
const meta = { createdAt: NOW, createdBy: 'seed', updatedAt: NOW, updatedBy: 'seed', schemaVersion: 1 };
const fixture = buildConflictFixture({ orgId: ORG, uid: 'user-lawyer', now: NOW, year: 2026 });
const C_PATH = `orgs/${ORG}/contacts`;
const M_PATH = `orgs/${ORG}/matters`;

function world(extra: Record<string, Record<string, unknown>> = {}, enforced = true) {
  const store = memoryFirestore({
    [`orgs/${ORG}`]: {
      name: 'Fictional Conflicts Practice',
      retentionYears: 7,
      flags: { 'conflicts.enforced': enforced },
    },
    ...Object.fromEntries(fixture.docs.map((doc) => [doc.path, doc.data])),
    ...extra,
  });
  const clock = new FakeClock(NOW);
  const log = createLog({ fn: 'test' }, () => undefined);
  const ctx = <T>(input: T, role: Role = 'lawyer', uid = `user-${role}`) =>
    ({
      input,
      uid,
      orgId: ORG,
      role,
      token: {},
      requestId: randomUUID(),
      log,
      clock,
      db: store.db,
      ports: fakePorts(),
      auth: () => {
        throw new Error('no auth in these tests');
      },
    }) as never;
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
  const doc = (path: string) => store.docs.get(path);
  const inCollection = (name: string) =>
    [...store.docs.entries()]
      .filter(([path]) => path.split('/').at(-2) === name)
      .map(([path, data]) => ({ path, data }));
  const run = (input: Record<string, unknown>, role: Role = 'lawyer') =>
    runDefinition.handler(ctx({ requestId: randomUUID(), ...input }, role));
  const determine = (input: Record<string, unknown>, role: Role = 'lawyer') =>
    determineDefinition.handler(ctx({ requestId: randomUUID(), ...input }, role));
  const trigger = (path: string) => {
    const [, orgId, , matterId, , partyId] = path.split('/');
    const data = store.docs.get(path);
    const change = { before: undefined, after: data ? { ref: { path }, data: () => data } : undefined };
    return recheckParty(
      change as unknown as TriggerChange,
      {
        eventId: 'e1',
        time: NOW,
        params: { orgId, matterId, partyId },
        log,
        clock,
        db: store.db,
        ports: fakePorts(),
      } as unknown as TriggerContext,
    );
  };
  return { ...store, clock, ctx, deps, doc, inCollection, run, determine, trigger };
}

const failureOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string; details?: Record<string, unknown> };
  }
  throw new Error('expected a failure');
};

const summary = (hits: ConflictHit[]) =>
  hits
    .map((hit) => ({
      contactId: hit.contactId,
      ...(hit.viaMergedContactId ? { viaMergedContactId: hit.viaMergedContactId } : {}),
      matters: hit.matters.map((m) => ({ matterId: m.matterId, role: m.role, status: m.status, adverse: !!m.adverse })),
    }))
    .sort((a, b) => a.contactId.localeCompare(b.contactId));

beforeEach(() => {
  clearRetentionCache();
  setRemoteFlagLoader(async () => ({}));
});
afterEach(() => clearFlagCaches());

describe('findConflictHits', () => {
  it.each(CONFLICT_SCENARIOS.map((s) => [s.kind, s.name, s] as const))('%s: %s', async (_kind, _name, scenario) => {
    const w = world();
    const hits = await findConflictHits(w.db, ORG, scenario.subjects, { adverse: true });
    expect(summary(hits)).toEqual([...scenario.expected].sort((a, b) => a.contactId.localeCompare(b.contactId)));
  });

  it('finds a contact stored without derived fields, emails or phones, with its display name and DOB reason', async () => {
    const w = world({
      [`${C_PATH}/c-margot`]: {
        ...meta,
        kind: 'person',
        givenNames: 'Margot',
        familyName: 'Ellis',
        dateOfBirth: '1948-04-09',
        search: ['margot', 'ellis'],
        sortName: 'ellis margot',
        deletedAt: null,
      },
    });
    const [hit] = await findConflictHits(
      w.db,
      ORG,
      [{ kind: 'person', name: 'Margot Ellis', role: 'client', dob: '1948-04-09' }],
      { adverse: true },
    );
    expect(hit).toMatchObject({ contactId: 'c-margot', displayName: 'Margot Ellis', matters: [] });
    expect(hit?.reasons).toEqual(expect.arrayContaining(['name', 'dateOfBirth']));
  });

  it('reports roles without adverse marking when adverse roles are not checked', async () => {
    const w = world();
    const hits = await findConflictHits(w.db, ORG, [{ name: 'Dorothea Quint', role: 'client' }], { adverse: false });
    expect(hits[0]?.matters[0]).toMatchObject({ role: 'defendant' });
    expect(hits[0]?.matters[0]?.adverse).toBeUndefined();
  });

  it('skips deleted contacts and removed party rows, keeps deleted matters, and excludes a matter', async () => {
    const w = world({
      [`${C_PATH}/c-gone`]: {
        ...meta,
        kind: 'person',
        givenNames: 'Peregrine',
        familyName: 'Oakhollow',
        deletedAt: NOW,
      },
      [`${M_PATH}/m-deleted`]: {
        ...meta,
        number: 'HV-2026-0900',
        title: 'Quint v Somebody',
        type: 'contest',
        status: 'archived',
        privileged: false,
        deletedAt: NOW,
      },
      [`${M_PATH}/m-deleted/parties/p1`]: {
        ...meta,
        orgId: ORG,
        matterId: 'm-deleted',
        contactId: C.dorothea,
        role: 'plaintiff',
      },
      [`${M_PATH}/${M.will}/parties/p-removed`]: {
        ...meta,
        orgId: ORG,
        matterId: M.will,
        contactId: C.dorothea,
        role: 'witness',
        deletedAt: NOW,
      },
    });
    expect(
      await findConflictHits(w.db, ORG, [{ name: 'Peregrine Oakhollow', role: 'client' }], { adverse: true }),
    ).toEqual([]);
    const [hit] = await findConflictHits(w.db, ORG, [{ name: 'Dorothea Quint', role: 'client' }], {
      adverse: true,
      excludeMatterId: M.contest,
    });
    expect(hit?.matters).toEqual([
      {
        matterId: 'm-deleted',
        number: 'HV-2026-0900',
        title: 'Quint v Somebody',
        status: 'archived',
        type: 'contest',
        role: 'plaintiff',
        adverse: 'Client against a plaintiff',
        deleted: true,
      },
    ]);
  });

  it('reports the subject’s own contact as self, with its other matters, and withholds privileged titles', async () => {
    const w = world({
      [`${M_PATH}/m-secret`]: {
        ...meta,
        number: 'HV-2026-0901',
        title: 'Very private estate',
        type: 'probate',
        status: 'open',
        privileged: true,
        deletedAt: null,
      },
      [`${M_PATH}/m-secret/parties/p1`]: {
        ...meta,
        orgId: ORG,
        matterId: 'm-secret',
        contactId: C.juniper,
        role: 'executor',
      },
    });
    const hits = await findConflictHits(
      w.db,
      ORG,
      [{ name: 'Juniper Ashdown', role: 'client', contactId: C.juniper }],
      { adverse: true, excludeMatterId: M.probate },
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ contactId: C.juniper, self: true, score: 1, reasons: [] });
    expect(hits[0]?.matters.map((m) => m.matterId).sort()).toEqual(
      [M.contest, M.fp, M.fpClosed, M.trust, 'm-secret'].sort(),
    );
    expect(hits[0]?.matters.find((m) => m.matterId === 'm-secret')).toMatchObject({
      title: 'Privileged matter',
      privileged: true,
    });
    // A picked contact on no other matter is not a hit.
    expect(
      await findConflictHits(w.db, ORG, [{ name: 'Ingrid Marchetti', role: 'client', contactId: C.ingrid }], {
        adverse: true,
        excludeMatterId: M.will,
      }),
    ).toEqual([]);
  });

  it('follows a picked tombstone to the contact it was merged into', async () => {
    const w = world();
    const [hit] = await findConflictHits(
      w.db,
      ORG,
      [{ name: 'Fenella Brightwater', role: 'client', contactId: C.fenellaOld }],
      { adverse: true },
    );
    expect(hit).toMatchObject({ contactId: C.fenella, self: true, viaMergedContactId: C.fenellaOld });
  });

  it('sorts hits best first across subjects', async () => {
    const w = world();
    const hits = await findConflictHits(
      w.db,
      ORG,
      [
        { name: 'Cosima Pell', role: 'beneficiary' },
        { name: 'Cosima Pell', role: 'beneficiary', dob: '1970-01-01', email: 'nobody@example.test' },
        { kind: 'organisation', name: 'Tidewater Lawyers Pty Ltd (fictional)', abn: '51824753556', role: 'client' },
      ],
      { adverse: true },
    );
    expect(hits.map((hit) => hit.subject)).toEqual([2, 0, 1]);
  });
});

describe('conflicts-run', () => {
  it('stores the run with its subjects, hits and the flag, and never touches the matter', async () => {
    const w = world();
    const before = { ...w.doc(`${M_PATH}/${M.probate}`) };
    const result = await w.run(
      { subjects: [{ name: 'Dorothea Quint', role: 'client' }], excludeMatterId: M.probate },
      'paralegal',
    );
    expect(result.adverseRolesChecked).toBe(true);
    expect(result.hits).toHaveLength(1);
    const stored = w.doc(`orgs/${ORG}/conflictChecks/${result.checkId}`);
    expect(stored).toMatchObject({
      excludeMatterId: M.probate,
      ranBy: 'user-paralegal',
      adverseRolesChecked: true,
      subjects: [{ kind: 'person', name: 'Dorothea Quint', role: 'client' }],
    });
    expect(w.doc(`${M_PATH}/${M.probate}`)).toEqual(before);
  });

  it('reports roles only while conflicts.enforced is off', async () => {
    const w = world({}, false);
    const result = await w.run({ subjects: [{ name: 'Barnaby Stroud', role: 'executor' }] });
    expect(result.adverseRolesChecked).toBe(false);
    expect(result.hits[0]?.matters[0]?.adverse).toBeUndefined();
  });

  it('refuses a missing excludeMatterId, and readonly through the wrapper', async () => {
    const w = world();
    expect(
      await failureOf(w.run({ subjects: [{ name: 'Ada', role: 'client' }], excludeMatterId: 'nope' })),
    ).toMatchObject({
      code: 'NOT_FOUND',
    });
    const denied = (await failureOf(
      runCallable(
        runDefinition,
        {
          data: { requestId: randomUUID(), subjects: [{ name: 'Ada', role: 'client' }] },
          auth: { uid: 'user-readonly', token: { orgId: ORG, role: 'readonly' } },
        },
        w.deps(),
      ),
    )) as HttpsError;
    expect(denied.details).toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});

describe('conflicts-determine', () => {
  const lead = {
    ...meta,
    number: 'HV-2026-0100',
    title: 'Quint estate intake',
    type: 'probate',
    status: 'lead',
    privileged: false,
    conflictCheck: { status: 'pending' },
    deletedAt: null,
  };
  const check = (excludeMatterId?: string) => ({
    ...meta,
    subjects: [{ kind: 'person', name: 'Dorothea Quint', role: 'client' }],
    hits: [],
    ranAt: NOW,
    ranBy: 'user-paralegal',
    adverseRolesChecked: true,
    ...(excludeMatterId ? { excludeMatterId } : {}),
  });

  it('records the determination on the matter and audits it with the reason', async () => {
    const w = world({ [`${M_PATH}/m-lead`]: lead, [`orgs/${ORG}/conflictChecks/k1`]: check('m-lead') });
    await expect(
      w.determine({ checkId: 'k1', matterId: 'm-lead', status: 'potential', reason: 'Different person, checked DOB' }),
    ).resolves.toEqual({ matterId: 'm-lead', status: 'potential' });
    expect(w.doc(`${M_PATH}/m-lead`)?.['conflictCheck']).toMatchObject({
      status: 'potential',
      checkedBy: 'user-lawyer',
      resultId: 'k1',
      reason: 'Different person, checked DOB',
    });
    const [entry] = w.inCollection('audit');
    expect(entry?.data).toMatchObject({
      action: 'matter.conflict_determined',
      data: { status: 'potential', previousStatus: 'pending', checkId: 'k1', reason: 'Different person, checked DOB' },
    });
  });

  it('accepts a check run before the matter existed and clears the alert it raised', async () => {
    const w = world({
      [`${M_PATH}/m-open`]: {
        ...lead,
        status: 'open',
        conflictAlert: { checkId: 'k2', contactId: C.dorothea, at: NOW, adverse: true },
      },
      [`orgs/${ORG}/conflictChecks/k2`]: check(),
    });
    await w.determine({ checkId: 'k2', matterId: 'm-open', status: 'clear' });
    expect(w.doc(`${M_PATH}/m-open`)?.['conflictAlert']).toBeUndefined();
    expect(w.doc(`${M_PATH}/m-open`)?.['conflictCheck']).toMatchObject({ status: 'clear', resultId: 'k2' });
  });

  it('refuses a check for another matter, a missing check or matter, and a paralegal', async () => {
    const w = world({ [`${M_PATH}/m-lead`]: lead, [`orgs/${ORG}/conflictChecks/k1`]: check('m-other') });
    expect(await failureOf(w.determine({ checkId: 'k1', matterId: 'm-lead', status: 'clear' }))).toMatchObject({
      code: 'FAILED_PRECONDITION',
      details: { reason: 'check_for_another_matter' },
    });
    expect(await failureOf(w.determine({ checkId: 'nope', matterId: 'm-lead', status: 'clear' }))).toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await failureOf(w.determine({ checkId: 'k1', matterId: 'nope', status: 'clear' }))).toMatchObject({
      code: 'NOT_FOUND',
    });
    const denied = (await failureOf(
      runCallable(
        determineDefinition,
        {
          data: { requestId: randomUUID(), checkId: 'k1', matterId: 'm-lead', status: 'clear' },
          auth: { uid: 'user-paralegal', token: { orgId: ORG, role: 'paralegal' } },
        },
        w.deps(),
      ),
    )) as HttpsError;
    expect(denied.details).toMatchObject({ code: 'PERMISSION_DENIED' });
    const noReason = (await failureOf(
      runCallable(
        determineDefinition,
        {
          data: { requestId: randomUUID(), checkId: 'k1', matterId: 'm-lead', status: 'conflict' },
          auth: { uid: 'user-lawyer', token: { orgId: ORG, role: 'lawyer' } },
        },
        w.deps(),
      ),
    )) as HttpsError;
    expect(noReason.details).toMatchObject({ code: 'INVALID_ARGUMENT', fields: { reason: expect.any(Array) } });
  });
});

describe('conflicts-onPartyAdded', () => {
  const addParty = (w: ReturnType<typeof world>, matterId: string, contactId: string, role: string, extra = {}) => {
    const path = `${M_PATH}/${matterId}/parties/p-new-${contactId}`;
    w.docs.set(path, {
      ...meta,
      createdAt: new Date('2026-10-04T02:00:00Z'),
      createdBy: 'user-para',
      orgId: ORG,
      matterId,
      contactId,
      role,
      ...extra,
    });
    return path;
  };

  it('alerts the matter and notifies the responsible lawyer when the party is on other matters', async () => {
    const w = world();
    // Barnaby (a plaintiff on the Stroud claim) added as executor on the open Halloway estate.
    const path = addParty(w, M.probate, C.barnaby, 'executor');
    expect(await w.trigger(path)).toBe('alerted');
    const alert = w.doc(`${M_PATH}/${M.probate}`)?.['conflictAlert'] as Record<string, unknown>;
    expect(alert).toMatchObject({ contactId: C.barnaby, partyId: `p-new-${C.barnaby}`, adverse: true });
    const stored = w.doc(`orgs/${ORG}/conflictChecks/${String(alert['checkId'])}`);
    expect(stored).toMatchObject({ excludeMatterId: M.probate, ranBy: 'user-para', adverseRolesChecked: true });
    const [notification] = w.inCollection('notifications');
    expect(notification?.data).toMatchObject({
      kind: 'conflict_alert',
      recipientUid: 'user-lawyer',
      matterId: M.probate,
      checkId: alert['checkId'],
      contactId: C.barnaby,
      link: `/matters/${M.probate}`,
      priority: 'high',
      channel: ['inapp'],
    });
    expect(Notification.create.safeParse(notification?.data).success).toBe(true);
  });

  it('marks the alert not adverse while the flag is off', async () => {
    const w = world({}, false);
    const path = addParty(w, M.probate, C.barnaby, 'executor');
    expect(await w.trigger(path)).toBe('alerted');
    expect(w.doc(`${M_PATH}/${M.probate}`)?.['conflictAlert']).toMatchObject({ adverse: false });
  });

  it('stores a clear re-check without alerting when the party is on no other matter', async () => {
    const w = world();
    const path = addParty(w, M.probate, C.ingrid, 'witness');
    // Ingrid is only on her own will matter, which is another matter: that is a hit.
    expect(await w.trigger(path)).toBe('alerted');
    const quiet = world();
    const quietPath = addParty(quiet, M.will, C.ingrid, 'witness');
    expect(await quiet.trigger(quietPath)).toBe('no_hits');
    expect(quiet.inCollection('conflictChecks')).toHaveLength(1);
    expect(quiet.doc(`${M_PATH}/${M.will}`)?.['conflictAlert']).toBeUndefined();
    expect(quiet.inCollection('notifications')).toHaveLength(0);
  });

  it('skips leads, closed matters, parties written with the matter, deleted parties and missing contacts', async () => {
    const w = world({
      [`${M_PATH}/m-lead`]: { ...meta, number: 'X', title: 'Lead', type: 'probate', status: 'lead', deletedAt: null },
    });
    expect(await w.trigger(addParty(w, 'm-lead', C.barnaby, 'executor'))).toBe('skipped_matter');
    expect(await w.trigger(addParty(w, M.fpClosed, C.dorothea, 'executor'))).toBe('skipped_matter');
    expect(
      await w.trigger(
        addParty(w, M.probate, C.dorothea, 'executor', {
          createdAt: w.doc(`${M_PATH}/${M.probate}`)?.['createdAt'],
        }),
      ),
    ).toBe('skipped_with_matter');
    expect(await w.trigger(addParty(w, M.probate, C.cosima, 'executor', { deletedAt: NOW }))).toBe('skipped_deleted');
    expect(await w.trigger(addParty(w, M.probate, 'c-missing', 'executor'))).toBe('skipped_contact');
    expect(w.inCollection('conflictChecks')).toHaveLength(0);
  });
});
