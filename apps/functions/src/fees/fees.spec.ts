import { randomUUID } from 'node:crypto';

import type { Timestamp } from 'firebase-admin/firestore';

import type { Role } from '@materia/domain';

import { recomputeBudget } from './budget';
import { budgetOnDisbursementDefinition, budgetOnTimeDefinition, budgetForEvent } from './triggers';
import { updateDefinition } from './update';
import { runCallable, type CallableDeps } from '../core/callable';
import { clearFlagCaches, setRemoteFlagLoader } from '../core/flags';
import { createLog } from '../core/log';
import type { TriggerContext } from '../core/trigger';
import { memoryFirestore } from '../orgs/testing';
import { FakeClock, fakePorts } from '../ports/fakes';

/** Unit tests for the fees functions (BILL-05). Every person, matter and amount is fictional. */

const ORG = 'org-fees';
const M = `orgs/${ORG}/matters/m1`;
const NOW = new Date('2026-10-09T00:00:00Z');
const meta = { createdBy: 'user-lawyer', updatedBy: 'user-lawyer', schemaVersion: 1 };

const member = (role: Role, extra: Record<string, unknown> = {}) => ({
  ...meta,
  role,
  status: 'active',
  displayName: role,
  defaultRateCents: 0,
  rates: [],
  ...extra,
});
const time = (amountCents: number, extra: Record<string, unknown> = {}) => ({
  ...meta,
  orgId: ORG,
  matterId: 'm1',
  uid: 'user-lawyer',
  date: '2026-10-01',
  minutes: 60,
  amountCents,
  billable: true,
  status: 'draft',
  deletedAt: null,
  ...extra,
});

function world(initial: Record<string, Record<string, unknown>> = {}, flagOn = true) {
  setRemoteFlagLoader(async () => ({}));
  clearFlagCaches();
  const store = memoryFirestore({
    [`orgs/${ORG}`]: { name: 'Harbour & Vine Legal', billing: {}, flags: { 'billing.feeBudgets': flagOn } },
    [`orgs/${ORG}/members/user-lawyer`]: member('lawyer', { supervisorUid: 'user-owner' }),
    [`orgs/${ORG}/members/user-owner`]: member('owner'),
    [`orgs/${ORG}/members/user-para`]: member('paralegal'),
    [M]: {
      ...meta,
      number: 'M-2026-0042',
      title: 'Estate of Rosalind Whitmore',
      responsibleUid: 'user-lawyer',
      fee: { arrangement: 'fixed', amountCents: 330000, revision: 0, history: [] },
      wipCents: 0,
    },
    ...initial,
  });
  const clock = new FakeClock(NOW);
  const log = createLog({ fn: 'test' }, () => undefined);
  const ports = fakePorts();
  const deps = { db: store.db, orgId: ORG, clock, log, ports };
  const recompute = () => recomputeBudget(deps, 'm1');
  const doc = (path: string) => store.docs.get(path);
  const notifications = () =>
    [...store.docs.entries()].filter(([path]) => path.startsWith(`orgs/${ORG}/notifications/`)).map(([, d]) => d);
  return { ...store, clock, log, ports, deps, recompute, doc, notifications };
}

describe('fees triggers', () => {
  it('are declared on time entries and disbursements', () => {
    expect(budgetOnTimeDefinition).toMatchObject({ name: 'fees-budgetOnTime', on: 'written' });
    expect(budgetOnTimeDefinition.document).toBe('orgs/{orgId}/matters/{matterId}/timeEntries/{entryId}');
    expect(budgetOnDisbursementDefinition.document).toBe(
      'orgs/{orgId}/matters/{matterId}/disbursements/{disbursementId}',
    );
  });

  it('recompute the matter in the event', async () => {
    const w = world({ [`${M}/timeEntries/t1`]: time(100000) });
    const ctx = {
      params: { orgId: ORG, matterId: 'm1' },
      db: w.db,
      clock: w.clock,
      log: w.log,
      ports: w.ports,
    } as unknown as TriggerContext;
    expect((await budgetForEvent(ctx))?.budget.recordedCents).toBe(100000);
  });
});

