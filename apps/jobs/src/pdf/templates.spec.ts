import { join } from 'node:path';

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
