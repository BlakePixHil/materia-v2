import { FieldValue, type DocumentReference } from 'firebase-admin/firestore';
import * as z from 'zod';

import {
  DocIdSchema,
  DomainError,
  today,
  XERO_SYNC_ERROR_COPY,
  type DateOnly,
  type XeroSync,
  type XeroSyncError,
} from '@materia/domain';

import { idempotencyKey } from './client';
import { ensureXeroContact } from './contacts';
import { sameDocument, xeroCreditNoteInput, xeroInvoiceInput } from './mapping';
import { notifyUnrecorded, notifyXeroAdmins } from './notices';
import { applyXeroPayments } from './payments';
import { syncIn, xeroOrg, XeroNotReady, type XeroDeps, type XeroOrg } from './shared';
import { creditNotePath, invoicePath } from '../billing/invoice-shared';
import { compact } from '../contacts/shared';
import { errorReportFields } from '../core/log';
import { defineQueue } from '../core/tasks';
import { OAUTH_SECRETS } from '../integrations/providers';
import { XeroApiError } from '../ports';
import { orgTimeZone } from '../templates/shared';

type Data = Record<string, unknown>;

/** The Cloud Tasks queue (and function) that sends documents to Xero. */
export const XERO_PUSH_QUEUE = 'xero-push';

/** Tries before a document is marked "Xero didn't respond" (a rate limit doesn't count). */
export const XERO_PUSH_MAX_ATTEMPTS = 5;

export const XeroPushTaskSchema = z.object({
  orgId: DocIdSchema,
  kind: z.enum(['invoice', 'creditNote']),
  id: DocIdSchema,
});
export type XeroPushTask = z.infer<typeof XeroPushTaskSchema>;

export const xeroDocPath = (task: Pick<XeroPushTask, 'orgId' | 'kind' | 'id'>) =>
  task.kind === 'invoice' ? invoicePath(task.orgId, task.id) : creditNotePath(task.orgId, task.id);

/** Xero already has a different document with the number: reported, never overwritten. */
export class XeroNumberTaken extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XeroNumberTaken';
  }
}

/**
 * Queues one document for Xero. `key` dedupes the task (the same event queues it once); with
 * `markQueued` the document shows "Sending to Xero" until the task runs. An earlier error stays
 * until a send succeeds, so a failure that repeats is only told about once.
 */
export async function queueXeroPush(
  deps: Pick<XeroDeps, 'db' | 'clock' | 'ports'>,
  task: XeroPushTask,
  key: string,
  options: { markQueued?: boolean; scheduleTime?: Date } = {},
): Promise<void> {
  if (options.markQueued) {
    await deps.db.doc(xeroDocPath(task)).update({ 'xero.status': 'queued', 'xero.queuedAt': deps.clock.now() });
  }
  await deps.ports.tasks.enqueue(XERO_PUSH_QUEUE, task, {
    dedupeKey: key,
    ...(options.scheduleTime ? { scheduleTime: options.scheduleTime } : {}),
  });
}

interface Synced {
  xeroId: string;
  contactId: string;
}

/** Writes the document's Xero copy: the whole record for a first send to this organisation, else fields. */
async function writeSync(ref: DocumentReference, fields: Partial<XeroSync>, replace: boolean): Promise<void> {
  if (replace) {
    await ref.update({ xero: compact(fields as Data) });
    return;
  }
  await ref.update(
    Object.fromEntries(Object.entries(compact(fields as Data)).map(([key, value]) => [`xero.${key}`, value])),
  );
}

/** The org's today, which payments are checked against. */
const orgToday = async (deps: XeroDeps, orgId: string): Promise<DateOnly> =>
  today(await orgTimeZone(deps.db, orgId), deps.clock.now());

/**
 * Makes Xero hold the invoice as Materia does (BILL-09, ADR-053): created once (adopting one an
 * earlier send made but didn't record), voided once when Materia voided it, and, when it was
 * already there, with any payments Xero holds brought across. A draft is never sent.
 */
