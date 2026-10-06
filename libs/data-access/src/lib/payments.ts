import * as z from 'zod';

import {
  DebtorsSnapshotSchema,
  InvoiceReminder,
  PAYMENT_CALLABLES,
  type DismissReminderInput,
  type RecordPaymentInput,
  type RecordPaymentResult,
  type RefreshDebtorsInput,
  type RefreshDebtorsResult,
  type ReversePaymentInput,
  type ReversePaymentResult,
  type SendReminderInput,
  type SendReminderResult,
} from '@materia/domain';

import type { CallableClient } from './callable-client';
import type { QuerySpec } from './query';
import { repo, type Repository } from './repository';

/**
 * The aged-debtors report as saved (`orgs/{orgId}/metrics/debtors-{date}`, BILL-08): the bucket
 * totals and the matters. Readable by billing.view roles; written only by Functions.
 */
export const DebtorsMetricsSchema = /* @__PURE__ */ z.object({
  period: z.string(),
  values: z.record(z.string(), z.number()).default({}),
  debtors: DebtorsSnapshotSchema.optional(),
  updatedAt: z.date().optional(),
});
export type DebtorsMetrics = z.infer<typeof DebtorsMetricsSchema>;

export function debtorsRepository(): Repository<DebtorsMetrics> {
  return repo((orgId) => `orgs/${orgId}/metrics`, { schema: DebtorsMetricsSchema, version: 1 });
}

/** The newest aged-debtors report (period ids sort by date). */
export const LATEST_DEBTORS_QUERY: QuerySpec<DebtorsMetrics> = {
  where: [
    ['period', '>=', 'debtors-'],
    ['period', '<', 'debtors.'],
  ],
  orderBy: [['period', 'desc']],
  pageSize: 1,
};

const reminder = InvoiceReminder.schema.shape;

/** A queued payment reminder as the debtors screen reads it (BILL-08). */
export const ReminderItemSchema = /* @__PURE__ */ z.object({
  invoiceId: reminder.invoiceId,
  invoiceNumber: reminder.invoiceNumber,
  matterId: reminder.matterId,
  matterNumber: reminder.matterNumber,
  matterTitle: reminder.matterTitle,
  clientName: reminder.clientName,
  threshold: reminder.threshold,
  dueDate: reminder.dueDate,
  balanceCents: reminder.balanceCents,
  lawyerUid: reminder.lawyerUid,
  to: reminder.to,
  status: reminder.status,
  sentAt: reminder.sentAt,
  createdAt: reminder.createdAt.optional(),
});
export type ReminderItem = z.infer<typeof ReminderItemSchema>;

/** `orgs/{orgId}/invoiceReminders` (BILL-08). Read-only: sent or dismissed through `paymentCallables`. */
export function reminderRepository(): Repository<ReminderItem> {
  return repo((orgId) => `orgs/${orgId}/invoiceReminders`, {
    schema: ReminderItemSchema,
    version: InvoiceReminder.version,
  });
}

/** The reminders waiting to be sent (sorted on screen: one equality filter needs no index). */
export const PENDING_REMINDERS_QUERY: QuerySpec<ReminderItem> = {
  where: [['status', '==', 'pending']],
  pageSize: 200,
};

type Input<T> = Omit<T, 'requestId'>;
type Options = { requestId?: string };

/** The `billing-*` payment, debtors and reminder callables (BILL-08). */
export interface PaymentCallables {
  /** `billing-recordPayment`: a payment received, or (owners and admins) a refund of credit held. */
  record(input: Input<RecordPaymentInput>, options?: Options): Promise<RecordPaymentResult>;
  /** `billing-reversePayment` (owners and admins): a bounced cheque, or one recorded in error. */
  reverse(input: Input<ReversePaymentInput>, options?: Options): Promise<ReversePaymentResult>;
  /** `billing-refreshDebtors`: works the aged-debtors report out now. */
  refreshDebtors(input?: Input<RefreshDebtorsInput>, options?: Options): Promise<RefreshDebtorsResult>;
  /** `billing-sendReminder`: emails a queued reminder as edited. Never automatic. */
  sendReminder(input: Input<SendReminderInput>, options?: Options): Promise<SendReminderResult>;
  /** `billing-dismissReminder`: drops a queued reminder unsent. */
  dismissReminder(input: Input<DismissReminderInput>, options?: Options): Promise<{ dismissed: boolean }>;
}

export function paymentCallables(client: Pick<CallableClient, 'call'>): PaymentCallables {
  const call =
    <I extends object, O>(name: string) =>
    (input: I = {} as I, options: Options = {}) =>
      client.call<I, O>(name, input, { idempotent: true, ...options });
  return {
    record: call(PAYMENT_CALLABLES.record),
    reverse: call(PAYMENT_CALLABLES.reverse),
    refreshDebtors: call(PAYMENT_CALLABLES.refreshDebtors),
    sendReminder: call(PAYMENT_CALLABLES.sendReminder),
    dismissReminder: call(PAYMENT_CALLABLES.dismissReminder),
  };
}
