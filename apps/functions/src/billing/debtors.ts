import type { DocumentSnapshot, Firestore } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';

import {
  debtorsPeriod,
  debtorsReport,
  debtorsValues,
  owingCents,
  PAYABLE_STATUSES,
  PAYMENT_CALLABLES,
  PERMISSIONS,
  RefreshDebtorsInput,
  reminderId,
  reminderThreshold,
  today,
  type DateOnly,
  type DebtorInvoiceLike,
  type DebtorsReport,
  type InvoicePayment,
  type RefreshDebtorsResult,
} from '@materia/domain';

import { invoicesPath } from './invoice-shared';
import { REGION } from '../config';
import { compact, isDeleted } from '../contacts/shared';
import { adminDb } from '../core/admin';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { orgClock } from '../core/emulator-clock';
import { isEnabled, requireFlag } from '../core/flags';
import { createLog, functionsSink, type Log } from '../core/log';
import { defineTrigger, type TriggerDefinition } from '../core/trigger';
import { matterPath } from '../matters/shared';
import type { Clock } from '../ports';
import { systemClock } from '../ports/container';
import { orgTimeZone } from '../templates/shared';

type Data = Record<string, unknown>;

export const remindersPath = (orgId: string) => `orgs/${orgId}/invoiceReminders`;

/** Invoices that may still owe something: issued or part paid (paid ones owe nothing; a credit is a refund, not a debt). */
const OWING_STATUSES = ['issued', 'part_paid'];

type OwingInvoice = DebtorInvoiceLike & { number: string };

const invoiceOf = (snap: DocumentSnapshot): OwingInvoice => {
  const data = snap.data() as Data;
  return {
    id: snap.id,
    number: String(data['number'] ?? ''),
    matterId: String(data['matterId'] ?? ''),
    matterNumber: data['matterNumber'] as string | undefined,
    matterTitle: data['matterTitle'] as string | undefined,
    buyer: data['buyer'] as { name?: string } | undefined,
    status: String(data['status'] ?? ''),
    issueDate: data['issueDate'] as string | undefined,
    dueDate: data['dueDate'] as string | undefined,
    totalCents: Number(data['totalCents'] ?? 0),
    creditedCents: Number(data['creditedCents'] ?? 0),
    payments: (data['payments'] ?? []) as InvoicePayment[],
  };
};

/** The org's invoices with something owing, and their matters (for the responsible lawyer). */
async function owingInvoices(db: Firestore, orgId: string) {
  const snap = await db.collection(invoicesPath(orgId)).where('status', 'in', OWING_STATUSES).get();
  const invoices = snap.docs.map(invoiceOf).filter((invoice) => owingCents(invoice) > 0);
  const matterIds = [...new Set(invoices.map((invoice) => invoice.matterId).filter(Boolean))];
  const matters = new Map<string, Data>();
  for (let i = 0; i < matterIds.length; i += 300) {
    const refs = matterIds.slice(i, i + 300).map((id) => db.doc(matterPath(orgId, id)));
    for (const matter of await db.getAll(...refs)) if (matter.exists) matters.set(matter.id, matter.data() as Data);
  }
  return { invoices, matters };
}

/**
 * Works out the org's aged-debtors report as of `asOf` and saves it as `metrics/debtors-{asOf}`:
 * the bucket totals in `values` (the shape every rollup has) and the matters in `debtors`.
 */
export async function rollupDebtors(
  db: Firestore,
  orgId: string,
  asOf: DateOnly,
  now: Date,
  by = 'system',
): Promise<DebtorsReport> {
  const { invoices, matters } = await owingInvoices(db, orgId);
  const lawyers: Record<string, string> = {};
  for (const [id, matter] of matters) {
    if (typeof matter['responsibleUid'] === 'string') lawyers[id] = matter['responsibleUid'];
  }
  const report = debtorsReport(invoices, asOf, { lawyers });
  const ref = db.doc(`orgs/${orgId}/metrics/${debtorsPeriod(asOf)}`);
  const existing = await ref.get();
  await ref.set({
    period: debtorsPeriod(asOf),
    values: debtorsValues(report),
    debtors: { asOf, rows: report.rows, truncated: report.truncated },
    createdAt: existing.exists ? existing.get('createdAt') : now,
    createdBy: existing.exists ? existing.get('createdBy') : by,
    updatedAt: now,
    updatedBy: by,
    schemaVersion: 1,
  });
  return report;
}

export interface ReminderOutcome {
  queued: string[];
  cancelled: string[];
}

/**
 * Queues payment reminders for the org (BILL-08): each invoice with something owing that reached
 * 7, 30 or 60 days past due gets `invoiceReminders/{invoiceId}-{threshold}` (`pending`), once, for
 * its matter's responsible lawyer to review and send. Nothing is sent here. A pending reminder
 * whose invoice no longer owes, or has reached a later threshold, becomes `cancelled`.
 */
