import { TestBed } from '@angular/core/testing';

import {
  buildInvoice,
  type InvoiceLine,
  planWriteDown,
  type WriteDownChange,
  XERO_SYNC_ERROR_COPY,
  xeroDocumentUrl,
} from '@materia/domain';

import { extraLinesFrom, invoiceSourcesFrom } from './invoices-view';
import { DOWNLOAD_NAVIGATOR } from '../documents/document-actions';
import { PDFJS_LOADER } from '../documents/pdf-viewer';
import { fakePdfJs } from '../documents/testing';
import { ADMIN, cleanUpOverlays, MATTER, ME, meta, openMatter, PARALEGAL, PRIYA } from '../matter-detail/testing';

/**
 * BILL-07 and BILL-08: pre-bills, invoices, credit notes, a matter's bills, payments and aged debtors;
 * BILL-09: where an invoice stands in Xero. Fictional data only.
 */

afterEach(cleanUpOverlays);

const ORG = 'org-harbour-vine';
const ON = { 'billing.invoicing': true };
type Seed = Record<string, unknown>;
type Page = Awaited<ReturnType<typeof openMatter>>;
const INVOICES = `orgs/${ORG}/invoices`;

function entry(data: Seed = {}): Seed {
  return {
    orgId: ORG,
    matterId: 'm-whitfield',
    uid: ME,
    date: '2026-10-01',
    minutes: 60,
    units: 10,
    rateCents: 44_000,
    amountCents: 44_000,
    narrative: 'Perusing and considering the will',
    billable: true,
    status: 'final',
    source: 'manual',
    wipCountedCents: 44_000,
    deletedAt: null,
    ...meta,
    ...data,
  };
}

const line = (data: Partial<Record<keyof InvoiceLine, unknown>>): InvoiceLine =>
  ({ kind: 'time', description: 'Work', quantity: 1, amountExGstCents: 0, gstCents: 0, ...data }) as InvoiceLine;

function issued(data: Seed = {}): Seed {
  return {
    number: 'INV-000007',
    matterId: 'm-whitfield',
    matterNumber: 'M-2026-0142',
    matterTitle: 'Estate of Margaret Whitfield',
    grouping: 'itemised',
    excludedTimeEntryIds: [],
    excludedDisbursementIds: [],
    extraLines: [],
    timeEntryIds: ['te-a'],
    disbursementIds: [],
    notes: '',
    paymentTermsDays: 14,
    issueDate: '2026-10-02',
    dueDate: '2026-10-16',
    lines: [line({ refId: 'te-a', description: 'Perusing the will', amountExGstCents: 44_000, gstCents: 4_400 })],
    subtotalCents: 44_000,
    gstCents: 4_400,
    totalCents: 48_400,
    gstRegistered: true,
    supplier: { name: 'Harbour & Vine Legal', abn: '51824753556' },
    buyer: { name: 'Avery Quill' },
    status: 'issued',
    issuedAt: new Date('2026-10-02T00:00:00Z'),
    issuedBy: ME,
    pdfStatus: 'ready',
    pdfJobId: 'job-1',
    pdfDocumentId: 'job-job-1',
    creditNoteIds: [],
    creditedCents: 0,
    payments: [],
    ...meta,
    ...data,
  };
}

/** An aged-debtors report (BILL-08): two matters for one client and one for another. */
function debtorsDoc(asOf: string): Seed {
  const row = (
    matterId: string,
    matterNumber: string,
    clientName: string,
    buckets: Seed,
    totalCents: number,
    lawyerUid = ME,
  ) => ({
    matterId,
    matterNumber,
    matterTitle: `Estate of ${matterNumber}`,
    clientName,
    lawyerUid,
    invoices: 1,
    buckets: { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, ...buckets },
    totalCents,
    oldestDueDate: '2026-08-01',
  });
  return {
    period: `debtors-${asOf}`,
    values: { total: 78_400 },
    debtors: {
      asOf,
      truncated: false,
      rows: [
        row('m-whitfield', 'M-2026-0142', 'Avery Quill', { d31_60: 28_400 }, 28_400),
        row('m-other', 'M-2026-0150', 'Avery Quill', { current: 20_000 }, 20_000, PRIYA),
        row('m-third', 'M-2026-0151', 'Bram Ostler', { d90_plus: 30_000 }, 30_000, PRIYA),
      ],
    },
    ...meta,
  };
}

/** The org, two final entries and a draft on the matter, and a disbursement. */
function practice(fs: Page['firestore'], emails: string[] = ['avery@example.test']): void {
  fs.set(`orgs/${ORG}`, {
    name: 'Harbour & Vine Legal',
    timezone: 'Australia/Melbourne',
    billing: { unitMinutes: 6, rounding: 'up', defaultRateCents: 30_000, gstRegistered: true, paymentTermsDays: 14 },
  });
  const avery = fs.get(`orgs/${ORG}/contacts/c-avery`) as Seed;
  fs.set(`orgs/${ORG}/contacts/c-avery`, {
    ...avery,
    emails: emails.map((address) => ({ type: 'personal', address })),
  });
  fs.set(`${MATTER}/timeEntries/te-a`, entry());
  fs.set(
    `${MATTER}/timeEntries/te-b`,
    entry({ date: '2026-10-02', units: 5, minutes: 30, amountCents: 22_000, narrative: 'Letter to the executor' }),
  );
  fs.set(`${MATTER}/timeEntries/te-c`, entry({ date: '2026-10-03', status: 'draft', narrative: 'Call with bank' }));
  fs.set(`${MATTER}/disbursements/d-1`, {
    orgId: ORG,
    matterId: 'm-whitfield',
    date: '2026-10-01',
    description: 'Title search',
    payee: 'Fictional Titles Office',
    category: 'search',
    amountExGstCents: 3_000,
    gstCents: 300,
    amountIncGstCents: null,
    gstTreatment: 'taxable',
    receiptDocumentId: null,
    status: 'unbilled',
    wipCountedCents: 3_000,
    deletedAt: null,
    ...meta,
  });
}

