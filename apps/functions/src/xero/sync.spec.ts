import { Timestamp } from 'firebase-admin/firestore';

import { DomainError } from '@materia/domain';

import { saveSettingsDefinition, optionsDefinition, sendDefinition, unsentToXero } from './callables';
import { xeroContactLinkId } from './contacts';
import { FAKE_XERO_TENANT } from './fake';
import { pullAllOrgs, pullOrgPayments } from './pull';
import { XERO_PUSH_QUEUE } from './push';
import { SETTINGS, STATUS_PATH, TENANT, xeroWorld, type XeroWorld } from './testing';
import { onCreditNoteDefinition, onInvoiceDefinition } from './triggers';
import { createCreditNoteDefinition } from '../billing/credit-notes';
import { recordPaymentDefinition } from '../billing/payments';
import { invoice, M, ORG, save, time } from '../billing/testing';
import { voidDefinition } from '../billing/void';
import { clearFlagCaches } from '../core/flags';
import type { TriggerChange } from '../core/trigger';
import { XeroApiError } from '../ports';
import type { FakeTaskQueue } from '../ports/fakes';

/** Xero sync (BILL-09, ADR-053) against the fake Xero organisation. Every firm, client and amount is fictional. */

const TOTAL = 44000 + 4400 + 13200 + 1320 + 33310; // the harness’s pre-bill: $962.30
/** What Settings → Integrations saves. */
const INPUT = {
  tenantId: SETTINGS.tenantId,
  feesAccountCode: SETTINGS.feesAccountCode,
  disbursementsAccountCode: SETTINGS.disbursementsAccountCode,
  autoPush: SETTINGS.autoPush,
  sendFrom: SETTINGS.sendFrom,
};
/** A time as Firestore stores it. */
const at = (date: Date) => Timestamp.fromDate(date);

const count = (w: XeroWorld, operation: string) => w.xero.calls.filter((call) => call === operation).length;
const queued = (w: XeroWorld) =>
  (w.ports.tasks as FakeTaskQueue).queued.filter((task) => task.queue === XERO_PUSH_QUEUE);
const credit = (w: XeroWorld, invoiceId: string, data: Record<string, unknown>) =>
  w.call(createCreditNoteDefinition as never, { invoiceId, reason: 'Fee reduced', ...data }, 'owner') as Promise<{
    creditNoteId: string;
    number: string;
    totalCents: number;
  }>;
const recordHere = (w: XeroWorld, invoiceId: string, data: Record<string, unknown>) =>
  w.call(recordPaymentDefinition as never, { invoiceId, date: '2026-10-05', method: 'eft', ...data }) as Promise<{
    paymentId: string;
  }>;
const payments = (w: XeroWorld, invoiceId: string) =>
  (invoice(w, invoiceId)['payments'] ?? []) as Record<string, unknown>[];

