import { FieldValue, type DocumentReference } from 'firebase-admin/firestore';

import {
  addDays,
  cents,
  checkPayment,
  checkReversal,
  daysBetween,
  isLivePayment,
  paymentStatus,
  PAYABLE_STATUSES,
  XERO_DUPLICATE_WINDOW_DAYS,
  XERO_UNRECORDED_MAX,
  type DateOnly,
  type InvoicePayment,
  type XeroUnrecordedPayment,
} from '@materia/domain';

import { compact } from '../contacts/shared';
import type { XeroPaymentSummary } from '../ports';
import type { XeroDeps } from './shared';

type Data = Record<string, unknown>;

/** A payment Xero holds against one of the practice's invoices. */
export interface IncomingXeroPayment extends XeroPaymentSummary {
  deleted: boolean;
}

/** The invoice's money, as a payment is checked against it. */
export interface InvoiceMoney {
  status: string;
  issueDate?: string | undefined;
  totalCents: number;
  creditedCents?: number | undefined;
  payments: InvoicePayment[];
}

export type XeroPaymentPlan =
  | { action: 'skip' }
  | { action: 'record'; payment: InvoicePayment }
  | { action: 'reverse'; paymentId: string }
  | { action: 'unrecorded'; entry: XeroUnrecordedPayment };

/** The Materia payment id for a Xero payment: one per PaymentID, so bringing it across twice records it once. */
export const xeroPaymentId = (paymentId: string) => `xero-${paymentId}`;

export const DELETED_IN_XERO = 'Deleted in Xero';

/**
 * What to do with one payment from Xero (BILL-09, ADR-053). A new one is recorded with method
 * `xero` when `checkPayment` allows it, flagged when a payment recorded by hand looks like the same
 * money (same amount within a week); otherwise it is listed as unrecorded with the reason (it would
 * overpay, the invoice is void). One deleted in Xero reverses the payment recorded from it. One
 * already brought across (even if someone has since reversed it here) is left alone.
 */
export function planXeroPayment(
  invoice: InvoiceMoney,
  incoming: IncomingXeroPayment,
  todayDate: DateOnly,
  now: Date,
): XeroPaymentPlan {
  const id = xeroPaymentId(incoming.id);
  const existing = invoice.payments.find((payment) => payment.id === id);
  if (incoming.deleted) {
    if (!existing || !isLivePayment(existing)) return { action: 'skip' };
    const problem = checkReversal(invoice, id);
    return problem
      ? { action: 'unrecorded', entry: unrecorded(incoming, `${DELETED_IN_XERO}, but not reversed here: ${problem}`) }
      : { action: 'reverse', paymentId: id };
  }
  if (existing) return { action: 'skip' };
  const date = incoming.date as DateOnly;
  // Xero's date is the organisation's own; allow a day either side of the practice's today.
  const check = checkPayment(
    invoice,
    { kind: 'payment', date, amountCents: incoming.amountCents, method: 'xero', reference: incoming.reference },
    addDays(todayDate, 1),
  );
  if (check.problem) return { action: 'unrecorded', entry: unrecorded(incoming, check.problem) };
  const linked = new Set(invoice.payments.map((payment) => payment.possibleDuplicateOf).filter(Boolean));
  const twin = invoice.payments.find(
    (payment) =>
      isLivePayment(payment) &&
      payment.kind === 'payment' &&
      payment.method !== 'xero' &&
      payment.amountCents === incoming.amountCents &&
      Math.abs(daysBetween(payment.date as DateOnly, date)) <= XERO_DUPLICATE_WINDOW_DAYS &&
      !linked.has(payment.id),
  );
  return {
    action: 'record',
    payment: compact({
      id,
      kind: 'payment' as const,
      date,
      amountCents: incoming.amountCents,
      method: 'xero' as const,
      reference: incoming.reference,
      recordedAt: now,
      possibleDuplicateOf: twin?.id,
    }) as InvoicePayment,
  };
}

function unrecorded(incoming: IncomingXeroPayment, reason: string): XeroUnrecordedPayment {
  return {
    id: incoming.id,
    date: incoming.date as DateOnly,
    amountCents: cents(incoming.amountCents),
    reason: reason.slice(0, 300),
  };
}

export interface AppliedPayments {
  recorded: number;
  reversed: number;
  /** Payments newly listed as unrecorded (whoever can act on them hears once). */
  unrecorded: XeroUnrecordedPayment[];
  number: string;
}

/**
 * Brings Xero's payments onto one invoice in a transaction: records, reverses and lists them as
 * `planXeroPayment` says, and sets the status from the money (BILL-08's `paymentStatus`). Written
 * as `system`, so the audit trigger records it. `billing-outstandingOnInvoice` then updates the
 * matter's outstanding amount.
 */
export async function applyXeroPayments(
  deps: Pick<XeroDeps, 'db' | 'clock'>,
  ref: DocumentReference,
  incoming: readonly IncomingXeroPayment[],
  todayDate: DateOnly,
): Promise<AppliedPayments> {
  const now = deps.clock.now();
  return deps.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data() as Data | undefined;
    const result: AppliedPayments = {
      recorded: 0,
      reversed: 0,
      unrecorded: [],
      number: String(data?.['number'] ?? ''),
    };
    if (!data) return result;
    const money: InvoiceMoney = {
      status: String(data['status']),
      issueDate: data['issueDate'] as string | undefined,
      totalCents: Number(data['totalCents'] ?? 0),
      creditedCents: Number(data['creditedCents'] ?? 0),
      payments: [...((data['payments'] ?? []) as InvoicePayment[])],
    };
    const before = ((data['xero'] as Data | undefined)?.['unrecordedPayments'] ?? []) as XeroUnrecordedPayment[];
    let listed = [...before];
    let changed = false;
    for (const payment of incoming) {
      const plan = planXeroPayment(money, payment, todayDate, now);
      if (plan.action === 'record') {
        money.payments.push(plan.payment);
        listed = listed.filter((entry) => entry.id !== payment.id);
        result.recorded++;
        changed = true;
      } else if (plan.action === 'reverse') {
        money.payments = money.payments.map((existing) =>
          existing.id === plan.paymentId ? { ...existing, reversedAt: now, reversalReason: DELETED_IN_XERO } : existing,
        );
        result.reversed++;
        changed = true;
      } else if (plan.action === 'unrecorded') {
        const known = listed.find((entry) => entry.id === plan.entry.id);
        if (!known || known.reason !== plan.entry.reason || known.amountCents !== plan.entry.amountCents) {
          if (!before.some((entry) => entry.id === plan.entry.id)) result.unrecorded.push(plan.entry);
          listed = [...listed.filter((entry) => entry.id !== plan.entry.id), plan.entry];
          changed = true;
        }
      }
    }
    if (!changed) return result;
    listed = listed.slice(-XERO_UNRECORDED_MAX);
    tx.update(ref, {
      payments: money.payments,
      ...(PAYABLE_STATUSES.has(money.status) ? { status: paymentStatus(money) } : {}),
      'xero.unrecordedPayments': listed.length ? listed : FieldValue.delete(),
      updatedAt: now,
      updatedBy: 'system',
      // Not the last callable's request: the audit trigger records this as the system's.
      _requestId: FieldValue.delete(),
    });
    return result;
  });
}