/** The `billing-*` callables as the server runs them, without the transaction. */
function billingCallables(): Record<string, (data: Seed, fs: Page['firestore']) => unknown> {
  return {
    'billing-saveDraft': (data, fs) => {
      const id = String(data['invoiceId'] ?? 'inv-new');
      const path = `${INVOICES}/${id}`;
      const fields = data['fields'] as Seed;
      fs.set(path, {
        number: '',
        matterId: data['matterId'],
        grouping: 'itemised',
        excludedTimeEntryIds: [],
        excludedDisbursementIds: [],
        extraLines: [],
        timeEntryIds: [],
        disbursementIds: [],
        notes: '',
        paymentTermsDays: 14,
        lines: [],
        subtotalCents: 0,
        gstCents: 0,
        totalCents: 0,
        status: 'draft',
        creditNoteIds: [],
        creditedCents: 0,
        payments: [],
        ...meta,
        ...(fs.get(path) ?? {}),
        ...fields,
      });
      return { invoiceId: id, totalCents: 0, warnings: [] };
    },
    'billing-issueInvoice': (data, fs) => {
      const path = `${INVOICES}/${String(data['invoiceId'])}`;
      fs.set(path, {
        ...issued({ pdfStatus: 'pending', pdfDocumentId: undefined }),
        ...(fs.get(path) ?? {}),
        number: 'INV-000001',
        status: 'issued',
        pdfStatus: 'pending',
      });
      return { invoiceId: data['invoiceId'], number: 'INV-000001', totalCents: 0 };
    },
    'billing-sendInvoice': (data) => ({ sent: (data['to'] as string[]).length }),
    'billing-voidInvoice': (data, fs) => {
      const path = `${INVOICES}/${String(data['invoiceId'])}`;
      fs.set(path, { ...fs.get(path), status: 'void', voidReason: data['reason'] });
      return { invoiceId: data['invoiceId'], released: 1 };
    },
    'billing-createCreditNote': () => ({ creditNoteId: 'cn-1', number: 'CN-000001', totalCents: 48_400 }),
    'billing-retryPdf': () => ({ jobId: 'job-2' }),
    'billing-deleteDraft': () => ({ deleted: true }),
    'billing-recordPayment': (data) => ({
      paymentId: 'p-new',
      status: 'part_paid',
      owingCents: 48_400 - Number(data['amountCents']),
      warnings: [],
    }),
    'billing-reversePayment': () => ({ reversed: true, status: 'issued', owingCents: 48_400 }),
    'billing-refreshDebtors': (_data, fs) => {
      fs.set(`orgs/${ORG}/metrics/debtors-2026-10-04`, debtorsDoc('2026-10-04'));
      return { asOf: '2026-10-04', invoices: 2, totalCents: 78_400 };
    },
    'billing-sendReminder': (data) => ({ sent: (data['to'] as string[]).length }),
    'time-writeDown': (data, fs) => {
      const updated: string[] = [];
      for (const id of data['entryIds'] as string[]) {
        const path = `${MATTER}/timeEntries/${id}`;
        const entry = fs.get(path) as (Seed & Parameters<typeof planWriteDown>[0]) | undefined;
        const change = (data['writeOff'] ? { writeOff: true } : { newUnits: data['newUnits'] }) as WriteDownChange;
        const { plan } = entry
          ? planWriteDown(entry, change, { by: ME, reason: String(data['reason']), unitMinutes: 6 })
          : {};
        if (!plan) continue;
        fs.set(path, { ...entry, ...plan, updatedAt: new Date('2026-10-04T01:00:00Z') });
        updated.push(id);
      }
      return { updated, skipped: [], conflicts: [] };
    },
    'billing-dismissReminder': () => ({ dismissed: true }),
    'billing-setPaidFromTrust': (data, fs) => {
      const path = `${INVOICES}/${String(data['invoiceId'])}`;
      fs.set(path, { ...fs.get(path), paidFromTrust: data['paidFromTrust'] });
      return { paidFromTrust: data['paidFromTrust'], pdfRendering: false };
    },
    'documents-getDownloadUrl': (data) => ({
      url: `https://files.example.test/${String(data['docId'])}.pdf`,
      expiresAt: '2026-10-04T00:05:00Z',
      fileName: 'Tax invoice INV-000007.pdf',
      version: 1,
    }),
  };
}

async function open(url: string, options: Parameters<typeof openMatter>[1] & { emails?: string[] } = {}) {
  const pdf = fakePdfJs({ pages: 1 });
  const downloads: string[] = [];
  const { emails, configure, ...rest } = options;
  const page = await openMatter(url, {
    flags: ON,
    callables: billingCallables(),
    ...rest,
    configure: (fs, port) => {
      practice(fs, emails);
      configure?.(fs, port);
    },
    providers: [
      { provide: PDFJS_LOADER, useValue: pdf.load },
      { provide: DOWNLOAD_NAVIGATOR, useValue: (href: string) => downloads.push(href) },
    ],
  });
  for (let i = 0; i < 4; i++) await page.stable(5);
  return { ...page, pdf, downloads };
}

/** A callable's calls without their generated request ids. */
const callsOf = (page: Page, name: string) =>
  page.calls(name).map((data) => Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'requestId')));

const byTestId = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('invoice view helpers', () => {
  it('turns fixed fees and discounts into lines, a discount negative', () => {
    expect(
      extraLinesFrom([
        { kind: 'fixed_fee', description: 'Grant of probate', amount: '2,200', gstFree: false },
        { kind: 'discount', description: 'Courtesy discount', amount: '$100.50', gstFree: false },
      ]),
    ).toEqual({
      lines: [
        { kind: 'fixed_fee', description: 'Grant of probate', amountExGstCents: 220_000 },
        { kind: 'adjustment', description: 'Courtesy discount', amountExGstCents: -10_050 },
      ],
      error: null,
    });
    expect(extraLinesFrom([{ kind: 'discount', description: '', amount: '5', gstFree: false }]).error).toBe(
      'Describe each discount.',
    );
    expect(extraLinesFrom([{ kind: 'fixed_fee', description: 'Fee', amount: 'lots', gstFree: false }]).error).toBe(
      'Enter an amount in dollars for “Fee”.',
    );
  });

  it('counts fees billed on live invoices, less their credit notes, against the cap', () => {
    const invoices = [
      { id: 'i1', status: 'issued', lines: [line({ amountExGstCents: 100_000 })] },
      { id: 'i2', status: 'void', lines: [line({ amountExGstCents: 50_000 })] },
      { id: 'i3', status: 'draft', lines: [line({ amountExGstCents: 70_000 })] },
    ];
    const creditNotes = [{ invoiceId: 'i1', lines: [line({ amountExGstCents: 20_000 })] }];
    const sources = invoiceSourcesFrom({
      org: { billing: { gstRegistered: false } } as never,
      matter: { fee: { arrangement: 'capped', capCents: 100_000 } } as never,
      entries: [entry({ id: 'te-a' }) as never],
      disbursements: [],
      invoices: invoices as never,
      creditNotes: creditNotes as never,
      people: {},
    });
    expect(sources.billedFeesCents).toBe(80_000);
    expect(sources.gstRegistered).toBe(false);
    // $800 of the $1,000 cap is used, so $440 of time is capped to $200.
    expect(buildInvoice({ paymentTermsDays: 14 }, sources).totalCents).toBe(20_000);
  });
});