describe('xero-push: invoices', () => {
  it('sends an issued invoice once, with its client, lines, GST and matter number', async () => {
    const w = xeroWorld();
    const invoiceId = await w.issued();
    await w.push({ kind: 'invoice', id: invoiceId });

    const sent = w.xero.byNumber('INV-000001');
    expect(sent).toMatchObject({
      type: 'ACCREC',
      status: 'AUTHORISED',
      reference: 'M-2026-0042',
      totalCents: TOTAL,
      lineAmountTypes: 'Exclusive',
      date: '2026-10-06',
    });
    expect(sent?.lines.map((line) => [line.accountCode, line.taxType, line.taxAmountCents])).toEqual([
      ['200', 'OUTPUT', 4400],
      ['200', 'OUTPUT', 1320],
      ['840', 'EXEMPTOUTPUT', 0],
    ]);
    const contact = w.xero.contacts.get(String(sent?.contactId));
    expect(contact).toMatchObject({ email: 'lan@example.com', tenantId: TENANT });
    expect(w.xeroOf(invoiceId)).toEqual({
      status: 'synced',
      tenantId: TENANT,
      id: sent?.id,
      contactId: sent?.contactId,
      syncedAt: at(w.clock.now()),
    });
    expect(w.doc(`orgs/${ORG}/xeroContacts/${xeroContactLinkId(TENANT, ['c1'])}`)).toMatchObject({
      tenantId: TENANT,
      contactId: sent?.contactId,
      clientContactIds: ['c1'],
    });

    // Sending again changes nothing in Xero.
    await w.push({ kind: 'invoice', id: invoiceId });
    expect(count(w, 'createInvoice')).toBe(1);
    expect(count(w, 'createContact')).toBe(1);
    expect(w.xero.documents.size).toBe(1);
  });

  it('reuses the client’s Xero contact for the next invoice', async () => {
    const w = xeroWorld();
    const first = await w.issued();
    await w.push({ kind: 'invoice', id: first });
    w.docs.set(`${M}/timeEntries/t3`, time(10_000, { date: '2026-10-02' }));
    const second = await w.issued();
    await w.push({ kind: 'invoice', id: second });
    expect(count(w, 'createContact')).toBe(1);
    expect(w.xeroOf(second)?.['contactId']).toBe(w.xeroOf(first)?.['contactId']);
  });

  it('adopts the invoice an earlier send created but didn’t record, instead of sending it twice', async () => {
    const w = xeroWorld();
    const invoiceId = await w.issued();
    await w.push({ kind: 'invoice', id: invoiceId });
    const id = w.xeroOf(invoiceId)?.['id'];
    // The write after Xero answered was lost.
    w.docs.set(`orgs/${ORG}/invoices/${invoiceId}`, { ...invoice(w, invoiceId), xero: { status: 'queued' } });
    await w.push({ kind: 'invoice', id: invoiceId });
    expect(w.xeroOf(invoiceId)).toMatchObject({ status: 'synced', id });
    expect(count(w, 'createInvoice')).toBe(1);
  });

  it('reports a number Xero already uses for something else, never overwriting it, and tells the owners once', async () => {
    const w = xeroWorld();
    const contact = await w.xero.createContact(TENANT, { name: 'Someone else' }, 'k');
    await w.xero.createInvoice(
      TENANT,
      {
        contactId: contact.id,
        number: 'INV-000001',
        date: '2026-09-01',
        lineAmountTypes: 'NoTax',
        lines: [{ description: 'Typed in by hand', quantity: 1, unitAmountCents: 1000, accountCode: '200' }],
      },
      'manual',
    );
    const invoiceId = await w.issued();
    await w.push({ kind: 'invoice', id: invoiceId });
    expect(w.xeroOf(invoiceId)).toMatchObject({
      status: 'conflict',
      error: {
        code: 'number_taken',
        message: expect.stringContaining('Xero already has a different invoice INV-000001'),
      },
    });
    expect(w.xero.byNumber('INV-000001')).toMatchObject({ totalCents: 1000, contactId: contact.id });
    expect(w.xero.documents.size).toBe(1);
    expect(w.notifications()).toEqual([
      expect.objectContaining({
        path: `orgs/${ORG}/notifications/xero-invoice-${invoiceId}-number_taken`,
        kind: 'integration_error',
        recipientUid: 'user-owner',
        title: 'Invoice INV-000001 didn’t reach Xero',
        link: `/billing/invoices/${invoiceId}`,
      }),
    ]);
    await w.push({ kind: 'invoice', id: invoiceId });
    expect(w.notifications()).toHaveLength(1);
  });

  it('matches the client by email when exactly one active Xero contact has it', async () => {
    const w = xeroWorld();
    const existing = await w.xero.createContact(TENANT, { name: 'L Nguyen', email: 'LAN@example.com' }, 'k');
    const invoiceId = await w.issued();
    await w.push({ kind: 'invoice', id: invoiceId });
    expect(w.xeroOf(invoiceId)?.['contactId']).toBe(existing.id);
    expect(count(w, 'createContact')).toBe(1); // only the test's own
  });

  it('never matches by name alone: a namesake gets a new contact with the client’s reference', async () => {
    const w = xeroWorld();
    const invoiceId = await w.issued();
    const buyer = String((invoice(w, invoiceId)['buyer'] as { name: string }).name);
    const namesake = await w.xero.createContact(TENANT, { name: buyer, email: 'someone@example.org' }, 'k');
    await w.push({ kind: 'invoice', id: invoiceId });
    const contactId = String(w.xeroOf(invoiceId)?.['contactId']);
    expect(contactId).not.toBe(namesake.id);
    expect(w.xero.contacts.get(contactId)?.name).toBe(`${buyer} (Materia c1)`);
  });

  it('sends a firm’s invoices without GST when it isn’t registered', async () => {
    const w = xeroWorld({ gstRegistered: false });
    const invoiceId = await w.issued();
    await w.push({ kind: 'invoice', id: invoiceId });
    const sent = w.xero.byNumber(String(invoice(w, invoiceId)['number']));
    expect(sent).toMatchObject({ lineAmountTypes: 'NoTax', totalCents: invoice(w, invoiceId)['totalCents'] });
    expect(sent?.lines.every((line) => line.taxType === undefined)).toBe(true);
  });

  it('voids it in Xero, once, when it’s voided here', async () => {
    const w = xeroWorld();
    const invoiceId = await w.issued();
    await w.push({ kind: 'invoice', id: invoiceId });
    await w.call(voidDefinition as never, { invoiceId, reason: 'Issued to the wrong client' }, 'owner');
    await w.push({ kind: 'invoice', id: invoiceId });
    expect(w.xero.byNumber('INV-000001')?.status).toBe('VOIDED');
    expect(w.xeroOf(invoiceId)).toMatchObject({ status: 'synced', voidedAt: at(w.clock.now()) });
    await w.push({ kind: 'invoice', id: invoiceId });
    expect(count(w, 'voidInvoice')).toBe(1);
  });

  it('never sends a draft', async () => {
    const w = xeroWorld();
    const { invoiceId } = await save(w);
    await w.push({ kind: 'invoice', id: invoiceId });
    expect(w.xero.calls).toEqual([]);
    expect(w.xeroOf(invoiceId)).toBeUndefined();
  });

  it('retries when Xero doesn’t respond, saying so and telling the owners only on the last try', async () => {
    const w = xeroWorld();
    const invoiceId = await w.issued();
    for (let i = 0; i < 5; i++)
      w.xero.failNext('invoiceByNumber', new XeroApiError('unavailable', 'Xero answered 503', 503));
    for (let attempt = 0; attempt < 4; attempt++) {
      await expect(w.push({ kind: 'invoice', id: invoiceId }, attempt)).rejects.toBeInstanceOf(XeroApiError);
    }
    expect(w.xeroOf(invoiceId)).toMatchObject({ error: { code: 'unavailable' } });
    expect(w.xeroOf(invoiceId)?.['status']).not.toBe('failed');
    expect(w.notifications()).toEqual([]);
    await w.push({ kind: 'invoice', id: invoiceId }, 4);
    expect(w.xeroOf(invoiceId)).toMatchObject({ status: 'failed', error: { code: 'unavailable' } });
    expect(w.notifications()).toHaveLength(1);

    // "Try again" works once Xero is back, and clears the error.
    await w.push({ kind: 'invoice', id: invoiceId });
    expect(w.xeroOf(invoiceId)).toMatchObject({ status: 'synced' });
    expect(w.xeroOf(invoiceId)?.['error']).toBeUndefined();
  });

  it('records Xero’s reason when it refuses the invoice, without retrying', async () => {
    const w = xeroWorld({ settings: { feesAccountCode: '201' } });
    const invoiceId = await w.issued();
    await w.push({ kind: 'invoice', id: invoiceId });
    expect(w.xeroOf(invoiceId)).toMatchObject({
      status: 'failed',
      error: {
        code: 'rejected',
        message: expect.stringContaining("Account code '201' is not a valid code for this document."),
      },
    });
    expect(w.notifications()).toHaveLength(1);
  });

  it('waits out a rate limit without using a try', async () => {
    const w = xeroWorld();
    const invoiceId = await w.issued();
    w.xero.failNext('invoiceByNumber', new DomainError('RATE_LIMITED', 'Xero asked to wait', { retryAfterMs: 30_000 }));
    await w.push({ kind: 'invoice', id: invoiceId }, 3);
    expect(queued(w)).toEqual([
      expect.objectContaining({
        payload: { orgId: ORG, kind: 'invoice', id: invoiceId },
        options: expect.objectContaining({ scheduleTime: new Date(w.clock.now().getTime() + 31_000) }),
      }),
    ]);
    expect(w.xeroOf(invoiceId)?.['error']).toBeUndefined();
  });

  it('marks the invoice not sent, telling no one again, when Xero isn’t connected', async () => {
    const w = xeroWorld({ status: 'reconnect_required' });
    const invoiceId = await w.issued();
    await w.push({ kind: 'invoice', id: invoiceId });
    expect(w.xeroOf(invoiceId)).toMatchObject({
      status: 'failed',
      error: { code: 'not_connected', message: expect.stringContaining('Xero needs reconnecting.') },
    });
    expect(w.xero.calls).toEqual([]);
    expect(w.notifications()).toEqual([]);
  });

  it('treats the vault refusing the connection as not connected, and Xero refusing the organisation as needing a reconnect', async () => {
    const w = xeroWorld();
    const invoiceId = await w.issued();
    w.xero.failNext('invoiceByNumber', new DomainError('INTEGRATION_RECONNECT_REQUIRED', 'Reconnect Xero'));
    await w.push({ kind: 'invoice', id: invoiceId });
    expect(w.xeroOf(invoiceId)).toMatchObject({ status: 'failed', error: { code: 'not_connected' } });
    expect(w.notifications()).toEqual([]);

    w.xero.tenantList = [];
    await w.push({ kind: 'invoice', id: invoiceId });
    expect(w.xeroOf(invoiceId)).toMatchObject({
      status: 'failed',
      error: { code: 'not_connected', message: expect.stringContaining('Reconnect Xero and choose it again') },
    });
  });
});

