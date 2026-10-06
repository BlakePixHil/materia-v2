import type {
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  Query,
  QuerySnapshot,
  Transaction,
} from 'firebase-admin/firestore';

import {
  DEFAULT_ORG_TIMEZONE,
  DomainError,
  feesOf,
  invoiceBuyer,
  type InvoiceClientLike,
  type InvoiceDisbursementLike,
  type InvoiceEntryLike,
  type InvoiceLine,
  type InvoiceParty,
  type InvoiceSources,
} from '@materia/domain';

import { matterPath } from '../matters/shared';

type Data = Record<string, unknown>;

export const invoicesPath = (orgId: string) => `orgs/${orgId}/invoices`;
export const invoicePath = (orgId: string, invoiceId: string) => `${invoicesPath(orgId)}/${invoiceId}`;
export const creditNotesPath = (orgId: string) => `orgs/${orgId}/creditNotes`;
export const creditNotePath = (orgId: string, creditNoteId: string) => `${creditNotesPath(orgId)}/${creditNoteId}`;

/** Issued invoices that still count (not drafts, not void). */
export const LIVE_INVOICE_STATUSES = new Set(['issued', 'part_paid', 'paid']);

/** Reads through a transaction when there is one, so its reads hold. */
export interface Reader {
  doc(ref: DocumentReference): Promise<DocumentSnapshot>;
  docs(refs: DocumentReference[]): Promise<DocumentSnapshot[]>;
  query(query: Query): Promise<QuerySnapshot>;
}

export function reader(db: Firestore, tx?: Transaction): Reader {
  return tx
    ? {
        doc: (ref) => tx.get(ref),
        docs: (refs) => (refs.length ? tx.getAll(...refs) : Promise.resolve([])),
        query: (query) => tx.get(query),
      }
    : {
        doc: (ref) => ref.get(),
        docs: (refs) => (refs.length ? db.getAll(...refs) : Promise.resolve([])),
        query: (query) => query.get(),
      };
}

/** The org's settings an invoice reads. */
export interface InvoiceOrg {
  name: string;
  abn?: string;
  timeZone: string;
  gstRegistered: boolean;
  unitMinutes?: number;
  invoicePrefix: string;
  paymentTermsDays: number;
}

export function invoiceOrg(data: Data | undefined): InvoiceOrg {
  const billing = (data?.['billing'] ?? {}) as Data;
  return {
    name: typeof data?.['name'] === 'string' ? data['name'] : '',
    ...(typeof data?.['abn'] === 'string' && data['abn'] ? { abn: data['abn'] } : {}),
    timeZone: typeof data?.['timezone'] === 'string' && data['timezone'] ? data['timezone'] : DEFAULT_ORG_TIMEZONE,
    // Unknown is treated as registered: a tax invoice with GST is the safer default for a law firm.
    gstRegistered: billing['gstRegistered'] !== false,
    ...(typeof billing['unitMinutes'] === 'number' ? { unitMinutes: billing['unitMinutes'] } : {}),
    invoicePrefix: typeof billing['invoicePrefix'] === 'string' ? billing['invoicePrefix'] : 'INV-',
    paymentTermsDays: typeof billing['paymentTermsDays'] === 'number' ? billing['paymentTermsDays'] : 14,
  };
}

/** The supplier on a tax invoice: the firm's name and ABN. */
export function supplierOf(org: InvoiceOrg): InvoiceParty {
  return { name: org.name || 'Supplier', ...(org.abn ? { abn: org.abn } : {}) };
}

const entryOf = (snap: DocumentSnapshot): InvoiceEntryLike => {
  const data = snap.data() as Data;
  return {
    id: snap.id,
    uid: String(data['uid'] ?? ''),
    date: String(data['date'] ?? ''),
    units: Number(data['units'] ?? 0),
    rateCents: Number(data['rateCents'] ?? 0),
    amountCents: Number(data['amountCents'] ?? 0),
    narrative: String(data['narrative'] ?? ''),
    billable: data['billable'] === true,
    status: String(data['status'] ?? ''),
    invoiceId: (data['invoiceId'] as string | undefined) ?? null,
    deletedAt: data['deletedAt'] ?? null,
  };
};