describe('recomputeBudget', () => {
  it('sums live time (billable or not, any status) and disbursements ex GST against the fixed fee', async () => {
    const w = world({
      [`${M}/timeEntries/t1`]: time(100000),
      [`${M}/timeEntries/t2`]: time(50000, { billable: false, status: 'final' }),
      [`${M}/timeEntries/t3`]: time(30000, { status: 'billed' }),
      [`${M}/timeEntries/t4`]: time(99999, { deletedAt: NOW }),
      // A live entry written without `deletedAt` still counts.
      [`${M}/timeEntries/t5`]: Object.fromEntries(Object.entries(time(20000)).filter(([key]) => key !== 'deletedAt')),
      [`${M}/disbursements/d1`]: { ...meta, amountExGstCents: 15000, gstCents: 1500, status: 'final' },
      [`${M}/disbursements/d2`]: { ...meta, amountExGstCents: 5000, status: 'billed', deletedAt: null },
      [`${M}/disbursements/d3`]: { ...meta, amountExGstCents: 7000, status: 'draft', deletedAt: NOW },
    });
    const outcome = await w.recompute();
    expect(outcome?.budget).toEqual({
      recordedCents: 220000,
      billedCents: 35000,
      basisCents: 330000,
      pct: 67,
      timeCents: 200000,
      disbursementsCents: 20000,
      revision: 0,
      alerted: [],
    });
    expect(w.doc(M)?.['budget']).toEqual(outcome?.budget);
    expect(await w.recompute()).toMatchObject({ written: false, fired: [] });
  });

  it('alerts the responsible lawyer and their supervisor once per threshold', async () => {
    const w = world({ [`${M}/timeEntries/t1`]: time(270000) });
    expect(await w.recompute()).toMatchObject({ fired: [80] });
    const sent = w.notifications();
    expect(sent.map((n) => n['recipientUid']).sort()).toEqual(['user-lawyer', 'user-owner']);
    expect(sent[0]).toMatchObject({
      kind: 'budget_alert',
      matterId: 'm1',
      title: 'Budget 80% used: M-2026-0042',
      link: '/matters/m1/overview',
    });
    expect(String(sent[0]?.['body'])).toContain('revise the estimate and update the costs disclosure');
    expect(String(sent[0]?.['body'])).not.toContain('Whitmore');

    expect(await w.recompute()).toMatchObject({ fired: [] });
    w.docs.set(`${M}/timeEntries/t2`, time(70000));
    expect(await w.recompute()).toMatchObject({ fired: [100] });
    expect(w.notifications()).toHaveLength(4);
    expect(w.doc(M)?.['budget']).toMatchObject({ pct: 103, alerted: [80, 100] });
  });

  it('re-arms the alerts when the fee is revised', async () => {
    const w = world({ [`${M}/timeEntries/t1`]: time(340000) });
    expect(await w.recompute()).toMatchObject({ fired: [80, 100] });
    w.docs.set(M, {
      ...w.doc(M),
      fee: { arrangement: 'fixed', amountCents: 400000, revision: 1, history: [] },
    });
    expect(await w.recompute()).toMatchObject({ fired: [80] });
    expect(w.doc(M)?.['budget']).toMatchObject({ basisCents: 400000, pct: 85, revision: 1, alerted: [80] });
  });

  it('never alerts on pro bono, and holds alerts while the flag is off', async () => {
    const pro = world({
      [M]: { ...meta, number: 'M-2026-0050', responsibleUid: 'user-lawyer', fee: { arrangement: 'pro_bono' } },
      [`${M}/timeEntries/t1`]: time(900000),
    });
    expect(await pro.recompute()).toMatchObject({ fired: [], budget: { recordedCents: 900000 } });
    expect(pro.doc(M)?.['budget']).not.toHaveProperty('pct');

    const off = world({ [`${M}/timeEntries/t1`]: time(340000) }, false);
    expect(await off.recompute()).toMatchObject({ fired: [], budget: { pct: 103, alerted: [] } });
    expect(off.notifications()).toHaveLength(0);
  });

  it('uses the org’s thresholds and leaves deleted matters alone', async () => {
    const w = world({
      [`orgs/${ORG}`]: { name: 'Harbour & Vine Legal', billing: { budgetAlertPcts: [50] }, flags: {} },
      [`${M}/timeEntries/t1`]: time(170000),
    });
    // The org override is gone, so the flag is off: the budget is kept, nothing fires.
    expect(await w.recompute()).toMatchObject({ fired: [] });
    w.docs.set(`orgs/${ORG}`, { ...w.doc(`orgs/${ORG}`), flags: { 'billing.feeBudgets': true } });
    clearFlagCaches();
    expect(await w.recompute()).toMatchObject({ fired: [50] });
    w.docs.set(M, { ...w.doc(M), deletedAt: NOW });
    expect(await w.recompute()).toBeNull();
    // Nor does a destroyed matter's tombstone (CORE-19) get a budget.
    w.docs.set(M, { number: 'M-2026-0001', destroyedAt: NOW });
    expect(await w.recompute()).toBeNull();
    expect(w.doc(M)?.['budget']).toBeUndefined();
  });
});