describe('xero-push: credit notes', () => {
  it('sends a credit note after its invoice, allocated against it', async () => {
    const w = xeroWorld();
    const invoiceId = await w.issued();
    const note = await credit(w, invoiceId, { lines: [{ line: 0, amountExGstCents: 10000 }] });
    await w.push({ kind: 'creditNote', id: note.creditNoteId });

    const xeroInvoice = w.xero.byNumber('INV-000001');
    expect(w.xero.byNumber('CN-000001')).toMatchObject({
      type: 'ACCRECCREDIT',
      reference: 'INV-000001',
      totalCents: 11000,
      contactId: xeroInvoice?.contactId,
      allocations: [{ invoiceId: xeroInvoice?.id, amountCents: 11000 }],
    });
    expect(w.xero.amountDueCents(String(xeroInvoice?.id))).toBe(TOTAL - 11000);
    expect(w.doc(`orgs/${ORG}/creditNotes/${note.creditNoteId}`)?.['xero']).toMatchObject({
      status: 'synced',
      tenantId: TENANT,
      allocatedAt: at(w.clock.now()),
    });
    expect(w.xeroOf(invoiceId)).toMatchObject({ status: 'synced', id: xeroInvoice?.id });

    await w.push({ kind: 'creditNote', id: note.creditNoteId });
    expect(count(w, 'createCreditNote')).toBe(1);
    expect(count(w, 'allocateCreditNote')).toBe(1);
  });

  it('leaves a credit Xero can’t allocate (the invoice was paid there) on the note, with Xero’s reason', async () => {
    const w = xeroWorld();
    const invoiceId = await w.issued();
    await w.push({ kind: 'invoice', id: invoiceId });
    w.xero.addPayment(String(w.xeroOf(invoiceId)?.['id']), { amountCents: TOTAL, date: '2026-10-06' });
    const note = await credit(w, invoiceId, { lines: [{ line: 0, amountExGstCents: 10000 }] });
    await w.push({ kind: 'creditNote', id: note.creditNoteId });
    const sync = w.doc(`orgs/${ORG}/creditNotes/${note.creditNoteId}`)?.['xero'] as Record<string, unknown>;
    expect(sync).toMatchObject({
      status: 'failed',
      id: w.xero.byNumber('CN-000001')?.id,
      error: { code: 'rejected', message: expect.stringContaining('exceeds the outstanding amount') },
    });
    expect(sync['allocatedAt']).toBeUndefined();
  });
});

