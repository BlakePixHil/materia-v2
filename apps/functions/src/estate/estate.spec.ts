import { randomUUID } from 'node:crypto';

import type { HttpsError } from 'firebase-functions/v2/https';

import { toRuleSetDoc, VIC_RULESET_V1 } from '@materia/deadlines';
import { ESTATE_INVENTORY_TITLE, type Role } from '@materia/domain';

import { exportInventoryDefinition, INVENTORY_TEMPLATE } from './export';
import {
  ESTATE_VALUE_FACTS,
  estateValueChanged,
  onLiabilityWriteDefinition,
  onWriteDefinition,
  syncEstate,
  type EstateSyncOutcome,
} from './sync';
import { runCallable, type CallableDeps } from '../core/callable';
import { clearFlagCaches } from '../core/flags';
import { createLog } from '../core/log';
import type { TriggerChange, TriggerContext } from '../core/trigger';
import { memoryFirestore } from '../orgs/testing';
import { FakeClock, fakePorts, type FakeJobRunner } from '../ports/fakes';

/** Unit tests for the estate register functions (CORE-16). Every org, person and asset is fictional. */

const ORG = 'org-a';
const M = `orgs/${ORG}/matters/m1`;
const NOW = new Date('2026-10-05T00:00:00.000Z');
const EARLIER = new Date('2026-10-01T00:00:00.000Z');
const LATER = new Date('2026-10-06T00:00:00.000Z');
const meta = { createdBy: 'user-lawyer', updatedBy: 'user-lawyer', schemaVersion: 1 };

type Data = Record<string, unknown>;

const asset = (extra: Data = {}) => ({
  ...meta,
  createdAt: EARLIER,
  class: 'bank',
  description: 'Savings account (fictional)',
  valueAtDeathCents: 10_000_00,
  jointlyHeld: false,
  passesOutsideEstate: false,
  status: 'identified',
  documentIds: [],
  ...extra,
});
const liability = (extra: Data = {}) => ({
  ...meta,
  createdAt: EARLIER,
  class: 'funeral',
  creditor: 'Bay Funerals (fictional)',
  amountCents: 2_000_00,
  status: 'notified',
  ...extra,
});
const distribution = (extra: Data = {}) => ({
  ...meta,
  createdAt: EARLIER,
  beneficiaryPartyId: 'beneficiary_c-1',
  kind: 'residuary',
  status: 'planned',
  ...extra,
});

function world(initial: Record<string, Data> = {}, flags: Data = { 'estate.register': true }) {
  clearFlagCaches();
  const store = memoryFirestore({
    [`orgs/${ORG}`]: { name: 'Fictional Bayside Legal', timezone: 'Australia/Melbourne', flags },
    [`orgs/${ORG}/members/user-lawyer`]: { ...meta, role: 'lawyer', status: 'active' },
    [`orgs/${ORG}/contacts/c-wren`]: { ...meta, kind: 'person', givenNames: 'Ada', familyName: 'Wren' },
    [M]: {
      ...meta,
      number: 'RM-2026-0001',
      title: 'Estate of Fictional Wren',
      type: 'probate',
      status: 'open',
      jurisdiction: 'VIC',
      privileged: false,
      deletedAt: null,
      deceased: { contactId: 'c-wren', dateOfDeath: '2026-07-16', domicile: 'VIC', lastAddress: 'Geelong' },
      estate: { grantType: 'probate' },
    },
    [`orgs/${ORG}/matters/m-priv`]: { ...meta, number: 'RM-2026-0002', title: 'Private', privileged: true },
    ...initial,
  });
  const clock = new FakeClock(NOW);
  const ports = fakePorts();
  const log = createLog({ fn: 'test' }, () => undefined);
  let event = 0;
  const doc = (path: string) => store.docs.get(path) as Data | undefined;
  /** Writes a register record as a client would, then runs its trigger. */
  const write = async (collection: 'assets' | 'liabilities', id: string, data: Data | undefined, matter = M) => {
    const path = `${matter}/${collection}/${id}`;
    const before = doc(path);
    if (data) store.docs.set(path, { ...before, ...data });
    else store.docs.delete(path);
    const after = doc(path);
    const change = {
      before: before ? { ref: { path }, data: () => before } : undefined,
      after: after ? { ref: { path }, data: () => after } : undefined,
    } as unknown as TriggerChange;
    const ctx = {
      eventId: `e${++event}`,
      time: NOW,
      params: { orgId: ORG, matterId: matter.split('/')[3], [collection === 'assets' ? 'assetId' : 'liabilityId']: id },
      log,
      clock,
      db: store.db,
      ports,
    } as unknown as TriggerContext;
    return syncEstate(change, ctx, collection === 'assets' ? 'asset' : 'liability') as Promise<EstateSyncOutcome>;
  };
  const deps = (): CallableDeps => ({
    db: () => store.db,
    clock,
    ports: () => ports,
    memberLookup: async () => true,
    idempotency: {
      begin: async () => ({ replay: false }),
      complete: async () => undefined,
      abandon: async () => undefined,
    },
    sink: () => undefined,
  });
  const exportInventory = (data: Data = {}, role: Role = 'lawyer') =>
    runCallable(
      exportInventoryDefinition,
      { data: { requestId: randomUUID(), matterId: 'm1', ...data }, auth: { uid: `user-${role}`, token: { orgId: ORG, role } } },
      deps(),
    );
  return { ...store, doc, write, exportInventory, ports, log, clock };
}