export async function syncInvoice(
  deps: XeroDeps,
  x: XeroOrg,
  invoiceId: string,
  options: { pullPayments?: boolean } = {},
): Promise<Synced | null> {
  const ref = deps.db.doc(invoicePath(x.orgId, invoiceId));
  const data = (await ref.get()).data();
  if (!data || data['status'] === 'draft') return null;
  const tenantId = x.settings.tenantId;
  const sync = syncIn(data, tenantId);
  let xeroId = sync?.id;
  let contactId = sync?.contactId;
  const now = deps.clock.now();

  if (!xeroId || !contactId) {
    contactId = await ensureXeroContact(deps, x, data);
    const input = xeroInvoiceInput(data, contactId, x.settings);
    const found = await x.client.invoiceByNumber(tenantId, input.number);
    if (found) {
      if (!sameDocument(found, input, Number(data['totalCents'] ?? 0))) {
        throw new XeroNumberTaken(
          `Xero already has a different invoice ${input.number}, so Materia left it alone. Check it in Xero, then try again.`,
        );
      }
      xeroId = found.id;
      contactId = found.contactId ?? contactId;
    } else {
      const key = idempotencyKey('invoice', x.orgId, tenantId, invoiceId);
      xeroId = (await x.client.createInvoice(tenantId, input, key)).id;
    }
    await writeSync(ref, { status: 'synced', tenantId, id: xeroId, contactId, syncedAt: now }, true);
  } else if (options.pullPayments !== false && data['status'] !== 'void') {
    // Already there: bring across what Xero holds (a resend after fixing an unrecorded payment).
    const held = await x.client.invoice(tenantId, xeroId);
    if (held?.payments?.length) {
      const applied = await applyXeroPayments(
        deps,
        ref,
        held.payments.map((payment) => ({ ...payment, deleted: false })),
        await orgToday(deps, x.orgId),
      );
      await notifyUnrecorded(deps, x.orgId, { id: invoiceId, number: applied.number }, applied.unrecorded);
    }
  }

  if (data['status'] === 'void' && !sync?.voidedAt) {
    await x.client.voidInvoice(tenantId, xeroId);
    await writeSync(ref, { voidedAt: now }, false);
  }
  return { xeroId, contactId };
}

/**
 * Makes Xero hold the credit note, allocated against its invoice (sent first if it isn't there).
 * Allocating fails in Xero when the invoice there has less owing than the credit (paid in Xero):
 * the note stays unallocated with Xero's reason, to allocate or refund in Xero.
 */
export async function syncCreditNote(deps: XeroDeps, x: XeroOrg, creditNoteId: string): Promise<boolean> {
  const ref = deps.db.doc(creditNotePath(x.orgId, creditNoteId));
  const data = (await ref.get()).data();
  if (!data) return false;
  const invoice = await syncInvoice(deps, x, String(data['invoiceId']), { pullPayments: false });
  if (!invoice) return false;
  const tenantId = x.settings.tenantId;
  const sync = syncIn(data, tenantId);
  let xeroId = sync?.id;
  const now = deps.clock.now();
  if (!xeroId) {
    const input = xeroCreditNoteInput(data, invoice.contactId, x.settings);
    const found = await x.client.creditNoteByNumber(tenantId, input.number);
    if (found) {
      if (!sameDocument(found, input, Number(data['totalCents'] ?? 0))) {
        throw new XeroNumberTaken(
          `Xero already has a different credit note ${input.number}, so Materia left it alone. Check it in Xero, then try again.`,
        );
      }
      xeroId = found.id;
    } else {
      const key = idempotencyKey('credit-note', x.orgId, tenantId, creditNoteId);
      xeroId = (await x.client.createCreditNote(tenantId, input, key)).id;
    }
    await writeSync(ref, { status: 'synced', tenantId, id: xeroId, contactId: invoice.contactId, syncedAt: now }, true);
  }
  if (!sync?.allocatedAt) {
    await x.client.allocateCreditNote(
      tenantId,
      xeroId,
      { invoiceId: invoice.xeroId, amountCents: Number(data['totalCents'] ?? 0), date: String(data['issueDate']) },
      idempotencyKey('allocate', x.orgId, tenantId, creditNoteId),
    );
    await writeSync(ref, { allocatedAt: now }, false);
  }
  return true;
}

/** What a failed send means for the document: its error, whether anyone is told, whether to try again. */
interface Failure {
  code: XeroSyncError;
  message: string;
  notify: boolean;
  retry: boolean;
}

function classify(error: unknown, attempt: number): Failure {
  const lastTry = attempt + 1 >= XERO_PUSH_MAX_ATTEMPTS;
  if (error instanceof XeroNotReady) return { code: error.code, message: error.message, notify: false, retry: false };
  if (error instanceof XeroNumberTaken)
    return { code: 'number_taken', message: error.message, notify: true, retry: false };
  if (error instanceof DomainError && error.code.startsWith('INTEGRATION_')) {
    // The vault already told the owners and admins when the connection stopped working.
    return { code: 'not_connected', message: XERO_SYNC_ERROR_COPY.not_connected, notify: false, retry: false };
  }
  if (error instanceof XeroApiError) {
    if (error.failure === 'rejected' || error.failure === 'not_found') {
      const said = error.messages.join(' ') || (error.failure === 'not_found' ? 'Xero no longer has it.' : '');
      return {
        code: 'rejected',
        message: `${XERO_SYNC_ERROR_COPY.rejected} ${said}`.trim(),
        notify: true,
        retry: false,
      };
    }
    if (error.failure === 'forbidden') {
      return {
        code: 'not_connected',
        message: 'Xero refused access to the chosen organisation. Reconnect Xero and choose it again.',
        notify: true,
        retry: false,
      };
    }
  }
  return { code: 'unavailable', message: XERO_SYNC_ERROR_COPY.unavailable, notify: lastTry, retry: !lastTry };
}