describe('a matter’s bills', () => {
  const bills = () => byTestId('matter-bills');

  it('stays hidden while billing.invoicing is off', async () => {
    await open('/matters/m-whitfield/time', { flags: {} });
    expect(bills()).toBeNull();
  });

  it('is hidden from roles without billing.view', async () => {
    await open('/matters/m-whitfield/time', { session: PARALEGAL });
    expect(bills()).toBeNull();
  });

  it('starts a pre-bill and opens it', async () => {
    const page = await open('/matters/m-whitfield/time');
    expect(page.text(bills())).toContain('No bills yet');
    await page.click('New pre-bill', bills() as HTMLElement);
    for (let i = 0; i < 4; i++) await page.stable(5);
    expect(callsOf(page, 'billing-saveDraft')).toEqual([{ matterId: 'm-whitfield', fields: {} }]);
    expect(page.router.url).toBe('/billing/invoices/inv-new');
    expect(byTestId('pre-bill-preview')).not.toBeNull();
  });

  it('lists its invoices and opens the pre-bill in progress', async () => {
    const page = await open('/matters/m-whitfield/time', {
      configure: (fs) => {
        fs.set(`${INVOICES}/inv-1`, issued());
        billingCallables()['billing-saveDraft']?.({ invoiceId: 'inv-draft', matterId: 'm-whitfield', fields: {} }, fs);
      },
    });
    expect(page.text(bills())).toContain('INV-000007');
    expect(page.text(bills())).toContain('$484.00 owing');
    await page.click('Open pre-bill', bills() as HTMLElement);
    expect(page.router.url).toBe('/billing/invoices/inv-draft');
    expect(callsOf(page, 'billing-saveDraft')).toEqual([]);
  });
});

describe('a pre-bill', () => {
  const openDraft = (options: Parameters<typeof open>[1] = {}) =>
    open('/billing/invoices/inv-draft', {
      ...options,
      configure: (fs) =>
        billingCallables()['billing-saveDraft']?.({ invoiceId: 'inv-draft', matterId: 'm-whitfield', fields: {} }, fs),
    });

  it('previews the lines and totals live, and leaves out what’s unticked', async () => {
    const page = await openDraft();
    expect(page.text(byTestId('pre-bill-matter'))).toBe('M-2026-0142 · Estate of Margaret Whitfield');
    const preview = byTestId('pre-bill-preview');
    expect(page.text(preview)).toContain('Tax invoice');
    expect(page.text(preview)).toContain('Perusing and considering the will');
    expect(page.text(preview)).toContain('Title search');
    // $440 + $220 + $30 ex GST, GST on each line.
    expect(page.text(byTestId('pre-bill-total'))).toBe('$759.00');
    // The draft entry isn't billable yet.
    expect(page.text(document.body)).toContain('1 entry in these dates isn’t approved yet');

    const letter = [...(byTestId('pre-bill-time')?.querySelectorAll('mt-checkbox') ?? [])].find((box) =>
      box.textContent?.includes('Letter to the executor'),
    );
    letter?.querySelector<HTMLInputElement>('input, button, [role="checkbox"]')?.click();
    await page.stable();
    expect(page.text(byTestId('pre-bill-total'))).toBe('$517.00');
  });

  it('keeps unsaved changes when the same pre-bill arrives again', async () => {
    const page = await openDraft();
    const letter = [...(byTestId('pre-bill-time')?.querySelectorAll('mt-checkbox') ?? [])].find((box) =>
      box.textContent?.includes('Letter to the executor'),
    );
    letter?.querySelector<HTMLElement>('[role="checkbox"]')?.click();
    await page.click('Add fixed fee');
    await page.fill('Fixed fee', 'Grant of probate application');
    await page.fill('Amount ex GST', '1000');
    // ($690 − $220 + $1,000) + 10% GST.
    expect(page.text(byTestId('pre-bill-total'))).toBe('$1,617.00');

    // Another snapshot of the same pre-bill (here the PDF bookkeeping; in the browser also the server
    // confirming a cached copy) is a new object with the same id.
    const path = `${INVOICES}/inv-draft`;
    page.firestore.set(path, { ...page.firestore.get(path), pdfAttempts: 0 });
    await page.stable();
    expect(page.text(byTestId('pre-bill-total'))).toBe('$1,617.00');
    expect(page.text(byTestId('pre-bill-preview'))).toContain('Grant of probate application');
  });

  it('marks the pre-bill changed since it was saved', async () => {
    await openDraft();
    // Saved with no lines, so everything now billable is new.
    expect(byTestId('pre-bill-changed')).not.toBeNull();
    expect(byTestId('pre-bill-time')?.textContent).toContain('New');
  });

  it('adds a fixed fee and a discount to the preview', async () => {
    const page = await openDraft();
    await page.click('Add fixed fee');
    await page.fill('Fixed fee', 'Grant of probate application');
    await page.fill('Amount ex GST', '1000');
    await page.click('Add discount');
    const descriptions = [...document.body.querySelectorAll('mt-text-field')].filter((field) =>
      field.querySelector('.mt-label')?.textContent?.trim().startsWith('Discount'),
    );
    const discount = descriptions[0]?.querySelector('input') as HTMLInputElement;
    discount.value = 'Courtesy discount';
    discount.dispatchEvent(new Event('input'));
    const amounts = [...document.body.querySelectorAll('mt-text-field')].filter((field) =>
      field.querySelector('.mt-label')?.textContent?.trim().startsWith('Amount ex GST'),
    );
    const amount = amounts[1]?.querySelector('input') as HTMLInputElement;
    amount.value = '59';
    amount.dispatchEvent(new Event('input'));
    await page.stable();
    // ($690 + $1,000 − $59) + 10% GST.
    expect(page.text(byTestId('pre-bill-total'))).toBe('$1,794.10');
    expect(page.text(byTestId('pre-bill-preview'))).toContain('Courtesy discount');
  });

  it('saves, then issues it after confirming, and becomes the invoice', async () => {
    const page = await openDraft();
    const letter = [...(byTestId('pre-bill-time')?.querySelectorAll('mt-checkbox') ?? [])].find((box) =>
      box.textContent?.includes('Letter to the executor'),
    );
    letter?.querySelector<HTMLInputElement>('input, button, [role="checkbox"]')?.click();
    await page.stable();
    await page.click('Issue invoice');
    expect(page.text(page.dialog())).toContain('$517.00 on M-2026-0142');
    await page.click('Issue invoice', page.dialog() as HTMLElement);
    for (let i = 0; i < 4; i++) await page.stable(5);
    const saved = callsOf(page, 'billing-saveDraft').at(-1);
    expect(saved?.['fields']).toMatchObject({ excludedTimeEntryIds: ['te-b'], paymentTermsDays: 14 });
    expect(callsOf(page, 'billing-issueInvoice')).toEqual([{ invoiceId: 'inv-draft' }]);
    expect(page.text(document.body)).toContain('Tax invoice INV-000001');
    expect(byTestId('invoice-pdf-pending')).not.toBeNull();
  });

  it('writes a time entry down from its row, and the total follows (BILL-07b)', async () => {
    const page = await openDraft();
    await page.click('Write down or off: Letter to the executor');
    const dialog = () => page.dialog() ?? page.body;
    expect(page.text(page.dialog())).toContain('Write down this entry');
    await page.fill('New units', '2', dialog());
    await page.fill('Reason', 'Shorter letter than recorded', dialog());
    await page.submit(page.dialog());
    for (let i = 0; i < 4; i++) await page.stable(5);
    expect(callsOf(page, 'time-writeDown')).toEqual([
      expect.objectContaining({
        matterId: 'm-whitfield',
        entryIds: ['te-b'],
        newUnits: 2,
        reason: 'Shorter letter than recorded',
      }),
    ]);
    // ($440 + $88 + $30) + 10% GST.
    expect(page.text(byTestId('pre-bill-total'))).toBe('$613.80');
  });

  it('writes a time entry off the pre-bill (BILL-07b)', async () => {
    const page = await openDraft();
    await page.click('Write down or off: Letter to the executor');
    await page.click('Write off', page.dialog() ?? page.body);
    await page.fill('Reason', 'Covered by the fixed fee', page.dialog() ?? page.body);
    await page.submit(page.dialog());
    for (let i = 0; i < 4; i++) await page.stable(5);
    expect(callsOf(page, 'time-writeDown')).toEqual([
      expect.objectContaining({ entryIds: ['te-b'], writeOff: true, reason: 'Covered by the fixed fee' }),
    ]);
    expect(byTestId('pre-bill-time')?.textContent).not.toContain('Letter to the executor');
    expect(page.text(byTestId('pre-bill-total'))).toBe('$517.00');
  });

  it('reads only for roles that can’t issue (none below lawyer reach it)', async () => {
    const page = await open('/billing/invoices/inv-x', { session: PARALEGAL });
    expect(page.router.url).not.toContain('/billing/invoices');
  });
});

