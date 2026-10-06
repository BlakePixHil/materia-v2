import {
  XeroApiError,
  type XeroClient,
  type XeroContactInput,
  type XeroContactRecord,
  type XeroDocumentInput,
  type XeroDocumentRecord,
  type XeroPaymentRecord,
  type XeroPort,
  type XeroTenantRecord,
} from '../ports';

/** The demo organisation the fake connects to. Fictional. */
export const FAKE_XERO_TENANT: XeroTenantRecord = {
  tenantId: '7d0f3b1e-5a6c-4e2b-9f1d-2c3b4a5d6e7f',
  tenantName: 'Harbour & Vine Legal (demo)',
};

interface StoredDocument extends XeroDocumentRecord {
  kind: 'invoice' | 'creditNote';
  tenantId: string;
  lines: XeroDocumentInput['lines'];
  lineAmountTypes: XeroDocumentInput['lineAmountTypes'];
  date: string;
  dueDate?: string;
  allocations: { invoiceId: string; amountCents: number }[];
}

interface StoredPayment extends XeroPaymentRecord {
  tenantId: string;
  updatedAt: Date;
}

type Operation = keyof XeroClient;

/**
 * An in-memory Xero organisation (BILL-09) that enforces what the real one does and the sync
 * depends on: unique active contact names, known account codes, numbers it finds, no voiding with
 * payments, no allocating more than is owed, and idempotency keys. Test hooks add and delete
 * payments and make the next call to an operation fail.
 */
export class FakeXero implements XeroPort, XeroClient {
  tenantList: XeroTenantRecord[] = [FAKE_XERO_TENANT];
  accountList = [
    { code: '200', name: 'Sales', class: 'REVENUE' },
    { code: '260', name: 'Other Revenue', class: 'REVENUE' },
    { code: '270', name: 'Interest Income', class: 'REVENUE' },
    { code: '840', name: 'Disbursements Recoverable', class: 'LIABILITY' },
  ];
  readonly contacts = new Map<string, XeroContactRecord & { tenantId: string; taxNumber?: string }>();
  readonly documents = new Map<string, StoredDocument>();
  readonly paymentsById = new Map<string, StoredPayment>();
  /** Each call made, as `operation` (for asserting what reached Xero). */
  readonly calls: Operation[] = [];
  private readonly results = new Map<string, unknown>();
  private readonly failures = new Map<Operation, Error[]>();
  private sequence = 0;
  now: () => Date = () => new Date();

  client(): XeroClient {
    return this;
  }

  /** The next call to `operation` throws `error` (queued: several calls fail in turn). */
  failNext(operation: Operation, error: Error): void {
    this.failures.set(operation, [...(this.failures.get(operation) ?? []), error]);
  }

  /** A payment made in Xero against an invoice (test hook). */
  addPayment(invoiceId: string, payment: { amountCents: number; date: string; reference?: string }): string {
    const invoice = this.documents.get(invoiceId);
    if (!invoice) throw new Error(`No Xero invoice ${invoiceId}`);
    const id = this.id('payment');
    this.paymentsById.set(id, {
      id,
      invoiceId,
      tenantId: invoice.tenantId,
      date: payment.date,
      amountCents: payment.amountCents,
      ...(payment.reference ? { reference: payment.reference } : {}),
      deleted: false,
      updatedAt: this.now(),
    });
    return id;
  }

  /** Someone deleted the payment in Xero (test hook). */
  deletePayment(paymentId: string): void {
    const payment = this.paymentsById.get(paymentId);
    if (payment) this.paymentsById.set(paymentId, { ...payment, deleted: true, updatedAt: this.now() });
  }

  /** Invoices and credit notes, by number. */
  byNumber(number: string): StoredDocument | undefined {
    return [...this.documents.values()].find((document) => document.number === number);
  }

  private id(kind: string): string {
    this.sequence++;
    return `fake-${kind}-${String(this.sequence).padStart(6, '0')}`;
  }

  private contactRecord(contact: XeroContactRecord): XeroContactRecord {
    return {
      id: contact.id,
      name: contact.name,
      ...(contact.email ? { email: contact.email } : {}),
      archived: contact.archived,
    };
  }