export async function queueReminders(
  db: Firestore,
  orgId: string,
  asOf: DateOnly,
  now: Date,
  log: Log,
): Promise<ReminderOutcome> {
  const { invoices, matters } = await owingInvoices(db, orgId);
  const wanted = new Map<string, { invoice: OwingInvoice; threshold: number }>();
  for (const invoice of invoices) {
    if (!invoice.dueDate) continue;
    const threshold = reminderThreshold(invoice.dueDate as DateOnly, asOf);
    if (threshold) wanted.set(reminderId(invoice.id, threshold), { invoice, threshold });
  }

  const pending = await db.collection(remindersPath(orgId)).where('status', '==', 'pending').get();
  const existing = wanted.size
    ? await db.getAll(...[...wanted.keys()].map((id) => db.doc(`${remindersPath(orgId)}/${id}`)))
    : [];
  const exists = new Set(existing.filter((snap) => snap.exists).map((snap) => snap.id));

  const contactIds = new Set<string>();
  for (const { invoice } of wanted.values()) {
    const ids = matters.get(invoice.matterId)?.['clientContactIds'];
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') contactIds.add(id);
  }
  const emails = new Map<string, string[]>();
  const ids = [...contactIds];
  for (let i = 0; i < ids.length; i += 300) {
    const snaps = await db.getAll(...ids.slice(i, i + 300).map((id) => db.doc(`orgs/${orgId}/contacts/${id}`)));
    for (const snap of snaps) {
      const list = (snap.get('emails') ?? []) as { address?: unknown }[];
      if (!snap.exists || isDeleted(snap.data())) continue;
      emails.set(
        snap.id,
        list.map((email) => email.address).filter((address): address is string => typeof address === 'string'),
      );
    }
  }

  const batch = db.batch();
  const queued: string[] = [];
  const cancelled: string[] = [];
  for (const [id, { invoice, threshold }] of wanted) {
    if (exists.has(id)) continue;
    const matter = matters.get(invoice.matterId) ?? {};
    const clientIds = Array.isArray(matter['clientContactIds']) ? (matter['clientContactIds'] as string[]) : [];
    const to = [...new Set(clientIds.flatMap((contactId) => emails.get(contactId)?.slice(0, 1) ?? []))].slice(0, 5);
    batch.create(
      db.doc(`${remindersPath(orgId)}/${id}`),
      compact({
        invoiceId: invoice.id,
        invoiceNumber: invoice.number,
        matterId: invoice.matterId,
        matterNumber: invoice.matterNumber,
        matterTitle: invoice.matterTitle,
        clientName: invoice.buyer?.name,
        threshold,
        dueDate: invoice.dueDate,
        balanceCents: owingCents(invoice),
        lawyerUid: typeof matter['responsibleUid'] === 'string' ? matter['responsibleUid'] : undefined,
        to,
        status: 'pending',
        createdAt: now,
        createdBy: 'system',
        updatedAt: now,
        updatedBy: 'system',
        schemaVersion: 1,
      }),
    );
    queued.push(id);
  }
  for (const doc of pending.docs) {
    if (wanted.has(doc.id)) continue;
    const invoiceId = String(doc.get('invoiceId'));
    const later = [...wanted.values()].some(({ invoice }) => invoice.id === invoiceId);
    batch.update(doc.ref, {
      status: 'cancelled',
      closedAt: now,
      closedBy: 'system',
      closeReason: later ? 'later_reminder' : 'nothing_owing',
      updatedAt: now,
      updatedBy: 'system',
    });
    cancelled.push(doc.id);
  }
  if (queued.length || cancelled.length) await batch.commit();
  log.info('payment reminders queued', { orgId, queued: queued.length, cancelled: cancelled.length });
  return { queued, cancelled };
}

/** The nightly run for one org: the debtors rollup and the reminder queue, while invoicing is on. */
export async function debtorsNightlyForOrg(
  db: Firestore,
  orgId: string,
  baseClock: Clock,
  log: Log,
): Promise<{ invoices: number; queued: number } | null> {
  const clock = await orgClock(db, orgId, baseClock);
  if (!(await isEnabled({ orgId, db, clock }, 'billing.invoicing'))) return null;
  const now = clock.now();
  const asOf = today(await orgTimeZone(db, orgId), now);
  const report = await rollupDebtors(db, orgId, asOf, now);
  const reminders = await queueReminders(db, orgId, asOf, now, log);
  return { invoices: report.invoices, queued: reminders.queued.length };
}

