import { TestBed } from '@angular/core/testing';

import type { InMemoryFirestore } from '@materia/data-access/repository';

import {
  ADMIN,
  cleanUpOverlays,
  matterDoc,
  meta,
  ME,
  openMatter,
  ORG,
  PARALEGAL,
  PRIYA,
  READONLY,
} from '../matter-detail/testing';

/**
 * The Insights screen (INS-02) against the in-memory Firestore: figures from the INS-01 metrics
 * documents, period switching (kept in the URL), comparison deltas, member visibility, CSV, the
 * empty and error states, and drill-down into matters and deadlines. A fictional practice; today is
 * Sunday 4 October 2026, in FY2026–27.
 */

afterEach(cleanUpOverlays);

type Page = Awaited<ReturnType<typeof openMatter>>;
type Seed = Record<string, unknown>;
const METRICS = `orgs/${ORG}/metrics`;
const MATTERS = `orgs/${ORG}/matters`;

const blobText = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });

/**
 * July: $40,000 billed, two probate matters (one referred by Bram Ostler), two deadlines met on
 * time. September: $20,000 billed, a will, a missed deadline. October so far: the WIP snapshot.
 * Jordan (lawyer) has a $200,000 FY budget; Jordan and Priya have FY figures.
 */
function practice(fs: InMemoryFirestore): void {
  fs.set(`orgs/${ORG}`, {
    name: 'Harbour & Vine Legal',
    timezone: 'Australia/Melbourne',
    fy: { startMonth: 7 },
    billing: { dailyTargetMinutes: 360 },
  });
  fs.set(`orgs/${ORG}/members/${ME}`, {
    ...fs.get(`orgs/${ORG}/members/${ME}`),
    budgets: { '2026': 20_000_000 },
  });
  fs.set(`${METRICS}/month-2026-07`, {
    period: 'month-2026-07',
    values: {
      'billing.invoicedCents': 4_000_000,
      'billing.collectedCents': 3_000_000,
      'time.billable.minutes': 9_000,
      'matters.opened': 2,
      'matters.opened.type.probate': 2,
      'matters.opened.referrer.c-bram': 1,
      'referrals.referrer.c-bram.billedCents': 500_000,
      'deadlines.due': 2,
      'deadlines.metOnTime': 2,
      'cycle.probate.instructionsToGrant.d45': 1,
    },
  });
  fs.set(`${METRICS}/month-2026-09`, {
    period: 'month-2026-09',
    values: {
      'billing.invoicedCents': 2_000_000,
      'billing.collectedCents': 2_500_000,
      'time.billable.minutes': 6_000,
      'matters.opened': 1,
      'matters.opened.type.will': 1,
      'deadlines.due': 1,
      'deadlines.missed': 1,
    },
  });
  fs.set(`${METRICS}/month-2026-10`, { period: 'month-2026-10', values: { 'wip.timeCents': 1_200_000 } });
  fs.set(`${METRICS}/fy-2026/byMember/${ME}`, {
    period: 'fy-2026',
    uid: ME,
    values: { 'time.billable.minutes': 9_000, 'time.recordedCents': 6_000_000 },
  });
  fs.set(`${METRICS}/fy-2026/byMember/${PRIYA}`, {
    period: 'fy-2026',
    uid: PRIYA,
    values: { 'time.billable.minutes': 6_000, 'time.recordedCents': 2_000_000 },
  });

  // The records behind the bars: probate matters opened in the FY (a lead and an older one aside),
  // and deadlines due in July, one met on time and one late.
  const opened = (id: string, at: string, data: Seed) =>
    fs.set(`${MATTERS}/${id}`, matterDoc({ ...data, createdAt: new Date(at) }));
  opened('m-hale', '2026-07-09T23:30:00Z', { number: 'M-2026-0101', title: 'Estate of Ivy Hale' });
  opened('m-lead', '2026-07-12T01:00:00Z', { number: 'M-2026-0102', title: 'Estate of Rowan Lake', status: 'lead' });
  opened('m-older', '2026-05-02T01:00:00Z', { number: 'M-2026-0050', title: 'Estate of Otto Fern' });
  opened('m-will', '2026-09-03T01:00:00Z', { number: 'M-2026-0150', title: 'Will of Nell Avon', type: 'will' });
  const deadline = (id: string, data: Seed) =>
    fs.set(`${MATTERS}/m-whitfield/deadlines/${id}`, {
      kind: 'statutory',
      critical: false,
      status: 'done',
      assigneeUid: ME,
      orgId: ORG,
      matterId: 'm-whitfield',
      privileged: false,
      deletedAt: null,
      ...meta,
      ...data,
    });
  deadline('d-filed', {
    title: 'File the probate application',
    dueDate: '2026-07-20',
    resolution: { on: '2026-07-19', by: ME, at: new Date('2026-07-19T02:00:00Z') },
  });
  deadline('d-late', {
    title: 'Serve the notice on the beneficiaries',
    dueDate: '2026-07-25',
    resolution: { on: '2026-07-28', by: ME, at: new Date('2026-07-28T02:00:00Z') },
  });
}