/**
 * Records why the document isn't in Xero, and on the last try tells the owners and admins, unless
 * it had already failed for the same reason (a "Try again" that fails again is told again).
 */
async function recordFailure(deps: XeroDeps, task: XeroPushTask, failure: Failure, final: boolean): Promise<void> {
  const ref = deps.db.doc(xeroDocPath(task));
  const snap = await ref.get();
  if (!snap.exists) return;
  const before = snap.get('xero') as XeroSync | undefined;
  // Already failed for this reason (tries before the last don't count): the owners were told.
  const told = (before?.status === 'failed' || before?.status === 'conflict') && before.error?.code === failure.code;
  const at = deps.clock.now();
  await ref.update({
    ...(final ? { 'xero.status': failure.code === 'number_taken' ? 'conflict' : 'failed' } : {}),
    'xero.error': { code: failure.code, message: failure.message.slice(0, 500), at },
  });
  if (!final || !failure.notify || told) return;
  const number = String(snap.get('number') ?? '');
  const invoiceId = task.kind === 'invoice' ? task.id : String(snap.get('invoiceId'));
  await notifyXeroAdmins(deps, task.orgId, {
    title: `${task.kind === 'invoice' ? 'Invoice' : 'Credit note'} ${number} didn’t reach Xero`,
    body: failure.message,
    link: `/billing/invoices/${invoiceId}`,
    key: `xero-${task.kind}-${task.id}-${failure.code}`,
  });
}

/**
 * `xero-push` (BILL-09): sends one invoice or credit note. A rate limit reschedules it for when
 * Xero says (not counted as a try). Xero refusing it, its number being taken, or Xero not being
 * connected are final: recorded on the document for the person to fix and resend. Anything else
 * is retried with backoff, and recorded as "Xero didn't respond" on the last try.
 */
export async function runXeroPush(task: XeroPushTask, deps: XeroDeps & { attempt: number }): Promise<void> {
  try {
    const x = await xeroOrg(deps, task.orgId);
    const sent =
      task.kind === 'invoice' ? (await syncInvoice(deps, x, task.id)) !== null : await syncCreditNote(deps, x, task.id);
    if (sent) {
      await deps.db.doc(xeroDocPath(task)).update({
        'xero.status': 'synced',
        'xero.error': FieldValue.delete(),
        'xero.queuedAt': FieldValue.delete(),
      });
    }
    deps.log.info('xero push done', { kind: task.kind, sent });
  } catch (error) {
    if (error instanceof DomainError && error.code === 'RATE_LIMITED') {
      const wait = Number((error.details as { retryAfterMs?: unknown } | undefined)?.retryAfterMs ?? 60_000);
      const at = new Date(deps.clock.now().getTime() + Math.min(Math.max(wait, 1_000), 24 * 3_600_000) + 1_000);
      await queueXeroPush(deps, task, `xero-${task.kind}-${task.id}-wait-${at.getTime()}`, { scheduleTime: at });
      deps.log.warn('xero rate limited; rescheduled', { kind: task.kind, waitMs: wait });
      return;
    }
    const failure = classify(error, deps.attempt);
    deps.log.warn('xero push failed', {
      kind: task.kind,
      code: failure.code,
      retry: failure.retry,
      ...errorReportFields(error),
    });
    await recordFailure(deps, task, failure, !failure.retry);
    if (failure.retry) throw error;
  }
}

/** The `xero-push` queue: one document at a time, at most one a second, across all orgs (Xero allows 60 calls a minute per organisation). */
export const push = defineQueue({
  name: XERO_PUSH_QUEUE,
  input: XeroPushTaskSchema,
  retry: { maxAttempts: XERO_PUSH_MAX_ATTEMPTS, minBackoffSeconds: 60, maxBackoffSeconds: 3_600 },
  rateLimits: { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1 },
  secrets: OAUTH_SECRETS,
  handler: (task, { db, ports, log, attempt }) => runXeroPush(task, { db, clock: ports.clock, log, ports, attempt }),
});