describe('an issued invoice', () => {
  const openIssued = (data: Seed = {}, options: Parameters<typeof open>[1] = {}) =>
    open('/billing/invoices/inv-1', { ...options, configure: (fs) => fs.set(`${INVOICES}/inv-1`, issued(data)) });

  it('shows its PDF, facts and status', async () => {
    const page = await openIssued();
    expect(page.text(document.body)).toContain('Tax invoice INV-000007');
    expect(page.text(byTestId('invoice-status'))).toBe('Issued');
    expect(page.text(byTestId('invoice-total'))).toBe('$484.00');
    expect(page.text(byTestId('invoice-owing'))).toBe('$484.00');
    expect(page.text(byTestId('invoice-sent'))).toBe('Not yet');
    expect(callsOf(page, 'documents-getDownloadUrl')).toEqual([{ matterId: 'm-whitfield', docId: 'job-job-1' }]);
    expect(page.pdf.opened).toEqual(['https://files.example.test/job-job-1.pdf']);
    await page.click('Download PDF');
    expect(page.downloads).toEqual(['https://files.example.test/job-job-1.pdf']);
  });

  it('emails it to the client by default, with a message', async () => {
    const page = await openIssued();
    await page.click('Email invoice');
    const to = page.dialog()?.querySelector<HTMLInputElement>('mt-text-field input');
    expect(to?.value).toBe('avery@example.test');
    await page.fill('Message', 'Thanks for your instructions.', page.dialog() as HTMLElement);
    await page.submit(page.dialog());
    expect(callsOf(page, 'billing-sendInvoice')).toEqual([
      { invoiceId: 'inv-1', to: ['avery@example.test'], message: 'Thanks for your instructions.' },
    ]);
  });

  it('refuses addresses that aren’t emails', async () => {
    const page = await openIssued();
    await page.click('Email invoice');
    await page.fill('To', 'avery@example.test, not-an-email', page.dialog() as HTMLElement);
    await page.submit(page.dialog());
    expect(page.text(page.dialog())).toContain('“not-an-email” isn’t an email address.');
    expect(callsOf(page, 'billing-sendInvoice')).toEqual([]);
  });

  it('can’t be emailed when the client has no email address, and offers the PDF to print', async () => {
    const page = await openIssued({}, { emails: [] });
    expect(byTestId('invoice-no-email')).not.toBeNull();
    expect(page.buttons('Email invoice')[0]?.hasAttribute('disabled')).toBe(true);
    expect(page.buttons('Download to print')).toHaveLength(1);
  });

  it('offers to make a failed PDF again', async () => {
    const page = await openIssued({ pdfStatus: 'failed', pdfDocumentId: undefined });
    expect(byTestId('invoice-pdf-failed')).not.toBeNull();
    await page.click('Try again');
    expect(callsOf(page, 'billing-retryPdf')).toEqual([{ invoiceId: 'inv-1' }]);
  });

  it('can’t be voided or credited by a lawyer', async () => {
    const page = await openIssued();
    expect(page.buttons('Void')).toHaveLength(0);
    expect(page.buttons('Credit note')).toHaveLength(0);
  });

  it('is voided with a reason by owners and admins', async () => {
    const page = await openIssued({}, { session: ADMIN });
    await page.click('Void');
    await page.submit(page.dialog());
    expect(page.text(page.dialog())).toContain('Say why it’s being voided.');
    await page.fill('Reason', 'Billed to the wrong matter', page.dialog() as HTMLElement);
    await page.submit(page.dialog());
    expect(callsOf(page, 'billing-voidInvoice')).toEqual([
      { invoiceId: 'inv-1', reason: 'Billed to the wrong matter' },
    ]);
    expect(page.text(byTestId('invoice-void'))).toContain('Billed to the wrong matter');
  });

  it('is credited in full, or by line, through a credit note', async () => {
    const page = await openIssued({}, { session: ADMIN });
    await page.click('Credit note');
    expect(page.text(page.dialog())).toContain('Credits $484.00 ($44.00 GST).');
    await page.fill('Reason', 'Fee waived', page.dialog() as HTMLElement);
    await page.submit(page.dialog());
    expect(callsOf(page, 'billing-createCreditNote')).toEqual([
      { invoiceId: 'inv-1', full: true, lines: [], reason: 'Fee waived' },
    ]);
  });

  it('can’t be voided once it has a credit note', async () => {
    const page = await openIssued({ creditedCents: 10_000, creditNoteIds: ['cn-1'] }, { session: ADMIN });
    expect(page.buttons('Void')).toHaveLength(0);
    expect(page.text(byTestId('invoice-owing'))).toBe('$384.00');
  });
});