  private enter(operation: Operation, tenantId?: string): void {
    this.calls.push(operation);
    const queued = this.failures.get(operation);
    const error = queued?.shift();
    if (error) throw error;
    if (tenantId !== undefined && !this.tenantList.some((tenant) => tenant.tenantId === tenantId)) {
      throw new XeroApiError('forbidden', 'Xero answered 403: AuthenticationUnsuccessful', 403);
    }
  }

  private once<T>(key: string, make: () => T): T {
    if (this.results.has(key)) return this.results.get(key) as T;
    const result = make();
    this.results.set(key, result);
    return result;
  }

  private rejected(...messages: string[]): XeroApiError {
    return new XeroApiError('rejected', `Xero answered 400: ${messages.join(' ')}`, 400, messages);
  }

  private paidCents(invoiceId: string): number {
    return [...this.paymentsById.values()]
      .filter((payment) => payment.invoiceId === invoiceId && !payment.deleted)
      .reduce((sum, payment) => sum + payment.amountCents, 0);
  }

  /** What is still owed on an invoice in Xero: its total less payments and allocated credit. */
  amountDueCents(invoiceId: string): number {
    const invoice = this.documents.get(invoiceId);
    if (!invoice) return 0;
    const credited = [...this.documents.values()]
      .flatMap((document) => document.allocations)
      .filter((allocation) => allocation.invoiceId === invoiceId)
      .reduce((sum, allocation) => sum + allocation.amountCents, 0);
    return invoice.totalCents - this.paidCents(invoiceId) - credited;
  }

  private store(kind: 'invoice' | 'creditNote', tenantId: string, input: XeroDocumentInput): StoredDocument {
    const contact = this.contacts.get(input.contactId);
    if (!contact || contact.tenantId !== tenantId) throw this.rejected('The contact could not be found.');
    for (const line of input.lines) {
      if (!this.accountList.some((account) => account.code === line.accountCode)) {
        throw this.rejected(`Account code '${line.accountCode}' is not a valid code for this document.`);
      }
    }
    const subtotal = input.lines.reduce((sum, line) => sum + Math.round(line.quantity * line.unitAmountCents), 0);
    const tax =
      input.lineAmountTypes === 'NoTax' ? 0 : input.lines.reduce((sum, line) => sum + (line.taxAmountCents ?? 0), 0);
    const document: StoredDocument = {
      kind,
      tenantId,
      id: this.id(kind === 'invoice' ? 'inv' : 'cred'),
      number: input.number,
      type: kind === 'invoice' ? 'ACCREC' : 'ACCRECCREDIT',
      status: 'AUTHORISED',
      ...(input.reference ? { reference: input.reference } : {}),
      totalCents: subtotal + tax,
      contactId: input.contactId,
      lines: input.lines,
      lineAmountTypes: input.lineAmountTypes,
      date: input.date,
      ...(input.dueDate ? { dueDate: input.dueDate } : {}),
      allocations: [],
    };
    this.documents.set(document.id, document);
    return document;
  }

  private record(document: StoredDocument): XeroDocumentRecord {
    const { id, number, type, status, reference, totalCents, contactId } = document;
    return {
      id,
      number,
      type,
      status,
      ...(reference ? { reference } : {}),
      totalCents,
      ...(contactId ? { contactId } : {}),
    };
  }

  async tenants() {
    this.enter('tenants');
    return [...this.tenantList];
  }

  async accounts(tenantId: string) {
    this.enter('accounts', tenantId);
    return [...this.accountList];
  }

  async contact(tenantId: string, contactId: string) {
    this.enter('contact', tenantId);
    const contact = this.contacts.get(contactId);
    if (!contact || contact.tenantId !== tenantId) return null;
    return this.contactRecord(contact);
  }

  async contactsByEmail(tenantId: string, email: string) {
    this.enter('contactsByEmail', tenantId);
    return [...this.contacts.values()]
      .filter((contact) => contact.tenantId === tenantId && contact.email?.toLowerCase() === email.toLowerCase())
      .map((contact) => this.contactRecord(contact));
  }

