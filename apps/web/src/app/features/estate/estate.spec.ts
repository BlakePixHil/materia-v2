import type { DriverFactory, JobSource, JobView } from '@materia/data-access';
import { FIRESTORE_DRIVER, type InMemoryFirestore } from '@materia/data-access/repository';

import { parseMoneyInput, parseShareInput } from './estate-view';
import { JOB_SOURCE } from '../../core/jobs/job-progress';
import {
  cleanUpOverlays,
  MATTER,
  meta,
  openMatter,
  partyDoc,
  READONLY,
  type OpenOptions,
} from '../matter-detail/testing';

/** The Estate tab (CORE-16). Fictional data only. */

afterEach(cleanUpOverlays);

const ESTATE = '/matters/m-whitfield/estate';
const ON = { 'estate.register': true };
type Page = Awaited<ReturnType<typeof openMatter>>;
type Seed = Record<string, unknown>;
/** Bram Ostler's beneficiary party. */
const BRAM = partyDoc('beneficiary', 'c-bram')[0].split('/').pop() as string;
const blobText = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });

const asset = (data: Seed = {}): Seed => ({
  class: 'bank',
  description: 'Everyday account',
  valueAtDeathCents: 1_250_000,
  jointlyHeld: false,
  passesOutsideEstate: false,
  status: 'valued',
  documentIds: [],
  deletedAt: null,
  ...meta,
  ...data,
});
const liability = (data: Seed = {}): Seed => ({
  class: 'funeral',
  creditor: 'Fictional Funerals',
  amountCents: 850_000,
  status: 'notified',
  deletedAt: null,
  ...meta,
  ...data,
});

/** The tab, once its lazy page and the flags have loaded. */
async function open(options: OpenOptions = {}, flags: Record<string, boolean> = ON) {
  const page = await openMatter(ESTATE, { ...options, flags });
  await page.stable(50);
  return page;
}