describe('the invoices list', () => {
  it('lists pre-bills and invoices with what’s owing, filtered by status', async () => {
    const page = await open('/billing/invoices', {
      configure: (fs) => {
        fs.set(`${INVOICES}/inv-1`, issued());
        fs.set(`${INVOICES}/inv-2`, issued({ number: 'INV-000006', status: 'void' }));
      },
    });
    expect(page.text(byTestId('invoices-summary'))).toBe('$484.00 owing on 1 issued');
    expect(page.text(byTestId('invoices'))).toContain('INV-000007');
    expect(page.text(byTestId('invoices'))).toContain('INV-000006');
    const void_ = [...document.body.querySelectorAll<HTMLElement>('[role="radio"], button')].find(
      (b) => b.textContent?.trim() === 'Void',
    );
    void_?.click();
    await page.stable();
    expect(page.text(byTestId('invoices'))).not.toContain('INV-000007');
  });

  it('is off while billing.invoicing is off', async () => {
    const page = await open('/billing/invoices', { flags: {} });
    expect(page.router.url).toBe('/today');
  });

  it('opens from Time and billing', async () => {
    const page = await open('/billing');
    expect(page.buttons('Invoices')).not.toHaveLength(0);
  });
});

describe('payments on an invoice (BILL-08)', () => {
  const openIssued = (data: Seed = {}, options: Parameters<typeof open>[1] = {}) =>
    open('/billing/invoices/inv-1', { ...options, configure: (fs) => fs.set(`${INVOICES}/inv-1`, issued(data)) });

  it('records a part payment, defaulting to today and what’s owing', async () => {
    const page = await openIssued();
    await page.click('Record payment');
    const amount = [...(page.dialog()?.querySelectorAll<HTMLInputElement>('mt-text-field input') ?? [])][1];
    expect(amount?.value).toBe('484.00');
    await page.fill('Amount (AUD)', '200', page.dialog() as HTMLElement);
    // Native selects take the option's index.
    await page.fill('Method', '2', page.dialog() as HTMLElement);
    await page.fill('Reference', '000123', page.dialog() as HTMLElement);
    await page.fill('Paid by', 'Sam Quill (executor)', page.dialog() as HTMLElement);
    expect(page.text(page.dialog())).toContain('Afterwards: $284.00 owing.');
    await page.submit(page.dialog());
    expect(callsOf(page, 'billing-recordPayment')).toEqual([
      {
        invoiceId: 'inv-1',
        kind: 'payment',
        date: '2026-10-04',
        amountCents: 20_000,
        method: 'cheque',
        reference: '000123',
        payer: 'Sam Quill (executor)',
        credit: false,
      },
    ]);
  });

  it('refuses an overpayment until the extra is kept as credit, and warns about an early date', async () => {
    const page = await openIssued();
    await page.click('Record payment');
    const dialog = page.dialog() as HTMLElement;
    await page.fill('Amount (AUD)', '500', dialog);
    await page.fill('Date received', '1/10/2026', dialog);
    expect(byTestId('payment-warning')?.textContent).toContain('dated before the invoice was issued');
    await page.submit(dialog);
    expect(page.text(byTestId('payment-problem'))).toContain('That’s more than the $484.00 owing.');
    expect(callsOf(page, 'billing-recordPayment')).toEqual([]);
    (dialog.querySelector('mt-checkbox button, mt-checkbox input') as HTMLElement).click();
    await page.stable();
    await page.submit(dialog);
    expect(callsOf(page, 'billing-recordPayment')).toEqual([
      expect.objectContaining({ amountCents: 50_000, date: '2026-10-01', credit: true }),
    ]);
  });

  const PAYMENTS = [
    { id: 'p1', kind: 'payment', date: '2026-10-03', amountCents: 20_000, method: 'cheque', reference: '000123' },
    {
      id: 'p0',
      kind: 'payment',
      date: '2026-10-02',
      amountCents: 5_000,
      method: 'eft',
      reversedAt: new Date('2026-10-03T00:00:00Z'),
      reversalReason: 'Recorded twice',
    },
  ];

  it('lists payments, reversed ones marked, without reversal for lawyers', async () => {
    const lawyer = await openIssued({ status: 'part_paid', payments: PAYMENTS });
    expect(lawyer.text(byTestId('invoice-paid'))).toBe('$200.00');
    expect(lawyer.text(byTestId('invoice-owing'))).toBe('$284.00');
    expect(lawyer.text(byTestId('payments'))).toContain('Ref 000123');
    expect(lawyer.text(byTestId('payment-reversed'))).toBe('Reversed: Recorded twice');
    expect(lawyer.buttons('Reverse')).toHaveLength(0);
    expect(lawyer.buttons('Void')).toHaveLength(0);
  });

  it('lets owners and admins reverse a payment with a reason', async () => {
    const admin = await openIssued({ status: 'part_paid', payments: PAYMENTS }, { session: ADMIN });
    expect(admin.buttons('Void')).toHaveLength(0);
    await admin.click('Reverse');
    await admin.fill('Reason', 'Cheque dishonoured', admin.dialog() as HTMLElement);
    await admin.submit(admin.dialog());
    expect(callsOf(admin, 'billing-reversePayment')).toEqual([
      { invoiceId: 'inv-1', paymentId: 'p1', reason: 'Cheque dishonoured' },
    ]);
  });

  it('offers owners and admins a refund of credit held', async () => {
    const payments = [{ id: 'p1', kind: 'payment', date: '2026-10-03', amountCents: 48_400, method: 'eft' }];
    const page = await openIssued({ status: 'paid', payments, creditedCents: 10_000 }, { session: ADMIN });
    expect(page.text(byTestId('invoice-owing'))).toBe('$100.00');
    expect(page.text(document.body)).toContain('Credit held');
    expect(page.buttons('Record payment')).toHaveLength(0);
    await page.click('Record refund');
    await page.submit(page.dialog());
    expect(callsOf(page, 'billing-recordPayment')).toEqual([
      expect.objectContaining({ kind: 'refund', amountCents: 10_000, credit: false }),
    ]);
  });
});

