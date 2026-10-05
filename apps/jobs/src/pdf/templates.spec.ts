import { join } from 'node:path';

import { ESTATE_INVENTORY_FOOTER, inventorySchedule, type InventoryInput } from '@materia/domain';

/** The estate inventory template (CORE-16) filled with a schedule. Fictional data only. */

const input: InventoryInput = {
  matterNumber: 'HV-2026-0001',
  matterTitle: 'Estate of Margaret Doyle',
  deceasedName: 'Margaret Doyle',
  dateOfDeath: '2026-07-16',
  preparedOn: '2026-10-05',
  assets: [
    {
      id: 'a1',
      class: 'bank',
      description: 'Savings <script>alert(1)</script>',
      institution: 'Corio Savings Bank',
      valueAtDeathCents: 42_317_55,
      jointlyHeld: false,
      passesOutsideEstate: false,
      status: 'valued',
    },
    {
      id: 'a2',
      class: 'superannuation',
      description: 'Fictional Super Fund',
      valueAtDeathCents: 412_000_00,
      jointlyHeld: false,
      passesOutsideEstate: true,
      status: 'identified',
    },
  ],
  liabilities: [{ id: 'l1', class: 'funeral', creditor: 'Bay Funerals', amountCents: 8_500_00, status: 'paid' }],
};

describe('estate-inventory template', () => {
  let render: (templateId: string, data: Record<string, unknown>) => Promise<string>;

  beforeAll(async () => {
    process.env['TEMPLATE_DIR'] = join(import.meta.dirname, '../../templates');
    render = (await import('./render')).renderTemplate;
  });

  it('renders the schedule, groups, totals, the outside section and the not-a-court-form footer, escaped', async () => {
    const html = await render('estate-inventory', { ...inventorySchedule(input) });
    expect(html).toContain('<title>Schedule of assets and liabilities (working draft)</title>');
    expect(html).toContain('Deceased: Margaret Doyle, died 16 July 2026');
    expect(html).toContain('Prepared 5 October 2026');
    expect(html).toContain('<h3>Bank accounts</h3>');
    expect(html).toContain('Total Bank accounts');
    expect(html).toContain('$42,317.55');
    expect(html).toContain('Savings &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('<h2>Assets passing outside the estate</h2>');
    expect(html).toContain('$412,000.00');
    expect(html).toContain(`<footer>${ESTATE_INVENTORY_FOOTER}</footer>`);
    expect(html).not.toContain('class="warning"');
  });

  it('shows the insolvency warning and says when nothing is recorded', async () => {
    const html = await render('estate-inventory', {
      ...inventorySchedule({
        ...input,
        assets: [],
        liabilities: [{ id: 'l', class: 'debt', creditor: 'Lender', amountCents: 1_00, status: 'notified' }],
      }),
    });
    expect(html).toContain('class="warning"');
    expect(html).toContain('No assets recorded.');
    expect(html).not.toContain('Assets passing outside the estate</h2>');
  });

  it('is the same HTML for the same register', async () => {
    const data = { ...inventorySchedule(input) };
    expect(await render('estate-inventory', data)).toBe(await render('estate-inventory', data));
  });
});