const summary = (page: Page) => page.text(page.body.querySelector('[aria-labelledby="mt-estate-summary"]'));
const quick = (page: Page, label: string) => page.body.querySelector<HTMLFormElement>(`form[aria-label="${label}"]`);
const type = (form: HTMLFormElement | null, label: string, value: string) => {
  const field = form?.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`);
  if (!field) throw new Error(`No field ${label}`);
  field.value = value;
  field.dispatchEvent(new Event(field.tagName === 'SELECT' ? 'change' : 'input'));
};
const written = (page: Page, collection: string) =>
  page.firestore.writes.filter((write) => write.path.startsWith(`${MATTER}/${collection}/`));

describe('estate view parsing', () => {
  it('reads dollars as cents and percentages as basis points', () => {
    expect(parseMoneyInput('$1,250,000.5')).toEqual({ value: 125_000_050 });
    expect(parseMoneyInput('420')).toEqual({ value: 42_000 });
    expect(parseMoneyInput('')).toEqual({ value: undefined });
    expect(parseMoneyInput('-5')).toEqual({ error: expect.any(String) });
    expect(parseShareInput('50%')).toEqual({ value: 5000 });
    expect(parseShareInput('33.33')).toEqual({ value: 3333 });
    expect(parseShareInput('120')).toEqual({ error: expect.any(String) });
  });
});

describe('estate tab', () => {
  it('is hidden while estate.register is off: its URL lands on the overview', async () => {
    const page = await open({}, {});
    const tabs = [...page.body.querySelectorAll('nav[aria-label="Matter sections"] a')].map((a) => page.text(a));
    expect(tabs).not.toContain('Estate');
    expect(page.router.url).toBe('/matters/m-whitfield/overview');
  });

  it('shows the summary: gross excludes assets passing outside the estate, shares count their part', async () => {
    const page = await open({
      configure: (fs) => {
        fs.set(`${MATTER}/assets/a-bank`, asset());
        fs.set(
          `${MATTER}/assets/a-house`,
          asset({
            class: 'real_property',
            description: '1 Fictional St',
            valueAtDeathCents: 90_000_000,
            jointlyHeld: true,
            jointHolding: 'tenants_in_common',
            shareBps: 5000,
            realisedCents: 46_000_000,
          }),
        );
        fs.set(
          `${MATTER}/assets/a-super`,
          asset({
            class: 'superannuation',
            description: 'Fictional Super',
            valueAtDeathCents: 30_000_000,
            passesOutsideEstate: true,
          }),
        );
        fs.set(`${MATTER}/liabilities/l-funeral`, liability());
      },
    });
    const text = summary(page);
    expect(text).toContain('Gross estate $462,500.00');
    expect(text).toContain('Liabilities $8,500.00');
    expect(text).toContain('Net estate $454,000.00');
    expect(text).toContain('Passing outside the estate $300,000.00');
    expect(text).toContain('Realised so far $460,000.00');
    expect(text).toContain('not distributed under the will');
    expect(page.text(page.body.querySelector('[aria-labelledby="mt-estate-assets"]'))).toContain(
      'Passing outside the estate',
    );
  });

  it('adds assets and liabilities from the quick-entry rows, and keeps the description ready for the next', async () => {
    const page = await open();
    const assets = quick(page, 'Add an asset');
    type(assets, 'New asset class', 'shares');
    type(assets, 'New asset description', 'Fictional Mining Ltd shares');
    type(assets, 'New asset value at date of death', '12,000.50');
    await page.submit(page.body.querySelector('[aria-labelledby="mt-estate-assets"]'));
    expect(written(page, 'assets').map((write) => [write.op, write.data])).toEqual([
      [
        'create',
        expect.objectContaining({
          class: 'shares',
          description: 'Fictional Mining Ltd shares',
          valueAtDeathCents: 1_200_050,
          jointlyHeld: false,
          passesOutsideEstate: false,
          status: 'valued',
          documentIds: [],
        }),
      ],
    ]);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('New asset description');
    expect(summary(page)).toContain('Gross estate $12,000.50');

    const liabilities = quick(page, 'Add a liability');
    type(liabilities, 'New liability creditor', 'Fictional Bank card');
    type(liabilities, 'New liability amount', '2000');
    await page.submit(page.body.querySelector('[aria-labelledby="mt-estate-liabilities"]'));
    expect(written(page, 'liabilities')[0]?.data).toMatchObject({
      class: 'debt',
      creditor: 'Fictional Bank card',
      amountCents: 200_000,
      status: 'notified',
    });
    expect(summary(page)).toContain('Net estate $10,000.50');
  });

  it('says what is wrong with a quick-entry row instead of saving it', async () => {
    const page = await open();
    const assets = quick(page, 'Add an asset');
    type(assets, 'New asset description', 'Car');
    type(assets, 'New asset value at date of death', 'lots');
    await page.submit(page.body.querySelector('[aria-labelledby="mt-estate-assets"]'));
    expect(written(page, 'assets')).toEqual([]);
    expect(page.text(page.body.querySelector('[aria-labelledby="mt-estate-assets"]'))).toContain(
      'Enter an amount like 1,250,000.00.',
    );
  });

  it('is ready for the next entry at once, and leaves the focus alone when the server answers later', async () => {
    // Firestore shows a new row at once and answers the write later: hold that answer.
    let firestore!: InMemoryFirestore;
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => (answer = resolve));
    const held: DriverFactory = (path, options) => {
      const driver = firestore.driver(path, options);
      return {
        ...driver,
        create: async (...args) => {
          const id = await driver.create(...args);
          await answered;
          return id;
        },
      };
    };
    const page = await open({
      configure: (fs) => (firestore = fs),
      providers: [{ provide: FIRESTORE_DRIVER, useFactory: () => held }],
    });
    const assets = quick(page, 'Add an asset');
    type(assets, 'New asset description', 'Fictional Mining Ltd shares');
    type(assets, 'New asset value at date of death', '12,000.50');
    await page.stable(); // As in a browser, the typing is rendered before Enter.
    await page.submit(page.body.querySelector('[aria-labelledby="mt-estate-assets"]'));
    const description = assets?.querySelector<HTMLInputElement>('[aria-label="New asset description"]');
    expect(document.activeElement).toBe(description);
    expect(description?.value).toBe('');

    // Someone moves on to a liability before the answer arrives: it leaves them there.
    const liabilities = quick(page, 'Add a liability');
    const creditor = liabilities?.querySelector<HTMLInputElement>('[aria-label="New liability creditor"]');
    creditor?.focus();
    type(liabilities, 'New liability creditor', 'Fictional Funerals');
    answer();
    await page.stable();
    expect(document.activeElement).toBe(creditor);
    expect(creditor?.value).toBe('Fictional Funerals');
    expect(summary(page)).toContain('Gross estate $12,000.50');
  });

  it('puts back what was entered when the save fails', async () => {
    let firestore!: InMemoryFirestore;
    const refused: DriverFactory = (path, options) => ({
      ...firestore.driver(path, options),
      create: () => Promise.reject({ code: 'permission-denied', message: 'Missing or insufficient permissions.' }),
    });
    const page = await open({
      configure: (fs) => (firestore = fs),
      providers: [{ provide: FIRESTORE_DRIVER, useFactory: () => refused }],
    });
    const assets = quick(page, 'Add an asset');
    type(assets, 'New asset description', 'Fictional Mining Ltd shares');
    type(assets, 'New asset value at date of death', '12,000.50');
    await page.submit(page.body.querySelector('[aria-labelledby="mt-estate-assets"]'));
    await page.stable();
    expect(assets?.querySelector<HTMLInputElement>('[aria-label="New asset description"]')?.value).toBe(
      'Fictional Mining Ltd shares',
    );
    expect(assets?.querySelector<HTMLInputElement>('[aria-label="New asset value at date of death"]')?.value).toBe(
      '12,000.50',
    );
    expect(page.text(page.body.querySelector('[aria-labelledby="mt-estate-assets"]'))).toContain(
      'The estate register didn’t save',
    );
  });

  it('warns on an insolvent estate and disables distributions', async () => {
    const page = await open({
      configure: (fs) => {
        fs.set(`${MATTER}/assets/a-bank`, asset({ valueAtDeathCents: 100_000 }));
        fs.set(`${MATTER}/liabilities/l-card`, liability({ class: 'debt', amountCents: 500_000 }));
        fs.set(...partyDoc('beneficiary', 'c-bram'));
      },
    });
    expect(summary(page)).toContain('appears insolvent');
    expect(page.buttons('Record distribution…')[0]?.hasAttribute('disabled')).toBe(true);
    expect(page.text(page.body.querySelector('[aria-labelledby="mt-estate-distributions"]'))).toContain(
      'Distributions are disabled while the estate is insolvent.',
    );
  });

  it('records a pecuniary gift to a beneficiary and shows the residue after it', async () => {
    const page = await open({
      matter: { estate: { grantType: 'probate', reservedCents: 1_000_000 } },
      configure: (fs) => {
        fs.set(`${MATTER}/assets/a-bank`, asset({ valueAtDeathCents: 5_000_000 }));
        fs.set(...partyDoc('beneficiary', 'c-bram', { share: 'Residue' }));
      },
    });
    await page.click('Record distribution…');
    const dialog = page.dialog() ?? page.body;
    expect(page.text(dialog)).toContain('Bram Ostler');
    await page.fill('Amount', '15000', dialog);
    await page.submit(page.dialog());
    expect(written(page, 'distributions')[0]?.data).toMatchObject({
      beneficiaryPartyId: BRAM,
      kind: 'pecuniary',
      status: 'planned',
      amountCents: 1_500_000,
    });
    const section = page.text(page.body.querySelector('[aria-labelledby="mt-estate-distributions"]'));
    expect(section).toContain('Bram Ostler');
    expect(section).toContain('Pecuniary gift · $15,000.00 · Planned');
    expect(section).toContain('Less pecuniary gifts$15,000.00');
    expect(section).toContain('Less held in reserve');
    expect(section).toContain('Residue$25,000.00');
  });

  it('flags a distribution for review and lets a person clear it', async () => {
    const page = await open({
      configure: (fs) => {
        fs.set(`${MATTER}/assets/a-bank`, asset());
        fs.set(...partyDoc('beneficiary', 'c-bram'));
        fs.set(`${MATTER}/distributions/d-1`, {
          beneficiaryPartyId: BRAM,
          kind: 'residuary',
          share: 'One half',
          status: 'planned',
          needsValueReview: true,
          deletedAt: null,
          ...meta,
        });
      },
    });
    const section = () => page.text(page.body.querySelector('[aria-labelledby="mt-estate-distributions"]'));
    expect(section()).toContain('One half of the residue');
    expect(section()).toContain('Needs review');
    await page.click('Mark reviewed');
    expect(written(page, 'distributions').at(-1)).toMatchObject({ op: 'update', data: { needsValueReview: false } });
    expect(section()).not.toContain('Needs review');
  });

  it('downloads the inventory as CSV', async () => {
    const page = await open({
      configure: (fs) => {
        fs.set(`${MATTER}/assets/a-bank`, asset());
        fs.set(`${MATTER}/liabilities/l-funeral`, liability());
      },
    });
    let blob: Blob | null = null;
    let name = '';
    const create = vi.spyOn(URL, 'createObjectURL').mockImplementation((value) => {
      blob = value as Blob;
      return 'blob:estate';
    });
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      name = this.download;
    });
    try {
      await page.click('Download CSV');
      await page.stable(10);
      expect(name).toBe('Schedule of assets and liabilities (working draft) - M-2026-0142.csv');
      const csv = await blobText(blob as unknown as Blob);
      expect(csv.split('\r\n')[1]).toBe('Assets,Bank accounts,Everyday account,,12500.00,12500.00,,No,Valued,,,,,');
      expect(csv).toContain('Summary,,Net estate,,,4000.00');
    } finally {
      create.mockRestore();
      revoke.mockRestore();
      click.mockRestore();
    }
  });

  it('exports the PDF through estate-exportInventory and follows its job', async () => {
    let report: ((job: JobView | null) => void) | undefined;
    const jobs: JobSource = {
      watch: (_org, _job, next) => {
        report = next;
        return () => undefined;
      },
    };
    const page = await open({
      configure: (fs) => fs.set(`${MATTER}/assets/a-bank`, asset()),
      callables: { 'estate-exportInventory': () => ({ jobId: 'job-1' }) },
      providers: [{ provide: JOB_SOURCE, useValue: jobs }],
    });
    await page.click('Export PDF');
    expect(page.calls('estate-exportInventory')).toEqual([{ matterId: 'm-whitfield', requestId: expect.any(String) }]);
    expect(page.body.querySelector('mt-job-progress')).not.toBeNull();
    report?.({ status: 'succeeded', progress: { done: 1, total: 1 }, warnings: [] });
    await page.stable();
    expect(page.body.querySelector('mt-job-progress')).toBeNull();
    expect(page.text()).toContain('Inventory PDF is ready');
  });

  it('is read-only for a read-only member: no quick entry, no adding', async () => {
    const page = await open({ session: READONLY, configure: (fs) => fs.set(`${MATTER}/assets/a-bank`, asset()) });
    expect(summary(page)).toContain('Gross estate $12,500.00');
    expect(quick(page, 'Add an asset')).toBeNull();
    expect(page.buttons('Add asset…')).toHaveLength(0);
    expect(page.buttons('Export PDF')).toHaveLength(0);
  });
});
