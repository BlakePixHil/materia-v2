import {
  can,
  checkPayment,
  checkReversal,
  DomainError,
  owingCents,
  PAYMENT_CALLABLES,
  paymentStatus,
  PERMISSIONS,
  RecordPaymentInput,
  ReversePaymentInput,
  today,
  type InvoicePayment,
  type DateOnly,
  type RecordPaymentResult,
  type ReversePaymentResult,
} from '@materia/domain';

import { existing, invoicePath } from './invoice-shared';
import { audit } from '../audit/audit';
import { compact, stamp } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { orgClock } from '../core/emulator-clock';
import { requireFlag } from '../core/flags';
import { liveMatter, matterPath } from '../matters/shared';
import { orgTimeZone } from '../templates/shared';

type Data = Record<string, unknown>;

const paymentsOf = (invoice: Data) => (invoice['payments'] ?? []) as InvoicePayment[];

/**
 * `billing-recordPayment` (BILL-08, ADR-046; `billing.issue`, refunds `billing.void`; flag
 * `billing.invoicing`; idempotent): records a payment received against an issued invoice, or a
 * refund of credit the client holds. In one transaction it re-reads the invoice, checks the
 * payment (`checkPayment`: an overpayment needs `credit`, a refund can't return more than is held,
 * no future dates), appends it to `payments` with who and when, and sets the status (`part_paid`
 * or `paid`, or back to `issued`). A payment dated before the invoice is recorded with a warning.
 * `billing-outstandingOnInvoice` then updates the matter's outstanding amount. Audited as
 * `invoice.payment_recorded` or `invoice.refund_recorded` (amount and method; never the payer).
 */
export const recordPaymentDefinition = {
  name: PAYMENT_CALLABLES.record,
  input: RecordPaymentInput,
  roles: PERMISSIONS['billing.issue'],
  idempotent: true,
  handler: async (ctx): Promise<RecordPaymentResult> => {
    const { input, orgId, uid, role, db, requestId, log } = ctx;
    await requireFlag({ orgId, db, clock: ctx.clock }, 'billing.invoicing');
    if (input.kind === 'refund' && !can(role, 'billing.void')) {
      throw new DomainError('PERMISSION_DENIED', 'Only owners and admins record refunds');
    }
    const clock = await orgClock(db, orgId, ctx.clock);
    const todayDate = today(await orgTimeZone(db, orgId), clock.now());
    const ref = db.doc(invoicePath(orgId, input.invoiceId));
    const paymentId = db.collection('_').doc().id;

    const result = await db.runTransaction(async (tx) => {
      const invoice = existing(await tx.get(ref));
      const matterId = String(invoice['matterId']);
      liveMatter(await tx.get(db.doc(matterPath(orgId, matterId))), role, matterId);
      const payments = paymentsOf(invoice);
      const check = checkPayment(
        {
          status: String(invoice['status']),
          issueDate: invoice['issueDate'] as string | undefined,
          totalCents: Number(invoice['totalCents'] ?? 0),
          creditedCents: Number(invoice['creditedCents'] ?? 0),
          payments,
        },
        { kind: input.kind, date: input.date as DateOnly, amountCents: input.amountCents, credit: input.credit },
        todayDate,
      );
      if (check.problem) throw new DomainError('FAILED_PRECONDITION', check.problem);
      const now = clock.now();
      const payment = compact({
        id: paymentId,
        kind: input.kind,
        date: input.date,
        amountCents: input.amountCents,
        method: input.method,
        reference: input.reference || undefined,
        payer: input.payer || undefined,
        credit: input.kind === 'payment' && input.credit ? true : undefined,
        recordedAt: now,
        recordedBy: uid,
      }) as InvoicePayment;
      tx.update(ref, {
        payments: [...payments, payment],
        status: check.statusAfter,
        ...stamp(uid, now, requestId),
      });
      return { check, number: String(invoice['number']), matterId };
    });

    await audit(ctx, {
      action: input.kind === 'refund' ? 'invoice.refund_recorded' : 'invoice.payment_recorded',
      entity: { path: ref.path },
      summary: `${input.kind === 'refund' ? 'Refund' : 'Payment'} recorded on invoice ${result.number}`,
      data: {
        paymentId,
        amountCents: input.amountCents,
        method: input.method,
        date: input.date,
        status: result.check.statusAfter,
        ...(input.credit ? { credit: true } : {}),
      },
    });
    log.info('payment recorded', {
      invoiceId: ref.id,
      kind: input.kind,
      status: result.check.statusAfter,
      warnings: result.check.warnings.length,
    });
    return {
      paymentId,
      status: result.check.statusAfter,
      owingCents: result.check.owingAfterCents,
      warnings: result.check.warnings,
    };
  },
} satisfies CallableDefinition<typeof RecordPaymentInput, RecordPaymentResult>;

