import type { XeroSettings } from '@materia/domain';

import { FAKE_XERO_TENANT, type FakeXero } from './fake';
import { runXeroPush, type XeroPushTask } from './push';
import type { XeroDeps } from './shared';
import { invoice, issue, meta, ORG, save, world } from '../billing/testing';
import { clearFlagCaches } from '../core/flags';
import { createLog } from '../core/log';

/** The invoicing harness (billing/testing.ts) with Xero connected and set up (BILL-09). Fictional throughout. */

export const TENANT = FAKE_XERO_TENANT.tenantId;
export const SETTINGS: XeroSettings = {
  tenantId: TENANT,
  tenantName: FAKE_XERO_TENANT.tenantName,
  feesAccountCode: '200',
  disbursementsAccountCode: '840',
  autoPush: true,
  sendFrom: '2026-10-01' as XeroSettings['sendFrom'],
};
export const STATUS_PATH = `orgs/${ORG}/integrationStatus/xero`;

export function xeroWorld(
  options: {
    flag?: boolean;
    settings?: Partial<XeroSettings> | null;
    status?: string | null;
    gstRegistered?: boolean;
  } = {},
) {
  const w = world();
  const org = w.doc(`orgs/${ORG}`) ?? {};
  w.docs.set(`orgs/${ORG}`, {
    ...org,
    flags: { ...(org['flags'] as object), 'integrations.xero': options.flag ?? true },
    billing: { ...(org['billing'] as object), gstRegistered: options.gstRegistered ?? true },
    ...(options.settings === null ? {} : { xero: { ...SETTINGS, ...options.settings } }),
  });
  if (options.status !== null) {
    w.docs.set(STATUS_PATH, {
      ...meta,
      provider: 'xero',
      level: 'org',
      uid: null,
      status: options.status ?? 'connected',
      scopes: [],
    });
  }
  clearFlagCaches();
  const xero = w.ports.xero as FakeXero;
  xero.now = () => w.clock.now();
  const logs: { level: string; message: string; fields: Record<string, unknown> }[] = [];
  const log = createLog({ fn: 'test' }, (level, message, fields) => logs.push({ level, message, fields }));
  const deps: XeroDeps = { db: w.db, clock: w.clock, log, ports: w.ports };
  const push = (task: Omit<XeroPushTask, 'orgId'>, attempt = 0) =>
    runXeroPush({ orgId: ORG, ...task }, { ...deps, attempt });
  /** An issued invoice (the harness's $962.30 pre-bill), its id. */
  const issued = async () => {
    const { invoiceId } = await save(w);
    await issue(w, invoiceId);
    return invoiceId;
  };
  const notifications = () => w.entries(`orgs/${ORG}/notifications/`) as (Record<string, unknown> & { path: string })[];
  const xeroOf = (invoiceId: string) => invoice(w, invoiceId)['xero'] as Record<string, unknown> | undefined;
  return { ...w, xero, deps, log, logs, push, issued, notifications, xeroOf };
}

export type XeroWorld = ReturnType<typeof xeroWorld>;