async function open(url: string, options: Parameters<typeof openMatter>[1] = {}): Promise<Page> {
  const page = await openMatter(url, {
    ...options,
    configure: (fs, port) => {
      practice(fs);
      options.configure?.(fs, port);
    },
  });
  await page.stable(10);
  return page;
}

const card = (page: Page, title: string) =>
  [...page.body.querySelectorAll<HTMLElement>('mt-insights-card')].find(
    (node) => node.querySelector('h2')?.textContent?.trim() === title,
  ) ?? null;
const stat = (page: Page, id: string) => page.text(page.body.querySelector(`[data-testid="stat-${id}"] .v`));

/** Picks the option labelled `label` in the select labelled `field`. */
async function choose(page: Page, field: string, label: string) {
  const host = [...page.body.querySelectorAll('mt-select')].find((select) =>
    select.querySelector('.mt-label')?.textContent?.trim().startsWith(field),
  );
  const select = host?.querySelector('select');
  const option = [...(select?.options ?? [])].find((o) => o.textContent?.trim() === label);
  if (!select || !option) throw new Error(`No option "${label}" in "${field}"`);
  select.value = option.value;
  select.dispatchEvent(new Event('change'));
  await page.stable(10);
}

/** A chart's "View as table" rows, each as its cells' text joined by spaces. */
function tableRows(page: Page, title: string): string[] {
  const rows = card(page, title)?.querySelectorAll('details tbody tr') ?? [];
  return [...rows].map((row) => [...row.querySelectorAll('th, td')].map((cell) => page.text(cell)).join(' '));
}

/** Clicks a chart's bar, as a pointer would. */
async function clickBar(page: Page, chart: HTMLElement | null, index: number) {
  const bar = chart?.querySelector(`[data-point="${index}"]`);
  if (!bar) throw new Error(`No bar ${index}`);
  bar.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await page.stable(10);
  await page.stable(10);
}

