import { DomainError } from '@materia/domain';

import { httpXeroClient, idempotencyKey, toCents, xeroDate, xeroDateOnly, xeroMessages, XERO_API } from './client';
import { XeroApiError, type XeroDocumentInput } from '../ports';

/**
 * Contract tests of the Xero Accounting API client (BILL-09) against responses shaped like Xero's
 * own (recorded from its API reference; every organisation, contact and amount is fictional).
 */

const TENANT = '7d0f3b1e-5a6c-4e2b-9f1d-2c3b4a5d6e7f';

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A `send` that answers each request with the next response and records what was asked. */
function fakeSend(...responses: (Response | Error)[]) {
  const sent: Sent[] = [];
  const send = async (url: string, init: RequestInit) => {
    sent.push({
      url,
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const next = responses.shift();
    if (!next) throw new Error(`No response for ${url}`);
    if (next instanceof Error) throw next;
    return next;
  };
  return { send, sent };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const INVOICE_RESPONSE = {
  Id: 'e3b0c442-98fc-1c14-9afb-f4c8996fb924',
  Status: 'OK',
  Invoices: [
    {
      Type: 'ACCREC',
      InvoiceID: '0e64a623-c2a1-446a-93ed-eb897f118cbc',
      InvoiceNumber: 'INV-000001',
      Reference: 'M-2026-0042',
      Status: 'AUTHORISED',
      Total: 962.3,
      Contact: { ContactID: '5b96e86b-418e-48e8-8949-308c14aec278', Name: 'Lan Nguyen' },
      Date: '/Date(1791244800000+0000)/',
      Payments: [
        { PaymentID: '0d666415-cf77-43fa-80c7-56775591d426', Date: '/Date(1791331200000+0000)/', Amount: 500 },
      ],
    },
  ],
};

const DOCUMENT: XeroDocumentInput = {
  contactId: '5b96e86b-418e-48e8-8949-308c14aec278',
  number: 'INV-000001',
  date: '2026-10-06',
  dueDate: '2026-10-20',
  reference: 'M-2026-0042',
  lineAmountTypes: 'Exclusive',
  lines: [
    {
      description: 'Advice on the will',
      quantity: 1.5,
      unitAmountCents: 44000,
      accountCode: '200',
      taxType: 'OUTPUT',
      taxAmountCents: 6600,
    },
    {
      description: 'Probate filing fee',
      quantity: 1,
      unitAmountCents: 33310,
      accountCode: '840',
      taxType: 'EXEMPTOUTPUT',
      taxAmountCents: 0,
    },
  ],
};

describe('Xero client (BILL-09)', () => {
  it('lists the organisations the connection reaches, not practice-manager tenants', async () => {
    const { send, sent } = fakeSend(
      json([
        { id: 'c1', tenantId: TENANT, tenantType: 'ORGANISATION', tenantName: 'Harbour & Vine Legal' },
        { id: 'c2', tenantId: 'a8f3b6c1-0000-4000-8000-000000000001', tenantType: 'PRACTICEMANAGER', tenantName: 'PM' },
      ]),
    );
    await expect(httpXeroClient(send).tenants()).resolves.toEqual([
      { tenantId: TENANT, tenantName: 'Harbour & Vine Legal' },
    ]);
    expect(sent[0]).toMatchObject({ url: 'https://api.xero.com/connections', method: 'GET' });
    expect(sent[0]?.headers['xero-tenant-id']).toBeUndefined();
  });

  it('lists active accounts for the tenant, leaving out bank accounts', async () => {
    const { send, sent } = fakeSend(
      json({
        Accounts: [
          { AccountID: 'a1', Code: '090', Name: 'Business Bank Account', Type: 'BANK', Class: 'ASSET' },
          { AccountID: 'a2', Code: '200', Name: 'Sales', Type: 'REVENUE', Class: 'REVENUE' },
          { AccountID: 'a3', Name: 'No code', Type: 'REVENUE', Class: 'REVENUE' },
          { AccountID: 'a4', Code: '840', Name: 'Disbursements Recoverable', Type: 'CURRLIAB', Class: 'LIABILITY' },
        ],
      }),
    );
    await expect(httpXeroClient(send).accounts(TENANT)).resolves.toEqual([
      { code: '200', name: 'Sales', class: 'REVENUE' },
      { code: '840', name: 'Disbursements Recoverable', class: 'LIABILITY' },
    ]);
    expect(sent[0]?.url).toBe(`${XERO_API}/Accounts?where=${encodeURIComponent('Status=="ACTIVE"')}&order=Code`);
    expect(sent[0]?.headers).toMatchObject({ 'xero-tenant-id': TENANT, accept: 'application/json' });
  });

  it('creates an authorised ACCREC invoice with tax types, GST amounts and an idempotency key', async () => {
    const { send, sent } = fakeSend(json(INVOICE_RESPONSE));
    const created = await httpXeroClient(send).createInvoice(TENANT, DOCUMENT, 'materia-key-1');
    expect(created).toEqual({
      id: '0e64a623-c2a1-446a-93ed-eb897f118cbc',
      number: 'INV-000001',
      type: 'ACCREC',
      status: 'AUTHORISED',
      reference: 'M-2026-0042',
      totalCents: 96230,
      contactId: '5b96e86b-418e-48e8-8949-308c14aec278',
      payments: [{ id: '0d666415-cf77-43fa-80c7-56775591d426', date: '2026-10-07', amountCents: 50000 }],
    });
    expect(sent[0]).toMatchObject({
      url: `${XERO_API}/Invoices`,
      method: 'POST',
      headers: { 'idempotency-key': 'materia-key-1', 'content-type': 'application/json', 'xero-tenant-id': TENANT },
      body: {
        Invoices: [
          {
            Type: 'ACCREC',
            Contact: { ContactID: '5b96e86b-418e-48e8-8949-308c14aec278' },
            Date: '2026-10-06',
            DueDate: '2026-10-20',
            InvoiceNumber: 'INV-000001',
            Reference: 'M-2026-0042',
            Status: 'AUTHORISED',
            LineAmountTypes: 'Exclusive',
            CurrencyCode: 'AUD',
            LineItems: [
              {
                Description: 'Advice on the will',
                Quantity: 1.5,
                UnitAmount: 440,
                AccountCode: '200',
                TaxType: 'OUTPUT',
                TaxAmount: 66,
              },
              {
                Description: 'Probate filing fee',
                Quantity: 1,
                UnitAmount: 333.1,
                AccountCode: '840',
                TaxType: 'EXEMPTOUTPUT',
                TaxAmount: 0,
              },
            ],
          },
        ],
      },
    });
  });

  it('sends no tax types for a firm not registered for GST', async () => {
    const { send, sent } = fakeSend(json(INVOICE_RESPONSE));
    const lines = DOCUMENT.lines.map(({ description, quantity, unitAmountCents, accountCode }) => ({
      description,
      quantity,
      unitAmountCents,
      accountCode,
    }));
    await httpXeroClient(send).createInvoice(TENANT, { ...DOCUMENT, lineAmountTypes: 'NoTax', lines }, 'k');
    const body = sent[0]?.body as { Invoices: { LineAmountTypes: string; LineItems: Record<string, unknown>[] }[] };
    expect(body.Invoices[0]?.LineAmountTypes).toBe('NoTax');
    expect(body.Invoices[0]?.LineItems.every((line) => !('TaxType' in line) && !('TaxAmount' in line))).toBe(true);
  });

  it('creates a credit note and allocates it against the invoice', async () => {
    const { send, sent } = fakeSend(
      json({
        CreditNotes: [
          {
            Type: 'ACCRECCREDIT',
            CreditNoteID: 'f7d4a1c0-1111-4222-8333-944455556666',
            CreditNoteNumber: 'CN-000001',
            Reference: 'INV-000001',
            Status: 'AUTHORISED',
            Total: 110,
          },
        ],
      }),
      json({ Allocations: [{ Amount: 110 }] }),
    );
    const client = httpXeroClient(send);
    const note = await client.createCreditNote(
      TENANT,
      { ...DOCUMENT, number: 'CN-000001', reference: 'INV-000001' },
      'k1',
    );
    expect(note).toMatchObject({ id: 'f7d4a1c0-1111-4222-8333-944455556666', type: 'ACCRECCREDIT', totalCents: 11000 });
    expect((sent[0]?.body as { CreditNotes: Record<string, unknown>[] }).CreditNotes[0]).toMatchObject({
      Type: 'ACCRECCREDIT',
      CreditNoteNumber: 'CN-000001',
    });
    await client.allocateCreditNote(
      TENANT,
      note.id,
      { invoiceId: '0e64a623-c2a1-446a-93ed-eb897f118cbc', amountCents: 11000, date: '2026-10-06' },
      'k2',
    );
    expect(sent[1]).toMatchObject({
      url: `${XERO_API}/CreditNotes/f7d4a1c0-1111-4222-8333-944455556666/Allocations`,
      method: 'PUT',
      headers: { 'idempotency-key': 'k2' },
      body: {
        Allocations: [
          { Amount: 110, Invoice: { InvoiceID: '0e64a623-c2a1-446a-93ed-eb897f118cbc' }, Date: '2026-10-06' },
        ],
      },
    });
  });

  it('finds an invoice by number among sales invoices only, ignoring bills and deleted ones', async () => {
    const raw = INVOICE_RESPONSE.Invoices[0];
    const { send, sent } = fakeSend(
      json({
        Invoices: [
          { ...raw, Type: 'ACCPAY', InvoiceID: 'bill' },
          { ...raw, InvoiceID: 'deleted', Status: 'DELETED' },
          { ...raw, InvoiceNumber: 'INV-0000010', InvoiceID: 'other' },
          raw,
        ],
      }),
      json({ Invoices: [] }),
    );
    const client = httpXeroClient(send);
    await expect(client.invoiceByNumber(TENANT, 'INV-000001')).resolves.toMatchObject({ id: raw?.InvoiceID });
    expect(sent[0]?.url).toBe(`${XERO_API}/Invoices?InvoiceNumbers=INV-000001`);
    await expect(client.invoiceByNumber(TENANT, 'INV-000002')).resolves.toBeNull();
  });

  it('voids an invoice', async () => {
    const { send, sent } = fakeSend(json(INVOICE_RESPONSE));
    await httpXeroClient(send).voidInvoice(TENANT, 'inv-1');
    expect(sent[0]).toMatchObject({
      url: `${XERO_API}/Invoices/inv-1`,
      method: 'POST',
      body: { Invoices: [{ InvoiceID: 'inv-1', Status: 'VOIDED' }] },
    });
  });

  it('matches contacts by email, refusing anything that could break out of the filter', async () => {
    const { send, sent } = fakeSend(
      json({
        Contacts: [
          { ContactID: 'c1', Name: 'Lan Nguyen', EmailAddress: 'lan@example.com', ContactStatus: 'ACTIVE' },
          { ContactID: 'c2', Name: 'Lan N (old)', EmailAddress: 'lan@example.com', ContactStatus: 'ARCHIVED' },
        ],
      }),
    );
    const client = httpXeroClient(send);
    await expect(client.contactsByEmail(TENANT, 'lan@example.com')).resolves.toEqual([
      { id: 'c1', name: 'Lan Nguyen', email: 'lan@example.com', archived: false },
      { id: 'c2', name: 'Lan N (old)', email: 'lan@example.com', archived: true },
    ]);
    expect(decodeURIComponent(sent[0]?.url ?? '')).toBe(`${XERO_API}/Contacts?where=EmailAddress=="lan@example.com"`);
    await expect(client.contactsByEmail(TENANT, 'a"||Name!=null||"@x.com')).rejects.toBeInstanceOf(XeroApiError);
    expect(sent).toHaveLength(1);
  });

  it('creates a contact with its email, ABN and address', async () => {
    const { send, sent } = fakeSend(
      json({ Contacts: [{ ContactID: 'c9', Name: 'Wren Estate', ContactStatus: 'ACTIVE' }] }),
    );
    const created = await httpXeroClient(send).createContact(
      TENANT,
      {
        name: 'Wren Estate',
        email: 'exec@example.com',
        taxNumber: '12345678901',
        address: '1 Fictional St, Geelong VIC 3220',
      },
      'k',
    );
    expect(created).toEqual({ id: 'c9', name: 'Wren Estate', archived: false });
    expect((sent[0]?.body as { Contacts: unknown[] }).Contacts[0]).toEqual({
      Name: 'Wren Estate',
      EmailAddress: 'exec@example.com',
      TaxNumber: '12345678901',
      Addresses: [{ AddressType: 'POBOX', AddressLine1: '1 Fictional St, Geelong VIC 3220' }],
    });
  });

  it('pages through receivable payments changed since a time, with deletions', async () => {
    const { send, sent } = fakeSend(
      json({
        Payments: [
          {
            PaymentID: 'p1',
            Date: '/Date(1791331200000+0000)/',
            Amount: 1234.56,
            Reference: 'EFT 0042',
            Status: 'AUTHORISED',
            UpdatedDateUTC: '/Date(1791334800000+0000)/',
            Invoice: { InvoiceID: 'inv-1', InvoiceNumber: 'INV-000001' },
          },
          {
            PaymentID: 'p2',
            Date: '2026-10-08T00:00:00',
            Amount: 10,
            Status: 'DELETED',
            UpdatedDateUTC: '2026-10-08T03:00:00',
            Invoice: { InvoiceID: 'inv-1' },
          },
          { PaymentID: 'p3', Date: '/Date(1791331200000+0000)/', Amount: 5, Status: 'AUTHORISED' },
        ],
      }),
    );
    const payments = await httpXeroClient(send).payments(TENANT, {
      modifiedSince: new Date('2026-10-01T05:06:07.890Z'),
      page: 2,
    });
    expect(payments).toEqual([
      {
        id: 'p1',
        date: '2026-10-07',
        amountCents: 123456,
        reference: 'EFT 0042',
        invoiceId: 'inv-1',
        deleted: false,
        updatedAt: new Date(1791334800000),
      },
      {
        id: 'p2',
        date: '2026-10-08',
        amountCents: 1000,
        invoiceId: 'inv-1',
        deleted: true,
        updatedAt: new Date('2026-10-08T03:00:00Z'),
      },
    ]);
    expect(decodeURIComponent(sent[0]?.url ?? '')).toBe(
      `${XERO_API}/Payments?where=PaymentType=="ACCRECPAYMENT"&order=UpdatedDateUTC&page=2`,
    );
    expect(sent[0]?.headers['if-modified-since']).toBe('2026-10-01T05:06:07');
  });

  it('answers a missing document or an unchanged list with null', async () => {
    const { send } = fakeSend(new Response(null, { status: 404 }), new Response(null, { status: 304 }));
    const client = httpXeroClient(send);
    await expect(client.invoice(TENANT, 'gone')).resolves.toBeNull();
    await expect(client.payments(TENANT, { modifiedSince: new Date(), page: 1 })).resolves.toEqual([]);
  });

  it('turns Xero’s refusals into errors that say why', async () => {
    const validation = json(
      {
        ErrorNumber: 10,
        Type: 'ValidationException',
        Message: 'A validation exception occurred',
        Elements: [
          {
            ValidationErrors: [{ Message: "Account code '999' is not a valid code for this document." }],
            LineItems: [{ ValidationErrors: [{ Message: 'Invoice not of valid status for modification' }] }],
          },
        ],
      },
      400,
    );
    const { send } = fakeSend(
      validation,
      json({ Title: 'Forbidden', Detail: 'AuthenticationUnsuccessful' }, 403),
      new Response('<html>Service Unavailable</html>', { status: 503 }),
      new Response('', { status: 429 }),
    );
    const client = httpXeroClient(send);
    await expect(client.createInvoice(TENANT, DOCUMENT, 'k')).rejects.toMatchObject({
      failure: 'rejected',
      status: 400,
      messages: [
        "Account code '999' is not a valid code for this document.",
        'Invoice not of valid status for modification',
      ],
    });
    await expect(client.tenants()).rejects.toMatchObject({
      failure: 'forbidden',
      messages: ['AuthenticationUnsuccessful'],
    });
    await expect(client.accounts(TENANT)).rejects.toMatchObject({ failure: 'unavailable', status: 503 });
    await expect(client.accounts(TENANT)).rejects.toMatchObject({ failure: 'unavailable', status: 429 });
  });

  it('is unavailable when Xero can’t be reached, and passes the vault’s own errors through', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const reconnect = new DomainError('INTEGRATION_RECONNECT_REQUIRED', 'Reconnect Xero');
    const { send } = fakeSend(new TypeError('fetch failed'), timeout, reconnect);
    const client = httpXeroClient(send);
    await expect(client.tenants()).rejects.toMatchObject({ failure: 'unavailable', status: 0 });
    await expect(client.tenants()).rejects.toMatchObject({ failure: 'unavailable' });
    await expect(client.tenants()).rejects.toBe(reconnect);
  });

  it('reads Xero’s dates and amounts', () => {
    expect(xeroDate('/Date(1518652800000+0000)/')).toEqual(new Date(1518652800000));
    expect(xeroDate('/Date(1518652800000)/')).toEqual(new Date(1518652800000));
    expect(xeroDate('2026-10-06T10:00:00')).toEqual(new Date('2026-10-06T10:00:00Z'));
    expect(xeroDate('2026-10-06T10:00:00+10:00')).toEqual(new Date('2026-10-06T00:00:00Z'));
    expect(xeroDate('soon')).toBeNull();
    expect(xeroDate(undefined)).toBeNull();
    expect(xeroDateOnly('/Date(1791244800000+0000)/')).toBe('2026-10-06');
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents('962.30')).toBe(96230);
    expect(xeroMessages({ Message: 'Plain message' })).toEqual(['Plain message']);
    expect(xeroMessages(null)).toEqual([]);
  });

  it('makes stable idempotency keys Xero accepts', () => {
    const key = idempotencyKey('invoice', 'org-1', TENANT, 'inv-1');
    expect(key).toBe(idempotencyKey('invoice', 'org-1', TENANT, 'inv-1'));
    expect(key).not.toBe(idempotencyKey('invoice', 'org-1', TENANT, 'inv-2'));
    expect(key.length).toBeLessThanOrEqual(128);
    expect(key).toMatch(/^materia-[0-9a-f]{64}$/);
  });
});
