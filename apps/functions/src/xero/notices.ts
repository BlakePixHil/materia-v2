import { cents, formatCents, type XeroUnrecordedPayment } from '@materia/domain';

import type { XeroDeps } from './shared';
import { errorReportFields } from '../core/log';
import { reconnectRecipients } from '../integrations/vault';
import { notify } from '../notifications/notify';

/**
 * Tells the practice's owners and admins about a Xero problem only they can fix (BILL-09), as an
 * `integration_error`. Best effort: a notification failing never fails the sync. `key` makes it
 * one notification per problem.
 */
export async function notifyXeroAdmins(
  deps: XeroDeps,
  orgId: string,
  notice: { title: string; body: string; link: string; key: string },
): Promise<void> {
  const ctx = { orgId, db: deps.db, clock: deps.clock, log: deps.log, ports: deps.ports };
  try {
    await notify(ctx, {
      kind: 'integration_error',
      provider: 'xero',
      title: notice.title,
      body: notice.body,
      link: notice.link,
      recipients: await reconnectRecipients(ctx, null),
      key: notice.key,
    });
  } catch (error) {
    deps.log.warn('xero notification failed', errorReportFields(error));
  }
}

/** One notice per payment Xero holds that Materia couldn't record. */
export async function notifyUnrecorded(
  deps: XeroDeps,
  orgId: string,
  invoice: { id: string; number: string },
  payments: readonly XeroUnrecordedPayment[],
): Promise<void> {
  for (const payment of payments) {
    await notifyXeroAdmins(deps, orgId, {
      title: `A Xero payment on invoice ${invoice.number} wasn’t recorded`,
      body: `${formatCents(cents(payment.amountCents))} paid on ${payment.date}: ${payment.reason}`,
      link: `/billing/invoices/${invoice.id}`,
      key: `xero-payment-${payment.id}`,
    });
  }
}
