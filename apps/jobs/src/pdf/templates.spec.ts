import { join } from 'node:path';

import { invoicePdfData } from '@materia/domain';

// The renderer reads its template folder when loaded: point it at apps/jobs/templates first.
process.env['TEMPLATE_DIR'] = join(import.meta.dirname, '../../templates');
const { renderTemplate } = await import('./render');

/** The safe custody templates (CORE-17) fill in and escape their data. Everything is fictional. */
describe('safe custody templates', () => {
  it('renders the receipt: the firm, the packet, each original and the latest will', async () => {
    const html = await renderTemplate('safe-custody-receipt', {
      firmName: 'Harbour & Vine Legal',
      firmAbn: '12345678901',
      packetNo: 'SC-000042',
      testatorName: 'Lan Nguyễn',
      testatorAddress: '1 Fictional St, Geelong VIC 3220',
      receivedOn: '14 Feb 2019',
      site: 'Geelong',
      items: [
        { kind: 'Will', date: '14 Feb 2019', description: 'Last will <b>signed</b>', current: true },
        { kind: 'Power of attorney', date: '14 Feb 2019', description: '', current: false },
      ],
      issuedOn: '5 Oct 2026',
    });
    expect(html).toContain('Safe custody receipt');
    expect(html).toContain('SC-000042');
    expect(html).toContain('Lan Nguyễn, 1 Fictional St, Geelong VIC 3220');
    expect(html).toContain('ABN 12345678901');
    expect(html).toContain('Harbour &amp; Vine Legal holds these original documents');
    expect(html).toContain('Last will &lt;b&gt;signed&lt;/b&gt;');
    expect(html.match(/\(latest\)/g)).toHaveLength(1);
    expect(html.slice(html.indexOf('<body>'))).not.toMatch(/cabinet|slot/i);
  });

  it('renders the stocktake by site and cabinet, with a box for each packet', async () => {
    const html = await renderTemplate('safe-custody-stocktake', {
      firmName: 'Harbour & Vine Legal',
      site: '',
      count: 2,
      preparedOn: '5 Oct 2026',
      sites: [
        {
          site: 'Geelong',
          cabinets: [
            {
              cabinet: 'Safe A',
              packets: [
                { slot: '2', packetNo: 'SC-000001', testatorName: 'Fictional One', items: 'Will', lastVerified: '' },
                {
                  slot: '12',
                  packetNo: 'SC-000002',
                  testatorName: 'Fictional Two',
                  items: 'Will, Codicil',
                  lastVerified: '1 Oct 2025',
                },
              ],
            },
          ],
        },
      ],
    });
    expect(html).toContain('<h2>Geelong</h2>');
    expect(html).toContain('<h3>Safe A</h3>');
    expect(html).toContain('2 packets held');
    expect(html.match(/class="sc-box"><span><\/span>/g)).toHaveLength(2);
    expect(html.indexOf('SC-000001')).toBeLessThan(html.indexOf('SC-000002'));
  });

  it('says when nothing is held', async () => {
    const html = await renderTemplate('safe-custody-stocktake', { firmName: 'F', count: 0, sites: [] });
    expect(html).toContain('No packets are held.');
  });
});

/** The invoice template (BILL-07), filled from the domain's `invoicePdfData`. Everything is fictional. */
describe('invoice template', () => {
  const lines = [
    {
      kind: 'time' as const,
      refId: 't1',
      description: 'Advice on the <will>',
      quantity: 1.5,
      unitPriceCents: 44000,
      amountExGstCents: 66000,
      gstCents: 6600,
      date: '2026-09-01',
      by: 'Pat Lawyer',
    },
    {
      kind: 'disbursement' as const,
      refId: 'd1',
      description: 'Probate filing fee (Supreme Court of Victoria)',
      quantity: 1,
      amountExGstCents: 33310,
      gstCents: 0,
      gstFree: true,
      date: '2026-09-02',
    },
  ];
  const invoice = {
    number: 'INV-000042',
    issueDate: '2026-10-06',
    dueDate: '2026-10-20',
    lines,
    subtotalCents: 99310,
    gstCents: 6600,
    totalCents: 105910,
    gstRegistered: true,
    supplier: { name: 'Harbour & Vine Legal', abn: '12345678901' },
    buyer: { name: 'Lan Nguyễn', address: '1 Fictional St, Geelong VIC 3220' },
    paymentTermsDays: 14,
    matterNumber: 'M-2026-0042',
  };

  it('renders every tax invoice element, escaped', async () => {
    const html = await renderTemplate('invoice', invoicePdfData(invoice));
    const body = html.slice(html.indexOf('<body>'));
    for (const text of [
      '<h1>Tax invoice</h1>',
      'INV-000042',
      'Harbour &amp; Vine Legal',
      'ABN 12 345 678 901',
      'Lan Nguyễn',
      '6 Oct 2026',
      '20 Oct 2026',
      'Advice on the &lt;will&gt;',
      '1.50 h',
      '$440.00/h',
      '$660.00',
      '$66.00',
      'GST-free',
      'Probate filing fee (Supreme Court of Victoria) *',
      'Subtotal ex GST',
      '$993.10',
      '$1,059.10',
      'Total includes GST of $66.00.',
      'Payment is due within 14 days, by 20 Oct 2026.',
    ])
      expect(body).toContain(text);
  });

  it('reads "Invoice" with no GST when the firm isn’t registered', async () => {
    const html = await renderTemplate(
      'invoice',
      invoicePdfData({ ...invoice, gstRegistered: false, gstCents: 0, totalCents: 99310 }),
    );
    const body = html.slice(html.indexOf('<body>'));
    expect(body).toContain('<h1>Invoice</h1>');
    expect(body).not.toMatch(/GST/);
  });

  it('adds the schedule for a summary invoice, and titles a credit note', async () => {
    const summary = await renderTemplate(
      'invoice',
      invoicePdfData({
        ...invoice,
        itemisation: [{ refId: 't1', date: '2026-09-01', description: 'Advice', hours: 1.5, amountExGstCents: 66000 }],
      }),
    );
    expect(summary).toContain('Schedule of professional fees · INV-000042');
    const credit = await renderTemplate(
      'invoice',
      invoicePdfData({ ...invoice, number: 'CN-000001' }, { invoiceNumber: 'INV-000042', reason: 'Fee reduced' }),
    );
    expect(credit).toContain('<h1>Adjustment note</h1>');
    expect(credit).toContain('Credits invoice');
    expect(credit).toContain('Total credited');
    expect(credit).not.toContain('Payment is due');
  });
});
