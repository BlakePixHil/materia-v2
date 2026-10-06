import {
  cents,
  DismissReminderInput,
  DomainError,
  formatCents,
  owingCents,
  PAYABLE_STATUSES,
  PAYMENT_CALLABLES,
  PERMISSIONS,
  SendReminderInput,
  type InvoicePayment,
  type Role,
  type SendReminderResult,
} from '@materia/domain';

import { remindersPath } from './debtors';
import { existing, invoicePath } from './invoice-shared';
import { invoiceMail, invoicePdfBytes, MAIL_FAILURE_COPY } from './send';
import { audit } from '../audit/audit';
import { stamp } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { requireFlag } from '../core/flags';
import { liveMatter, matterPath } from '../matters/shared';
import { MailError } from '../ports';

type Data = Record<string, unknown>;

/** Lawyers act on the reminders queued for them; owners and admins on any. */
function mayActOn(reminder: Data, role: Role, uid: string): boolean {
  return role === 'owner' || role === 'admin' || reminder['lawyerUid'] === uid;
}

/**
 * `billing-sendReminder` (BILL-08, ADR-046; `billing.issue`, lawyers only reminders queued for
 * them; flag `billing.invoicing`; idempotent): emails a queued payment reminder, with the message
 * as the lawyer edited it and the invoice's PDF attached when it's ready, to the addresses given.
 * The reminder must still be pending and its invoice still owe something. Then the reminder is
 * `sent` with who, when and to how many. Reminders are only ever sent from here: the nightly job
 * queues them, never sends. Audited as `invoice.reminder_sent` (never the addresses or message).
 */
export const sendReminderDefinition = {
  name: PAYMENT_CALLABLES.sendReminder,
  input: SendReminderInput,
  roles: PERMISSIONS['billing.issue'],
  idempotent: true,
  handler: async (ctx): Promise<SendReminderResult> => {
    const { input, orgId, uid, role, db, clock, requestId, ports, log } = ctx;
    await requireFlag({ orgId, db, clock }, 'billing.invoicing');
    const ref = db.doc(`${remindersPath(orgId)}/${input.reminderId}`);
    const reminder = existing(await ref.get(), 'Reminder');
    if (!mayActOn(reminder, role, uid)) {
      throw new DomainError('PERMISSION_DENIED', 'This reminder is for the matter’s responsible lawyer');
    }
    if (reminder['status'] !== 'pending') {
      throw new DomainError('FAILED_PRECONDITION', 'This reminder was already sent or dismissed');
    }
    const invoiceRef = db.doc(invoicePath(orgId, String(reminder['invoiceId'])));
    const invoice = existing(await invoiceRef.get());
    const matterId = String(invoice['matterId']);
    liveMatter(await db.doc(matterPath(orgId, matterId)).get(), role, matterId);
    const owing = owingCents({
      totalCents: Number(invoice['totalCents'] ?? 0),
      creditedCents: Number(invoice['creditedCents'] ?? 0),
      payments: (invoice['payments'] ?? []) as InvoicePayment[],
    });
    if (!PAYABLE_STATUSES.has(String(invoice['status'])) || owing <= 0) {
      throw new DomainError('FAILED_PRECONDITION', 'Nothing is owing on this invoice any more');
    }

    const { model: base, attachment } = invoiceMail(invoice, await invoicePdfBytes(db, orgId, invoice));
    const model = { ...base, owing: formatCents(cents(owing)), message: input.message.trim(), attached: !!attachment };
    const to = [...new Set(input.to)];
    let sent = 0;
    const record = async () => {
      const now = clock.now();
      await ref.update({
        status: 'sent',
        sentAt: now,
        sentBy: uid,
        sentTo: to.slice(0, sent),
        ...stamp(uid, now, requestId),
      });
    };
    for (const [index, address] of to.entries()) {
      try {
        await ports.mail.send({
          to: address,
          template: 'invoice_reminder',
          model,
          idempotencyKey: `${requestId}-${index}`,
          attachments: attachment ? [attachment] : [],
        });
        sent++;
      } catch (error) {
        log.warn('reminder email not sent', {
          reminderId: ref.id,
          reason: error instanceof MailError ? error.failure : 'unknown',
          sentBefore: sent,
        });
        if (sent) await record();
        const copy = error instanceof MailError ? MAIL_FAILURE_COPY[error.failure] : undefined;
        throw new DomainError(
          error instanceof MailError && error.failure === 'transient' ? 'UNAVAILABLE' : 'FAILED_PRECONDITION',
          copy ?? 'The reminder couldn’t be emailed',
          { sent },
        );
      }
    }
    await record();
    await audit(ctx, {
      action: 'invoice.reminder_sent',
      entity: { path: invoiceRef.path },
      summary: `Payment reminder sent for invoice ${String(invoice['number'])}`,
      data: { reminderId: ref.id, threshold: Number(reminder['threshold']), recipients: sent },
    });
    log.info('reminder sent', { reminderId: ref.id, recipients: sent });
    return { sent };
  },
} satisfies CallableDefinition<typeof SendReminderInput, SendReminderResult>;

/**
 * `billing-dismissReminder` (BILL-08; `billing.issue`, lawyers only reminders queued for them;
 * idempotent): drops a pending reminder without sending it (the client has called, say), with an
 * optional reason. Dismissing one already closed changes nothing.
 */
export const dismissReminderDefinition = {
  name: PAYMENT_CALLABLES.dismissReminder,
  input: DismissReminderInput,
  roles: PERMISSIONS['billing.issue'],
  idempotent: true,
  handler: async (ctx): Promise<{ dismissed: boolean }> => {
    const { input, orgId, uid, role, db, clock, requestId, log } = ctx;
    await requireFlag({ orgId, db, clock }, 'billing.invoicing');
    const ref = db.doc(`${remindersPath(orgId)}/${input.reminderId}`);
    const dismissed = await db.runTransaction(async (tx) => {
      const reminder = existing(await tx.get(ref), 'Reminder');
      if (!mayActOn(reminder, role, uid)) {
        throw new DomainError('PERMISSION_DENIED', 'This reminder is for the matter’s responsible lawyer');
      }
      if (reminder['status'] !== 'pending') return false;
      const now = clock.now();
      tx.update(ref, {
        status: 'dismissed',
        closedAt: now,
        closedBy: uid,
        ...(input.reason ? { closeReason: input.reason } : {}),
        ...stamp(uid, now, requestId),
      });
      return true;
    });
    log.info('reminder dismissed', { reminderId: ref.id, repeat: !dismissed });
    return { dismissed };
  },
} satisfies CallableDefinition<typeof DismissReminderInput, { dismissed: boolean }>;

export const sendReminder = defineCallable(sendReminderDefinition);
export const dismissReminder = defineCallable(dismissReminderDefinition);
