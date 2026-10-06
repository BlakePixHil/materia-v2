import { createHash } from 'node:crypto';

import {
  XeroApiError,
  type AuthorizedSend,
  type XeroClient,
  type XeroContactInput,
  type XeroContactRecord,
  type XeroDocumentInput,
  type XeroDocumentRecord,
  type XeroFailure,
  type XeroLineInput,
  type XeroPaymentRecord,
  type XeroPaymentSummary,
  type XeroPort,
  type XeroTenantRecord,
} from '../ports';

/** Xero's Accounting API and its connections endpoint (BILL-09). */
export const XERO_API = 'https://api.xero.com/api.xro/2.0';
export const XERO_CONNECTIONS = 'https://api.xero.com/connections';

type Json = Record<string, unknown>;

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** Dollars (Xero's decimals) to integer cents. */
export const toCents = (amount: unknown): number => Math.round(Number(amount ?? 0) * 100);

/** Integer cents to Xero's two-decimal dollars. */
export const toAmount = (cents: number): number => Number((cents / 100).toFixed(2));

/**
 * Xero's dates: `/Date(1518652800000+0000)/` in most responses, ISO strings in some. Null when
 * neither.
 */
export function xeroDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const legacy = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/.exec(value);
  if (legacy) return new Date(Number(legacy[1]));
  const iso = Date.parse(/Z|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`);
  return Number.isNaN(iso) ? null : new Date(iso);
}

/** A Xero date as the calendar date it names (Xero keeps dates at midnight UTC). */
export const xeroDateOnly = (value: unknown): string | null => xeroDate(value)?.toISOString().slice(0, 10) ?? null;

/** Xero's `where` filters take double-quoted strings; anything that could break out is refused. */
function quoted(value: string): string {
  if (/["\\\n\r]/.test(value)) throw new XeroApiError('rejected', 'Unsupported characters in a Xero filter', 400);
  return `"${value}"`;
}

/** An idempotency key Xero accepts (at most 128 characters): `materia-` and a sha256. */
export const idempotencyKey = (...parts: string[]): string =>
  `materia-${createHash('sha256').update(parts.join('\u0000')).digest('hex')}`;

/** The validation messages in a Xero error body (`Elements[].ValidationErrors[].Message`, or `Message`). */
export function xeroMessages(body: unknown): string[] {
  const out = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(visit);
    const record = value as Json;
    for (const error of (record['ValidationErrors'] as unknown[] | undefined) ?? []) {
      const message = text((error as Json)?.['Message']);
      if (message) out.add(message.slice(0, 300));
    }
    for (const key of ['Elements', 'Invoices', 'CreditNotes', 'Contacts', 'Allocations', 'LineItems']) {
      visit(record[key]);
    }
  };
  visit(body);
  if (!out.size) {
    const detail = text((body as Json | null)?.['Detail']) ?? text((body as Json | null)?.['Message']);
    if (detail) out.add(detail.slice(0, 300));
  }
  return [...out];
}

function failureFor(status: number): XeroFailure {
  if (status === 400) return 'rejected';
  if (status === 404) return 'not_found';
  if (status === 401 || status === 403) return 'forbidden';
  return 'unavailable';
}

function contactOf(raw: Json): XeroContactRecord {
  const email = text(raw['EmailAddress']);
  return {
    id: String(raw['ContactID']),
    name: String(raw['Name'] ?? ''),
    ...(email ? { email } : {}),
    archived: raw['ContactStatus'] === 'ARCHIVED',
  };
}

function paymentSummaryOf(raw: Json): XeroPaymentSummary {
  const reference = text(raw['Reference']);
  return {
    id: String(raw['PaymentID']),
    date: xeroDateOnly(raw['Date']) ?? '',
    amountCents: toCents(raw['Amount']),
    ...(reference ? { reference } : {}),
  };
}

function documentOf(raw: Json, kind: 'invoice' | 'creditNote'): XeroDocumentRecord {
  const reference = text(raw['Reference']);
  const contactId = text((raw['Contact'] as Json | undefined)?.['ContactID']);
  const payments = raw['Payments'] as Json[] | undefined;
  return {
    id: String(kind === 'invoice' ? raw['InvoiceID'] : raw['CreditNoteID']),
    number: String((kind === 'invoice' ? raw['InvoiceNumber'] : raw['CreditNoteNumber']) ?? ''),
    type: String(raw['Type'] ?? ''),
    status: String(raw['Status'] ?? ''),
    ...(reference ? { reference } : {}),
    totalCents: toCents(raw['Total']),
    ...(contactId ? { contactId } : {}),
    ...(Array.isArray(payments) ? { payments: payments.map(paymentSummaryOf) } : {}),
  };
}

function paymentOf(raw: Json): XeroPaymentRecord | null {
  const invoiceId = text((raw['Invoice'] as Json | undefined)?.['InvoiceID']);
  if (!invoiceId || !text(raw['PaymentID'])) return null;
  const updatedAt = xeroDate(raw['UpdatedDateUTC']);
  return {
    ...paymentSummaryOf(raw),
    invoiceId,
    deleted: raw['Status'] === 'DELETED',
    ...(updatedAt ? { updatedAt } : {}),
  };
}

/**
 * A line as Xero wants it. Quantity and unit price are kept when they multiply out to the line's
 * amount exactly (hours at a rate); otherwise the line is one unit of its amount, so Xero's totals
 * always equal Materia's.
 */
function lineOf(line: XeroLineInput, lineAmountTypes: XeroDocumentInput['lineAmountTypes']): Json {
  return {
    Description: line.description.slice(0, 4000),
    Quantity: line.quantity,
    UnitAmount: toAmount(line.unitAmountCents),
    AccountCode: line.accountCode,
    ...(lineAmountTypes === 'Exclusive' && line.taxType ? { TaxType: line.taxType } : {}),
    ...(lineAmountTypes === 'Exclusive' && line.taxAmountCents !== undefined
      ? { TaxAmount: toAmount(line.taxAmountCents) }
      : {}),
  };
}

function documentBody(input: XeroDocumentInput, kind: 'invoice' | 'creditNote'): Json {
  return {
    Type: kind === 'invoice' ? 'ACCREC' : 'ACCRECCREDIT',
    Contact: { ContactID: input.contactId },
    Date: input.date,
    ...(input.dueDate ? { DueDate: input.dueDate } : {}),
    [kind === 'invoice' ? 'InvoiceNumber' : 'CreditNoteNumber']: input.number,
    ...(input.reference ? { Reference: input.reference.slice(0, 255) } : {}),
    Status: 'AUTHORISED',
    LineAmountTypes: input.lineAmountTypes,
    CurrencyCode: 'AUD',
    LineItems: input.lines.map((line) => lineOf(line, input.lineAmountTypes)),
  };
}

/** Xero's Accounting API over an authorised `send` (the vault's `authorizedFetch`). */
export function httpXeroClient(send: AuthorizedSend): XeroClient {
  const request = async (
    url: string,
    options: { tenantId?: string; method?: string; body?: unknown; idempotencyKey?: string; headers?: Json } = {},
  ): Promise<Json | Json[] | null> => {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.tenantId) headers['xero-tenant-id'] = options.tenantId;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
    for (const [key, value] of Object.entries(options.headers ?? {})) headers[key] = String(value);
    let response: Response;
    try {
      response = await send(url, {
        method: options.method ?? 'GET',
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      if (error instanceof Error && error.name !== 'TimeoutError' && error.name !== 'TypeError') throw error;
      throw new XeroApiError('unavailable', 'Xero could not be reached', 0);
    }
    const raw = await response.text();
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
    if (response.ok) return body as Json | Json[] | null;
    // 404: no such document; 304: nothing changed since If-Modified-Since.
    if (response.status === 404 || response.status === 304) return null;
    const messages = xeroMessages(body);
    throw new XeroApiError(
      failureFor(response.status),
      `Xero answered ${response.status}${messages.length ? `: ${messages.join(' ')}` : ''}`,
      response.status,
      messages,
    );
  };
  const list = (body: Json | Json[] | null, key: string): Json[] =>
    Array.isArray((body as Json | null)?.[key]) ? ((body as Json)[key] as Json[]) : [];
  const first = (body: Json | Json[] | null, key: string): Json => {
    const item = list(body, key)[0];
    if (!item) throw new XeroApiError('unavailable', `Xero returned no ${key}`, 200);
    return item;
  };

  return {
    async tenants(): Promise<XeroTenantRecord[]> {
      const body = await request(XERO_CONNECTIONS);
      return (Array.isArray(body) ? body : [])
        .filter((connection) => connection['tenantType'] === 'ORGANISATION' && text(connection['tenantId']))
        .map((connection) => ({
          tenantId: String(connection['tenantId']),
          tenantName: String(connection['tenantName'] ?? 'Xero organisation'),
        }));
    },

    async accounts(tenantId) {
      const where = encodeURIComponent('Status=="ACTIVE"');
      const body = await request(`${XERO_API}/Accounts?where=${where}&order=Code`, { tenantId });
      return list(body, 'Accounts')
        .filter((account) => text(account['Code']) && account['Type'] !== 'BANK')
        .map((account) => ({
          code: String(account['Code']),
          name: String(account['Name'] ?? account['Code']),
          class: String(account['Class'] ?? ''),
        }));
    },

    async contact(tenantId, contactId) {
      const body = await request(`${XERO_API}/Contacts/${encodeURIComponent(contactId)}`, { tenantId });
      const raw = list(body, 'Contacts')[0];
      return raw ? contactOf(raw) : null;
    },

    async contactsByEmail(tenantId, email) {
      const where = encodeURIComponent(`EmailAddress==${quoted(email)}`);
      const body = await request(`${XERO_API}/Contacts?where=${where}`, { tenantId });
      return list(body, 'Contacts').map(contactOf);
    },

    async createContact(tenantId, contact: XeroContactInput, key) {
      const body = await request(`${XERO_API}/Contacts`, {
        tenantId,
        method: 'POST',
        idempotencyKey: key,
        body: {
          Contacts: [
            {
              Name: contact.name.slice(0, 255),
              ...(contact.email ? { EmailAddress: contact.email } : {}),
              ...(contact.taxNumber ? { TaxNumber: contact.taxNumber } : {}),
              ...(contact.address
                ? { Addresses: [{ AddressType: 'POBOX', AddressLine1: contact.address.slice(0, 500) }] }
                : {}),
            },
          ],
        },
      });
      return contactOf(first(body, 'Contacts'));
    },

    async invoiceByNumber(tenantId, number) {
      const body = await request(`${XERO_API}/Invoices?InvoiceNumbers=${encodeURIComponent(number)}`, { tenantId });
      const found = list(body, 'Invoices')
        .map((raw) => documentOf(raw, 'invoice'))
        // Bills (ACCPAY) carry suppliers' numbers, which may be anything: only sales invoices count.
        .filter((invoice) => invoice.number === number && invoice.type === 'ACCREC' && invoice.status !== 'DELETED');
      return found[0] ?? null;
    },

    async invoice(tenantId, invoiceId) {
      const body = await request(`${XERO_API}/Invoices/${encodeURIComponent(invoiceId)}`, { tenantId });
      const raw = list(body, 'Invoices')[0];
      return raw ? documentOf(raw, 'invoice') : null;
    },

    async createInvoice(tenantId, invoice, key) {
      const body = await request(`${XERO_API}/Invoices`, {
        tenantId,
        method: 'POST',
        idempotencyKey: key,
        body: { Invoices: [documentBody(invoice, 'invoice')] },
      });
      return documentOf(first(body, 'Invoices'), 'invoice');
    },

    async voidInvoice(tenantId, invoiceId) {
      await request(`${XERO_API}/Invoices/${encodeURIComponent(invoiceId)}`, {
        tenantId,
        method: 'POST',
        body: { Invoices: [{ InvoiceID: invoiceId, Status: 'VOIDED' }] },
      });
    },

    async creditNoteByNumber(tenantId, number) {
      const where = encodeURIComponent(`CreditNoteNumber==${quoted(number)}`);
      const body = await request(`${XERO_API}/CreditNotes?where=${where}`, { tenantId });
      const found = list(body, 'CreditNotes')
        .map((raw) => documentOf(raw, 'creditNote'))
        .filter((note) => note.number === number && note.status !== 'DELETED');
      return found[0] ?? null;
    },

    async createCreditNote(tenantId, note, key) {
      const body = await request(`${XERO_API}/CreditNotes`, {
        tenantId,
        method: 'POST',
        idempotencyKey: key,
        body: { CreditNotes: [documentBody(note, 'creditNote')] },
      });
      return documentOf(first(body, 'CreditNotes'), 'creditNote');
    },

    async allocateCreditNote(tenantId, creditNoteId, allocation, key) {
      await request(`${XERO_API}/CreditNotes/${encodeURIComponent(creditNoteId)}/Allocations`, {
        tenantId,
        method: 'PUT',
        idempotencyKey: key,
        body: {
          Allocations: [
            {
              Amount: toAmount(allocation.amountCents),
              Invoice: { InvoiceID: allocation.invoiceId },
              Date: allocation.date,
            },
          ],
        },
      });
    },

    async payments(tenantId, { modifiedSince, page }) {
      const where = encodeURIComponent('PaymentType=="ACCRECPAYMENT"');
      const body = await request(`${XERO_API}/Payments?where=${where}&order=UpdatedDateUTC&page=${page}`, {
        tenantId,
        headers: { 'if-modified-since': modifiedSince.toISOString().slice(0, 19) },
      });
      return list(body, 'Payments')
        .map(paymentOf)
        .filter((payment): payment is XeroPaymentRecord => payment !== null);
    },
  };
}

/** The real port: a client per send function (one per org and call). */
export function httpXero(): XeroPort {
  return { client: (send) => httpXeroClient(send) };
}