describe('to be paid from trust (BILL-12)', () => {
  const TRUST_ON = { ...ON, 'billing.trustDisplay': true };
  const SNAPSHOT = {
    matterId: 'm-whitfield',
    amountCents: 8_421_000,
    asAt: '2026-10-02',
    source: 'manual',
    sourceSystemName: 'Smokeball',
    recordedBy: 'user-priya',
    recordedAt: new Date('2026-10-02T03:00:00Z'),
    ...meta,
  };
  const openIssued = (data: Seed = {}, options: Parameters<typeof open>[1] & { snapshot?: boolean } = {}) => {
    const { snapshot = true, ...rest } = options;
    return open('/billing/invoices/inv-1', {
      flags: TRUST_ON,
      ...rest,
      configure: (fs) => {
        fs.set(`${INVOICES}/inv-1`, issued(data));
        if (snapshot) fs.set(`orgs/${ORG}/trustSnapshots/m-whitfield`, SNAPSHOT);
      },
    });
  };
  const fromTrust = async (page: Page, reference?: string) => {
    await page.click('Record payment');
    const dialog = page.dialog() as HTMLElement;
    await page.fill('Amount (AUD)', '200', dialog);
    // Native selects take the option's index: From trust is the fourth.
    await page.fill('Method', '3', dialog);
    if (reference) await page.fill('Trust records reference', reference, dialog);
    return dialog;
  };

  it('is chosen on the pre-bill and saved with it, with no notice until the wording is approved', async () => {
    const page = await open('/billing/invoices/inv-draft', {
      configure: (fs) =>
        billingCallables()['billing-saveDraft']?.({ invoiceId: 'inv-draft', matterId: 'm-whitfield', fields: {} }, fs),
    });
    expect(byTestId('pre-bill-trust')).toBeNull();
    const option = [...document.body.querySelectorAll('mt-checkbox')].find((box) =>
      box.textContent?.includes('To be paid from trust'),
    );
    option?.querySelector<HTMLElement>('input, button, [role="checkbox"]')?.click();
    await page.stable();
    expect(page.text(byTestId('pre-bill-trust'))).toBe(
      'To be paid from trust. No withdrawal notice prints until the wording is approved.',
    );
    await page.click('Save');
    for (let i = 0; i < 4; i++) await page.stable(5);
    expect(callsOf(page, 'billing-saveDraft').at(-1)?.['fields']).toMatchObject({ paidFromTrust: true });
  });

  it('is marked on an issued invoice; the notice shows when the invoice carries one', async () => {
    const page = await openIssued();
    expect(byTestId('invoice-trust-notice')).toBeNull();
    byTestId('invoice-trust-option')?.querySelector<HTMLElement>('input, button, [role="checkbox"]')?.click();
    for (let i = 0; i < 4; i++) await page.stable(5);
    expect(callsOf(page, 'billing-setPaidFromTrust')).toEqual([{ invoiceId: 'inv-1', paidFromTrust: true }]);
  });

  it('says when the PDF carries the notice', async () => {
    await openIssued({ paidFromTrust: true, trustNotice: { version: 1, text: 'Notice of intended withdrawal…' } });
    expect(byTestId('invoice-trust-notice')).not.toBeNull();
  });

  it('records a payment from trust only with its reference, then prompts to update the trust balance', async () => {
    const page = await openIssued({ paidFromTrust: true });
    const dialog = await fromTrust(page);
    expect(page.text(byTestId('payment-trust'))).toBe(
      'Record this after the withdrawal is made in your trust records.',
    );
    expect(page.text(dialog)).toContain('Date withdrawn');
    await page.submit(dialog);
    expect(page.text(byTestId('payment-problem'))).toBe('Enter the trust system’s reference for the withdrawal');
    expect(callsOf(page, 'billing-recordPayment')).toEqual([]);
    await page.fill('Trust records reference', 'TR-0042', dialog);
    await page.submit(dialog);
    for (let i = 0; i < 4; i++) await page.stable(5);
    expect(callsOf(page, 'billing-recordPayment')).toEqual([
      expect.objectContaining({ method: 'trust_transfer', reference: 'TR-0042', amountCents: 20_000 }),
    ]);
    // The prompt; nothing changes the snapshot by itself.
    expect(page.text(page.dialog())).toContain('Update the trust balance?');
    expect(page.text(page.dialog())).toContain('$84,210.00, as at 2 Oct 2026 · from Smokeball');
    expect(page.calls('trust-recordSnapshot')).toEqual([]);
    await page.click('Update trust balance', page.dialog() as HTMLElement);
    // The trust balance dialog loads lazily: wait for it, not for a fixed number of ticks.
    await vi.waitFor(async () => {
      await page.stable(5);
      expect(page.text(page.dialog())).toContain('Copy the balance from Smokeball');
    });
    expect(page.calls('trust-recordSnapshot')).toEqual([]);
  });

  it('doesn’t prompt when the matter has no trust balance', async () => {
    const page = await openIssued({}, { snapshot: false });
    const dialog = await fromTrust(page, 'TR-0042');
    await page.submit(dialog);
    for (let i = 0; i < 4; i++) await page.stable(5);
    expect(callsOf(page, 'billing-recordPayment')).toHaveLength(1);
    expect(page.dialog()).toBeNull();
  });

  it('warns that the trust records need their own correction when a trust payment is reversed', async () => {
    const payments = [
      {
        id: 'p1',
        kind: 'payment',
        date: '2026-10-03',
        amountCents: 20_000,
        method: 'trust_transfer',
        reference: 'TR-1',
      },
    ];
    const page = await openIssued({ status: 'part_paid', payments }, { session: ADMIN });
    await page.click('Reverse');
    expect(page.text(byTestId('reverse-trust-warning'))).toContain('Correct the withdrawal in your trust records too');
  });

  it('never offers a withdrawal or an amount available in trust', async () => {
    await openIssued({ paidFromTrust: true });
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/available in trust|withdraw now|schedule withdrawal/i);
    expect([...document.body.querySelectorAll('button')].map((b) => b.textContent?.trim())).not.toContain('Withdraw');
  });
});

describe('the matter’s outstanding amount (BILL-08)', () => {
  const withOutstanding = (fs: Page['firestore']) =>
    fs.set(MATTER, { ...(fs.get(MATTER) as Seed), outstandingCents: 28_400 });

  it('shows in the header for billing roles while invoicing is on', async () => {
    const page = await open('/matters/m-whitfield', { configure: withOutstanding });
    expect(page.text(byTestId('matter-outstanding'))).toBe('Outstanding $284.00');
  });

  it('stays hidden from paralegals', async () => {
    await open('/matters/m-whitfield', { configure: withOutstanding, session: PARALEGAL });
    expect(byTestId('matter-outstanding')).toBeNull();
  });

  it('stays hidden while invoicing is off', async () => {
    await open('/matters/m-whitfield', { configure: withOutstanding, flags: {} });
    expect(byTestId('matter-outstanding')).toBeNull();
  });

  it('stays hidden when nothing is owed', async () => {
    await open('/matters/m-whitfield');
    expect(byTestId('matter-outstanding')).toBeNull();
  });
});