const disbursementOf = (snap: DocumentSnapshot): InvoiceDisbursementLike => {
  const data = snap.data() as Data;
  return {
    id: snap.id,
    date: String(data['date'] ?? ''),
    description: String(data['description'] ?? ''),
    payee: typeof data['payee'] === 'string' ? data['payee'] : undefined,
    amountExGstCents: Number(data['amountExGstCents'] ?? 0),
    gstCents: Number(data['gstCents'] ?? 0),
    gstTreatment: String(data['gstTreatment'] ?? 'taxable'),
    status: String(data['status'] ?? ''),
    invoiceId: (data['invoiceId'] as string | undefined) ?? null,
    deletedAt: data['deletedAt'] ?? null,
  };
};

/**
 * What a matter's pre-bill builds from: its draft and final time (drafts only count as "not yet
 * approved"), its unbilled disbursements, who did the work, and the professional fees already
 * billed (issued invoices less their credit notes) that a cap has used.
 */
export async function readInvoiceSources(
  read: Reader,
  db: Firestore,
  orgId: string,
  matterId: string,
  matter: Data,
  org: InvoiceOrg,
): Promise<InvoiceSources> {
  const path = matterPath(orgId, matterId);
  const [entrySnap, disbursementSnap, invoiceSnap, creditSnap] = await Promise.all([
    read.query(db.collection(`${path}/timeEntries`).where('status', 'in', ['draft', 'final'])),
    read.query(db.collection(`${path}/disbursements`).where('status', '==', 'unbilled')),
    read.query(db.collection(invoicesPath(orgId)).where('matterId', '==', matterId)),
    read.query(db.collection(creditNotesPath(orgId)).where('matterId', '==', matterId)),
  ]);
  const entries = entrySnap.docs.map(entryOf);
  const uids = [...new Set(entries.map((entry) => entry.uid).filter(Boolean))];
  const members = await read.docs(uids.map((uid) => db.doc(`orgs/${orgId}/members/${uid}`)));
  const people: Record<string, string> = {};
  for (const member of members) {
    const name = member.get('displayName');
    if (typeof name === 'string' && name) people[member.id] = name;
  }

  const live = new Set<string>();
  let billedFees = 0;
  for (const invoice of invoiceSnap.docs) {
    if (!LIVE_INVOICE_STATUSES.has(String(invoice.get('status')))) continue;
    live.add(invoice.id);
    billedFees += feesOf((invoice.get('lines') ?? []) as InvoiceLine[]);
  }
  for (const note of creditSnap.docs) {
    if (live.has(String(note.get('invoiceId')))) billedFees -= feesOf((note.get('lines') ?? []) as InvoiceLine[]);
  }

  return {
    gstRegistered: org.gstRegistered,
    ...(org.unitMinutes ? { unitMinutes: org.unitMinutes } : {}),
    fee: (matter['fee'] ?? null) as InvoiceSources['fee'],
    entries,
    disbursements: disbursementSnap.docs.map(disbursementOf),
    people,
    billedFeesCents: billedFees,
  };
}

/** The matter's clients, for the buyer and the default "To". */
export async function readClients(
  read: Reader,
  db: Firestore,
  orgId: string,
  matter: Data,
): Promise<InvoiceClientLike[]> {
  const ids = Array.isArray(matter['clientContactIds']) ? (matter['clientContactIds'] as string[]) : [];
  const snaps = await read.docs(ids.map((id) => db.doc(`orgs/${orgId}/contacts/${id}`)));
  return snaps.flatMap((snap) => (snap.exists ? [snap.data() as InvoiceClientLike] : []));
}

export function buyerOf(clients: readonly InvoiceClientLike[]): InvoiceParty {
  return invoiceBuyer(clients);
}

/** The invoice's data, or NOT_FOUND. */
export function existing(snap: DocumentSnapshot, what = 'Invoice'): Data {
  const data = snap.data();
  if (!snap.exists || !data) throw new DomainError('NOT_FOUND', `${what} not found`);
  return data as Data;
}
