/**
 * The demo practice's billing history and switches (`seed --scenario=demo`, `demo-reset`): run on
 * the dataset after its matters are built, it adds what the billing callables would have written
 * over the past year and a half, so the invoice, debtor and Insights screens have something to
 * show on the first sign-in:
 *
 * - each matter's `invoices` (seed/demo-data.ts), built with `buildInvoice` from the matter's
 *   billed time (and a fixed fee), numbered in issue order from the org's `INV-` counter, with
 *   their payments, the r 42(3) notice on those paid from trust (BILL-12), and the time entries,
 *   the matter's `lastInvoicedOn` and `outstandingCents` as issuing and paying leave them;
 * - a queued PDF render for each (`jobs/{invoiceId}-pdf`): `demo-reset` starts them on dev, where
 *   `billing-onPdfJob` files each PDF in the matter's documents;
 * - today's aged-debtors report and the payment reminder the nightly job would queue (BILL-08);
 * - the org's flags for every built feature the demo shows (`DEMO_FLAGS`), and its invoice prefix.
 *
 * Pure: it only reads and adds documents. Everything is fictional.
 */
import * as D from '@materia/domain';
// Namespace import: the workspace lib loads as CommonJS under tsx, so named imports don't resolve.
import * as TestUtilsNs from '@materia/test-utils';

import type { InvoiceSpec, MatterSpec, SeedDoc } from './dataset.ts';
import { unwrap } from './interop.ts';

const domain = unwrap(D);
const F = unwrap(TestUtilsNs);

/**
 * The demo org's flag overrides (`orgs/{orgId}.flags` wins over Remote Config): every built feature
 * a demo walks through. Practitioner sign-offs gate these in prod, never on this fictional org.
 * Left off: features still held or planned (the daily brief, litigation, intake prefill, will
 * extraction, time assist), integrations that need a connection, and mobile voice.
 */
export const DEMO_FLAGS = {
  'clerk.enabled': true,
  'clerk.features.chat': true,
  'clerk.features.suggestions': true,
  'clerk.features.classification': true,
  'clerk.features.insightsNarrative': true,
  'billing.invoicing': true,
  'billing.trustNotice': true,
} as const satisfies Partial<Record<D.FlagKey, boolean>>;

/** Who issues invoices and records payments in the demo: the principal. */
const PRIYA = 'user-priya';

type Data = Record<string, unknown>;

export interface DemoContext {
  orgId: string;
  anchor: D.DateOnly;
  now: Date;
  matters: readonly MatterSpec[];
}

/** The PDF render job of a demo invoice. */
export const demoPdfJobId = (invoiceId: string) => `${invoiceId}-pdf`;

