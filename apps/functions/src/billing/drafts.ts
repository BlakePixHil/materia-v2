import {
  buildInvoice,
  DeleteInvoiceDraftInput,
  DomainError,
  Invoice,
  INVOICE_CALLABLES,
  PERMISSIONS,
  SaveInvoiceDraftInput,
  type InvoiceDraftFieldsInput,
  type SaveInvoiceDraftResult,
} from '@materia/domain';

import { existing, invoiceOrg, invoicePath, invoicesPath, readInvoiceSources, reader } from './invoice-shared';
import { compact, stamp } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { requireFlag } from '../core/flags';
import { liveMatter, matterPath } from '../matters/shared';

type Data = Record<string, unknown>;

/** A stored instant (a Firestore Timestamp) as a Date. */
const asDate = (value: unknown): Date | undefined =>
  value instanceof Date
    ? value
    : typeof (value as { toDate?: unknown } | undefined)?.toDate === 'function'
      ? (value as { toDate: () => Date }).toDate()
      : undefined;

/** The choices stored on a draft, as the builder takes them. */
export function draftFields(draft: Data | undefined, paymentTermsDays: number): InvoiceDraftFieldsInput {
  return compact({
    from: draft?.['from'] as string | undefined,
    to: draft?.['to'] as string | undefined,
    grouping: (draft?.['grouping'] as 'itemised' | 'summary' | undefined) ?? 'itemised',
    excludedTimeEntryIds: (draft?.['excludedTimeEntryIds'] as string[] | undefined) ?? [],
    excludedDisbursementIds: (draft?.['excludedDisbursementIds'] as string[] | undefined) ?? [],
    extraLines: (draft?.['extraLines'] as InvoiceDraftFieldsInput['extraLines']) ?? [],
    notes: (draft?.['notes'] as string | undefined) ?? '',
    paymentTermsDays: typeof draft?.['paymentTermsDays'] === 'number' ? draft['paymentTermsDays'] : paymentTermsDays,
    paidFromTrust: draft?.['paidFromTrust'] === true ? true : undefined,
  }) as InvoiceDraftFieldsInput;
}

/**
 * `billing-saveDraft` (BILL-07; `billing.issue`, flag `billing.invoicing`, idempotent): creates a
 * matter's pre-bill, or saves a draft's choices (the date range, items left out, grouping, fixed
 * fees and adjustments, notes, payment terms). Either way the lines are built on the server from
 * the matter's time and disbursements as they are now (`buildInvoice`), so saving again is how a
 * pre-bill "refreshes" items changed since they were added. A draft can't move to another matter.
 */
export const saveDraftDefinition = {
  name: INVOICE_CALLABLES.saveDraft,
  input: SaveInvoiceDraftInput,
  roles: PERMISSIONS['billing.issue'],
  idempotent: true,
  handler: async ({ input, orgId, uid, role, db, clock, requestId, log }): Promise<SaveInvoiceDraftResult> => {
    await requireFlag({ orgId, db, clock }, 'billing.invoicing');
    const read = reader(db);
    const [matterSnap, orgSnap, draftSnap] = await Promise.all([
      db.doc(matterPath(orgId, input.matterId)).get(),
      db.doc(`orgs/${orgId}`).get(),
      input.invoiceId ? db.doc(invoicePath(orgId, input.invoiceId)).get() : Promise.resolve(null),
    ]);
    const matter = liveMatter(matterSnap, role, input.matterId);
    const org = invoiceOrg(orgSnap.data());
    const draft = draftSnap ? existing(draftSnap) : undefined;
    if (draft && draft['status'] !== 'draft') {
      throw new DomainError('FAILED_PRECONDITION', 'Only a pre-bill can be changed; this invoice is issued');
    }
    if (draft && draft['matterId'] !== input.matterId) {
      throw new DomainError('INVALID_ARGUMENT', 'A pre-bill stays on its matter', { field: 'matterId' });
    }

    const fields = { ...draftFields(draft, org.paymentTermsDays), ...compact(input.fields as Data) };
    const build = buildInvoice(fields, await readInvoiceSources(read, db, orgId, input.matterId, matter, org));
    const now = clock.now();
    const ref = draftSnap ? draftSnap.ref : db.collection(invoicesPath(orgId)).doc();
    const doc = Invoice.schema.parse(
      compact({
        number: '',
        matterId: input.matterId,
        matterNumber: matter['number'] as string | undefined,
        matterTitle: matter['title'] as string | undefined,
        ...fields,
        lines: build.lines,
        itemisation: build.itemisation,
        subtotalCents: build.subtotalCents,
        gstCents: build.gstCents,
        totalCents: build.totalCents,
        timeEntryIds: build.timeEntryIds,
        disbursementIds: build.disbursementIds,
        gstRegistered: org.gstRegistered,
        status: 'draft',
        creditNoteIds: [],
        creditedCents: 0,
        payments: [],
        createdAt: asDate(draft?.['createdAt']) ?? now,
        createdBy: (draft?.['createdBy'] as string | undefined) ?? uid,
        ...stamp(uid, now, requestId),
        schemaVersion: Invoice.version,
      }),
    );
    // A full replace: cleared choices (a removed date range or itemisation) don't linger.
    await ref.set(doc);
    log.info('pre-bill saved', {
      invoiceId: ref.id,
      matterId: input.matterId,
      created: !draft,
      lines: build.lines.length,
      warnings: build.warnings,
    });
    return { invoiceId: ref.id, totalCents: build.totalCents, warnings: build.warnings };
  },
} satisfies CallableDefinition<typeof SaveInvoiceDraftInput, SaveInvoiceDraftResult>;

export const saveDraft = defineCallable(saveDraftDefinition);

/**
 * `billing-deleteDraft` (BILL-07; `billing.issue`, idempotent): deletes a pre-bill. It has no
 * number and has billed nothing, so nothing else changes. Issued invoices are voided, never deleted.
 */
export const deleteDraftDefinition = {
  name: INVOICE_CALLABLES.deleteDraft,
  input: DeleteInvoiceDraftInput,
  roles: PERMISSIONS['billing.issue'],
  idempotent: true,
  handler: async ({ input, orgId, role, db, clock, log }): Promise<{ deleted: boolean }> => {
    await requireFlag({ orgId, db, clock }, 'billing.invoicing');
    const ref = db.doc(invoicePath(orgId, input.invoiceId));
    const deleted = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      if (snap.get('status') !== 'draft') {
        throw new DomainError('FAILED_PRECONDITION', 'An issued invoice can’t be deleted; void it instead');
      }
      liveMatter(
        await tx.get(db.doc(matterPath(orgId, String(snap.get('matterId'))))),
        role,
        String(snap.get('matterId')),
      );
      tx.delete(ref);
      return true;
    });
    log.info('pre-bill deleted', { invoiceId: input.invoiceId, deleted });
    return { deleted };
  },
} satisfies CallableDefinition<typeof DeleteInvoiceDraftInput, { deleted: boolean }>;

export const deleteDraft = defineCallable(deleteDraftDefinition);