describe('Insights', () => {
  it('shows this FY to date from the metrics documents: hero, Stats and every chart', async () => {
    const page = await open('/insights?period=this_fy');
    expect(page.text(page.body.querySelector('h1'))).toBe('Insights');
    expect(page.text(page.body.querySelector('[data-testid="insights-subtitle"]'))).toBe('FY2026–27 to date');

    const hero = page.body.querySelector('[data-testid="insights-hero"]');
    expect(page.text(hero?.querySelector('h2'))).toBe('Billed in FY2026–27 to date');
    expect(page.text(page.body.querySelector('[data-testid="hero-billed"]'))).toBe('$60,000.00');
    expect(page.text(page.body.querySelector('[data-testid="hero-budget"]'))).toBe('30% of the $200,000.00 budget');

    expect(stat(page, 'collected')).toBe('$55,000.00');
    expect(stat(page, 'wip')).toBe('$12,000.00');
    // 68 working days to 4 October, 6 hours a day, for three fee earners: 15,000 of 73,440 minutes.
    expect(stat(page, 'utilisation')).toBe('20%');
    expect(stat(page, 'opened')).toBe('3');
    // Two met on time of three resolved.
    expect(stat(page, 'deadlines')).toBe('67%');

    const titles = [...page.body.querySelectorAll('mt-insights-card h2')].map((h) => page.text(h));
    expect(titles).toEqual([
      'Billed by month',
      'Collected by month',
      'Matters opened by type',
      'Median days to grant',
      'Utilisation by fee earner',
      'Deadline performance',
      'Referrers by fees',
      'FY2026–27 budget by fee earner',
    ]);
    // Every chart has its table view and a CSV.
    expect(page.body.querySelectorAll('mt-insights-card [data-csv]')).toHaveLength(8);
    expect(page.body.querySelectorAll('mt-insights-card details.mt-tableview')).toHaveLength(8);

    expect(tableRows(page, 'Matters opened by type')).toEqual(['Probate 2', 'Will 1']);
    // Sam Lee is read-only, not a fee earner.
    expect(tableRows(page, 'Utilisation by fee earner')).toEqual([
      'Jordan Price 37% 100%',
      'Priya Shah 25% 100%',
      'Daniel Kim 0% 100%',
    ]);
    expect(tableRows(page, 'Referrers by fees')).toEqual(['Bram Ostler $5,000.00']);
    const budgets = [...page.body.querySelectorAll('[data-testid="insights-budgets"] li')].map((li) =>
      [...li.querySelectorAll('.name, .pct')].map((cell) => page.text(cell)).join(' '),
    );
    expect(budgets).toEqual(['Jordan Price 30%']);
  });

  it('switches the period and comparison, keeping them in the URL', async () => {
    const page = await open('/insights?period=this_fy');
    await choose(page, 'Period', 'Last month');
    expect(page.router.url).toBe('/insights?period=last_month');
    expect(page.text(page.body.querySelector('[data-testid="insights-subtitle"]'))).toBe('September 2026');
    expect(page.text(page.body.querySelector('[data-testid="hero-billed"]'))).toBe('$20,000.00');
    expect(stat(page, 'opened')).toBe('1');
    expect(page.body.querySelector('[data-testid="hero-budget"]')).toBeNull();

    await choose(page, 'Compare with', 'Previous period');
    expect(page.router.url).toBe('/insights?period=last_month&compare=previous');
    expect(page.text(page.body.querySelector('[data-testid="insights-subtitle"]'))).toBe(
      'September 2026 · Compared with August 2026',
    );
    // Nothing billed in August: up $20,000.
    expect(page.text(page.body.querySelector('[data-testid="insights-hero"] mt-delta'))).toContain('+$20,000.00');
    expect(page.text(page.body.querySelector('[data-testid="stat-collected"]'))).toContain('vs August 2026');

    // Chosen months, from the URL.
    await choose(page, 'Period', 'Choose months');
    expect(page.router.url).toBe('/insights?period=custom&compare=previous&from=2026-09&to=2026-09');
    await choose(page, 'From', 'July 2026');
    expect(page.text(page.body.querySelector('[data-testid="insights-subtitle"]'))).toContain('Jul 2026 – Sep 2026');
    expect(page.text(page.body.querySelector('[data-testid="hero-billed"]'))).toBe('$60,000.00');
  });

  it('downloads a chart’s data as CSV', async () => {
    const page = await open('/insights?period=this_fy');
    let blob: Blob | null = null;
    let name = '';
    const create = vi.spyOn(URL, 'createObjectURL').mockImplementation((value) => {
      blob = value as Blob;
      return 'blob:insights';
    });
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      name = this.download;
    });
    try {
      card(page, 'Deadline performance')?.querySelector<HTMLElement>('[data-csv]')?.click();
      await page.stable(10);
      expect(name).toBe('insights-deadline-performance-fy2026-27-to-date.csv');
      expect(await blobText(blob as unknown as Blob)).toBe(
        'Result,Deadlines\r\nMet on time,2\r\nMet late,0\r\nMissed,1\r\nWaived,0\r\n',
      );
    } finally {
      create.mockRestore();
      revoke.mockRestore();
      click.mockRestore();
    }
  });

  it('drills from a matter type into the matters opened, and from a result into the deadlines', async () => {
    const page = await open('/insights?period=this_fy');
    await clickBar(page, card(page, 'Matters opened by type'), 0);
    const dialog = page.dialog();
    expect(page.text(dialog?.querySelector('h2'))).toBe('Probate matters opened');
    // Opened in the FY, oldest first; the lead and the matter from May aren't listed.
    const rows = [...(dialog?.querySelectorAll('[data-drill-list] li') ?? [])].map((li) =>
      page.text(li.querySelector('.primary')),
    );
    expect(rows).toEqual(['M-2026-0101 Estate of Ivy Hale', 'M-2026-0142 Estate of Margaret Whitfield']);
    dialog?.querySelector<HTMLElement>('[data-drill-list] a')?.click();
    await page.stable(10);
    expect(page.router.url).toBe('/matters/m-hale/overview');

    await page.router.navigateByUrl('/insights?period=this_fy');
    await page.stable(10);
    await page.stable(10);
    await clickBar(page, card(page, 'Deadline performance'), 0);
    expect(page.text(page.dialog()?.querySelector('h2'))).toBe('Deadlines met on time');
    expect(page.text(page.dialog()?.querySelector('[data-drill-list]'))).toContain('File the probate application');
    expect(page.text(page.dialog()?.querySelector('[data-drill-list]'))).not.toContain('Serve the notice');
  });

  it('opens a referrer’s contact from their bar', async () => {
    const page = await open('/insights?period=this_fy');
    await clickBar(page, card(page, 'Referrers by fees'), 0);
    expect(page.router.url).toBe('/contacts?contact=c-bram');
  });

  it('shows a paralegal only their own figures while the firm keeps them to lawyers', async () => {
    const page = await open('/insights?period=this_fy', { session: PARALEGAL });
    const utilisation = card(page, 'Utilisation by fee earner');
    expect(page.text(utilisation)).toContain(
      'Only your own figures: your firm shows everyone’s to owners, admins and lawyers.',
    );
    expect(page.text(utilisation?.querySelector('details'))).not.toContain('Priya Shah');
  });

  it('lets an admin choose who sees everyone’s figures, keeping the rest of the settings', async () => {
    const lawyer = await open('/insights?period=this_fy');
    // A lawyer doesn't change it.
    expect(lawyer.body.querySelector('mt-insights-visibility mt-select')).toBeNull();
    cleanUpOverlays();
    TestBed.resetTestingModule();

    const page = await open('/insights?period=this_fy', {
      session: ADMIN,
      configure: (fs) =>
        fs.set(`orgs/${ORG}`, { ...fs.get(`orgs/${ORG}`), settings: { referrals: { thankYouTask: true } } }),
    });
    await choose(page, 'Everyone’s figures shown to', 'Everyone in the firm');
    await page.stable(10);
    expect(page.firestore.get(`orgs/${ORG}`)?.['settings']).toEqual({
      referrals: { thankYouTask: true },
      insights: { memberVisibility: 'everyone' },
    });
    expect(page.text()).toContain('Everyone’s figures are shown to everyone in the firm');
  });

  it('explains an empty period, and offers a retry when the figures can’t be read', async () => {
    const empty = await open('/insights?period=custom&from=2026-08&to=2026-08');
    expect(empty.text(empty.body.querySelector('[data-testid="insights-empty"]'))).toContain(
      'Insights appear after your first month',
    );
    expect(empty.body.querySelector('mt-insights-card')).toBeNull();
    cleanUpOverlays();
    TestBed.resetTestingModule();

    const page = await open('/insights?period=this_fy', {
      configure: (fs) => fs.failNext({ code: 'unavailable', message: 'offline' }, 'metrics'),
    });
    expect(page.text(page.body.querySelector('[role="alert"]'))).toContain('Insights couldn’t be loaded');
    await page.click('Try again');
    await page.stable(10);
    expect(page.text(page.body.querySelector('[data-testid="hero-billed"]'))).toBe('$60,000.00');
  });
});