describe('estate-onWrite', () => {
  it('is declared on assets and liabilities', () => {
    expect(onWriteDefinition).toMatchObject({
      name: 'estate-onWrite',
      on: 'written',
      document: 'orgs/{orgId}/matters/{matterId}/assets/{assetId}',
    });
    expect(onLiabilityWriteDefinition).toMatchObject({
      name: 'estate-onLiabilityWrite',
      on: 'written',
      document: 'orgs/{orgId}/matters/{matterId}/liabilities/{liabilityId}',
    });
  });

  it('keeps the matter’s totals and gross and net values in step with the register', async () => {
    const w = world();
    await w.write('assets', 'a1', asset({ valueAtDeathCents: 500_000_00 }));
    await w.write('assets', 'a2', asset({ class: 'superannuation', valueAtDeathCents: 300_000_00, passesOutsideEstate: true }));
    await w.write('assets', 'a3', asset({ class: 'real_property', valueAtDeathCents: 800_000_00, shareBps: 5000, realisedCents: 410_000_00 }));
    const outcome = await w.write('liabilities', 'l1', liability({ amountCents: 15_000_00 }));
    expect(outcome).toMatchObject({ synced: true, valueChanged: true, recomputed: false });
    const matter = w.doc(M) as Data;
    expect(matter['estateRegister']).toEqual({
      grossCents: 900_000_00,
      liabilitiesCents: 15_000_00,
      netCents: 885_000_00,
      outsideCents: 300_000_00,
      realisedCents: 410_000_00,
      assetCount: 3,
      liabilityCount: 1,
      updatedAt: expect.anything(),
    });
    expect(matter['estate']).toEqual({ grantType: 'probate', grossValueCents: 900_000_00, netValueCents: 885_000_00 });
  });

  it('writes nothing when the totals already agree, and follows deletes into an insolvent estate', async () => {
    const w = world();
    await w.write('assets', 'a1', asset({ valueAtDeathCents: 1_000_00 }));
    const renamed = await w.write('assets', 'a1', asset({ valueAtDeathCents: 1_000_00, description: 'Renamed' }));
    expect(renamed).toMatchObject({ synced: false, valueChanged: false, flagged: [] });
    await w.write('liabilities', 'l1', liability({ amountCents: 900_00 }));
    await w.write('liabilities', 'l2', liability({ amountCents: 500_00 }));
    expect((w.doc(M)?.['estate'] as Data)['netValueCents']).toBe(-400_00);
    await w.write('liabilities', 'l2', liability({ amountCents: 500_00, deletedAt: NOW, deletedBy: 'user-lawyer' }));
    expect(w.doc(M)?.['estateRegister']).toMatchObject({ netCents: 100_00, liabilityCount: 1 });
    await w.write('assets', 'a1', undefined);
    expect(w.doc(M)?.['estateRegister']).toMatchObject({ grossCents: 0, netCents: -900_00, assetCount: 0 });
  });

  it('flags distributions recorded before an asset’s worth changed, once', async () => {
    const w = world({
      [`${M}/distributions/residue`]: distribution(),
      [`${M}/distributions/car`]: distribution({ kind: 'specific', assetId: 'a1' }),
      [`${M}/distributions/car-fixed`]: distribution({ kind: 'specific', assetId: 'a1', amountCents: 5_00 }),
      [`${M}/distributions/other`]: distribution({ kind: 'specific', assetId: 'a2' }),
      [`${M}/distributions/cash`]: distribution({ kind: 'pecuniary', amountCents: 1_000_00 }),
      [`${M}/distributions/cancelled`]: distribution({ status: 'cancelled' }),
      [`${M}/distributions/new`]: distribution({ createdAt: LATER }),
    });
    const first = await w.write('assets', 'a1', asset());
    expect(first.flagged.sort()).toEqual(['car', 'residue']);
    expect(w.doc(`${M}/distributions/residue`)).toMatchObject({ needsReview: true, updatedBy: 'system' });
    expect(w.doc(`${M}/distributions/cash`)?.['needsReview']).toBeUndefined();
    // A rename changes nothing the distributions depend on; a value change flags only the unflagged.
    expect((await w.write('assets', 'a1', asset({ description: 'Car (fictional)' }))).flagged).toEqual([]);
    w.docs.set(`${M}/distributions/residue`, { ...w.doc(`${M}/distributions/residue`), needsReview: false });
    expect((await w.write('assets', 'a1', asset({ valueAtDeathCents: 1 }))).flagged).toEqual(['residue']);
    // Liabilities don't flag distributions.
    w.docs.set(`${M}/distributions/residue`, { ...w.doc(`${M}/distributions/residue`), needsReview: false });
    expect((await w.write('liabilities', 'l1', liability())).flagged).toEqual([]);
  });

  it('skips a matter that no longer exists', async () => {
    const w = world();
    expect(await w.write('assets', 'a1', asset(), `orgs/${ORG}/matters/m-missing`)).toEqual({
      synced: false,
      totals: null,
      valueChanged: false,
      recomputed: false,
      flagged: [],
    });
  });

  it('recomputes deadlines only when the matter’s rule set reads the estate values', async () => {
    const w = world();
    const ctx = (params: Data = {}) =>
      ({ params: { orgId: ORG, matterId: 'm1', ...params }, db: w.db, log: w.log, clock: w.clock, ports: w.ports }) as unknown as TriggerContext;
    // vic-v1 has no estate-value conditions.
    expect(await estateValueChanged(w.doc(M) as Data, ctx())).toBe(false);
    expect(await estateValueChanged({ ...(w.doc(M) as Data), status: 'closed' }, ctx())).toBe(false);
    expect(await estateValueChanged({ ...(w.doc(M) as Data), jurisdiction: 'NSW' }, ctx())).toBe(false);
    // A newer published version that does read them is recomputed.
    const rule = VIC_RULESET_V1.rules.find((r) => 'offset' in r) as (typeof VIC_RULESET_V1.rules)[number];
    const next = {
      ...VIC_RULESET_V1,
      version: VIC_RULESET_V1.version + 1,
      rules: [{ ...rule, conditions: [{ fact: ESTATE_VALUE_FACTS[0], exists: true }] }],
    };
    w.docs.set(`ruleSets/${VIC_RULESET_V1.ruleSetId}/versions/${next.version}`, toRuleSetDoc(next) as Data);
    expect(await estateValueChanged(w.doc(M) as Data, ctx())).toBe(true);
  });
});