/** Adds the demo's invoices, PDF jobs, debtors report, reminders and flags to a built dataset. */
export function applyDemo(input: readonly SeedDoc[], ctx: DemoContext): SeedDoc[] {
  const { orgId, anchor } = ctx;
  const docs = [...input];
  const at = new Map(docs.map((doc, i) => [doc.path, i]));
  const get = (path: string): Data => {
    const i = at.get(path);
    if (i === undefined) throw new Error(`demo: no document at ${path}`);
    return (docs[i] as SeedDoc).data;
  };
  const patch = (path: string, fields: Data) => {
    const i = at.get(path) as number;
    docs[i] = { path, data: { ...get(path), ...fields } };
  };
  const add = (path: string, data: object) => {
    if (at.has(path)) throw new Error(`demo: ${path} already exists`);
    at.set(path, docs.length);
    docs.push({ path, data: data as Data });
  };
  const day = (daysAgo: number) => domain.addDays(anchor, -daysAgo);
  const instant = (date: string) => new Date(`${date}T00:00:00Z`);
  const meta = (date: string, by = PRIYA) => ({
    createdAt: instant(date),
    updatedAt: instant(date),
    createdBy: by,
    updatedBy: by,
  });

  const orgPath = `orgs/${orgId}`;
  const org = get(orgPath);
  const billing = org['billing'] as D.Org['billing'];
  patch(orgPath, {
    flags: { ...(org['flags'] as Data), ...DEMO_FLAGS },
    billing: { ...billing, invoicePrefix: 'INV-', paymentTermsDays: 14 },
  });
  const supplier: D.InvoiceParty = {
    name: String(org['name']),
    ...(typeof org['abn'] === 'string' ? { abn: org['abn'] } : {}),
  };

  const people: Record<string, string> = {};
  for (const doc of docs) {
    const [, o, members, uid, rest] = doc.path.split('/');
    if (o === orgId && members === 'members' && uid && rest === undefined)
      people[uid] = String(doc.data['displayName']);
  }

  // Each matter's invoices, oldest first, billing its billed time since the previous one.
  interface Built {
    id: string;
    spec: InvoiceSpec;
    matterId: string;
    matterPath: string;
    order: number;
    issueDate: D.DateOnly;
    build: D.InvoiceBuild;
    extraLines: D.InvoiceExtraLine[];
    paymentTermsDays: number;
  }
  const built: Built[] = [];
  ctx.matters.forEach((spec, order) => {
    if (!spec.invoices?.length) return;
    const matterPath = `${orgPath}/matters/${spec.id}`;
    const matter = get(matterPath);
    const fee = matter['fee'] as D.InvoiceFeeLike | undefined;
    const entries = docs
      .filter((doc) => doc.path.startsWith(`${matterPath}/timeEntries/`) && doc.data['status'] === 'billed')
      .map((doc) => ({ path: doc.path, data: doc.data }));
    const covered = new Set<string>();
    let previous: D.DateOnly | null = null;
    let billedFees = 0;
    const invoices = [...spec.invoices].sort((a, b) => b.issuedDaysAgo - a.issuedDaysAgo);
    invoices.forEach((invoice, i) => {
      const issueDate = day(invoice.issuedDaysAgo);
      const mine = entries.filter(({ data }) => {
        const date = String(data['date']);
        return date <= issueDate && (previous === null || date > previous);
      });
      const extraLines: D.InvoiceExtraLine[] = invoice.fixedFee
        ? [{ kind: 'fixed_fee', description: invoice.fixedFee, amountExGstCents: (fee?.amountCents ?? 0) as D.Cents }]
        : [];
      const paymentTermsDays = invoice.paymentTermsDays ?? 14;
      // Billed now; final (approved) when the pre-bill was built.
      const sources = mine.map(({ path, data }) => ({
        id: path.split('/').pop() as string,
        uid: String(data['uid']),
        date: String(data['date']),
        units: Number(data['units']),
        rateCents: Number(data['rateCents']),
        amountCents: Number(data['amountCents']),
        narrative: String(data['narrative']),
        billable: data['billable'] === true,
        status: 'final',
        invoiceId: null,
      }));
      const build = domain.buildInvoice(
        {
          grouping: 'itemised',
          extraLines,
          paymentTermsDays,
          ...(invoice.paidFromTrust ? { paidFromTrust: true } : {}),
        },
        {
          gstRegistered: billing.gstRegistered,
          unitMinutes: billing.unitMinutes,
          fee,
          entries: sources,
          disbursements: [],
          people,
          billedFeesCents: billedFees,
        },
      );
      if (build.problem) throw new Error(`demo: ${spec.id} invoice ${i + 1}: ${build.problem}`);
      if (build.timeEntryIds.length !== sources.length)
        throw new Error(`demo: ${spec.id} invoice ${i + 1} left billed time off`);
      for (const { path } of mine) covered.add(path);
      billedFees += domain.feesOf(build.lines);
      built.push({
        id: `${spec.id}-inv-${i + 1}`,
        spec: invoice,
        matterId: spec.id,
        matterPath,
        order,
        issueDate,
        build,
        extraLines,
        paymentTermsDays,
      });
      previous = issueDate;
    });
    const missed = entries.filter(({ path }) => !covered.has(path));
    if (missed.length) throw new Error(`demo: ${spec.id} has billed time on no invoice (${missed[0]?.path})`);
  });

  // Numbered in the order they were issued, as the counter hands numbers out.
  built.sort((a, b) => (a.issueDate < b.issueDate ? -1 : a.issueDate > b.issueDate ? 1 : a.order - b.order));
  const prefix = 'INV-';
  const issued: (D.DebtorInvoiceLike & { number: string })[] = [];
  const lastInvoicedOn = new Map<string, D.DateOnly>();
  const outstanding = new Map<string, number>();
  built.forEach((item, i) => {
    const { id, spec, matterId, matterPath, issueDate, build, extraLines, paymentTermsDays } = item;
    const matter = get(matterPath);
    const number = domain.formatInvoiceNumber(prefix, i + 1);
    const matterNumber = String(matter['number']);
    const matterTitle = String(matter['title']);
    const clients = ((matter['clientContactIds'] ?? []) as string[]).map(
      (contactId) => get(`${orgPath}/contacts/${contactId}`) as D.InvoiceClientLike,
    );
    const issuedBy = PRIYA;
    let paid = 0;
    const payments: D.InvoicePayment[] = (spec.payments ?? []).map(([daysAgo, method, amount], k) => {
      const date = day(daysAgo);
      if (date < issueDate) throw new Error(`demo: ${id} is paid before it was issued`);
      const amountCents = (amount ?? build.totalCents - paid) as D.Cents;
      paid += amountCents;
      return {
        id: `${id}-pay-${k + 1}`,
        kind: 'payment',
        date,
        amountCents,
        method,
        recordedAt: instant(date),
        recordedBy: PRIYA,
      };
    });
    const money = { totalCents: build.totalCents, creditedCents: 0, payments };
    const status = domain.paymentStatus(money);
    const dueDate = domain.invoiceDueDate(issueDate, paymentTermsDays);
    const buyer = domain.invoiceBuyer(clients);
    const fields = {
      ...meta(payments.at(-1)?.date ?? issueDate, issuedBy),
      createdAt: instant(issueDate),
      createdBy: issuedBy,
      number,
      matterId,
      matterNumber,
      matterTitle,
      grouping: 'itemised' as const,
      extraLines,
      timeEntryIds: build.timeEntryIds,
      disbursementIds: build.disbursementIds,
      paymentTermsDays,
      issueDate,
      dueDate,
      lines: build.lines,
      subtotalCents: build.subtotalCents,
      gstCents: build.gstCents,
      totalCents: build.totalCents,
      gstRegistered: billing.gstRegistered,
      supplier,
      buyer,
      status,
      issuedAt: instant(issueDate),
      issuedBy,
      pdfStatus: 'pending' as const,
      pdfJobId: demoPdfJobId(id),
      payments,
      ...(spec.paidFromTrust
        ? {
            paidFromTrust: true,
            trustNotice: domain.trustNoticeFor({
              firm: supplier.name,
              amount: domain.formatCents(build.totalCents),
              matter: `${matterNumber} (${matterTitle})`,
              number,
            }),
          }
        : {}),
    };
    const invoice = F.makeInvoice(fields as Partial<D.Invoice>);
    add(`${orgPath}/invoices/${id}`, invoice);

    // The PDF render issuing starts (jobs-startPdf's job, ADR-014), queued for demo-reset to run.
    add(
      `${orgPath}/jobs/${demoPdfJobId(id)}`,
      F.makeJob({
        createdAt: ctx.now,
        updatedAt: ctx.now,
        createdBy: issuedBy,
        updatedBy: issuedBy,
        type: 'pdf.render',
        input: {
          templateId: 'invoice',
          data: {
            ...domain.invoicePdfData({ ...invoice, matterNumber } as Parameters<typeof domain.invoicePdfData>[0]),
            documentRef: `invoices/${id}`,
          },
        },
        target: {
          kind: 'matter',
          matterId,
          name: domain.invoicePdfName('invoice', number, billing.gstRegistered),
          category: 'financial',
          privileged: matter['privileged'] === true,
        },
        status: 'queued',
        progress: { done: 0, total: 0 },
        warnings: [],
        attempts: 0,
        startedAt: undefined,
        heartbeatAt: undefined,
      } as Partial<D.Job>),
    );

    for (const entryId of build.timeEntryIds) {
      patch(`${matterPath}/timeEntries/${entryId}`, { invoiceId: id, updatedAt: instant(issueDate) });
    }
    lastInvoicedOn.set(matterPath, issueDate);
    outstanding.set(matterPath, (outstanding.get(matterPath) ?? 0) + Math.max(0, domain.owingCents(money)));
    issued.push({ id, number, matterId, matterNumber, matterTitle, buyer, status, issueDate, dueDate, ...money });
  });
  for (const [matterPath, date] of lastInvoicedOn) {
    patch(matterPath, { lastInvoicedOn: date, outstandingCents: outstanding.get(matterPath) ?? 0 });
  }
  add(`${orgPath}/counters/${domain.INVOICE_COUNTER}`, F.makeCounter({ ...meta(anchor), next: built.length + 1 }));

  // Today's aged debtors and the reminders due (billing-debtorsNightly), as of the anchor.
  const lawyers: Record<string, string> = {};
  for (const item of built) lawyers[item.matterId] = String(get(item.matterPath)['responsibleUid']);
  const report = domain.debtorsReport(issued, anchor, { lawyers });
  add(`${orgPath}/metrics/${domain.debtorsPeriod(anchor)}`, {
    ...meta(anchor, 'system'),
    schemaVersion: 1,
    period: domain.debtorsPeriod(anchor),
    values: domain.debtorsValues(report),
    debtors: { asOf: anchor, rows: report.rows, truncated: report.truncated },
  });
  for (const invoice of issued) {
    const owing = domain.owingCents(invoice);
    if (owing <= 0 || !invoice.dueDate) continue;
    const threshold = domain.reminderThreshold(invoice.dueDate as D.DateOnly, anchor);
    if (!threshold) continue;
    const matter = get(`${orgPath}/matters/${invoice.matterId}`);
    const to = ((matter['clientContactIds'] ?? []) as string[])
      .flatMap((contactId) => {
        const emails = (get(`${orgPath}/contacts/${contactId}`)['emails'] ?? []) as { address?: string }[];
        return emails.slice(0, 1).flatMap((email) => (email.address ? [email.address] : []));
      })
      .slice(0, 5);
    add(
      `${orgPath}/invoiceReminders/${domain.reminderId(invoice.id, threshold)}`,
      F.makeInvoiceReminder({
        ...meta(anchor, 'system'),
        invoiceId: invoice.id,
        invoiceNumber: invoice.number,
        matterId: invoice.matterId,
        matterNumber: invoice.matterNumber,
        matterTitle: invoice.matterTitle,
        clientName: invoice.buyer?.name,
        threshold,
        dueDate: invoice.dueDate as D.DateOnly,
        balanceCents: owing,
        lawyerUid: String(matter['responsibleUid']),
        to,
        status: 'pending',
      }),
    );
  }

  // A few things waiting for the principal in the bell (FND-20), as the triggers word them.
  const nguyen = get(`${orgPath}/matters/m-nguyen-fp`);
  const doyle = get(`${orgPath}/matters/m-doyle-estate`);
  const serve = get(`${orgPath}/matters/m-nguyen-fp/deadlines/m-nguyen-fp-dl-1`);
  const counsel = get(`${orgPath}/matters/m-nguyen-fp/tasks/m-nguyen-fp-t-2`);
  const proposed = docs.filter(
    (doc) => doc.path.startsWith(`${orgPath}/matters/m-doyle-estate/suggestions/`) && doc.data['status'] === 'proposed',
  ).length;
  const hoursAgo = (hours: number) => new Date(ctx.now.getTime() - hours * 3_600_000);
  const notifications: [id: string, hours: number, read: boolean, payload: Data][] = [
    [
      'demo-nt-task',
      2,
      false,
      {
        kind: 'task_assigned',
        taskId: 'm-nguyen-fp-t-2',
        matterId: 'm-nguyen-fp',
        title: 'Task assigned to you',
        body: `${String(counsel['title'])} · ${String(nguyen['number'])}`,
        link: '/matters/m-nguyen-fp/tasks',
      },
    ],
    [
      'demo-nt-deadline',
      5,
      false,
      {
        kind: 'deadline_reminder',
        deadlineId: 'm-nguyen-fp-dl-1',
        matterId: 'm-nguyen-fp',
        title: `Deadline overdue: ${String(nguyen['number'])}`,
        body: `${String(serve['title'])} was due ${String(serve['dueDate'])} (critical).`,
        link: '/matters/m-nguyen-fp/deadlines',
        priority: 'high',
      },
    ],
    [
      'demo-nt-suggestion',
      26,
      true,
      {
        kind: 'suggestion',
        suggestionId: 'm-doyle-estate-sg-1',
        matterId: 'm-doyle-estate',
        title: `Clerk has ${proposed} suggestions on ${String(doyle['number'])}`,
        body: 'Review them before anything changes.',
        link: '/matters/m-doyle-estate/overview',
      },
    ],
  ];
  for (const [id, hours, read, payload] of notifications) {
    const when = hoursAgo(hours);
    add(
      `${orgPath}/notifications/${id}`,
      F.makeNotification({
        createdAt: when,
        updatedAt: read ? hoursAgo(hours - 2) : when,
        createdBy: 'system',
        updatedBy: read ? PRIYA : 'system',
        recipientUid: PRIYA,
        channels: ['inapp'],
        readAt: read ? hoursAgo(hours - 2) : null,
        summaryId: null,
        ...payload,
      } as Partial<D.Notification>),
    );
  }
  return docs;
}
