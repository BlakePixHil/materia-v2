import type { Role } from '@materia/domain';

import { createCreditNoteDefinition } from './credit-notes';
import { deleteDraftDefinition, saveDraftDefinition } from './drafts';
import { onPdfJobDefinition, recordPdfOutcome, retryPdfDefinition } from './invoice-pdf';
import { sendDefinition, setInvoiceFiles } from './send';
import { invoice, issue, M, meta, ORG, PDF, save, time, world, type World } from './testing';
import { voidDefinition } from './void';
import type { TriggerChange } from '../core/trigger';
import { budgetOnCreditNoteDefinition } from '../fees/triggers';
import { MailError } from '../ports';
import { FakeJobRunner, FakeMail } from '../ports/fakes';

/** Unit tests for invoicing (BILL-07). Every firm, client, matter and amount is fictional. */

describe('billing-saveDraft', () => {
  it('builds a pre-bill from final, billable time and unbilled disbursements', async () => {
    const w = world();
    const { invoiceId, totalCents, warnings } = await save(w);
    expect(totalCents).toBe(44000 + 4400 + 13200 + 1320 + 33310);
    expect(warnings).toEqual(['unapproved_time']);
    expect(invoice(w, invoiceId)).toMatchObject({
      number: '',
      status: 'draft',
      matterId: 'm1',
      matterNumber: 'M-2026-0042',
      paymentTermsDays: 14,
      timeEntryIds: ['t1', 't2'],
      disbursementIds: ['d1'],
      gstRegistered: true,
      createdBy: 'user-lawyer',
    });
    expect((invoice(w, invoiceId)['lines'] as { by?: string }[])[0]?.by).toBe('Pat Lawyer');
  });

  it('saves the choices again, rebuilding the lines', async () => {
    const w = world();
    const { invoiceId } = await save(w);
    const saved = await save(
      w,
      {
        excludedTimeEntryIds: ['t2'],
        grouping: 'summary',
        extraLines: [{ kind: 'adjustment', description: 'Courtesy discount', amountExGstCents: -4000 }],
        notes: 'Thank you for your instructions.',
        paymentTermsDays: 7,
      },
      invoiceId,
    );
    expect(saved.invoiceId).toBe(invoiceId);
    expect(invoice(w, invoiceId)).toMatchObject({
      grouping: 'summary',
      timeEntryIds: ['t1'],
      paymentTermsDays: 7,
      notes: 'Thank you for your instructions.',
      itemisation: [expect.objectContaining({ refId: 't1' })],
    });
    expect(invoice(w, invoiceId)['createdAt']).toBeDefined();
  });

  it('is refused on an issued invoice, another matter, and while the flag is off', async () => {
    const w = world();
    const { invoiceId } = await save(w);
    await issue(w, invoiceId);
    await expect(save(w, {}, invoiceId)).rejects.toMatchObject({ code: 'failed-precondition' });
    const other = world({ [`orgs/${ORG}/invoices/x`]: { ...meta, matterId: 'm2', status: 'draft' } });
    await expect(save(other, {}, 'x')).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(save(world({}, false))).rejects.toMatchObject({ code: 'failed-precondition' });
    await expect(w.call(saveDraftDefinition as never, { matterId: 'm1' }, 'paralegal')).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });
});

describe('billing-deleteDraft', () => {
  it('deletes a pre-bill but never an issued invoice', async () => {
    const w = world();
    const a = await save(w);
    expect(await w.call(deleteDraftDefinition as never, { invoiceId: a.invoiceId })).toEqual({ deleted: true });
    expect(w.doc(`orgs/${ORG}/invoices/${a.invoiceId}`)).toBeUndefined();
    expect(await w.call(deleteDraftDefinition as never, { invoiceId: a.invoiceId })).toEqual({ deleted: false });
    const b = await save(w);
    await issue(w, b.invoiceId);
    await expect(w.call(deleteDraftDefinition as never, { invoiceId: b.invoiceId })).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });
});

