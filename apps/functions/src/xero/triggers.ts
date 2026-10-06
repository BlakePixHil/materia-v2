import { queueXeroPush } from './push';
import { syncIn, xeroSettingsOf, xeroStatusPath } from './shared';
import { isEnabled } from '../core/flags';
import { defineTrigger, type TriggerContext, type TriggerDefinition } from '../core/trigger';

type Data = Record<string, unknown>;

/**
 * Whether the org sends to Xero as things happen: the flag on, an organisation chosen, sending
 * on issue turned on, and a connection that isn't deliberately disconnected (one that needs
 * reconnecting still queues, so each document shows why it didn't go).
 */
async function autoPushSettings(ctx: TriggerContext, orgId: string) {
  if (!(await isEnabled({ orgId, db: ctx.db, clock: ctx.clock }, 'integrations.xero'))) return null;
  const settings = xeroSettingsOf((await ctx.db.doc(`orgs/${orgId}`).get()).data());
  if (!settings?.autoPush) return null;
  const status = (await ctx.db.doc(xeroStatusPath(orgId)).get()).get('status');
  return status === 'connected' || status === 'reconnect_required' ? settings : null;
}

/**
 * `xero-onInvoice` (BILL-09): an invoice issued on or after the "send from" date is queued for
 * Xero, and so is a void of one Xero has (or would have). Only these status changes count: the
 * sync's own writes, payments and PDF bookkeeping are ignored.
 */
export const onInvoiceDefinition: TriggerDefinition = {
  name: 'xero-onInvoice',
  document: 'orgs/{orgId}/invoices/{invoiceId}',
  on: 'written',
  handler: async (change, ctx) => {
    const before = change.before?.data() as Data | undefined;
    const after = change.after?.data() as Data | undefined;
    if (!after) return;
    const issued = before?.['status'] === 'draft' && after['status'] !== 'draft';
    const voided = after['status'] === 'void' && before?.['status'] !== 'void' && before?.['status'] !== 'draft';
    if (!issued && !voided) return;
    const orgId = ctx.params['orgId'] as string;
    const invoiceId = ctx.params['invoiceId'] as string;
    const settings = await autoPushSettings(ctx, orgId);
    if (!settings) return;
    const sent = !!syncIn(after, settings.tenantId)?.id;
    if (!sent && String(after['issueDate'] ?? '') < settings.sendFrom) return;
    await queueXeroPush(
      { db: ctx.db, clock: ctx.clock, ports: ctx.ports },
      { orgId, kind: 'invoice', id: invoiceId },
      `xero-invoice-${invoiceId}-${String(after['status'])}`,
      { markQueued: true },
    );
  },
};

/**
 * `xero-onCreditNote` (BILL-09): a new credit note is queued for Xero when its invoice is there,
 * or would be (issued on or after the "send from" date).
 */
export const onCreditNoteDefinition: TriggerDefinition = {
  name: 'xero-onCreditNote',
  document: 'orgs/{orgId}/creditNotes/{creditNoteId}',
  on: 'created',
  handler: async (change, ctx) => {
    const note = change.after?.data() as Data | undefined;
    if (!note) return;
    const orgId = ctx.params['orgId'] as string;
    const creditNoteId = ctx.params['creditNoteId'] as string;
    const settings = await autoPushSettings(ctx, orgId);
    if (!settings) return;
    const invoice = (await ctx.db.doc(`orgs/${orgId}/invoices/${String(note['invoiceId'])}`).get()).data();
    const sent = !!syncIn(invoice, settings.tenantId)?.id;
    if (!sent && String(invoice?.['issueDate'] ?? '') < settings.sendFrom) return;
    await queueXeroPush(
      { db: ctx.db, clock: ctx.clock, ports: ctx.ports },
      { orgId, kind: 'creditNote', id: creditNoteId },
      `xero-creditNote-${creditNoteId}`,
      { markQueued: true },
    );
  },
};

export const onInvoice = defineTrigger(onInvoiceDefinition);
export const onCreditNote = defineTrigger(onCreditNoteDefinition);