/**
 * `billing-reversePayment` (BILL-08; `billing.void`: owners and admins; flag `billing.invoicing`;
 * idempotent): reverses a payment or refund recorded in error or that didn't clear (a bounced
 * cheque). It stays on the invoice with `reversedAt`, `reversedBy` and `reversalReason` and no
 * longer counts; the status follows. Reversing one already reversed changes nothing. A payment a
 * refund was paid from needs the refund reversed first. Audited as `invoice.payment_reversed`.
 */
export const reversePaymentDefinition = {
  name: PAYMENT_CALLABLES.reverse,
  input: ReversePaymentInput,
  roles: PERMISSIONS['billing.void'],
  idempotent: true,
  handler: async (ctx): Promise<ReversePaymentResult> => {
    const { input, orgId, uid, role, db, requestId, log } = ctx;
    await requireFlag({ orgId, db, clock: ctx.clock }, 'billing.invoicing');
    const clock = await orgClock(db, orgId, ctx.clock);
    const ref = db.doc(invoicePath(orgId, input.invoiceId));
    const reason = input.reason.trim();

    const result = await db.runTransaction(async (tx) => {
      const invoice = existing(await tx.get(ref));
      const matterId = String(invoice['matterId']);
      liveMatter(await tx.get(db.doc(matterPath(orgId, matterId))), role, matterId);
      const payments = paymentsOf(invoice);
      const money = {
        totalCents: Number(invoice['totalCents'] ?? 0),
        creditedCents: Number(invoice['creditedCents'] ?? 0),
      };
      const problem = checkReversal({ ...money, payments }, input.paymentId);
      if (problem) {
        throw new DomainError(problem.startsWith('That payment') ? 'NOT_FOUND' : 'FAILED_PRECONDITION', problem);
      }
      const target = payments.find((payment) => payment.id === input.paymentId) as InvoicePayment;
      const number = String(invoice['number']);
      if (target.reversedAt) {
        return { reversed: false, payments, number, target, money };
      }
      const now = clock.now();
      const next = payments.map((payment) =>
        payment.id === input.paymentId
          ? { ...payment, reversedAt: now, reversedBy: uid, reversalReason: reason }
          : payment,
      );
      tx.update(ref, {
        payments: next,
        status: paymentStatus({ ...money, payments: next }),
        ...stamp(uid, now, requestId),
      });
      return { reversed: true, payments: next, number, target, money };
    });

    const money = { ...result.money, payments: result.payments };
    if (result.reversed) {
      await audit(ctx, {
        action: 'invoice.payment_reversed',
        entity: { path: ref.path },
        summary: `${result.target.kind === 'refund' ? 'Refund' : 'Payment'} reversed on invoice ${result.number}`,
        data: { paymentId: input.paymentId, amountCents: result.target.amountCents, reason },
      });
    }
    log.info('payment reversed', { invoiceId: ref.id, repeat: !result.reversed });
    return { reversed: result.reversed, status: paymentStatus(money), owingCents: owingCents(money) };
  },
} satisfies CallableDefinition<typeof ReversePaymentInput, ReversePaymentResult>;

export const recordPayment = defineCallable(recordPaymentDefinition);
export const reversePayment = defineCallable(reversePaymentDefinition);
