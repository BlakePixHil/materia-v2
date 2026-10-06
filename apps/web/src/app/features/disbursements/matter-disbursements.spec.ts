import { storedDocument } from '../documents/testing';
import { cleanUpOverlays, MATTER, meta, openMatter, READONLY } from '../matter-detail/testing';

/** Disbursements on the matter's Time tab (BILL-04). Fictional data only. */

afterEach(() => {
  cleanUpOverlays();
  localStorage.removeItem('materia.disbursements.amountEntry');
});

const URL = '/matters/m-whitfield/time';
const ORG = 'org-harbour-vine';
const ON = { 'billing.disbursements': true };
type Page = Awaited<ReturnType<typeof openMatter>>;
type Seed = Record<string, unknown>;

function item(data: Seed = {}): Seed {
  return {
    orgId: ORG,
    matterId: 'm-whitfield',
    date: '2026-10-01',
    description: 'Title search',
    payee: 'Fictional Titles Office',
    category: 'search',
    amountExGstCents: 2_000,
    gstCents: 200,
    amountIncGstCents: null,
    gstTreatment: 'taxable',
    receiptDocumentId: null,
    status: 'unbilled',
    wipCountedCents: 2_000,
    deletedAt: null,
    ...meta,
    ...data,
  };
}

function practice(fs: Page['firestore']): void {
  fs.set(`${MATTER}/disbursements/d-1`, item());
  fs.set(
    `${MATTER}/disbursements/d-2`,
    item({
      date: '2026-09-28',
      description: 'Supreme Court filing fee',
      payee: 'Fictional Registry',
      category: 'court_fee',
      amountExGstCents: 34_560,
      gstCents: 0,
      gstTreatment: 'gst_free',
      receiptDocumentId: 'doc-receipt',
    }),
  );
  fs.set(`${MATTER}/disbursements/d-3`, item({ description: 'Courier', status: 'written_off', wipCountedCents: 0 }));
  fs.set(`${MATTER}/disbursements/d-4`, item({ description: 'Valuation', status: 'billed', invoiceId: 'inv-1' }));
  fs.set(`${MATTER}/documents/doc-receipt`, storedDocument('doc-receipt', 'Registry receipt.pdf'));
}

/** disbursements-setStatus as the server runs it. */
const setStatus = (data: Seed, fs: Page['firestore']) => {
  const updated: string[] = [];
  for (const id of data['disbursementIds'] as string[]) {
    const path = `${MATTER}/disbursements/${id}`;
    const stored = fs.get(path);
    if (!stored) continue;
    fs.set(path, { ...stored, status: data['status'] });
    updated.push(id);
  }
  return { updated, skipped: [] };
};

const open = (options: Parameters<typeof openMatter>[1] = {}) =>
  openMatter(URL, { configure: practice, callables: { 'disbursements-setStatus': setStatus }, flags: ON, ...options });

const section = (page: Page) => page.body.querySelector<HTMLElement>('mt-matter-disbursements') as HTMLElement;
const form = (page: Page) => section(page).querySelector<HTMLElement>('mt-disbursement-form') as HTMLElement;
const rows = (page: Page) =>
  [...section(page).querySelectorAll('tbody tr')].map((row) =>
    [...row.querySelectorAll('td')].slice(1, 6).map((cell) => page.text(cell)),
  );
const created = (page: Page) =>
  page.firestore.writes
    .filter((write) => write.op === 'create' && write.path.includes('/disbursements/'))
    .map((write) => page.firestore.get(write.path) as Seed);

/** Picks a native select's option by its text. */
async function choose(page: Page, label: string, text: string, root: HTMLElement): Promise<void> {
  const host = [...root.querySelectorAll('mt-select')].find((field) =>
    field.querySelector('.mt-label')?.textContent?.trim().startsWith(label),
  );
  const select = host?.querySelector('select') as HTMLSelectElement;
  const option = [...select.options].find((o) => o.textContent?.trim() === text);
  if (!option) throw new Error(`No option "${text}"`);
  select.value = option.value;
  select.dispatchEvent(new Event('change'));
  await page.stable();
}