describe('billing-issueInvoice', () => {
  it('numbers and freezes the invoice, bills its items and starts the PDF', async () => {
    const w = world();
    const { invoiceId } = await save(w);
    const result = await issue(w, invoiceId);
    expect(result).toMatchObject({ number: 'INV-000001' });
    expect(invoice(w, invoiceId)).toMatchObject({
      number: 'INV-000001',
      status: 'issued',
      issueDate: '2026-10-06',
      dueDate: '2026-10-20',
      supplier: { name: 'Harbour & Vine Legal', abn: '12345678901' },
      buyer: { name: 'Lan Nguyễn', address: '1 Fictional St, Geelong VIC 3220' },
      issuedBy: 'user-lawyer',
      pdfStatus: 'pending',
      pdfJobId: expect.any(String),
    });
    for (const id of ['t1', 't2'])
      expect(w.doc(`${M}/timeEntries/${id}`)).toMatchObject({ status: 'billed', invoiceId });
    expect(w.doc(`${M}/timeEntries/draft`)).toMatchObject({ status: 'draft' });
    expect(w.doc(`${M}/disbursements/d1`)).toMatchObject({ status: 'billed', invoiceId });
    expect(w.doc(M)).toMatchObject({ lastInvoicedOn: '2026-10-06' });
    expect(w.doc(`orgs/${ORG}/counters/invoice`)).toMatchObject({ next: 2 });
    expect(w.entries(`orgs/${ORG}/audit/`).map((a) => (a as Record<string, unknown>)['action'])).toContain(
      'invoice.issued',
    );
    const job = w.doc(`orgs/${ORG}/jobs/${String(invoice(w, invoiceId)['pdfJobId'])}`);
    expect(job).toMatchObject({
      type: 'pdf.render',
      input: {
        templateId: 'invoice',
        data: expect.objectContaining({ title: 'Tax invoice', documentRef: `invoices/${invoiceId}` }),
      },
      target: { kind: 'matter', matterId: 'm1', name: 'Tax invoice INV-000001', category: 'financial' },
    });
    expect((w.ports.jobs as FakeJobRunner).started).toHaveLength(1);
  });

  it('is idempotent and gapless across invoices', async () => {
    const w = world();
    const a = await save(w);
    expect((await issue(w, a.invoiceId)).number).toBe('INV-000001');
    expect((await issue(w, a.invoiceId)).number).toBe('INV-000001');
    const b = await save(w, { extraLines: [{ kind: 'fixed_fee', description: 'Fixed fee', amountExGstCents: 1000 }] });
    expect((await issue(w, b.invoiceId)).number).toBe('INV-000002');
  });

  it('refuses a pre-bill that changed since it was saved, without using a number', async () => {
    const w = world();
    const { invoiceId } = await save(w);
    w.docs.set(`${M}/timeEntries/t1`, { ...w.doc(`${M}/timeEntries/t1`), amountCents: 30000 });
    await expect(issue(w, invoiceId)).rejects.toMatchObject({
      code: 'failed-precondition',
      details: expect.objectContaining({ reason: 'stale_draft', changed: ['t1'] }),
    });
    expect(w.doc(`orgs/${ORG}/counters/invoice`)).toBeUndefined();
    expect(invoice(w, invoiceId)['status']).toBe('draft');
    await save(w, {}, invoiceId);
    expect((await issue(w, invoiceId)).number).toBe('INV-000001');
  });

  it('refuses an empty pre-bill, a void invoice, and paralegals', async () => {
    const w = world({ [`${M}/timeEntries/t1`]: time(1, { status: 'billed' }) });
    const { invoiceId } = await save(w, { excludedTimeEntryIds: ['t2'], excludedDisbursementIds: ['d1'] });
    await expect(issue(w, invoiceId)).rejects.toMatchObject({ code: 'failed-precondition' });
    w.docs.set(`orgs/${ORG}/invoices/v`, { ...meta, matterId: 'm1', status: 'void', number: 'INV-000009' });
    await expect(issue(w, 'v')).rejects.toMatchObject({ code: 'failed-precondition' });
    await expect(issue(w, invoiceId, 'paralegal')).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('leaves the invoice issued with a failed PDF when the render can’t start, and retries it', async () => {
    const w = world();
    const runner = w.ports.jobs as FakeJobRunner;
    const start = runner.start.bind(runner);
    runner.start = async () => {
      throw new Error('Cloud Run down');
    };
    const { invoiceId } = await save(w);
    await issue(w, invoiceId);
    expect(invoice(w, invoiceId)).toMatchObject({ status: 'issued', pdfStatus: 'failed' });
    runner.start = start;
    const { jobId } = (await w.call(retryPdfDefinition as never, { invoiceId })) as { jobId: string };
    expect(invoice(w, invoiceId)).toMatchObject({ pdfStatus: 'pending', pdfJobId: jobId });
    await expect(w.call(retryPdfDefinition as never, { invoiceId })).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });
});

describe('billing-onPdfJob', () => {
  const change = (before: Record<string, unknown> | undefined, after: Record<string, unknown>) =>
    ({
      before: before ? { data: () => before } : undefined,
      after: { data: () => after },
    }) as unknown as TriggerChange;

  it('records a finished render on its invoice, and ignores others', async () => {
    const w = world();
    const { invoiceId } = await save(w);
    await issue(w, invoiceId);
    const jobId = String(invoice(w, invoiceId)['pdfJobId']);
    const job = w.doc(`orgs/${ORG}/jobs/${jobId}`) as Record<string, unknown>;
    const ctx = w.triggerCtx({ jobId });
    expect(onPdfJobDefinition).toMatchObject({ name: 'billing-onPdfJob', document: 'orgs/{orgId}/jobs/{jobId}' });
    // Progress, another template, and a stale job change nothing.
    expect(await recordPdfOutcome(change(job, { ...job, status: 'running' }), ctx)).toBeNull();
    expect(
      await recordPdfOutcome(change(job, { ...job, status: 'succeeded', input: { templateId: 'other' } }), ctx),
    ).toBeNull();
    expect(
      await recordPdfOutcome(change(job, { ...job, status: 'failed' }), w.triggerCtx({ jobId: 'older-job' })),
    ).toBeNull();
    expect(
      await recordPdfOutcome(change(job, { ...job, status: 'succeeded', output: { documentId: `job-${jobId}` } }), ctx),
    ).toBe('ready');
    expect(invoice(w, invoiceId)).toMatchObject({ pdfStatus: 'ready', pdfDocumentId: `job-${jobId}` });
    expect(await recordPdfOutcome(change(job, { ...job, status: 'failed' }), ctx)).toBe('failed');
    expect(invoice(w, invoiceId)['pdfStatus']).toBe('failed');
  });
});

describe('billing-voidInvoice', () => {
  it('voids an unpaid invoice, keeping its number and returning its items to WIP', async () => {
    const w = world();
    const first = await save(w);
    await issue(w, first.invoiceId);
    const { invoiceId } = await save(w, {
      extraLines: [{ kind: 'fixed_fee', description: 'Fixed fee', amountExGstCents: 1000 }],
    });
    w.clock.set(new Date('2026-10-08T00:00:00Z'));
    await issue(w, invoiceId);
    // Void the first: its items come back; the matter's last invoice is now the second.
    const result = (await w.call(
      voidDefinition as never,
      { invoiceId: first.invoiceId, reason: 'Wrong client' },
      'owner',
    )) as {
      released: number;
    };
    expect(result.released).toBe(3);
    expect(invoice(w, first.invoiceId)).toMatchObject({
      status: 'void',
      number: 'INV-000001',
      voidReason: 'Wrong client',
      voidedBy: 'user-owner',
    });
    expect(w.doc(`${M}/timeEntries/t1`)).toMatchObject({ status: 'final' });
    expect(w.doc(`${M}/timeEntries/t1`)).not.toHaveProperty('invoiceId');
    expect(w.doc(`${M}/disbursements/d1`)).toMatchObject({ status: 'unbilled' });
    expect(w.doc(M)).toMatchObject({ lastInvoicedOn: '2026-10-08' });
    expect(w.entries(`orgs/${ORG}/audit/`).map((a) => (a as Record<string, unknown>)['action'])).toContain(
      'invoice.voided',
    );
    // Idempotent; the counter isn't touched.
    await w.call(voidDefinition as never, { invoiceId: first.invoiceId, reason: 'Again' }, 'owner');
    expect(w.doc(`orgs/${ORG}/counters/invoice`)).toMatchObject({ next: 3 });
  });

  it('refuses pre-bills, paid or credited invoices, and lawyers', async () => {
    const w = world();
    const { invoiceId } = await save(w);
    const voidIt = (role: Role = 'owner') => w.call(voidDefinition as never, { invoiceId, reason: 'x' }, role);
    await expect(voidIt()).rejects.toMatchObject({ code: 'failed-precondition' });
    await issue(w, invoiceId);
    await expect(voidIt('lawyer')).rejects.toMatchObject({ code: 'permission-denied' });
    w.docs.set(`orgs/${ORG}/invoices/${invoiceId}`, { ...invoice(w, invoiceId), creditedCents: 100 });
    await expect(voidIt()).rejects.toMatchObject({ code: 'failed-precondition' });
    w.docs.set(`orgs/${ORG}/invoices/${invoiceId}`, {
      ...invoice(w, invoiceId),
      creditedCents: 0,
      status: 'part_paid',
      payments: [{ id: 'p1' }],
    });
    await expect(voidIt()).rejects.toMatchObject({ code: 'failed-precondition' });
  });
});

describe('billing-createCreditNote', () => {
  it('credits part of an invoice, then the rest, with its own CN- sequence', async () => {
    const w = world();
    const { invoiceId } = await save(w);
    await issue(w, invoiceId);
    const credit = (data: Record<string, unknown>) =>
      w.call(createCreditNoteDefinition as never, { invoiceId, reason: 'Fee reduced', ...data }, 'owner') as Promise<{
        creditNoteId: string;
        number: string;
        totalCents: number;
      }>;
    const first = await credit({ lines: [{ line: 0, amountExGstCents: 10000 }] });
    expect(first).toMatchObject({ number: 'CN-000001', totalCents: 11000 });
    expect(w.doc(`orgs/${ORG}/creditNotes/${first.creditNoteId}`)).toMatchObject({
      invoiceId,
      invoiceNumber: 'INV-000001',
      matterId: 'm1',
      issueDate: '2026-10-06',
      full: false,
      subtotalCents: 10000,
      gstCents: 1000,
      supplier: { name: 'Harbour & Vine Legal' },
      pdfStatus: 'pending',
    });
    expect(invoice(w, invoiceId)).toMatchObject({ creditNoteIds: [first.creditNoteId], creditedCents: 11000 });
    const rest = await credit({ full: true });
    expect(rest.number).toBe('CN-000002');
    const total = Number(invoice(w, invoiceId)['totalCents']);
    expect(invoice(w, invoiceId)['creditedCents']).toBe(total);
    await expect(credit({ full: true })).rejects.toMatchObject({ code: 'failed-precondition' });
    // The billed work stays billed.
    expect(w.doc(`${M}/timeEntries/t1`)).toMatchObject({ status: 'billed' });
    expect(
      w.entries(`orgs/${ORG}/audit/`).filter((a) => (a as Record<string, unknown>)['action'] === 'invoice.credited'),
    ).toHaveLength(2);
  });

  it('refuses pre-bills and void invoices', async () => {
    const w = world();
    const { invoiceId } = await save(w);
    await expect(
      w.call(createCreditNoteDefinition as never, { invoiceId, reason: 'x', full: true }, 'owner'),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('lowers what the matter has billed in its budget', async () => {
    const w = world();
    const { invoiceId } = await save(w);
    await issue(w, invoiceId);
    await w.call(
      createCreditNoteDefinition as never,
      { invoiceId, reason: 'x', lines: [{ line: 0, amountExGstCents: 4000 }] },
      'owner',
    );
    const note = w.entries(`orgs/${ORG}/creditNotes/`)[0] as Record<string, unknown>;
    await budgetOnCreditNoteDefinition.handler(
      { before: undefined, after: { get: (key: string) => note[key] } } as unknown as TriggerChange,
      w.triggerCtx({ creditNoteId: 'x' }),
    );
    expect(w.doc(M)?.['budget']).toMatchObject({ billedCents: 44000 + 13200 + 33310 - 4000 });
  });
});

describe('billing-sendInvoice', () => {
  afterEach(() => setInvoiceFiles());

  async function readyInvoice(w: World) {
    const { invoiceId } = await save(w);
    await issue(w, invoiceId);
    w.docs.set(`${M}/documents/job-1`, { ...meta, storagePath: `${M}/documents/job-1/v1`, version: 1 });
    w.docs.set(`orgs/${ORG}/invoices/${invoiceId}`, {
      ...invoice(w, invoiceId),
      pdfStatus: 'ready',
      pdfDocumentId: 'job-1',
    });
    setInvoiceFiles(
      () => ({ read: async (path: string) => (path.endsWith('job-1/v1') ? Buffer.from(PDF) : null) }) as never,
    );
    return invoiceId;
  }

  it('emails the PDF as an attachment and records who it went to', async () => {
    const w = world();
    const invoiceId = await readyInvoice(w);
    const result = await w.call(sendDefinition as never, {
      invoiceId,
      to: ['lan@example.com', 'Executor@Example.com'],
      message: 'Dear Lan, please find our invoice attached.',
    });
    expect(result).toEqual({ sent: 2 });
    const sent = (w.ports.mail as FakeMail).sent;
    expect(sent.map((m) => m.to)).toEqual(['lan@example.com', 'executor@example.com']);
    expect(sent[0]).toMatchObject({
      template: 'invoice',
      model: {
        documentTitle: 'Tax invoice',
        number: 'INV-000001',
        firmName: 'Harbour & Vine Legal',
        firmAbn: '12 345 678 901',
        dueLabel: '20 Oct 2026',
        message: 'Dear Lan, please find our invoice attached.',
      },
      attachments: [{ name: 'Tax invoice INV-000001.pdf', contentType: 'application/pdf' }],
    });
    expect(invoice(w, invoiceId)).toMatchObject({
      sentBy: 'user-lawyer',
      sentTo: ['lan@example.com', 'executor@example.com'],
    });
    expect(
      w.entries(`orgs/${ORG}/audit/`).find((a) => (a as Record<string, unknown>)['action'] === 'invoice.sent'),
    ).toMatchObject({
      data: { number: 'INV-000001', recipients: 2 },
    });
  });

  it('needs an issued invoice with its PDF ready', async () => {
    const w = world();
    const { invoiceId } = await save(w);
    const send = () => w.call(sendDefinition as never, { invoiceId, to: ['lan@example.com'] });
    await expect(send()).rejects.toMatchObject({ code: 'failed-precondition' });
    await issue(w, invoiceId);
    await expect(send()).rejects.toMatchObject({ code: 'failed-precondition', message: 'The PDF isn’t ready yet' });
  });

  it('says why mail failed, recording what did go', async () => {
    const w = world();
    const invoiceId = await readyInvoice(w);
    let calls = 0;
    (w.ports.mail as FakeMail).send = async () => {
      calls++;
      if (calls > 1) throw new MailError('not_configured');
      return { id: 'm1' };
    };
    await expect(
      w.call(sendDefinition as never, { invoiceId, to: ['a@example.com', 'b@example.com'] }),
    ).rejects.toMatchObject({ code: 'failed-precondition', details: { sent: 1 } });
    expect(invoice(w, invoiceId)['sentTo']).toEqual(['a@example.com']);
  });
});