describe('xero-pullPayments: payments made in Xero', () => {
  async function synced(w: XeroWorld) {
    const invoiceId = await w.issued();
    await w.push({ kind: 'invoice', id: invoiceId });
    return { invoiceId, xeroId: String(w.xeroOf(invoiceId)?.['id']) };
  }

  it('records each payment once, as a Xero payment, and the invoice’s status follows', async () => {
    const w = xeroWorld();
    const { invoiceId, xeroId } = await synced(w);
    const paymentId = w.xero.addPayment(xeroId, { amountCents: 50_000, date: '2026-10-06', reference: 'EFT 0042' });
    w.clock.advance(60_000);
    await expect(pullOrgPayments(w.deps, ORG)).resolves.toEqual({
      payments: 1,
      recorded: 1,
      reversed: 0,
      unrecorded: 0,
    });
    expect(payments(w, invoiceId)).toEqual([
      expect.objectContaining({
        id: `xero-${paymentId}`,
        kind: 'payment',
        method: 'xero',
        amountCents: 50_000,
        date: '2026-10-06',
        reference: 'EFT 0042',
      }),
    ]);
    expect(invoice(w, invoiceId)).toMatchObject({ status: 'part_paid', updatedBy: 'system' });
    expect(w.doc(STATUS_PATH)?.['sync']).toEqual({
      paymentsCheckedAt: at(w.clock.now()),
      paymentsCursor: expect.any(Timestamp),
    });

    // Asked again, from the start: still recorded once.
    w.docs.set(STATUS_PATH, { ...w.doc(STATUS_PATH), sync: {} });
    await pullOrgPayments(w.deps, ORG);
    expect(payments(w, invoiceId)).toHaveLength(1);

    w.xero.addPayment(xeroId, { amountCents: TOTAL - 50_000, date: '2026-10-06' });
    await pullOrgPayments(w.deps, ORG);
    expect(invoice(w, invoiceId)['status']).toBe('paid');
  });

  it('asks Xero only for what changed since the last check', async () => {
    const w = xeroWorld();
    const { xeroId } = await synced(w);
    w.xero.addPayment(xeroId, { amountCents: 10_000, date: '2026-10-06' });
    await pullOrgPayments(w.deps, ORG);
    w.clock.advance(3_600_000);
    await expect(pullOrgPayments(w.deps, ORG)).resolves.toMatchObject({ payments: 1, recorded: 0 });
    w.clock.advance(3_600_000);
    w.xero.addPayment(xeroId, { amountCents: 10_000, date: '2026-10-06' });
    await expect(pullOrgPayments(w.deps, ORG)).resolves.toMatchObject({ recorded: 1 });
  });

  it('reverses a payment deleted in Xero', async () => {
    const w = xeroWorld();
    const { invoiceId, xeroId } = await synced(w);
    const paymentId = w.xero.addPayment(xeroId, { amountCents: 50_000, date: '2026-10-06' });
    await pullOrgPayments(w.deps, ORG);
    w.clock.advance(60_000);
    w.xero.deletePayment(paymentId);
    await expect(pullOrgPayments(w.deps, ORG)).resolves.toMatchObject({ reversed: 1 });
    expect(payments(w, invoiceId)[0]).toMatchObject({
      reversedAt: at(w.clock.now()),
      reversalReason: 'Deleted in Xero',
    });
    expect(invoice(w, invoiceId)['status']).toBe('issued');
  });

  it('flags a payment recorded here by hand that looks like the same money', async () => {
    const w = xeroWorld();
    const { invoiceId, xeroId } = await synced(w);
    const manual = await recordHere(w, invoiceId, { amountCents: 30_000, date: '2026-10-05' });
    w.xero.addPayment(xeroId, { amountCents: 30_000, date: '2026-10-06' });
    w.xero.addPayment(xeroId, { amountCents: 30_000, date: '2026-10-06' });
    await pullOrgPayments(w.deps, ORG);
    const fromXero = payments(w, invoiceId).filter((payment) => payment['method'] === 'xero');
    expect(fromXero.map((payment) => payment['possibleDuplicateOf'])).toEqual([manual.paymentId, undefined]);
  });

  it('lists a payment it can’t record and tells the owners, once', async () => {
    const w = xeroWorld();
    const { invoiceId, xeroId } = await synced(w);
    await recordHere(w, invoiceId, { amountCents: TOTAL });
    const paymentId = w.xero.addPayment(xeroId, { amountCents: 20_000, date: '2026-10-06' });
    await expect(pullOrgPayments(w.deps, ORG)).resolves.toMatchObject({ unrecorded: 1, recorded: 0 });
    expect(w.xeroOf(invoiceId)?.['unrecordedPayments']).toEqual([
      { id: paymentId, date: '2026-10-06', amountCents: 20_000, reason: expect.any(String) },
    ]);
    expect(w.notifications()).toEqual([
      expect.objectContaining({
        path: `orgs/${ORG}/notifications/xero-payment-${paymentId}`,
        title: 'A Xero payment on invoice INV-000001 wasn’t recorded',
      }),
    ]);
    w.docs.set(STATUS_PATH, { ...w.doc(STATUS_PATH), sync: {} });
    await expect(pullOrgPayments(w.deps, ORG)).resolves.toMatchObject({ unrecorded: 0 });
    expect(w.notifications()).toHaveLength(1);
  });

  it('brings across what Xero already holds when an invoice is sent again', async () => {
    const w = xeroWorld();
    const { invoiceId, xeroId } = await synced(w);
    w.xero.addPayment(xeroId, { amountCents: 25_000, date: '2026-10-06' });
    await w.push({ kind: 'invoice', id: invoiceId });
    expect(payments(w, invoiceId)).toEqual([expect.objectContaining({ method: 'xero', amountCents: 25_000 })]);
  });

  it('ignores payments on invoices Materia didn’t send', async () => {
    const w = xeroWorld();
    const contact = await w.xero.createContact(TENANT, { name: 'Walk-in' }, 'k');
    const other = await w.xero.createInvoice(
      TENANT,
      {
        contactId: contact.id,
        number: 'X-1',
        date: '2026-10-01',
        lineAmountTypes: 'NoTax',
        lines: [{ description: 'Other', quantity: 1, unitAmountCents: 5000, accountCode: '200' }],
      },
      'k',
    );
    w.xero.addPayment(other.id, { amountCents: 5000, date: '2026-10-06' });
    await expect(pullOrgPayments(w.deps, ORG)).resolves.toMatchObject({ payments: 1, recorded: 0 });
  });

  it('runs every org with Xero, skipping ones not set up or needing a reconnect', async () => {
    const w = xeroWorld({ status: 'reconnect_required' });
    w.docs.set('orgs/org-other', { name: 'No Xero Pty Ltd' });
    await expect(pullAllOrgs(w.deps)).resolves.toEqual({
      orgs: 0,
      payments: 0,
      recorded: 0,
      reversed: 0,
      unrecorded: 0,
    });
    expect(w.xero.calls).toEqual([]);

    w.docs.set(STATUS_PATH, { ...w.doc(STATUS_PATH), status: 'connected' });
    w.xero.failNext('payments', new DomainError('RATE_LIMITED', 'Wait', { retryAfterMs: 60_000 }));
    await expect(pullAllOrgs(w.deps)).resolves.toMatchObject({ orgs: 0 });
    expect(w.logs).toContainEqual(expect.objectContaining({ level: 'warn', message: 'xero payments skipped' }));
    await expect(pullAllOrgs(w.deps)).resolves.toMatchObject({ orgs: 1 });
  });
});

