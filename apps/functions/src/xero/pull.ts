import { onSchedule } from 'firebase-functions/v2/scheduler';

import { DomainError, today, XERO_PAYMENTS_LOOKBACK_DAYS } from '@materia/domain';

import { notifyUnrecorded } from './notices';
import { applyXeroPayments, type IncomingXeroPayment } from './payments';
import { xeroOrg, XeroNotReady, xeroStatusPath, type XeroDeps } from './shared';
import { invoicesPath } from '../billing/invoice-shared';
import { REGION } from '../config';
import { isDeleted } from '../contacts/shared';
import { adminDb } from '../core/admin';
import { createLog, errorReportFields, functionsSink } from '../core/log';
import { OAUTH_SECRETS } from '../integrations/providers';
import { ports, systemClock } from '../ports/container';
import { orgTimeZone } from '../templates/shared';

/** Pages of 100 fetched per org and run; the cursor picks up where a long run stopped. */
export const XERO_PAYMENT_PAGES = 20;

export interface PullResult {
  payments: number;
  recorded: number;
  reversed: number;
  unrecorded: number;
}

const asDate = (value: unknown): Date | null => {
  if (value instanceof Date) return value;
  const toDate = (value as { toDate?: () => Date } | null)?.toDate;
  return typeof toDate === 'function' ? toDate.call(value) : null;
};

/**
 * Brings one org's Xero payments across (BILL-09, ADR-053): every receivable payment changed in
 * Xero since the last fetch (the first fetch looks back 180 days), matched to the invoices Materia
 * sent there by Xero's InvoiceID, recorded once each by PaymentID. Others' invoices are ignored.
 * Then `integrationStatus/xero.sync` records when, and from when the next fetch asks.
 */
export async function pullOrgPayments(deps: XeroDeps, orgId: string): Promise<PullResult> {
  const x = await xeroOrg(deps, orgId);
  const tenantId = x.settings.tenantId;
  const statusRef = deps.db.doc(xeroStatusPath(orgId));
  const now = deps.clock.now();
  const cursor = asDate((await statusRef.get()).get('sync.paymentsCursor'));
  const since = cursor ?? new Date(now.getTime() - XERO_PAYMENTS_LOOKBACK_DAYS * 86_400_000);

  const byInvoice = new Map<string, IncomingXeroPayment[]>();
  let latest = since;
  let payments = 0;
  for (let page = 1; page <= XERO_PAYMENT_PAGES; page++) {
    const batch = await x.client.payments(tenantId, { modifiedSince: since, page });
    for (const payment of batch) {
      payments++;
      byInvoice.set(payment.invoiceId, [...(byInvoice.get(payment.invoiceId) ?? []), payment]);
      if (payment.updatedAt && payment.updatedAt > latest) latest = payment.updatedAt;
    }
    if (batch.length < 100) break;
  }

  const result: PullResult = { payments, recorded: 0, reversed: 0, unrecorded: 0 };
  const todayDate = today(await orgTimeZone(deps.db, orgId), now);
  for (const [xeroInvoiceId, incoming] of byInvoice) {
    const found = await deps.db.collection(invoicesPath(orgId)).where('xero.id', '==', xeroInvoiceId).limit(5).get();
    const invoice = found.docs.find((doc) => doc.get('xero.tenantId') === tenantId);
    if (!invoice) continue;
    const applied = await applyXeroPayments(deps, invoice.ref, incoming, todayDate);
    result.recorded += applied.recorded;
    result.reversed += applied.reversed;
    result.unrecorded += applied.unrecorded.length;
    await notifyUnrecorded(deps, orgId, { id: invoice.id, number: applied.number }, applied.unrecorded);
  }

  await statusRef.update({ 'sync.paymentsCheckedAt': now, 'sync.paymentsCursor': latest });
  return result;
}

/**
 * Every org with Xero set up; one org's failure doesn't stop the others. Orgs without Xero, or
 * whose connection needs reconnecting (the vault told their admins), are skipped quietly. A rate
 * limit waits for the next run.
 */
export async function pullAllOrgs(deps: XeroDeps): Promise<PullResult & { orgs: number }> {
  const orgs = await deps.db.collection('orgs').get();
  const total = { orgs: 0, payments: 0, recorded: 0, reversed: 0, unrecorded: 0 };
  for (const org of orgs.docs) {
    if (isDeleted(org.data()) || !org.get('xero')) continue;
    try {
      const result = await pullOrgPayments(deps, org.id);
      total.orgs++;
      total.payments += result.payments;
      total.recorded += result.recorded;
      total.reversed += result.reversed;
      total.unrecorded += result.unrecorded;
    } catch (error) {
      if (error instanceof XeroNotReady) continue;
      if (error instanceof DomainError && (error.code.startsWith('INTEGRATION_') || error.code === 'RATE_LIMITED')) {
        deps.log.warn('xero payments skipped', { orgId: org.id, code: error.code });
        continue;
      }
      deps.log.error('xero payments failed', { orgId: org.id, ...errorReportFields(error) });
    }
  }
  return total;
}

/** `xero-pullPayments` (BILL-09): hourly, brings payments made in Xero across. */
export const pullPayments = onSchedule(
  {
    schedule: 'every 60 minutes',
    timeZone: 'Australia/Melbourne',
    region: REGION,
    retryCount: 0,
    secrets: OAUTH_SECRETS,
  },
  async () => {
    const log = createLog({ fn: 'xero-pullPayments' }, functionsSink);
    const result = await pullAllOrgs({ db: adminDb(), clock: systemClock, log, ports: ports() });
    log.info('ok', { ...result });
  },
);