describe('fees-update', () => {
  const deps = (w: ReturnType<typeof world>): CallableDeps => ({
    db: () => w.db,
    clock: w.clock,
    ports: () => w.ports,
    memberLookup: async () => true,
    idempotency: {
      begin: async () => ({ replay: false }),
      complete: async () => undefined,
      abandon: async () => undefined,
    },
    sink: () => undefined,
  });
  const call = (w: ReturnType<typeof world>, data: Record<string, unknown>, role: Role = 'lawyer') =>
    runCallable(
      updateDefinition,
      {
        data: { requestId: randomUUID(), matterId: 'm1', reason: 'Probate application contested', ...data },
        auth: { uid: `user-${role}`, token: { orgId: ORG, role } },
      },
      deps(w),
    );
  const audits = (w: ReturnType<typeof world>) =>
    [...w.docs.entries()].filter(([path]) => path.startsWith(`orgs/${ORG}/audit/`)).map(([, d]) => d);

  it('revises the fee with a history entry, audits it and re-arms the budget', async () => {
    const w = world({ [`${M}/timeEntries/t1`]: time(340000) });
    await w.recompute();
    const result = await call(w, {
      fee: { arrangement: 'hourly', estimateLowCents: 400000, estimateHighCents: 600000 },
    });
    expect(result).toEqual({ matterId: 'm1', revision: 1, changed: true });
    const fee = w.doc(M)?.['fee'] as Record<string, unknown>;
    expect(fee).toMatchObject({
      arrangement: 'hourly',
      estimateLowCents: 400000,
      estimateHighCents: 600000,
      revision: 1,
    });
    expect(fee).not.toHaveProperty('amountCents');
    expect(fee['history']).toEqual([
      {
        at: expect.anything(),
        by: 'user-lawyer',
        from: { arrangement: 'fixed', amountCents: 330000 },
        to: { arrangement: 'hourly', estimateLowCents: 400000, estimateHighCents: 600000 },
        reason: 'Probate application contested',
      },
    ]);
    expect((fee['history'] as { at: Timestamp }[])[0]?.at.toDate()).toEqual(NOW);
    expect(w.doc(M)).toMatchObject({ updatedBy: 'user-lawyer' });
    expect(audits(w).map((a) => a['action'])).toContain('matter.fee_revised');
    // 340,000 of 600,000 is 57%: below both thresholds of the new revision.
    expect(w.doc(M)?.['budget']).toMatchObject({ basisCents: 600000, pct: 57, revision: 1, alerted: [] });
  });

  it('changes nothing when the terms are the same', async () => {
    const w = world();
    expect(await call(w, { fee: { arrangement: 'fixed', amountCents: 330000 } })).toEqual({
      matterId: 'm1',
      revision: 0,
      changed: false,
    });
    expect((w.doc(M)?.['fee'] as { history: unknown[] }).history).toEqual([]);
    expect(audits(w)).toHaveLength(0);
  });

  it('is for lawyers and above, behind the flag, on live matters, with a reason', async () => {
    const w = world();
    await expect(call(w, { fee: { arrangement: 'hourly' } }, 'paralegal')).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(call(w, { fee: { arrangement: 'hourly' }, reason: ' ' })).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    await expect(
      call(w, { fee: { arrangement: 'conditional', conditional: { upliftPct: 10, condition: '' } } }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(call(w, { matterId: 'nope', fee: { arrangement: 'hourly' } })).rejects.toMatchObject({
      code: 'not-found',
    });
    const off = world({}, false);
    await expect(call(off, { fee: { arrangement: 'hourly' } })).rejects.toMatchObject({
      details: { code: 'FEATURE_DISABLED' },
    });
  });

  it('refuses an archived matter (CORE-19)', async () => {
    const w = world();
    w.docs.set(M, { ...w.doc(M), status: 'archived' });
    await expect(call(w, { fee: { arrangement: 'hourly' } })).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { reason: 'matter_archived' },
    });
  });
});