  async createContact(tenantId: string, input: XeroContactInput, key: string) {
    this.enter('createContact', tenantId);
    return this.once(`contact:${key}`, () => {
      const taken = [...this.contacts.values()].some(
        (contact) => contact.tenantId === tenantId && !contact.archived && contact.name === input.name,
      );
      if (taken) {
        throw this.rejected(
          `The contact name ${input.name} is already assigned to another contact. The contact name must be unique across all active contacts.`,
        );
      }
      const record: XeroContactRecord = {
        id: this.id('cont'),
        name: input.name,
        ...(input.email ? { email: input.email } : {}),
        archived: false,
      };
      this.contacts.set(record.id, { ...record, tenantId, ...(input.taxNumber ? { taxNumber: input.taxNumber } : {}) });
      return record;
    });
  }

  async invoiceByNumber(tenantId: string, number: string) {
    this.enter('invoiceByNumber', tenantId);
    const found = [...this.documents.values()].find(
      (document) =>
        document.kind === 'invoice' &&
        document.tenantId === tenantId &&
        document.number === number &&
        document.status !== 'DELETED',
    );
    return found ? this.record(found) : null;
  }

  async invoice(tenantId: string, invoiceId: string) {
    this.enter('invoice', tenantId);
    const found = this.documents.get(invoiceId);
    if (!found || found.kind !== 'invoice' || found.tenantId !== tenantId) return null;
    const payments = [...this.paymentsById.values()]
      .filter((payment) => payment.invoiceId === invoiceId && !payment.deleted)
      .map(({ id, date, amountCents, reference }) => ({ id, date, amountCents, ...(reference ? { reference } : {}) }));
    return { ...this.record(found), payments };
  }

  async createInvoice(tenantId: string, input: XeroDocumentInput, key: string) {
    this.enter('createInvoice', tenantId);
    return this.once(`invoice:${key}`, () => this.record(this.store('invoice', tenantId, input)));
  }

  async voidInvoice(tenantId: string, invoiceId: string) {
    this.enter('voidInvoice', tenantId);
    const invoice = this.documents.get(invoiceId);
    if (!invoice || invoice.tenantId !== tenantId) throw new XeroApiError('not_found', 'Xero answered 404', 404);
    if (this.paidCents(invoiceId) > 0) {
      throw this.rejected('This document cannot be voided as it has payments allocated to it.');
    }
    this.documents.set(invoiceId, { ...invoice, status: 'VOIDED' });
  }

  async creditNoteByNumber(tenantId: string, number: string) {
    this.enter('creditNoteByNumber', tenantId);
    const found = [...this.documents.values()].find(
      (document) =>
        document.kind === 'creditNote' &&
        document.tenantId === tenantId &&
        document.number === number &&
        document.status !== 'DELETED',
    );
    return found ? this.record(found) : null;
  }

  async createCreditNote(tenantId: string, input: XeroDocumentInput, key: string) {
    this.enter('createCreditNote', tenantId);
    return this.once(`credit:${key}`, () => this.record(this.store('creditNote', tenantId, input)));
  }

  async allocateCreditNote(
    tenantId: string,
    creditNoteId: string,
    allocation: { invoiceId: string; amountCents: number; date: string },
    key: string,
  ) {
    this.enter('allocateCreditNote', tenantId);
    this.once(`allocate:${key}`, () => {
      const note = this.documents.get(creditNoteId);
      if (!note || note.tenantId !== tenantId) throw new XeroApiError('not_found', 'Xero answered 404', 404);
      if (allocation.amountCents > this.amountDueCents(allocation.invoiceId)) {
        throw this.rejected('The amount allocated exceeds the outstanding amount on the invoice.');
      }
      note.allocations.push({ invoiceId: allocation.invoiceId, amountCents: allocation.amountCents });
      return true;
    });
  }

  async payments(tenantId: string, options: { modifiedSince: Date; page: number }) {
    this.enter('payments', tenantId);
    const all = [...this.paymentsById.values()]
      .filter((payment) => payment.tenantId === tenantId && payment.updatedAt >= options.modifiedSince)
      .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
    return all.slice((options.page - 1) * 100, options.page * 100).map((payment): XeroPaymentRecord => ({
      id: payment.id,
      invoiceId: payment.invoiceId,
      date: payment.date,
      amountCents: payment.amountCents,
      ...(payment.reference ? { reference: payment.reference } : {}),
      deleted: payment.deleted,
      updatedAt: payment.updatedAt,
    }));
  }
}
