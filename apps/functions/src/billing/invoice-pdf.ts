import {
  DomainError,
  invoicePdfData,
  invoicePdfName,
  INVOICE_CALLABLES,
  PERMISSIONS,
  RetryInvoicePdfInput,
  type InvoiceItem,
  type InvoiceLine,
  type InvoiceParty,
  type RetryInvoicePdfResult,
} from '@materia/domain';

import { creditNotePath, existing, invoicePath, LIVE_INVOICE_STATUSES } from './invoice-shared';
import { stamp } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { requireFlag } from '../core/flags';
import { defineTrigger, type TriggerChange, type TriggerContext, type TriggerDefinition } from '../core/trigger';
import { createJob, type CreateJobContext } from '../jobs/start-pdf';
import { liveMatter, matterPath } from '../matters/shared';

type Data = Record<string, unknown>;

/** The template in `apps/jobs/templates` (FND-24). */
export const INVOICE_TEMPLATE = 'invoice';

/** Which document a render is for, carried in the job's data so its outcome finds its way back. */
const DOCUMENT_REF = /^(invoices|creditNotes)\/([^/]+)$/;

/** An issued invoice or credit note, as stored. */
interface StoredDocument extends Data {
  number: string;
  matterId: string;
  issueDate?: string;
  dueDate?: string;
  lines: InvoiceLine[];
  itemisation?: InvoiceItem[];
  subtotalCents: number;
  gstCents: number;
  totalCents: number;
  gstRegistered?: boolean;
  supplier?: InvoiceParty;
  buyer?: InvoiceParty;
  notes?: string;
  paymentTermsDays?: number;
  matterNumber?: string;
  matterTitle?: string;
  invoiceNumber?: string;
  reason?: string;
  trustNotice?: { version: number; text: string };
}

/**
 * Renders an issued invoice's or credit note's PDF into its matter's documents (`financial`,
 * privileged when the matter is) and records the job on it (`pdfStatus: pending`). A job that
 * can't start leaves the document `failed`, never undone: a render failure is retried, not voided.
 */
export async function startDocumentPdf(
  ctx: CreateJobContext,
  kind: 'invoice' | 'credit_note',
  id: string,
  doc: StoredDocument,
  matter: Data,
): Promise<string | null> {
  const path = kind === 'invoice' ? invoicePath(ctx.orgId, id) : creditNotePath(ctx.orgId, id);
  const ref = ctx.db.doc(path);
  const data = {
    ...invoicePdfData(
      { ...doc, matterNumber: doc.matterNumber ?? (matter['number'] as string | undefined) },
      kind === 'credit_note' ? { invoiceNumber: doc.invoiceNumber ?? '', reason: doc.reason ?? '' } : undefined,
    ),
    documentRef: `${kind === 'invoice' ? 'invoices' : 'creditNotes'}/${id}`,
  };
  try {
    const { jobId } = await createJob(ctx, {
      type: 'pdf.render',
      input: { templateId: INVOICE_TEMPLATE, data },
      target: {
        kind: 'matter',
        matterId: doc.matterId,
        name: invoicePdfName(kind, doc.number, doc.gstRegistered !== false),
        category: 'financial',
        privileged: matter['privileged'] === true,
      },
    });
    await ref.update({ pdfStatus: 'pending', pdfJobId: jobId, ...stamp(ctx.uid, ctx.clock.now(), ctx.requestId) });
    return jobId;
  } catch (error) {
    ctx.log.warn('pdf did not start', { kind, id, code: error instanceof DomainError ? error.code : 'unknown' });
    await ref.update({ pdfStatus: 'failed', ...stamp(ctx.uid, ctx.clock.now(), ctx.requestId) });
    return null;
  }
}

/**
 * `billing-retryPdf` (BILL-07; `billing.issue`, idempotent): renders an issued invoice's or credit
 * note's PDF again after it failed (or never started). One that is rendering or ready is left alone.
 */