describe('estate-exportInventory', () => {
  it('starts a pdf.render job from the live register, saved to the matter as a financial document', async () => {
    const w = world({
      [`${M}/assets/a1`]: asset({ valueAtDeathCents: 42_317_55, institution: 'Corio Savings Bank' }),
      [`${M}/assets/gone`]: asset({ deletedAt: NOW }),
      [`${M}/liabilities/l1`]: liability(),
    });
    const result = await w.exportInventory();
    expect(result).toEqual({ jobId: expect.any(String) });
    const job = w.doc(`orgs/${ORG}/jobs/${result.jobId}`) as Data;
    expect(job).toMatchObject({
      type: 'pdf.render',
      status: 'queued',
      target: {
        kind: 'matter',
        matterId: 'm1',
        name: 'Schedule of assets and liabilities (working draft) - RM-2026-0001.pdf',
        category: 'financial',
        privileged: false,
      },
    });
    const input = job['input'] as { templateId: string; data: Data };
    expect(input.templateId).toBe(INVENTORY_TEMPLATE);
    expect(input.data).toMatchObject({
      title: ESTATE_INVENTORY_TITLE,
      matterNumber: 'RM-2026-0001',
      deceasedName: 'Ada Wren',
      dateOfDeath: '16 July 2026',
      preparedOn: '5 October 2026',
    });
    expect((input.data['assetGroups'] as { lines: unknown[] }[])[0]?.lines).toHaveLength(1);
    expect((w.ports.jobs as FakeJobRunner).started).toEqual([{ job: 'pdf', orgId: ORG, jobId: result.jobId }]);
  });

  it('makes a privileged matter’s schedule privileged, and hides the matter from roles that can’t see it', async () => {
    const w = world({ [`orgs/${ORG}/matters/m-priv/assets/a1`]: asset() });
    const { jobId } = await w.exportInventory({ matterId: 'm-priv' });
    expect((w.doc(`orgs/${ORG}/jobs/${jobId}`)?.['target'] as Data)['privileged']).toBe(true);
    await expect(w.exportInventory({ matterId: 'm-priv' }, 'paralegal')).rejects.toMatchObject({
      details: { code: 'NOT_FOUND' },
    } satisfies Partial<HttpsError>);
  });

  it('refuses an empty register, readonly members and an org with the register off', async () => {
    await expect(world().exportInventory()).rejects.toMatchObject({
      details: { code: 'FAILED_PRECONDITION', reason: 'estate_empty' },
    });
    const w = world({ [`${M}/assets/a1`]: asset() });
    await expect(w.exportInventory({}, 'readonly')).rejects.toMatchObject({ details: { code: 'PERMISSION_DENIED' } });
    const off = world({ [`${M}/assets/a1`]: asset() }, {});
    await expect(off.exportInventory()).rejects.toMatchObject({ details: { code: 'FEATURE_DISABLED' } });
  });
});