describe('matter disbursements', () => {
  it('is hidden while billing.disbursements is off', async () => {
    const page = await open({ flags: {} });
    expect(section(page)).toBeNull();
  });

  it('lists disbursements with GST, totals of the unbilled ones and the receipt', async () => {
    const page = await open();
    expect(page.text(section(page).querySelector('h2'))).toBe('Disbursements');
    expect(rows(page)).toEqual([
      ['Title search Search · Fictional Titles Office', 'Taxable (10% GST)', '$20.00', '$2.00', '$22.00'],
      ['Courier Search · Fictional Titles Office Written off', 'Taxable (10% GST)', '$20.00', '$2.00', '$22.00'],
      ['Valuation Search · Fictional Titles Office Billed', 'Taxable (10% GST)', '$20.00', '$2.00', '$22.00'],
      ['Supreme Court filing fee Court fee · Fictional Registry', 'GST-free', '$345.60', '$0.00', '$345.60'],
    ]);
    // Written-off and billed ones aren't counted.
    expect(page.text(section(page).querySelector('[data-testid="disbursement-totals"]'))).toBe(
      '2 unbilled · $365.60 ex GST · $2.00 GST',
    );
    expect(page.buttons('Open the receipt', section(page))[0]?.getAttribute('href')).toBe(
      '/matters/m-whitfield/documents/doc-receipt',
    );
  });

  it('adds one from a preset, GST-inclusive: the 1-cent remainder sits in the GST', async () => {
    const page = await open();
    await page.click('Add disbursement', section(page));
    await choose(page, 'Preset', 'Statutory notice (s 33) advertisement', form(page));
    expect(form(page).querySelector<HTMLInputElement>('mt-text-field.description input')?.value).toBe(
      'Statutory notice (s 33) advertisement',
    );
    await page.fill('Amount paid', '11.05', form(page));
    expect(page.text(form(page).querySelector('[data-testid="disbursement-preview"]'))).toBe(
      '$10.05 + $1.00 GST = $11.05',
    );
    await choose(page, 'Receipt', 'Registry receipt.pdf', form(page));
    await page.submit(form(page));
    expect(created(page)).toEqual([
      expect.objectContaining({
        orgId: ORG,
        matterId: 'm-whitfield',
        date: '2026-10-04',
        description: 'Statutory notice (s 33) advertisement',
        category: 'advertising',
        presetId: 's33-notice',
        gstTreatment: 'taxable',
        amountIncGstCents: 1_105,
        amountExGstCents: 1_005,
        gstCents: 100,
        receiptDocumentId: 'doc-receipt',
        status: 'unbilled',
        wipCountedCents: 0,
      }),
    ]);
  });

  it('enters excluding GST, remembers that choice, and checks the fields', async () => {
    const page = await open();
    await page.click('Add disbursement', section(page));
    await page.submit(form(page));
    expect(page.text(form(page))).toContain('Say what was paid for.');
    expect(page.text(form(page))).toContain('Enter the amount paid.');
    await page.click('Excl. GST', form(page));
    expect(localStorage.getItem('materia.disbursements.amountEntry')).toBe('ex');
    await page.fill('Description', 'Death certificate', form(page));
    await choose(page, 'GST', 'GST-free', form(page));
    await page.fill('Amount paid', '42.50', form(page));
    expect(page.text(form(page).querySelector('[data-testid="disbursement-preview"]'))).toBe('$42.50, no GST');
    await page.submit(form(page));
    expect(created(page)[0]).toMatchObject({
      amountExGstCents: 4_250,
      gstCents: 0,
      amountIncGstCents: null,
      gstTreatment: 'gst_free',
    });
    // The next one starts excluding GST.
    await page.click('Add disbursement', section(page));
    expect(form(page).querySelector('.mt-seg-item[data-selected]')?.textContent?.trim()).toBe('Excl. GST');
  });

  it('edits unbilled ones; billed ones have no menu; approvers write off and restore', async () => {
    const page = await open();
    await page.click('More actions for Title search', section(page));
    await page.click('Edit');
    const editing = section(page).querySelector<HTMLElement>('tbody mt-disbursement-form') as HTMLElement;
    expect(editing.querySelector<HTMLInputElement>('mt-text-field.description input')?.value).toBe('Title search');
    await page.fill('Amount paid', '30', editing);
    await page.submit(editing);
    expect(page.firestore.get(`${MATTER}/disbursements/d-1`)).toMatchObject({
      amountExGstCents: 3_000,
      gstCents: 300,
      amountIncGstCents: null,
    });

    expect(page.buttons('More actions for Valuation', section(page))).toHaveLength(0);

    await page.click('More actions for Title search', section(page));
    await page.click('Write off');
    expect(page.calls('disbursements-setStatus')).toEqual([
      expect.objectContaining({ matterId: 'm-whitfield', disbursementIds: ['d-1'], status: 'written_off' }),
    ]);
    await page.click('More actions for Courier', section(page));
    expect(page.buttons('Edit')).toHaveLength(0);
    await page.click('Restore');
    expect(page.firestore.get(`${MATTER}/disbursements/d-3`)?.['status']).toBe('unbilled');
  });

  it('deletes an unbilled one after confirming', async () => {
    const page = await open();
    await page.click('More actions for Supreme Court filing fee', section(page));
    await page.click('Delete');
    expect(page.text(page.dialog())).toContain('The receipt stays in Documents.');
    await page.click('Delete disbursement', page.dialog() as HTMLElement);
    expect(page.firestore.get(`${MATTER}/disbursements/d-2`)?.['deletedAt']).toBeTruthy();
    expect(rows(page)).toHaveLength(3);
  });

  it('a read-only member sees them but records none', async () => {
    const page = await open({ session: READONLY });
    expect(page.buttons('Add disbursement', section(page))).toHaveLength(0);
    expect(rows(page)).toHaveLength(4);
    expect(page.buttons('More actions for Title search', section(page))).toHaveLength(0);
  });
});
