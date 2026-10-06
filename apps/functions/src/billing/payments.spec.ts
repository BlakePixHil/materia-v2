import type { Role } from '@materia/domain';

import { createCreditNoteDefinition } from './credit-notes';
import {
  debtorsNightlyForOrg,
  outstandingOnInvoiceDefinition,
  queueReminders,
  recomputeOutstanding,
  refreshDebtorsDefinition,
} from './debtors';
import { recordPaymentDefinition, reversePaymentDefinition } from './payments';
import { dismissReminderDefinition, sendReminderDefinition } from './reminders';
import { setInvoiceFiles } from './send';
import { invoice, issue, M, meta, ORG, PDF, save, world, type World } from './testing';
import { voidDefinition } from './void';
import { createLog } from '../core/log';
import type { TriggerChange } from '../core/trigger';
import { FakeClock, FakeMail } from '../ports/fakes';

/** Unit tests for payments, aged debtors and reminders (BILL-08). Every client, matter and amount is fictional. */

const TOTAL = 44000 + 4400 + 13200 + 1320 + 33310; // the harness’s pre-bill: $962.30
const log = createLog({ fn: 'test' }, () => undefined);

async function issued(w: World) {
  const { invoiceId } = await save(w);
  await issue(w, invoiceId);
  return invoiceId;
}

type PaymentResult = { paymentId: string; status: string; owingCents: number; warnings: string[] };
const record = (w: World, invoiceId: string, data: Record<string, unknown>, role: Role = 'lawyer') =>
  w.call(
    recordPaymentDefinition as never,
    { invoiceId, date: '2026-10-06', method: 'eft', ...data },
    role,
  ) as Promise<PaymentResult>;
const reverse = (w: World, invoiceId: string, paymentId: string, role: Role = 'owner') =>
  w.call(reversePaymentDefinition as never, { invoiceId, paymentId, reason: 'Cheque dishonoured' }, role) as Promise<{
    reversed: boolean;
    status: string;
    owingCents: number;
  }>;
const audits = (w: World, action: string) =>
  w.entries(`orgs/${ORG}/audit/`).filter((entry) => (entry as Record<string, unknown>)['action'] === action);