describe('fees-update and the costs disclosure (BILL-06)', () => {
  const deps = (w: ReturnType<typeof world>): CallableDeps => ({
    db: () => w.db,
    clock: w.clock,
    ports: () => w.ports,
    memberLookup: async () => true,
    idempotency: {
      begin: async () => ({ replay: false }),
      complete: async () => undefined,
      abandon: async () => undefined,
    },
    sink: () => undefined,
  });
  const revise = (w: ReturnType<typeof world>, amountCents: number) =>
    runCallable(
      updateDefinition,
      {
        data: {
          requestId: randomUUID(),
          matterId: 'm1',
          reason: 'Probate application contested',
          fee: { arrangement: 'fixed', amountCents },
        },
        auth: { uid: 'user-lawyer', token: { orgId: ORG, role: 'lawyer' } },
      },
      deps(w),
    );
  const sent = {
    status: 'sent',
    requirement: 'full',
    bandId: 'full',
    rulesVersion: 'vic-v1',
    basisEstimateCents: 330000,
    sentOn: '2026-09-01',
    sentMethod: 'email',
    sentEstimateCents: 330000,
    sentBandId: 'full',
    history: [],
  };
  /** The matter in Victoria with a disclosure; the flag on unless `flagOn` is false; the org's own percentage. */
  const disclosed = (disclosure: Record<string, unknown>, flagOn = true, pct?: number) => {
    const w = world();
    w.docs.set(`orgs/${ORG}`, {
      name: 'Harbour & Vine Legal',
      timezone: 'Australia/Melbourne',
      billing: pct ? { disclosureChangePct: pct } : {},
      flags: { 'billing.feeBudgets': true, 'billing.costsDisclosure': flagOn },
    });
    w.docs.set(M, { ...w.doc(M), jurisdiction: 'VIC', costsDisclosure: disclosure });
    return w;
  };
  const disclosure = (w: ReturnType<typeof world>) => w.doc(M)?.['costsDisclosure'] as Record<string, unknown>;
  const audits = (w: ReturnType<typeof world>) =>
    [...w.docs.entries()].filter(([path]) => path.startsWith(`orgs/${ORG}/audit/`)).map(([, d]) => d['action']);

  it('makes a sent disclosure update-required on a significant rise, with a task and a notification', async () => {
    const w = disclosed(sent);
    await revise(w, 370000);
    expect(disclosure(w)).toMatchObject({
      status: 'update_required',
      updateReasons: ['increase'],
      requiredSince: '2026-10-09',
      basisEstimateCents: 370000,
      sentEstimateCents: 330000,
      taskId: 'costs-disclosure-update-2026-10-09',
    });
    expect(w.doc(`${M}/tasks/costs-disclosure-update-2026-10-09`)).toMatchObject({
      title: 'Send an updated costs disclosure',
      assigneeUid: 'user-lawyer',
      source: 'rule',
    });
    expect(w.notifications()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'costs_disclosure',
          recipientUid: 'user-lawyer',
          title: 'Updated costs disclosure needed: M-2026-0042',
        }),
      ]),
    );
    expect(audits(w)).toEqual(expect.arrayContaining(['matter.disclosure_update_required', 'matter.fee_revised']));
  });

  it('leaves it sent below the org’s percentage, and follows the org’s own', async () => {
    const small = disclosed(sent);
    await revise(small, 350000);
    expect(disclosure(small)).toMatchObject({ status: 'sent', basisEstimateCents: 350000 });
    expect(small.doc(`${M}/tasks/costs-disclosure-update-2026-10-09`)).toBeUndefined();
    const strict = disclosed(sent, true, 5);
    await revise(strict, 350000);
    expect(disclosure(strict)).toMatchObject({ status: 'update_required', updateReasons: ['increase'] });
  });

  it('follows the estimate before one is given, and leaves the disclosure alone while the flag is off', async () => {
    const w = disclosed({
      ...sent,
      status: 'required',
      sentOn: undefined,
      sentMethod: undefined,
      requiredSince: '2026-10-01',
    });
    await revise(w, 50000);
    expect(disclosure(w)).toMatchObject({ status: 'not_required', notRequiredReason: 'below_threshold' });
    expect(disclosure(w)).not.toHaveProperty('requiredSince');
    const off = disclosed(sent, false);
    await revise(off, 900000);
    expect(disclosure(off)).toEqual(sent);
  });
});