describe('Insights: Clerk explains what changed (INS-04)', () => {
  const CLERK = { 'clerk.enabled': true, 'clerk.features.insightsNarrative': true };
  const billed = {
    metric: 'billing.invoicedCents',
    period: 'current',
    label: 'Billed, excluding GST',
    value: '$60,000',
  };
  const wills = {
    metric: 'matters.opened.type',
    dimension: 'will',
    period: 'current',
    label: 'Matters opened: wills',
    value: '1',
  };
  const missed = { metric: 'deadlines.missed', period: 'current', label: 'Deadlines missed', value: '1' };
  const recorded = { metric: 'time.recordedCents', period: 'current', label: 'Time recorded', value: '$80,000' };

  /** An explanation written just now, so Refresh waits its 10 minutes. */
  function narrative(extra: Seed = {}) {
    const at = Date.now();
    return {
      periodLabel: 'FY2026–27 to date',
      comparisonLabel: null,
      paragraphs: [
        { text: 'So far this year the practice has billed $60,000.', citations: [billed] },
        {
          text: 'It opened 1 will, 1 deadline was missed and $80,000 of time was recorded.',
          citations: [wills, missed, recorded],
        },
      ],
      insufficientData: false,
      omitted: 1,
      generatedAt: new Date(at).toISOString(),
      refreshAfter: new Date(at + 600_000).toISOString(),
      expiresAt: new Date(at + 86_400_000).toISOString(),
      stale: false,
      promptRef: 'insights-narrative@1.0.0',
      ...extra,
    };
  }
  const explaining = (kept: Seed | null = null) => ({
    // The kept explanation is this FY's; every other selection has none.
    'clerk-explainInsights': (data: Seed) => ({
      narrative: data['mode'] !== 'cached' ? narrative() : data['range'] === 'this_fy' ? kept : null,
    }),
  });
  const section = (page: Page) => page.body.querySelector<HTMLElement>('[data-testid="insights-narrative"]');
  const chip = (page: Page, label: string) =>
    [...(section(page)?.querySelectorAll<HTMLElement>('.mt-cite') ?? [])].find((node) =>
      page.text(node).startsWith(label),
    ) ?? null;
  const bars = (page: Page, title: string) =>
    [...(card(page, title)?.querySelectorAll('path.bar') ?? [])].map((bar) => bar.classList.contains('muted'));

  it('is hidden while Clerk or the feature is off', async () => {
    const page = await open('/insights?period=this_fy', { flags: { 'clerk.enabled': true } });
    expect(section(page)).toBeNull();
    expect(page.calls('clerk-explainInsights')).toEqual([]);
  });

  it('explains the selection with Clerk, then picks out each cited figure from its chip', async () => {
    const page = await open('/insights?period=this_fy', { flags: CLERK, callables: explaining() });
    expect(page.calls('clerk-explainInsights')).toEqual([{ range: 'this_fy', compare: 'none', mode: 'cached' }]);
    expect(page.text(section(page))).toContain('Clerk can describe what changed in FY2026–27 to date');

    await page.click('Explain with Clerk', section(page) as HTMLElement);
    await page.stable(10);
    expect(page.calls('clerk-explainInsights')[1]).toMatchObject({
      range: 'this_fy',
      compare: 'none',
      mode: 'explain',
    });
    const text = page.text(section(page));
    expect(text).toContain('So far this year the practice has billed $60,000.');
    expect(page.text(section(page)?.querySelector('[data-testid="narrative-omitted"]'))).toBe(
      'Clerk left out a paragraph whose numbers didn’t match the figures.',
    );
    // Just written: Refresh waits 10 minutes.
    expect(page.buttons('Refresh', section(page) as HTMLElement)[0]?.hasAttribute('disabled')).toBe(true);

    // A Stat's figure: the hero is outlined.
    chip(page, 'Billed, excluding GST')?.click();
    await page.stable();
    expect(page.body.querySelector('[data-testid="insights-hero"]')?.hasAttribute('data-cited')).toBe(true);

    // A chart's bar: the others mute.
    chip(page, 'Matters opened: wills')?.click();
    await page.stable();
    expect(page.body.querySelector('[data-testid="insights-hero"]')?.hasAttribute('data-cited')).toBe(false);
    expect(card(page, 'Matters opened by type')?.hasAttribute('data-cited')).toBe(true);
    expect(bars(page, 'Matters opened by type')).toEqual([true, false]);
    chip(page, 'Deadlines missed')?.click();
    await page.stable();
    // Met on time (muted) and missed: the empty results draw no bar.
    expect(bars(page, 'Deadline performance')).toEqual([true, false]);

    // A figure the screen doesn't show stays a plain chip.
    expect(chip(page, 'Time recorded')?.tagName).toBe('SPAN');
  });

  it('shows the explanation kept for the selection, says when the figures have moved, and refreshes it', async () => {
    const kept = narrative({ stale: true, refreshAfter: new Date(Date.now() - 1000).toISOString() });
    const page = await open('/insights?period=this_fy', { flags: CLERK, callables: explaining(kept) });
    expect(page.text(section(page))).toContain('So far this year the practice has billed $60,000.');
    expect(page.text(section(page)?.querySelector('[data-testid="narrative-stale"]'))).toContain(
      'The figures have changed since Clerk wrote this.',
    );
    await page.click('Refresh', section(page) as HTMLElement);
    await page.stable(10);
    expect(page.calls('clerk-explainInsights').map((call) => call['mode'])).toEqual(['cached', 'refresh']);
    expect(section(page)?.querySelector('[data-testid="narrative-stale"]')).toBeNull();

    // Another period asks for its own.
    await choose(page, 'Period', 'Last month');
    expect(page.calls('clerk-explainInsights').at(-1)).toEqual({
      range: 'last_month',
      compare: 'none',
      mode: 'cached',
    });
    expect(page.text(section(page))).toContain('Clerk can describe what changed in September 2026');
  });

  it('says when Clerk’s explanation failed or didn’t match the figures', async () => {
    const page = await open('/insights?period=this_fy', {
      flags: CLERK,
      callables: {
        'clerk-explainInsights': (data: Seed) =>
          data['mode'] === 'cached' ? { narrative: null } : { narrative: null, problem: 'unverified' },
      },
    });
    await page.click('Explain with Clerk', section(page) as HTMLElement);
    await page.stable(10);
    expect(page.text(section(page)?.querySelector('[data-testid="narrative-problem"]'))).toContain(
      'Clerk’s explanation didn’t match the figures, so it isn’t shown.',
    );
  });

  it('is hidden when the practice has turned it off, and explains why when Explain is refused', async () => {
    const off = await open('/insights?period=this_fy', {
      flags: CLERK,
      callables: {
        'clerk-explainInsights': () => {
          throw {
            code: 'functions/failed-precondition',
            details: { code: 'CLERK_DISABLED', switch: 'org.settings.clerk.features.insightsNarrative' },
          };
        },
      },
    });
    expect(section(off)).toBeNull();
    cleanUpOverlays();
    TestBed.resetTestingModule();

    const page = await open('/insights?period=this_fy', {
      flags: CLERK,
      callables: {
        'clerk-explainInsights': (data: Seed) => {
          if (data['mode'] === 'cached') return { narrative: null };
          throw {
            code: 'functions/failed-precondition',
            details: { code: 'CLERK_DISABLED', switch: 'org.byok.missing' },
          };
        },
      },
    });
    await page.click('Explain with Clerk', section(page) as HTMLElement);
    await page.stable(10);
    expect(page.text(section(page)?.querySelector('[data-testid="narrative-problem"]'))).toContain(
      'Clerk needs your practice’s Anthropic API key.',
    );
  });

  it('is not shown to read-only members', async () => {
    const page = await open('/insights?period=this_fy', {
      flags: CLERK,
      callables: explaining(),
      session: READONLY,
    });
    expect(section(page)).toBeNull();
  });
});
