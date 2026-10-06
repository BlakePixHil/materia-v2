import { TestBed } from '@angular/core/testing';

import { DISBURSEMENT_CALLABLES, DISBURSEMENT_PRESETS_DOC } from '@materia/domain';

import { CallableClient } from './callable-client';
import {
  MATTER_DISBURSEMENTS_QUERY,
  disbursementCallables,
  disbursementPresetsRepository,
  matterDisbursementRepository,
} from './disbursements';
import { OrgContext } from './org-context';
import { InMemoryFirestore, provideInMemoryFirestore } from './testing/in-memory-firestore';

/** Disbursements: reads, client-direct creates, presets and disbursements-setStatus (BILL-04). Fictional data only. */

const meta = {
  createdAt: new Date('2026-10-01T00:00:00Z'),
  createdBy: 'u-jordan',
  updatedAt: new Date('2026-10-01T00:00:00Z'),
  updatedBy: 'u-jordan',
  schemaVersion: 1,
};
const M = 'orgs/org-a/matters/m-1/disbursements';

function disbursement(date: string, extra: Record<string, unknown> = {}) {
  return {
    orgId: 'org-a',
    matterId: 'm-1',
    date,
    description: 'Title search',
    payee: 'LANDATA',
    category: 'search',
    amountExGstCents: 2000,
    gstCents: 200,
    gstTreatment: 'taxable',
    status: 'unbilled',
    wipCountedCents: 2000,
    ...meta,
    ...extra,
  };
}

function setup() {
  const fs = new InMemoryFirestore();
  TestBed.configureTestingModule({ providers: [provideInMemoryFirestore(fs)] });
  TestBed.inject(OrgContext).setSession({ uid: 'u-jordan', orgId: 'org-a', role: 'lawyer' });
  const run = <T>(fn: () => T) => TestBed.runInInjectionContext(fn);
  return { fs, run };
}

describe('matterDisbursementRepository', () => {
  it('lists a matter’s disbursements newest first and hides deleted ones', async () => {
    const { fs, run } = setup();
    fs.set(`${M}/db-1`, disbursement('2026-10-01'));
    fs.set(`${M}/db-2`, disbursement('2026-10-03', { status: 'written_off' }));
    fs.set(`${M}/db-3`, disbursement('2026-10-02', { deletedAt: new Date('2026-10-04T00:00:00Z') }));
    const rows = await run(() => matterDisbursementRepository(() => 'm-1')).query(MATTER_DISBURSEMENTS_QUERY);
    expect(rows.map((row) => row.id)).toEqual(['db-2', 'db-1']);
    expect(rows[1]).toMatchObject({ amountExGstCents: 2000, gstCents: 200, status: 'unbilled', payee: 'LANDATA' });
  });

  it('creates an uncounted, unbilled disbursement with the org and matter the rules require', async () => {
    const { fs, run } = setup();
    const repo = run(() => matterDisbursementRepository(() => 'm-1'));
    const id = await repo.create({
      date: '2026-10-05' as never,
      description: 'Death certificate',
      payee: 'Births, Deaths and Marriages Victoria',
      category: 'certificate',
      amountExGstCents: 3530 as never,
      gstCents: 0 as never,
      gstTreatment: 'gst_free',
    });
    expect(fs.get(`${M}/${id}`)).toMatchObject({
      orgId: 'org-a',
      matterId: 'm-1',
      status: 'unbilled',
      wipCountedCents: 0,
      gstTreatment: 'gst_free',
      createdBy: 'u-jordan',
      schemaVersion: 1,
    });
  });

  it('refuses a create without a matter', async () => {
    const { run } = setup();
    await expect(
      run(() => matterDisbursementRepository(() => null)).create({
        date: '2026-10-05' as never,
        description: 'Courier',
        payee: '',
        amountExGstCents: 1500 as never,
        gstCents: 150 as never,
        gstTreatment: 'taxable',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

describe('disbursementPresetsRepository', () => {
  it('creates the presets document by its fixed id, then replaces the list', async () => {
    const { fs, run } = setup();
    const repo = run(() => disbursementPresetsRepository());
    await repo.create(
      { presets: [{ id: 'courier', label: 'Courier', category: 'courier', gstTreatment: 'taxable' }] },
      { id: DISBURSEMENT_PRESETS_DOC },
    );
    const path = `orgs/org-a/settings/${DISBURSEMENT_PRESETS_DOC}`;
    expect(fs.get(path)).toMatchObject({ presets: [{ id: 'courier', label: 'Courier' }] });

    await repo.update(DISBURSEMENT_PRESETS_DOC, {
      presets: [
        {
          id: 'title-search',
          label: 'Title search',
          category: 'search',
          gstTreatment: 'taxable',
          defaultAmountCents: 2000,
        },
      ],
    });
    expect(fs.get(path)).toMatchObject({ presets: [{ id: 'title-search', defaultAmountCents: 2000 }] });
  });

  it('reads a malformed list as no presets', async () => {
    const { fs, run } = setup();
    fs.set(`orgs/org-a/settings/${DISBURSEMENT_PRESETS_DOC}`, { presets: [{ label: 42 }], ...meta });
    const doc = await run(() => disbursementPresetsRepository()).get(DISBURSEMENT_PRESETS_DOC);
    expect(doc?.presets).toEqual([]);
  });
});

describe('disbursementCallables', () => {
  it('calls disbursements-setStatus with a request id', async () => {
    const calls: { name: string; data: unknown }[] = [];
    const client = new CallableClient(
      {
        call: async <T>(name: string, data: unknown) => {
          calls.push({ name, data });
          return { updated: ['db-1'], skipped: [] } as T;
        },
        refreshClaims: async () => undefined,
      },
      { newId: () => '00000000-0000-4000-8000-000000000001' },
    );
    const result = await disbursementCallables(client).setStatus({
      matterId: 'm-1',
      disbursementIds: ['db-1'],
      status: 'written_off',
    });
    expect(result).toEqual({ updated: ['db-1'], skipped: [] });
    expect(calls).toEqual([
      {
        name: DISBURSEMENT_CALLABLES.setStatus,
        data: {
          matterId: 'm-1',
          disbursementIds: ['db-1'],
          status: 'written_off',
          requestId: '00000000-0000-4000-8000-000000000001',
        },
      },
    ]);
  });
});