describe('aged debtors (BILL-08)', () => {
  const reminder = (data: Seed = {}): Seed => ({
    invoiceId: 'inv-1',
    invoiceNumber: 'INV-000007',
    matterId: 'm-whitfield',
    matterNumber: 'M-2026-0142',
    matterTitle: 'Estate of Margaret Whitfield',
    clientName: 'Avery Quill',
    threshold: 30,
    dueDate: '2026-09-01',
    balanceCents: 28_400,
    lawyerUid: ME,
    to: ['avery@example.test'],
    status: 'pending',
    ...meta,
    ...data,
  });
  const openDebtors = (options: Parameters<typeof open>[1] = {}, configure?: (fs: Page['firestore']) => void) =>
    open('/billing/debtors', {
      ...options,
      configure: (fs) => {
        fs.set(`orgs/${ORG}/metrics/debtors-2026-10-04`, debtorsDoc('2026-10-04'));
        fs.set(`orgs/${ORG}/invoiceReminders/inv-1-30`, reminder());
        fs.set(`orgs/${ORG}/invoiceReminders/inv-9-7`, reminder({ invoiceNumber: 'INV-000009', lawyerUid: PRIYA }));
        configure?.(fs);
      },
    });

  it('groups what’s owed by client and matter, bucketed by age', async () => {
    const page = await openDebtors();
    expect(page.text(byTestId('debtors-as-of'))).toBe('As of 4 Oct 2026');
    const clients = [...document.body.querySelectorAll('[data-testid="debtor-client"]')].map((row) =>
      [...row.children].map((cell) => page.text(cell)),
    );
    expect(clients).toEqual([
      ['Avery Quill', '', '$200.00', '—', '$284.00', '—', '—', '$484.00'],
      ['Bram Ostler', '', '—', '—', '—', '—', '$300.00', '$300.00'],
    ]);
    expect(document.body.querySelectorAll('[data-testid="debtor-matter"]')).toHaveLength(3);
    expect(page.text(byTestId('debtors-total'))).toBe('$784.00');
    expect(callsOf(page, 'billing-refreshDebtors')).toEqual([]);
    const mine = [...document.body.querySelectorAll<HTMLElement>('[role="radio"], button')].find(
      (b) => b.textContent?.trim() === 'My matters',
    );
    mine?.click();
    await page.stable();
    expect(page.text(byTestId('debtors-total'))).toBe('$284.00');
  });

  it('works out today’s report when the latest is older', async () => {
    const page = await openDebtors({}, (fs) => {
      fs.delete(`orgs/${ORG}/metrics/debtors-2026-10-04`);
      fs.set(`orgs/${ORG}/metrics/debtors-2026-10-03`, debtorsDoc('2026-10-03'));
    });
    expect(callsOf(page, 'billing-refreshDebtors')).toEqual([{}]);
    expect(page.text(byTestId('debtors-as-of'))).toBe('As of 4 Oct 2026');
  });

  it('shows a lawyer their own reminders, drafted to review before sending', async () => {
    const page = await openDebtors();
    expect(page.text(byTestId('reminders'))).toContain('INV-000007');
    expect(page.text(byTestId('reminders'))).not.toContain('INV-000009');
    await page.click('Review and send');
    const message = page.dialog()?.querySelector<HTMLTextAreaElement>('textarea');
    expect(message?.value).toContain('Dear Avery Quill,');
    expect(message?.value).toContain('is now more than 30 days overdue');
    expect(message?.value.endsWith('Kind regards,\nJordan Price')).toBe(true);
    expect(callsOf(page, 'billing-sendReminder')).toEqual([]);
    await page.submit(page.dialog());
    expect(callsOf(page, 'billing-sendReminder')).toEqual([
      { reminderId: 'inv-1-30', to: ['avery@example.test'], message: expect.stringContaining('Dear Avery Quill,') },
    ]);
  });

  it('lets owners and admins see and dismiss every reminder', async () => {
    const page = await openDebtors({ session: ADMIN });
    expect(page.text(byTestId('reminders'))).toContain('INV-000009');
    const rows = [...(byTestId('reminders')?.querySelectorAll('li') ?? [])];
    await page.click(
      'Dismiss',
      rows.find((row) => row.textContent?.includes('INV-000009')),
    );
    expect(callsOf(page, 'billing-dismissReminder')).toEqual([{ reminderId: 'inv-9-7' }]);
  });

  it('is off while billing.invoicing is off', async () => {
    expect((await open('/billing/debtors', { flags: {} })).router.url).toBe('/today');
  });

  it('is off for paralegals', async () => {
    expect((await open('/billing/debtors', { session: PARALEGAL })).router.url).not.toBe('/billing/debtors');
  });
});

