import { TRUST_NOTICE_TEMPLATE, TRUST_REFERENCE_PROBLEM } from '@materia/domain';

import { setPaidFromTrustDefinition } from './paid-from-trust';
import { recordPaymentDefinition } from './payments';
import { invoice, issue, ORG, save, world, type World } from './testing';
import { voidDefinition } from './void';

/** Unit tests for "To be paid from trust" (BILL-12, ADR-035). Every client, matter and amount is fictional. */

const ORG_DOC = {
  name: 'Harbour & Vine Legal',
  abn: '12345678901',
  timezone: 'Australia/Melbourne',
  billing: { gstRegistered: true, invoicePrefix: 'INV-', paymentTermsDays: 14, unitMinutes: 6 },
};
/** The harness's world with `billing.trustNotice` on or off. */
const trustWorld = (noticeOn: boolean) =>
  world({ [`orgs/${ORG}`]: { ...ORG_DOC, flags: { 'billing.invoicing': true, 'billing.trustNotice': noticeOn } } });

const mark = (w: World, invoiceId: string, paidFromTrust = true, role: 'lawyer' | 'paralegal' = 'lawyer') =>
  w.call(setPaidFromTrustDefinition as never, { invoiceId, paidFromTrust }, role) as Promise<{
    paidFromTrust: boolean;
    pdfRendering: boolean;
  }>;
const jobOf = (w: World, invoiceId: string) =>
  w.doc(`orgs/${ORG}/jobs/${String(invoice(w, invoiceId)['pdfJobId'])}`) as
    { input: { data: Record<string, unknown> } } | undefined;
const audits = (w: World, action: string) =>
  w.entries(`orgs/${ORG}/audit/`).filter((entry) => (entry as Record<string, unknown>)['action'] === action);

describe('an invoice to be paid from trust', () => {
  it('prints the r 42(3) notice only when the invoice is marked and billing.trustNotice is on', async () => {
    const on = trustWorld(true);
    const { invoiceId } = await save(on, { paidFromTrust: true });
    expect(invoice(on, invoiceId)['paidFromTrust']).toBe(true);
    const { number } = await issue(on, invoiceId);
    const notice = invoice(on, invoiceId)['trustNotice'] as { version: number; text: string };
    expect(notice.version).toBe(TRUST_NOTICE_TEMPLATE.version);
    expect(notice.text).toContain(`Harbour & Vine Legal intends to withdraw $962.30`);
    expect(notice.text).toContain(`M-2026-0042 (Estate of the late Wren) to pay this invoice (${number})`);
    expect(jobOf(on, invoiceId)?.input.data['trustNotice']).toBe(notice.text);

    // Marked, flag off: the intention is kept but nothing prints.
    const off = trustWorld(false);
    const draft = await save(off, { paidFromTrust: true });
    await issue(off, draft.invoiceId);
    expect(invoice(off, draft.invoiceId)).toMatchObject({ paidFromTrust: true });
    expect(invoice(off, draft.invoiceId)['trustNotice']).toBeUndefined();
    expect(jobOf(off, draft.invoiceId)?.input.data['trustNotice']).toBeUndefined();

    // Flag on, not marked: no notice.
    const plain = trustWorld(true);
    const unmarked = await save(plain);
    await issue(plain, unmarked.invoiceId);
    expect(invoice(plain, unmarked.invoiceId)['trustNotice']).toBeUndefined();
  });

  it('marks an issued invoice afterwards and renders the PDF again with the notice, then without it', async () => {
    const w = trustWorld(true);
    const { invoiceId } = await save(w);
    await issue(w, invoiceId);
    const firstJob = invoice(w, invoiceId)['pdfJobId'];

    expect(await mark(w, invoiceId)).toEqual({ paidFromTrust: true, pdfRendering: true });
    expect(invoice(w, invoiceId)).toMatchObject({ paidFromTrust: true, pdfStatus: 'pending' });
    expect(invoice(w, invoiceId)['pdfJobId']).not.toBe(firstJob);
    expect(String(jobOf(w, invoiceId)?.input.data['trustNotice'])).toContain('Notice of intended withdrawal');
    expect(audits(w, 'invoice.trust_option_set')).toHaveLength(1);

    // Marking it again changes nothing and renders nothing.
    const job = invoice(w, invoiceId)['pdfJobId'];
    expect(await mark(w, invoiceId)).toEqual({ paidFromTrust: true, pdfRendering: false });
    expect(invoice(w, invoiceId)['pdfJobId']).toBe(job);
    expect(audits(w, 'invoice.trust_option_set')).toHaveLength(1);

    expect(await mark(w, invoiceId, false)).toEqual({ paidFromTrust: false, pdfRendering: true });
    expect(invoice(w, invoiceId)['trustNotice']).toBeUndefined();
    expect(jobOf(w, invoiceId)?.input.data['trustNotice']).toBeUndefined();
  });

  it('only records the intention on a pre-bill, and refuses a paralegal and a void invoice', async () => {
    const w = trustWorld(true);
    const { invoiceId } = await save(w);
    expect(await mark(w, invoiceId)).toEqual({ paidFromTrust: true, pdfRendering: false });
    expect(invoice(w, invoiceId)).toMatchObject({ status: 'draft', paidFromTrust: true });
    expect(invoice(w, invoiceId)['trustNotice']).toBeUndefined();
    await expect(mark(w, invoiceId, false, 'paralegal')).rejects.toMatchObject({ code: 'permission-denied' });

    await issue(w, invoiceId);
    await w.call(voidDefinition as never, { invoiceId, reason: 'Issued to the wrong client' }, 'owner');
    await expect(mark(w, invoiceId, false)).rejects.toMatchObject({ code: 'failed-precondition' });
  });
});

describe('payments from trust', () => {
  it('need the trust system’s reference; part from trust and part by EFT are two payments', async () => {
    const w = trustWorld(false);
    const { invoiceId } = await save(w, { paidFromTrust: true });
    await issue(w, invoiceId);
    const record = (data: Record<string, unknown>) =>
      w.call(recordPaymentDefinition as never, { invoiceId, date: '2026-10-06', ...data }) as Promise<{
        status: string;
        owingCents: number;
      }>;
    await expect(record({ amountCents: 50_000, method: 'trust_transfer' })).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    expect(TRUST_REFERENCE_PROBLEM).toMatch(/reference/);
    expect(await record({ amountCents: 50_000, method: 'trust_transfer', reference: 'TR-0042' })).toMatchObject({
      status: 'part_paid',
    });
    expect(await record({ amountCents: 46_230, method: 'eft' })).toMatchObject({ status: 'paid', owingCents: 0 });
    expect(invoice(w, invoiceId)['payments']).toEqual([
      expect.objectContaining({ method: 'trust_transfer', reference: 'TR-0042', date: '2026-10-06' }),
      expect.objectContaining({ method: 'eft' }),
    ]);
    // Materia records it after the fact: no trust collection is ever written.
    expect(w.entries(`orgs/${ORG}/trustSnapshots/`)).toEqual([]);
  });
});