export const retryPdfDefinition = {
  name: INVOICE_CALLABLES.retryPdf,
  input: RetryInvoicePdfInput,
  roles: PERMISSIONS['billing.issue'],
  idempotent: true,
  handler: async (ctx): Promise<RetryInvoicePdfResult> => {
    const { input, orgId, role, db, clock } = ctx;
    await requireFlag({ orgId, db, clock }, 'billing.invoicing');
    const kind = input.invoiceId ? 'invoice' : 'credit_note';
    const id = (input.invoiceId ?? input.creditNoteId) as string;
    const path = kind === 'invoice' ? invoicePath(orgId, id) : creditNotePath(orgId, id);
    const doc = existing(await db.doc(path).get(), kind === 'invoice' ? 'Invoice' : 'Credit note') as StoredDocument;
    if (kind === 'invoice' && !LIVE_INVOICE_STATUSES.has(String(doc['status']))) {
      throw new DomainError('FAILED_PRECONDITION', 'Only an issued invoice has a PDF');
    }
    if (doc['pdfStatus'] === 'ready' || doc['pdfStatus'] === 'pending') {
      throw new DomainError('FAILED_PRECONDITION', 'The PDF is already rendering or ready');
    }
    const matter = liveMatter(await db.doc(matterPath(orgId, doc.matterId)).get(), role, doc.matterId);
    const jobId = await startDocumentPdf(ctx, kind, id, doc, matter);
    if (!jobId) throw new DomainError('UNAVAILABLE', 'The PDF could not be started; try again shortly');
    return { jobId };
  },
} satisfies CallableDefinition<typeof RetryInvoicePdfInput, RetryInvoicePdfResult>;

export const retryPdf = defineCallable(retryPdfDefinition);

/**
 * `billing-onPdfJob` (BILL-07), on writes of `orgs/{orgId}/jobs/{jobId}`: when an `invoice` render
 * finishes, its invoice or credit note becomes `ready` with the matter document (`pdfDocumentId`)
 * or `failed` (the detail page offers a retry). A job that is no longer the document's latest
 * render (a retry replaced it) is ignored.
 */
export async function recordPdfOutcome(change: TriggerChange, ctx: TriggerContext): Promise<string | null> {
  const after = change.after?.data() as Data | undefined;
  const before = change.before?.data() as Data | undefined;
  if (!after || after['status'] === before?.['status']) return null;
  if (after['status'] !== 'succeeded' && after['status'] !== 'failed') return null;
  const input = after['input'] as { templateId?: unknown; data?: { documentRef?: unknown } } | undefined;
  if (input?.templateId !== INVOICE_TEMPLATE) return null;
  const match = DOCUMENT_REF.exec(String(input.data?.documentRef ?? ''));
  if (!match) return null;
  const orgId = ctx.params['orgId'] as string;
  const jobId = ctx.params['jobId'] as string;
  const ref = ctx.db.doc(`orgs/${orgId}/${match[1]}/${match[2]}`);
  const output = after['output'] as { documentId?: unknown } | undefined;
  const succeeded = after['status'] === 'succeeded' && typeof output?.documentId === 'string';
  const outcome = await ctx.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get('pdfJobId') !== jobId) return null;
    tx.update(ref, {
      pdfStatus: succeeded ? 'ready' : 'failed',
      ...(succeeded ? { pdfDocumentId: output?.documentId } : {}),
      updatedAt: ctx.time,
      updatedBy: 'system',
    });
    return succeeded ? 'ready' : 'failed';
  });
  ctx.log.info('invoice pdf recorded', { jobId, kind: match[1], outcome });
  return outcome;
}

export const onPdfJobDefinition: TriggerDefinition = {
  name: 'billing-onPdfJob',
  document: 'orgs/{orgId}/jobs/{jobId}',
  on: 'written',
  handler: async (change, ctx) => void (await recordPdfOutcome(change, ctx)),
};

export const onPdfJob = defineTrigger(onPdfJobDefinition);