describe('Xero on an invoice (BILL-09)', () => {
  const XERO_ON = { ...ON, 'integrations.xero': true };
  const TENANT = '11111111-1111-4111-8111-111111111111';
  const XERO_ID = 'aaaaaaaa-0000-4000-8000-000000000007';
  const settings = {
    tenantId: TENANT,
    tenantName: 'Harbour & Vine Legal (demo)',
    feesAccountCode: '200',
    disbursementsAccountCode: '260',
    autoPush: true,
    sendFrom: '2026-10-01',
  };
  const synced = (data: Seed = {}): Seed => ({
    status: 'synced',
    tenantId: TENANT,
    id: XERO_ID,
    contactId: 'cccccccc-0000-4000-8000-000000000001',
    syncedAt: new Date('2026-10-02T01:00:00Z'),
    ...data,
  });

  /** An issued invoice in a practice that has (or hasn't) chosen its Xero organisation. */
  const openIssued = (data: Seed = {}, options: Parameters<typeof open>[1] & { xero?: Seed | null } = {}) => {
    const { xero = settings, configure, ...rest } = options;
    return open('/billing/invoices/inv-1', {
      flags: XERO_ON,
      callables: { ...billingCallables(), 'xero-send': () => ({ queued: 1 }) },
      ...rest,
      configure: (fs, port) => {
        if (xero) fs.set(`orgs/${ORG}`, { ...fs.get(`orgs/${ORG}`), xero });
        fs.set(`${INVOICES}/inv-1`, issued(data));
        configure?.(fs, port);
      },
    });
  };
  const chip = () => byTestId('invoice-xero');

  it('shows nothing about Xero while the flag is off, or until the practice has chosen its organisation', async () => {
    const off = await openIssued({ xero: synced() }, { flags: ON });
    expect(chip()).toBeNull();
    expect(off.text(document.body)).not.toContain('Xero');
    cleanUpOverlays();
    TestBed.resetTestingModule();
    const unset = await openIssued({}, { xero: null });
    expect(chip()).toBeNull();
    expect(unset.buttons('Send to Xero')).toHaveLength(0);
  });

  it('links an invoice that’s in Xero to it there, in a new tab', async () => {
    await openIssued({ xero: synced() });
    expect(chip()?.querySelector('mt-badge')?.textContent?.trim()).toBe('In Xero');
    const link = chip()?.querySelector<HTMLAnchorElement>('a');
    expect(link?.getAttribute('href')).toBe(xeroDocumentUrl('invoice', XERO_ID));
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toContain('noopener');
    expect(byTestId('invoice-xero-error')).toBeNull();
  });

  it('labels an invoice on its way, and one sent to another Xero organisation as not sent', async () => {
    await openIssued({ xero: { status: 'queued', queuedAt: new Date('2026-10-04T00:00:00Z') } });
    expect(chip()?.textContent?.trim()).toBe('Sending to Xero');
    cleanUpOverlays();
    TestBed.resetTestingModule();
    await openIssued({ xero: synced({ tenantId: '22222222-2222-4222-8222-222222222222' }) });
    expect(chip()?.textContent?.trim()).toBe('Not sent to Xero');
    expect(chip()?.querySelector('a')).toBeNull();
  });

  it('offers Send to Xero for an issued invoice never sent', async () => {
    const page = await openIssued();
    expect(chip()?.textContent?.trim()).toBe('Not sent to Xero');
    expect(page.text(byTestId('invoice-xero-unsent'))).toContain('This invoice isn’t in Xero.');
    await page.click('Send to Xero');
    expect(callsOf(page, 'xero-send')).toEqual([{ invoiceId: 'inv-1' }]);
    expect(page.text(document.body)).toContain('Sending invoice INV-000007 to Xero');
  });

  it('doesn’t offer Send to Xero for a void invoice', async () => {
    const page = await openIssued({ status: 'void', voidReason: 'Billed to the wrong matter' });
    expect(page.buttons('Send to Xero')).toHaveLength(0);
  });

  it('says why it isn’t in Xero, and tries again', async () => {
    const error = {
      code: 'rejected',
      message: `${XERO_SYNC_ERROR_COPY.rejected} Account code 999 is not valid.`,
      at: new Date('2026-10-03T00:00:00Z'),
    };
    const page = await openIssued({ xero: { status: 'failed', tenantId: TENANT, error } });
    expect(chip()?.textContent?.trim()).toBe('Not in Xero');
    const alert = byTestId('invoice-xero-error');
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(page.text(alert)).toContain('Not in Xero. Xero didn’t accept it. Account code 999 is not valid.');
    expect(page.text(alert)).not.toContain('accept it. Xero didn’t');
    await page.click('Try again', alert as HTMLElement);
    expect(callsOf(page, 'xero-send')).toEqual([{ invoiceId: 'inv-1' }]);
  });

  it('explains a number Xero already uses', async () => {
    const error = { code: 'number_taken', message: '', at: new Date('2026-10-03T00:00:00Z') };
    const page = await openIssued({ xero: { status: 'conflict', tenantId: TENANT, error } });
    expect(page.text(byTestId('invoice-xero-error'))).toContain(XERO_SYNC_ERROR_COPY.number_taken);
  });

  it('lists payments in Xero that couldn’t be recorded here', async () => {
    const unrecordedPayments = [
      { id: 'xp-1', date: '2026-10-03', amountCents: 60_000, reason: 'It would pay more than is owing.' },
    ];
    const page = await openIssued({ xero: synced({ unrecordedPayments }) });
    const warning = byTestId('invoice-xero-unrecorded');
    expect(page.text(warning)).toContain('Payments in Xero not recorded here');
    expect(page.text(warning)).toContain('3 Oct 2026 · $600.00 · It would pay more than is owing.');
  });

  it('names payments from Xero, and marks a possible duplicate while both count', async () => {
    const payments = [
      { id: 'p1', kind: 'payment', date: '2026-10-02', amountCents: 20_000, method: 'eft' },
      {
        id: 'xero-pay-1',
        kind: 'payment',
        date: '2026-10-03',
        amountCents: 20_000,
        method: 'xero',
        possibleDuplicateOf: 'p1',
      },
    ];
    const page = await openIssued({ status: 'part_paid', payments, xero: synced() });
    const rows = [...(byTestId('payments')?.querySelectorAll('li') ?? [])];
    const fromXero = rows.find((row) => row.textContent?.includes('3 Oct 2026'));
    expect(fromXero?.querySelector('.label')?.textContent?.trim()).toBe('Xero');
    const badge = fromXero?.querySelector('[data-testid="payment-duplicate"]');
    expect(badge?.textContent?.trim()).toBe('Possible duplicate');
    expect(badge?.getAttribute('title')).toBe(
      'A payment of the same amount was recorded here within a week. Check it isn’t counted twice.',
    );
    expect(page.body.querySelectorAll('[data-testid="payment-duplicate"]')).toHaveLength(1);

    cleanUpOverlays();
    TestBed.resetTestingModule();
    const reversed = [{ ...payments[0], reversedAt: new Date('2026-10-04T00:00:00Z'), reversalReason: 'Twice' }];
    await openIssued({ status: 'part_paid', payments: [...reversed, payments[1]], xero: synced() });
    expect(byTestId('payment-duplicate')).toBeNull();
  });

  it('shows where each credit note stands in Xero', async () => {
    await openIssued(
      { creditedCents: 10_000, creditNoteIds: ['cn-1'], xero: synced() },
      {
        configure: (fs) =>
          fs.set(`orgs/${ORG}/creditNotes/cn-1`, {
            number: 'CN-000001',
            invoiceId: 'inv-1',
            invoiceNumber: 'INV-000007',
            matterId: 'm-whitfield',
            issueDate: '2026-10-03',
            reason: 'Fee waived',
            full: false,
            lines: [],
            subtotalCents: 9_091,
            gstCents: 909,
            totalCents: 10_000,
            gstRegistered: true,
            pdfStatus: 'ready',
            pdfDocumentId: 'job-cn-1',
            xero: synced({ id: 'bbbbbbbb-0000-4000-8000-000000000001' }),
            ...meta,
          }),
      },
    );
    const noteChip = byTestId('credit-note-xero');
    expect(noteChip?.querySelector('mt-badge')?.textContent?.trim()).toBe('In Xero');
    expect(noteChip?.querySelector('a')?.getAttribute('href')).toBe(
      xeroDocumentUrl('creditNote', 'bbbbbbbb-0000-4000-8000-000000000001'),
    );
  });

  it('never offers Xero as a method when a payment is recorded by hand', async () => {
    const page = await openIssued();
    await page.click('Record payment');
    const options = [...(page.dialog()?.querySelectorAll<HTMLOptionElement>('mt-select option') ?? [])].map((o) =>
      o.text.trim(),
    );
    expect(options).toEqual(['Choose…', 'Bank transfer', 'Card', 'Cheque', 'From trust', 'Other']);
  });
});