describe('xero-onInvoice and xero-onCreditNote', () => {
  const change = (before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined) =>
    ({
      before: before ? { data: () => before } : undefined,
      after: after ? { data: () => after } : undefined,
    }) as unknown as TriggerChange;
  const onInvoice = (w: XeroWorld, invoiceId: string, before: Record<string, unknown> | undefined) =>
    onInvoiceDefinition.handler(change(before, invoice(w, invoiceId)), w.triggerCtx({ invoiceId }));

  it('queues an invoice issued on or after the send-from date, and its void', async () => {
    const w = xeroWorld();
    const invoiceId = await w.issued();
    const issuedInvoice = invoice(w, invoiceId);
    await onInvoice(w, invoiceId, { ...issuedInvoice, status: 'draft' });
    expect(queued(w)).toEqual([
      expect.objectContaining({
        payload: { orgId: ORG, kind: 'invoice', id: invoiceId },
        options: { dedupeKey: `xero-invoice-${invoiceId}-issued` },
      }),
    ]);
    expect(w.xeroOf(invoiceId)).toMatchObject({ status: 'queued', queuedAt: at(w.clock.now()) });

    // A payment changing the status, or the sync's own write, isn't a send.
    await onInvoice(w, invoiceId, { ...issuedInvoice, status: 'part_paid' });
    expect(queued(w)).toHaveLength(1);

    w.docs.set(`orgs/${ORG}/invoices/${invoiceId}`, { ...invoice(w, invoiceId), status: 'void' });
    await onInvoice(w, invoiceId, issuedInvoice);
    expect(queued(w).map((task) => task.options.dedupeKey)).toContain(`xero-invoice-${invoiceId}-void`);
  });

  it('leaves out invoices issued before the send-from date, and does nothing with sending on issue off or Xero off', async () => {
    const cases: Parameters<typeof xeroWorld>[0][] = [
      { settings: { sendFrom: '2026-10-07' as never } },
      { settings: { autoPush: false } },
      { flag: false },
      { settings: null },
      { status: 'disconnected' },
    ];
    for (const options of cases) {
      const w = xeroWorld(options);
      const invoiceId = await w.issued();
      await onInvoice(w, invoiceId, { ...invoice(w, invoiceId), status: 'draft' });
      expect(queued(w)).toEqual([]);
      expect(w.xeroOf(invoiceId)).toBeUndefined();
    }
  });

  it('still voids in Xero an invoice issued before the send-from date that someone sent', async () => {
    const w = xeroWorld({ settings: { sendFrom: '2026-10-07' as never } });
    const invoiceId = await w.issued();
    await w.push({ kind: 'invoice', id: invoiceId });
    const before = invoice(w, invoiceId);
    w.docs.set(`orgs/${ORG}/invoices/${invoiceId}`, { ...before, status: 'void' });
    await onInvoice(w, invoiceId, before);
    expect(queued(w)).toHaveLength(1);
  });

  it('queues a credit note on an invoice that is (or would be) in Xero', async () => {
    const w = xeroWorld();
    const invoiceId = await w.issued();
    const note = await credit(w, invoiceId, { lines: [{ line: 0, amountExGstCents: 10000 }] });
    const data = w.doc(`orgs/${ORG}/creditNotes/${note.creditNoteId}`);
    await onCreditNoteDefinition.handler(change(undefined, data), w.triggerCtx({ creditNoteId: note.creditNoteId }));
    expect(queued(w)).toEqual([
      expect.objectContaining({
        payload: { orgId: ORG, kind: 'creditNote', id: note.creditNoteId },
        options: { dedupeKey: `xero-creditNote-${note.creditNoteId}` },
      }),
    ]);

    const late = xeroWorld({ settings: { sendFrom: '2026-10-07' as never } });
    const lateInvoice = await late.issued();
    const lateNote = await credit(late, lateInvoice, { full: true });
    await onCreditNoteDefinition.handler(
      change(undefined, late.doc(`orgs/${ORG}/creditNotes/${lateNote.creditNoteId}`)),
      late.triggerCtx({ creditNoteId: lateNote.creditNoteId }),
    );
    expect(queued(late)).toEqual([]);
  });
});