/** Every active org; one org's failure doesn't stop the others. */
export async function debtorsNightlyAllOrgs(db: Firestore, clock: Clock, log: Log): Promise<number> {
  const orgs = await db.collection('orgs').get();
  let queued = 0;
  for (const org of orgs.docs) {
    if (isDeleted(org.data())) continue;
    try {
      queued += (await debtorsNightlyForOrg(db, org.id, clock, log))?.queued ?? 0;
    } catch (error) {
      log.error('debtors nightly failed', {
        orgId: org.id,
        errorType: error instanceof Error ? error.name : typeof error,
      });
    }
  }
  return queued;
}

/** `billing-debtorsNightly` (BILL-08): the aged-debtors rollup and payment reminder queue, at 01:30 Melbourne time. */
export const debtorsNightly = onSchedule(
  { schedule: '30 1 * * *', timeZone: 'Australia/Melbourne', region: REGION, retryCount: 0 },
  async () => {
    const log = createLog({ fn: 'billing-debtorsNightly' }, functionsSink);
    const queued = await debtorsNightlyAllOrgs(adminDb(), systemClock, log);
    log.info('ok', { queued });
  },
);

/**
 * `billing-refreshDebtors` (BILL-08; `billing.view`; flag `billing.invoicing`; idempotent): works the
 * aged-debtors report out now (and queues any reminders now due), saving it as today's, so the
 * report needn't wait for the night.
 */
export const refreshDebtorsDefinition = {
  name: PAYMENT_CALLABLES.refreshDebtors,
  input: RefreshDebtorsInput,
  roles: PERMISSIONS['billing.view'],
  idempotent: true,
  handler: async (ctx): Promise<RefreshDebtorsResult> => {
    const { orgId, uid, db, log } = ctx;
    await requireFlag({ orgId, db, clock: ctx.clock }, 'billing.invoicing');
    const clock = await orgClock(db, orgId, ctx.clock);
    const now = clock.now();
    const asOf = today(await orgTimeZone(db, orgId), now);
    const report = await rollupDebtors(db, orgId, asOf, now, uid);
    await queueReminders(db, orgId, asOf, now, log);
    return { asOf, invoices: report.invoices, totalCents: report.totals.totalCents };
  },
} satisfies CallableDefinition<typeof RefreshDebtorsInput, RefreshDebtorsResult>;

export const refreshDebtors = defineCallable(refreshDebtorsDefinition);

/**
 * Recomputes a matter's `outstandingCents` (BILL-08): what its issued invoices still owe, inc GST
 * (credit held on one invoice doesn't reduce another's debt). Written only when it changed, and
 * never to a destroyed matter's tombstone (CORE-19).
 */
export async function recomputeOutstanding(db: Firestore, orgId: string, matterId: string): Promise<number | null> {
  const ref = db.doc(matterPath(orgId, matterId));
  const invoices = await db.collection(invoicesPath(orgId)).where('matterId', '==', matterId).get();
  const outstanding = invoices.docs
    .map(invoiceOf)
    .filter((invoice) => PAYABLE_STATUSES.has(invoice.status))
    .reduce((sum, invoice) => sum + Math.max(0, owingCents(invoice)), 0);
  return db.runTransaction(async (tx) => {
    const matter = await tx.get(ref);
    if (!matter.exists || matter.get('destroyedAt')) return null;
    if ((matter.get('outstandingCents') ?? 0) === outstanding) return outstanding;
    tx.update(ref, { outstandingCents: outstanding });
    return outstanding;
  });
}

/** `billing-outstandingOnInvoice` (BILL-08): any invoice write (issue, payment, credit, void) recomputes its matter's outstanding amount. */
export const outstandingOnInvoiceDefinition: TriggerDefinition = {
  name: 'billing-outstandingOnInvoice',
  document: 'orgs/{orgId}/invoices/{invoiceId}',
  on: 'written',
  handler: async (change, ctx) => {
    const before = change.before?.data() as Data | undefined;
    const after = change.after?.data() as Data | undefined;
    const matterId = (after?.['matterId'] ?? before?.['matterId']) as unknown;
    if (typeof matterId !== 'string' || !matterId) return;
    // Drafts owe nothing; skip pre-bill saves (and PDF bookkeeping that leaves the money alone).
    const money = (data: Data | undefined) =>
      JSON.stringify([data?.['status'], data?.['totalCents'], data?.['creditedCents'], data?.['payments']]);
    if (money(before) === money(after)) return;
    if (before?.['status'] === 'draft' && (!after || after['status'] === 'draft')) return;
    if (!before && after?.['status'] === 'draft') return;
    const outstanding = await recomputeOutstanding(ctx.db, ctx.params['orgId'] as string, matterId);
    ctx.log.debug('matter outstanding', { matterId, outstanding });
  },
};

export const outstandingOnInvoice = defineTrigger(outstandingOnInvoiceDefinition);