describe('billing-recordPayment', () => {
  it('takes an invoice from issued to part paid to paid', async () => {
    const w = world();
    const invoiceId = await issued(w);
    const first = await record(w, invoiceId, { amountCents: 50_000, method: 'cheque', reference: '000123' });
    expect(first).toMatchObject({ status: 'part_paid', owingCents: TOTAL - 50_000, warnings: [] });
    expect(invoice(w, invoiceId)).toMatchObject({
      status: 'part_paid',
      payments: [
        {
          id: first.paymentId,
          kind: 'payment',
          date: '2026-10-06',
          amountCents: 50_000,
          method: 'cheque',
          reference: '000123',
          recordedBy: 'user-lawyer',
        },
      ],
    });
    const second = await record(w, invoiceId, { amountCents: TOTAL - 50_000, payer: 'Sam Wren (executor)' });
    expect(second).toMatchObject({ status: 'paid', owingCents: 0 });
    expect((invoice(w, invoiceId)['payments'] as { payer?: string }[])[1]?.payer).toBe('Sam Wren (executor)');
    expect(audits(w, 'invoice.payment_recorded')).toHaveLength(2);
    expect(audits(w, 'invoice.payment_recorded')[0]).toMatchObject({
      data: { amountCents: 50_000, method: 'cheque', status: 'part_paid' },
    });
    expect(JSON.stringify(audits(w, 'invoice.payment_recorded'))).not.toContain('Sam Wren');
  });

  it('refuses an overpayment unless it is kept as credit', async () => {
    const w = world();
    const invoiceId = await issued(w);
    await expect(record(w, invoiceId, { amountCents: TOTAL + 1 })).rejects.toMatchObject({
      code: 'failed-precondition',
      message: 'That’s more than the $962.30 owing. Change the amount or keep the extra as a credit.',
    });
    expect(invoice(w, invoiceId)['payments']).toEqual([]);
    const credit = await record(w, invoiceId, { amountCents: TOTAL + 1000, credit: true });
    expect(credit).toMatchObject({ status: 'paid', owingCents: -1000 });
  });

  it('records a payment dated before the invoice with a warning, never one in the future', async () => {
    const w = world();
    const invoiceId = await issued(w);
    await expect(record(w, invoiceId, { amountCents: 100, date: '2026-10-05' })).resolves.toMatchObject({
      warnings: ['before_issue'],
    });
    await expect(record(w, invoiceId, { amountCents: 100, date: '2026-10-07' })).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });

  it('refuses pre-bills, void invoices, paralegals, and refunds from lawyers', async () => {
    const w = world();
    const { invoiceId } = await save(w);
    await expect(record(w, invoiceId, { amountCents: 100 })).rejects.toMatchObject({ code: 'failed-precondition' });
    await issue(w, invoiceId);
    await expect(record(w, invoiceId, { amountCents: 100 }, 'paralegal')).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(record(w, invoiceId, { amountCents: 100, kind: 'refund' })).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await w.call(voidDefinition as never, { invoiceId, reason: 'Wrong matter' }, 'owner');
    await expect(record(w, invoiceId, { amountCents: 100 })).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('is refused while invoicing is off', async () => {
    const w = world({}, false);
    await expect(record(w, 'any', { amountCents: 100 })).rejects.toMatchObject({ code: 'failed-precondition' });
  });
});

describe('billing-reversePayment', () => {
  it('reverses a bounced cheque: it stays on the record and no longer counts', async () => {
    const w = world();
    const invoiceId = await issued(w);
    const { paymentId } = await record(w, invoiceId, { amountCents: TOTAL, method: 'cheque' });
    expect(invoice(w, invoiceId)['status']).toBe('paid');
    await expect(reverse(w, invoiceId, paymentId, 'lawyer')).rejects.toMatchObject({ code: 'permission-denied' });
    const result = await reverse(w, invoiceId, paymentId);
    expect(result).toEqual({ reversed: true, status: 'issued', owingCents: TOTAL });
    expect(invoice(w, invoiceId)).toMatchObject({
      status: 'issued',
      payments: [{ id: paymentId, reversedBy: 'user-owner', reversalReason: 'Cheque dishonoured' }],
    });
    expect(await reverse(w, invoiceId, paymentId)).toMatchObject({ reversed: false, status: 'issued' });
    expect(audits(w, 'invoice.payment_reversed')).toHaveLength(1);
    await expect(reverse(w, invoiceId, 'nope')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('lets a reversed invoice be voided, but not one with a live payment', async () => {
    const w = world();
    const invoiceId = await issued(w);
    const { paymentId } = await record(w, invoiceId, { amountCents: 10_000 });
    const voidIt = () => w.call(voidDefinition as never, { invoiceId, reason: 'Issued in error' }, 'owner');
    await expect(voidIt()).rejects.toMatchObject({
      code: 'failed-precondition',
      message: 'A paid invoice can’t be voided; issue a credit note, and record a refund if money goes back',
    });
    await reverse(w, invoiceId, paymentId);
    await expect(voidIt()).resolves.toMatchObject({ invoiceId });
  });
});

describe('credit notes and refunds after a part payment', () => {
  it('settles a part-paid invoice with a credit, then refunds credit held', async () => {
    const w = world();
    const invoiceId = await issued(w);
    const { paymentId } = await record(w, invoiceId, { amountCents: 60_000 });
    await w.call(createCreditNoteDefinition as never, { invoiceId, reason: 'Matter ended early', full: true }, 'owner');
    expect(invoice(w, invoiceId)).toMatchObject({ status: 'paid', creditedCents: TOTAL });
    const refund = await record(w, invoiceId, { kind: 'refund', amountCents: 60_000 }, 'owner');
    expect(refund).toMatchObject({ status: 'issued', owingCents: 0 });
    await expect(reverse(w, invoiceId, paymentId)).rejects.toMatchObject({
      message: 'A refund was made from this money. Reverse the refund first.',
    });
    expect(audits(w, 'invoice.refund_recorded')).toHaveLength(1);
  });
});

describe('matter outstanding (billing-outstandingOnInvoice)', () => {
  const change = (before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined) =>
    ({
      before: before ? { data: () => before } : undefined,
      after: after ? { data: () => after } : undefined,
    }) as unknown as TriggerChange;

  it('keeps what the matter’s invoices still owe', async () => {
    const w = world();
    const invoiceId = await issued(w);
    const trigger = (before: Record<string, unknown> | undefined) =>
      outstandingOnInvoiceDefinition.handler(change(before, invoice(w, invoiceId)), w.triggerCtx({ invoiceId }));
    await trigger(undefined);
    expect(w.doc(M)?.['outstandingCents']).toBe(TOTAL);
    const before = invoice(w, invoiceId);
    await record(w, invoiceId, { amountCents: 50_000 });
    await trigger(before);
    expect(w.doc(M)?.['outstandingCents']).toBe(TOTAL - 50_000);
  });

  it('skips pre-bill saves and destroyed matters', async () => {
    const w = world();
    const { invoiceId } = await save(w);
    await outstandingOnInvoiceDefinition.handler(change(undefined, invoice(w, invoiceId)), w.triggerCtx({ invoiceId }));
    expect(w.doc(M)?.['outstandingCents']).toBeUndefined();
    w.docs.set(M, { ...w.doc(M), destroyedAt: new Date() });
    expect(await recomputeOutstanding(w.db as never, ORG, 'm1')).toBeNull();
  });
});

describe('aged debtors and reminders (fake clock)', () => {
  async function overdue(w: World, days: number) {
    const invoiceId = await issued(w); // issued 6 Oct, due 20 Oct
    (w.clock as FakeClock).set(new Date(Date.parse('2026-10-20T01:00:00Z') + days * 86_400_000));
    return invoiceId;
  }

  it('rolls up aged debt into metrics/debtors-{date}', async () => {
    const w = world();
    const invoiceId = await overdue(w, 31);
    await record(w, invoiceId, { amountCents: 10_000, date: '2026-10-21' });
    const outcome = await debtorsNightlyForOrg(w.db as never, ORG, w.clock, log);
    expect(outcome).toEqual({ invoices: 1, queued: 1 });
    const metrics = w.doc(`orgs/${ORG}/metrics/debtors-2026-11-20`);
    expect(metrics).toMatchObject({
      period: 'debtors-2026-11-20',
      values: { current: 0, d1_30: 0, d31_60: TOTAL - 10_000, total: TOTAL - 10_000, invoices: 1, matters: 1 },
      debtors: {
        asOf: '2026-11-20',
        truncated: false,
        rows: [
          {
            matterId: 'm1',
            matterNumber: 'M-2026-0042',
            clientName: 'Lan Nguyễn',
            lawyerUid: 'user-lawyer',
            invoices: 1,
            oldestDueDate: '2026-10-20',
          },
        ],
      },
    });
  });

  it('queues one reminder per threshold for the responsible lawyer, never sending it', async () => {
    const w = world();
    const invoiceId = await overdue(w, 6);
    const asOf = (days: number) => {
      const at = new Date(Date.parse('2026-10-20T01:00:00Z') + days * 86_400_000);
      return { at, date: at.toISOString().slice(0, 10) as never };
    };
    expect((await queueReminders(w.db as never, ORG, asOf(6).date, asOf(6).at, log)).queued).toEqual([]);
    expect((await queueReminders(w.db as never, ORG, asOf(7).date, asOf(7).at, log)).queued).toEqual([
      `${invoiceId}-7`,
    ]);
    expect((await queueReminders(w.db as never, ORG, asOf(8).date, asOf(8).at, log)).queued).toEqual([]);
    expect(w.doc(`orgs/${ORG}/invoiceReminders/${invoiceId}-7`)).toMatchObject({
      invoiceId,
      invoiceNumber: 'INV-000001',
      matterId: 'm1',
      threshold: 7,
      dueDate: '2026-10-20',
      balanceCents: TOTAL,
      lawyerUid: 'user-lawyer',
      to: ['lan@example.com'],
      status: 'pending',
    });
    const later = await queueReminders(w.db as never, ORG, asOf(30).date, asOf(30).at, log);
    expect(later).toEqual({ queued: [`${invoiceId}-30`], cancelled: [`${invoiceId}-7`] });
    expect(w.doc(`orgs/${ORG}/invoiceReminders/${invoiceId}-7`)).toMatchObject({
      status: 'cancelled',
      closeReason: 'later_reminder',
    });
    expect((w.ports.mail as FakeMail).sent).toEqual([]);

    await record(w, invoiceId, { amountCents: TOTAL, date: '2026-10-21' });
    const paid = await queueReminders(w.db as never, ORG, asOf(60).date, asOf(60).at, log);
    expect(paid).toEqual({ queued: [], cancelled: [`${invoiceId}-30`] });
  });

  it('refreshes the report on demand while invoicing is on', async () => {
    const w = world();
    await overdue(w, 1);
    const result = await w.call(refreshDebtorsDefinition as never, {});
    expect(result).toEqual({ asOf: '2026-10-21', invoices: 1, totalCents: TOTAL });
    expect(w.doc(`orgs/${ORG}/metrics/debtors-2026-10-21`)?.['createdBy']).toBe('user-lawyer');
    await expect(w.call(refreshDebtorsDefinition as never, {}, 'paralegal')).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });
});

describe('billing-sendReminder and -dismissReminder', () => {
  afterEach(() => setInvoiceFiles());

  async function queued(w: World) {
    const invoiceId = await issued(w);
    w.docs.set(`${M}/documents/job-1`, { ...meta, storagePath: `${M}/documents/job-1/v1`, version: 1 });
    w.docs.set(`orgs/${ORG}/invoices/${invoiceId}`, {
      ...invoice(w, invoiceId),
      pdfStatus: 'ready',
      pdfDocumentId: 'job-1',
    });
    setInvoiceFiles(
      () => ({ read: async (path: string) => (path.endsWith('job-1/v1') ? Buffer.from(PDF) : null) }) as never,
    );
    const at = new Date('2026-10-27T01:00:00Z');
    (w.clock as FakeClock).set(at);
    await queueReminders(w.db as never, ORG, '2026-10-27' as never, at, log);
    return { invoiceId, reminderId: `${invoiceId}-7` };
  }

  it('sends the lawyer’s edited message with the PDF, once', async () => {
    const w = world();
    const { invoiceId, reminderId } = await queued(w);
    const send = (role: Role = 'lawyer') =>
      w.call(
        sendReminderDefinition as never,
        { reminderId, to: ['Lan@Example.com'], message: 'Dear Lan,\n\nA gentle reminder.' },
        role,
      );
    await expect(send()).resolves.toEqual({ sent: 1 });
    const mail = (w.ports.mail as FakeMail).sent;
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({
      to: 'lan@example.com',
      template: 'invoice_reminder',
      model: { number: 'INV-000001', owing: '$962.30', message: 'Dear Lan,\n\nA gentle reminder.', attached: true },
      attachments: [{ name: 'Tax invoice INV-000001.pdf' }],
    });
    expect(w.doc(`orgs/${ORG}/invoiceReminders/${reminderId}`)).toMatchObject({
      status: 'sent',
      sentBy: 'user-lawyer',
      sentTo: ['lan@example.com'],
    });
    await expect(send()).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(audits(w, 'invoice.reminder_sent')[0]).toMatchObject({
      entity: expect.objectContaining({ id: invoiceId }),
      data: { threshold: 7, recipients: 1 },
    });
  });

  it('keeps other lawyers’ reminders to them, and lets them be dismissed', async () => {
    const w = world();
    const { reminderId } = await queued(w);
    w.docs.set(`orgs/${ORG}/invoiceReminders/${reminderId}`, {
      ...w.doc(`orgs/${ORG}/invoiceReminders/${reminderId}`),
      lawyerUid: 'user-someone-else',
    });
    const dismiss = (role: Role) =>
      w.call(dismissReminderDefinition as never, { reminderId, reason: 'Client called' }, role);
    await expect(dismiss('lawyer')).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(dismiss('admin')).resolves.toEqual({ dismissed: true });
    await expect(dismiss('admin')).resolves.toEqual({ dismissed: false });
    expect(w.doc(`orgs/${ORG}/invoiceReminders/${reminderId}`)).toMatchObject({
      status: 'dismissed',
      closedBy: 'user-admin',
      closeReason: 'Client called',
    });
  });

  it('won’t send once the invoice is paid', async () => {
    const w = world();
    const { invoiceId, reminderId } = await queued(w);
    await record(w, invoiceId, { amountCents: TOTAL, date: '2026-10-27' });
    await expect(
      w.call(sendReminderDefinition as never, { reminderId, to: ['lan@example.com'], message: 'Hi' }),
    ).rejects.toMatchObject({ code: 'failed-precondition', message: 'Nothing is owing on this invoice any more' });
  });
});