describe('xero-options, xero-saveSettings and xero-send', () => {
  it('lists the organisations and the chosen one’s accounts, for owners and admins', async () => {
    const w = xeroWorld({ settings: null });
    await expect(w.call(optionsDefinition as never, {}, 'owner')).resolves.toEqual({
      tenants: [FAKE_XERO_TENANT],
      tenantId: TENANT,
      accounts: w.xero.accountList,
    });
    w.xero.tenantList = [FAKE_XERO_TENANT, { tenantId: 'a8f3b6c1-0000-4000-8000-000000000001', tenantName: 'Other' }];
    await expect(w.call(optionsDefinition as never, {}, 'owner')).resolves.toMatchObject({
      tenantId: null,
      accounts: [],
    });
    await expect(w.call(optionsDefinition as never, {}, 'lawyer')).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('is off while the flag is off', async () => {
    const w = xeroWorld({ flag: false });
    await expect(w.call(optionsDefinition as never, {}, 'owner')).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'FEATURE_DISABLED' }),
    });
    await expect(w.call(sendDefinition as never, { invoiceId: 'x' }, 'owner')).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'FEATURE_DISABLED' }),
    });
  });

  it('saves the organisation and accounts, audits it, and says how many invoices aren’t in Xero yet', async () => {
    const w = xeroWorld({ settings: null });
    await w.issued();
    const input = INPUT;
    await expect(w.call(saveSettingsDefinition as never, { settings: input }, 'owner')).resolves.toEqual({
      saved: true,
      unsent: 1,
    });
    expect(w.doc(`orgs/${ORG}`)?.['xero']).toEqual(SETTINGS);
    const audits = w
      .entries(`orgs/${ORG}/audit/`)
      .filter((entry) => (entry as Record<string, unknown>)['action'] === 'xero.settings_updated');
    expect(audits).toHaveLength(1);
    await expect(w.call(saveSettingsDefinition as never, { settings: input }, 'owner')).resolves.toEqual({
      saved: false,
      unsent: 1,
    });
  });

  it('refuses an organisation the connection doesn’t reach, or an account it doesn’t have', async () => {
    const w = xeroWorld({ settings: null });
    const input = INPUT;
    await expect(
      w.call(
        saveSettingsDefinition as never,
        { settings: { ...input, tenantId: 'a8f3b6c1-0000-4000-8000-000000000001' } },
        'owner',
      ),
    ).rejects.toMatchObject({ details: expect.objectContaining({ code: 'FAILED_PRECONDITION' }) });
    await expect(
      w.call(saveSettingsDefinition as never, { settings: { ...input, disbursementsAccountCode: '999' } }, 'owner'),
    ).rejects.toMatchObject({ message: 'Xero has no active account 999' });
    expect(w.doc(`orgs/${ORG}`)?.['xero']).toBeUndefined();
    await expect(w.call(saveSettingsDefinition as never, { settings: input }, 'lawyer')).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('sends one invoice, or everything unsent (owners and admins only)', async () => {
    const w = xeroWorld();
    const invoiceId = await w.issued();
    await expect(w.call(sendDefinition as never, { invoiceId }, 'lawyer')).resolves.toEqual({ queued: 1 });
    expect(w.xeroOf(invoiceId)).toMatchObject({ status: 'queued' });
    expect(queued(w)).toHaveLength(1);
    await expect(w.call(sendDefinition as never, {}, 'lawyer')).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(w.call(sendDefinition as never, {}, 'owner')).resolves.toEqual({ queued: 1 });
    expect(
      w.entries(`orgs/${ORG}/audit/`).filter((entry) => (entry as Record<string, unknown>)['action'] === 'xero.sent'),
    ).toHaveLength(2);

    await w.push({ kind: 'invoice', id: invoiceId });
    await expect(unsentToXero(w.db as never, ORG, SETTINGS, 200)).resolves.toEqual([]);
  });

  it('won’t send a draft or something that doesn’t exist', async () => {
    const w = xeroWorld();
    const { invoiceId } = await save(w);
    await expect(w.call(sendDefinition as never, { invoiceId }, 'owner')).rejects.toMatchObject({
      message: 'Issue the invoice first',
    });
    await expect(w.call(sendDefinition as never, { invoiceId: 'nope' }, 'owner')).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'NOT_FOUND' }),
    });
  });

  it('turns the flag back off cleanly', async () => {
    const w = xeroWorld();
    const invoiceId = await w.issued();
    w.docs.set(`orgs/${ORG}`, {
      ...w.doc(`orgs/${ORG}`),
      flags: { 'billing.invoicing': true, 'integrations.xero': false },
    });
    clearFlagCaches();
    await w.push({ kind: 'invoice', id: invoiceId });
    expect(w.xeroOf(invoiceId)).toMatchObject({ status: 'failed', error: { code: 'not_connected' } });
    expect(w.xero.calls).toEqual([]);
  });
});
