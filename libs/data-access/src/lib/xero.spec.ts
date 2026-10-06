import { TestBed } from '@angular/core/testing';

import { XERO_CALLABLES } from '@materia/domain';

import { CallableClient } from './callable-client';
import { OrgContext } from './org-context';
import { InMemoryFirestore, provideInMemoryFirestore } from './testing/in-memory-firestore';
import {
  INTEGRATION_CALLABLES,
  integrationCallables,
  integrationStatusRepository,
  orgXeroSettingsRepository,
  xeroCallables,
} from './xero';

/** Xero (BILL-09): the org's settings, the connection's status and the xero-* callables. Fictional data only. */

const meta = {
  createdAt: new Date('2026-10-01T00:00:00Z'),
  createdBy: 'u-priya',
  updatedAt: new Date('2026-10-01T00:00:00Z'),
  updatedBy: 'u-priya',
  schemaVersion: 1,
};
const TENANT = '00000000-0000-4000-8000-00000000aaaa';
const REQUEST = '00000000-0000-4000-8000-000000000001';

function setup() {
  const fs = new InMemoryFirestore();
  TestBed.configureTestingModule({ providers: [provideInMemoryFirestore(fs)] });
  TestBed.inject(OrgContext).setSession({ uid: 'u-priya', orgId: 'org-a', role: 'owner' });
  const run = <T>(fn: () => T) => TestBed.runInInjectionContext(fn);
  return { fs, run };
}

function client(answer: unknown) {
  const calls: { name: string; data: unknown }[] = [];
  const callable = new CallableClient(
    {
      call: async <T>(name: string, data: unknown) => {
        calls.push({ name, data });
        return answer as T;
      },
      refreshClaims: async () => undefined,
    },
    { newId: () => REQUEST },
  );
  return { calls, callable };
}

describe('orgXeroSettingsRepository', () => {
  it('reads only the xero settings from the org', async () => {
    const { fs, run } = setup();
    const xero = {
      tenantId: TENANT,
      tenantName: 'Harbour & Vine Legal (demo)',
      feesAccountCode: '200',
      disbursementsAccountCode: '260',
      autoPush: true,
      sendFrom: '2026-10-01',
    };
    fs.set('orgs/org-a', { name: 'Harbour & Vine Legal', xero, ...meta });
    const org = await run(() => orgXeroSettingsRepository()).get('org-a');
    expect(org).toEqual({ id: 'org-a', xero });
  });
});

describe('integrationStatusRepository', () => {
  it('reads the practice’s Xero connection and refuses writes', async () => {
    const { fs, run } = setup();
    fs.set('orgs/org-a/integrationStatus/xero', {
      provider: 'xero',
      level: 'org',
      uid: null,
      status: 'connected',
      scopes: ['accounting.transactions'],
      account: { tenantName: 'Harbour & Vine Legal (demo)' },
      connectedAt: new Date('2026-10-02T00:00:00Z'),
      sync: { paymentsCheckedAt: new Date('2026-10-04T01:00:00Z') },
      ...meta,
    });
    const repo = run(() => integrationStatusRepository());
    const status = await repo.get('xero');
    expect(status).toMatchObject({
      id: 'xero',
      status: 'connected',
      account: { tenantName: 'Harbour & Vine Legal (demo)' },
      sync: { paymentsCheckedAt: new Date('2026-10-04T01:00:00Z') },
    });
    await expect(repo.update('xero', { status: 'disconnected' } as never)).rejects.toMatchObject({
      code: 'FAILED_PRECONDITION',
    });
    await expect(repo.hardDelete('xero')).rejects.toMatchObject({ code: 'FAILED_PRECONDITION' });
  });
});

describe('xeroCallables', () => {
  it('calls each xero-* callable with a request id', async () => {
    const { calls, callable } = client({ queued: 3 });
    const api = xeroCallables(callable);
    await api.options();
    await api.options({ tenantId: TENANT });
    await api.saveSettings({
      settings: {
        tenantId: TENANT,
        feesAccountCode: '200',
        disbursementsAccountCode: '260',
        autoPush: false,
        sendFrom: '2026-10-04',
      },
    });
    expect(await api.send()).toEqual({ queued: 3 });
    await api.send({ invoiceId: 'inv-1' });
    expect(calls.map((call) => call.name)).toEqual([
      XERO_CALLABLES.options,
      XERO_CALLABLES.options,
      XERO_CALLABLES.saveSettings,
      XERO_CALLABLES.send,
      XERO_CALLABLES.send,
    ]);
    expect(calls.map((call) => call.data)).toEqual([
      { requestId: REQUEST },
      { tenantId: TENANT, requestId: REQUEST },
      expect.objectContaining({ settings: expect.objectContaining({ tenantId: TENANT }), requestId: REQUEST }),
      { requestId: REQUEST },
      { invoiceId: 'inv-1', requestId: REQUEST },
    ]);
  });
});

describe('integrationCallables', () => {
  it('starts and disconnects a connection with a request id', async () => {
    const { calls, callable } = client({ url: 'https://login.xero.example.test/consent' });
    const api = integrationCallables(callable);
    await api.start({ provider: 'xero', returnTo: '/settings/integrations', origin: 'http://localhost:4200' });
    await api.disconnect({ provider: 'xero' });
    expect(calls).toEqual([
      {
        name: INTEGRATION_CALLABLES.start,
        data: {
          provider: 'xero',
          returnTo: '/settings/integrations',
          origin: 'http://localhost:4200',
          requestId: REQUEST,
        },
      },
      { name: INTEGRATION_CALLABLES.disconnect, data: { provider: 'xero', requestId: REQUEST } },
    ]);
  });
});
