import * as D from '@materia/domain';

import { buildDataset, type FixtureName, SEED_ORG_ID, stripUndefined } from './dataset.ts';
import { DEMO_FLAGS, demoPdfJobId } from './demo.ts';
import { FIXTURE_NAMES, fixtureInfo, fixturePageText } from './pdfs.ts';
import { entityRegistry } from '../seed.ts';

const fixtures = Object.fromEntries(FIXTURE_NAMES.map((name) => [name, fixtureInfo(name)])) as Record<
  FixtureName,
  ReturnType<typeof fixtureInfo>
>;
const anchor = D.dateOnly('2026-10-07');
const now = new Date('2026-10-07T01:00:00Z');
const dataset = buildDataset({ anchor, fixtures, now, scenario: 'demo' });
const org = `orgs/${SEED_ORG_ID}`;
const under = (collection: string) =>
  dataset.docs.filter((d) => new RegExp(`^${org}/${collection}/[^/]+$`).test(d.path));
const byPath = new Map(dataset.docs.map((d) => [d.path, d.data]));

describe('the demo scenario', () => {
  it('is schema-valid for every document, and every path has a schema', () => {
    const registry = entityRegistry();
    for (const doc of dataset.docs) {
      const entity = registry.find((e) => e.pattern.test(doc.path));
      expect(entity, doc.path).toBeDefined();
      const result = entity?.schema.safeParse(stripUndefined(doc.data));
      expect(result?.success, `${doc.path}: ${JSON.stringify(result?.error?.issues)}`).toBe(true);
    }
  });

  it('is deterministic for the same anchor and time', () => {
    expect(buildDataset({ anchor, fixtures, now, scenario: 'demo' })).toEqual(dataset);
  });

  it('turns on the demo’s features for the org, on top of the practice’s own', () => {
    const flags = byPath.get(org)?.['flags'] as Record<string, unknown>;
    expect(flags).toMatchObject(DEMO_FLAGS);
    expect(flags).toMatchObject({ 'billing.disbursements': true, 'estate.register': true });
    expect(flags['litigation.enabled']).toBeUndefined();
    expect(byPath.get(org)?.['billing']).toMatchObject({ invoicePrefix: 'INV-', gstRegistered: true });
    // The default practice is unchanged.
    const practice = buildDataset({ anchor, fixtures, now }).docs.find((d) => d.path === org)?.data;
    expect((practice?.['flags'] as Record<string, unknown>)['billing.invoicing']).toBeUndefined();
  });

  it('adds a year and a half of closed matters, numbered in the year each opened', () => {
    const matters = under('matters').map((d) => d.data as D.Matter);
    expect(matters.length).toBeGreaterThanOrEqual(30);
    const closed = matters.filter((m) => m.status === 'closed' || m.status === 'archived');
    expect(closed.length).toBeGreaterThanOrEqual(20);
    for (const matter of closed) expect(matter.closedAt?.getTime()).toBeGreaterThan(matter.createdAt.getTime());
    const opened = matters.map((m) => m.createdAt.toISOString().slice(0, 7));
    expect(new Set(opened).size).toBeGreaterThanOrEqual(12);
    for (const matter of matters) {
      expect(matter.number.slice(3, 7)).toBe(String(D.matterNumberYear(matter.createdAt, 'Australia/Melbourne')));
    }
    const counters = under('counters').map((d) => [d.path.split('/').at(-1), d.data['next']]);
    expect(counters).toEqual(expect.arrayContaining([['matter-2025', expect.any(Number)]]));
    const numbers = matters.map((m) => m.number);
    expect(new Set(numbers).size).toBe(numbers.length);
    // The practice's and the history's matters are numbered in the order they opened (the
    // conflict scenarios' fixture numbers follow them).
    const practice = under('matters')
      .filter((d) => !d.path.includes('/m-cf-'))
      .map((d) => d.data as D.Matter)
      .sort((a, b) => a.number.localeCompare(b.number));
    for (let i = 1; i < practice.length; i++) {
      const [prev, next] = [practice[i - 1] as D.Matter, practice[i] as D.Matter];
      if (prev.number.slice(0, 7) === next.number.slice(0, 7))
        expect(next.createdAt.getTime(), next.number).toBeGreaterThanOrEqual(prev.createdAt.getTime());
    }
  });

  it('bills every billed time entry on exactly one invoice, numbered in issue order', () => {
    const invoices = under('invoices').map((d) => ({
      id: d.path.split('/').at(-1) as string,
      ...(d.data as D.Invoice),
    }));
    expect(invoices.length).toBeGreaterThanOrEqual(30);
    const sorted = [...invoices].sort((a, b) => a.number.localeCompare(b.number));
    expect(sorted.map((i) => i.number)).toEqual(sorted.map((_, i) => D.formatInvoiceNumber('INV-', i + 1)));
    for (let i = 1; i < sorted.length; i++)
      expect((sorted[i]?.issueDate ?? '') >= (sorted[i - 1]?.issueDate ?? '')).toBe(true);
    expect(byPath.get(`${org}/counters/invoice`)?.['next']).toBe(invoices.length + 1);

    const entries = dataset.docs.filter((d) => /\/timeEntries\/[^/]+$/.test(d.path));
    const billed = entries.filter((d) => d.data['status'] === 'billed');
    for (const entry of billed) {
      const invoice = invoices.find((i) => i.id === entry.data['invoiceId']);
      expect(invoice?.timeEntryIds, entry.path).toContain(entry.path.split('/').at(-1));
      expect(entry.path.startsWith(`${org}/matters/${invoice?.matterId}/`)).toBe(true);
    }
    const listed = invoices.flatMap((i) => i.timeEntryIds);
    expect(listed).toHaveLength(billed.length);
    for (const entry of entries.filter((d) => d.data['status'] !== 'billed'))
      expect(entry.data['invoiceId']).toBeUndefined();
  });

  it('keeps each invoice’s money, status and PDF job consistent', () => {
    for (const doc of under('invoices')) {
      const invoice = doc.data as D.Invoice;
      const id = doc.path.split('/').at(-1) as string;
      expect(D.invoiceTotals(invoice.lines).totalCents).toBe(invoice.totalCents);
      expect(invoice.status).toBe(D.paymentStatus(invoice));
      expect(D.owingCents(invoice)).toBeGreaterThanOrEqual(0);
      for (const payment of invoice.payments) expect(payment.date >= (invoice.issueDate ?? '')).toBe(true);
      expect(invoice.dueDate).toBe(D.invoiceDueDate(invoice.issueDate as D.DateOnly, invoice.paymentTermsDays));
      expect(invoice.buyer?.name).toBeTruthy();
      expect(Boolean(invoice.trustNotice)).toBe(invoice.paidFromTrust === true);
      if (invoice.trustNotice) expect(invoice.trustNotice.text).toContain(invoice.number);
      expect(invoice.pdfJobId).toBe(demoPdfJobId(id));
      const job = byPath.get(`${org}/jobs/${demoPdfJobId(id)}`) as D.Job | undefined;
      expect(job).toMatchObject({ type: 'pdf.render', status: 'queued', target: { matterId: invoice.matterId } });
      expect((job?.input as { data: { documentRef: string } }).data.documentRef).toBe(`invoices/${id}`);
    }
  });

  it('gives matters what issuing and paying leave: the last invoice day and what is still owed', () => {
    const invoices = under('invoices').map((d) => d.data as D.Invoice);
    for (const doc of under('matters')) {
      const matterId = doc.path.split('/').at(-1);
      const mine = invoices.filter((i) => i.matterId === matterId);
      const matter = doc.data as D.Matter;
      expect(matter.outstandingCents ?? 0).toBe(mine.reduce((sum, i) => sum + Math.max(0, D.owingCents(i)), 0));
      expect(matter.lastInvoicedOn).toBe(
        mine
          .map((i) => i.issueDate)
          .sort()
          .at(-1),
      );
    }
    const statuses = new Set(invoices.map((i) => i.status));
    expect(statuses).toEqual(new Set(['issued', 'part_paid', 'paid']));
  });

  it('has an overdue invoice in today’s aged debtors with a reminder to send (BILL-08)', () => {
    const debtors = byPath.get(`${org}/metrics/${D.debtorsPeriod(anchor)}`) as {
      values: Record<string, number>;
      debtors: { rows: { matterId: string }[] };
    };
    expect(debtors.values['invoices']).toBeGreaterThanOrEqual(3);
    expect(debtors.values['d31_60']).toBeGreaterThan(0);
    expect(debtors.debtors.rows.map((r) => r.matterId)).toContain('m-nguyen-fp');
    const reminders = under('invoiceReminders').map((d) => d.data as D.InvoiceReminder);
    expect(reminders).toEqual([
      expect.objectContaining({ matterId: 'm-nguyen-fp', threshold: 30, status: 'pending', lawyerUid: 'user-priya' }),
    ]);
  });

  it('gives Insights more than a year of figures: matters opened and closed, invoices and payments', () => {
    const all: D.MetricContribution = {};
    const merge = (cells: D.MetricContribution) => {
      for (const [cell, values] of Object.entries(cells)) {
        const into = (all[cell] ??= {});
        for (const [k, v] of Object.entries(values)) into[k] = (into[k] ?? 0) + v;
      }
    };
    for (const doc of under('matters')) merge(D.metricsContribution('matter', doc.data));
    for (const doc of under('invoices')) {
      const matter = byPath.get(`${org}/matters/${(doc.data as D.Invoice).matterId}`);
      merge(D.metricsContribution('invoice', doc.data, { matter }));
    }
    // Cells are days (and members): the months with something in them.
    const months = (key: string) =>
      new Set(
        Object.entries(all)
          .filter(([cell, values]) => !cell.includes('|') && (values[key] ?? 0) > 0)
          .map(([cell]) => cell.slice(0, 7)),
      );
    const has = (prefix: string) =>
      Object.values(all).some((values) => Object.keys(values).some((k) => k.startsWith(prefix)));
    expect(months('matters.opened').size).toBeGreaterThanOrEqual(12);
    expect(months('matters.closed').size).toBeGreaterThanOrEqual(10);
    expect(has('cycle.probate.grantToDistribution')).toBe(true);
    expect(has('cycle.probate.instructionsToGrant')).toBe(true);
  });

  it('adds a Clerk thread on the Nguyen claim whose citations quote the orders', () => {
    const messages = dataset.docs.filter((d) => /\/clerkThreads\/m-nguyen-fp-ct-1\/messages\/[^/]+$/.test(d.path));
    const answer = D.ClerkMessage.schema.parse(messages[1]?.data);
    const orders = fixturePageText('court-order');
    expect(answer.citations.length).toBe(4);
    for (const citation of answer.citations.filter(D.isDocumentCitation)) {
      expect(D.verifyQuote(citation, orders).verified, citation.quote).toBe(true);
    }
  });

  it('leaves a few notifications for the principal, one of them read', () => {
    const notifications = under('notifications').map((d) => d.data as D.Notification);
    expect(notifications.map((n) => n.kind)).toEqual(['task_assigned', 'deadline_reminder', 'suggestion']);
    expect(notifications.every((n) => n.recipientUid === 'user-priya' && n.channels.join() === 'inapp')).toBe(true);
    expect(notifications.filter((n) => n.readAt === null)).toHaveLength(2);
  });

  it('spreads the conflict scenarios’ matters over the past months', () => {
    const pell = byPath.get(`${org}/matters/m-cf-pell-fp`) as D.Matter;
    expect(pell.createdAt.toISOString().slice(0, 10)).toBe(D.addDays(anchor, -260));
    expect(pell.closedAt?.toISOString().slice(0, 10)).toBe(D.addDays(anchor, -150));
  });
});
