import { MT_TODAY } from '@materia/ui';

import {
  ADMIN,
  cleanUpOverlays,
  matterDoc,
  MATTER,
  meta,
  ME,
  openMatter,
  PARALEGAL,
  PRIYA,
  READONLY,
  type FakeCallable,
} from '../matter-detail/testing';

/** The Time and billing screen (BILL-03). Fictional data only. */

afterEach(cleanUpOverlays);

const ORG = 'org-harbour-vine';
const CHEN = `orgs/${ORG}/matters/m-chen`;
const DANIEL = 'user-daniel';
type Page = Awaited<ReturnType<typeof openMatter>>;
type Seed = Record<string, unknown>;

const SEEN = new Date('2026-10-03T00:00:00Z');

function entryDoc(matterId: string, data: Seed = {}): Seed {
  return {
    orgId: ORG,
    matterId,
    uid: ME,
    date: '2026-10-01',
    minutes: 60,
    units: 10,
    rateCents: 44000,
    amountCents: 44000,
    narrative: 'Perusing and considering the will',
    billable: true,
    status: 'draft',
    source: 'manual',
    wipCountedCents: 44000,
    deletedAt: null,
    ...meta,
    updatedAt: SEEN,
    ...data,
  };
}

const pathOf = (matterId: string, id: string) => `orgs/${ORG}/matters/${matterId}/timeEntries/${id}`;

/**
 * The practice: a 7-hour daily target, Jordan (lawyer, $200,000 FY2026–27 budget) supervising
 * Daniel (paralegal), and Priya (owner). Jordan has two drafts this week on two matters, a final
 * entry and a billed one in July; Daniel has two drafts and one sent back; Priya one draft.
 */
function practice(fs: Page['firestore']): void {
  fs.set(`orgs/${ORG}`, {
    name: 'Harbour & Vine Legal',
    timezone: 'Australia/Melbourne',
    billing: { unitMinutes: 6, rounding: 'up', defaultRateCents: 30000, gstRegistered: true, dailyTargetMinutes: 420 },
  });
  const member = (uid: string, displayName: string, role: string, data: Seed = {}) =>
    fs.set(`orgs/${ORG}/members/${uid}`, {
      displayName,
      email: `${uid}@example.test`,
      role,
      status: 'active',
      ...data,
    });
  member(ME, 'Jordan Price', 'lawyer', { budgets: { '2026': 20_000_000 }, supervisorUid: PRIYA });
  member(PRIYA, 'Priya Shah', 'owner');
  member(DANIEL, 'Daniel Kim', 'paralegal', { supervisorUid: ME });
  fs.set(CHEN, matterDoc({ number: 'M-2026-0150', title: 'Chen family trust', type: 'trust' }));
  fs.set(pathOf('m-whitfield', 'te-1'), entryDoc('m-whitfield'));
  fs.set(
    pathOf('m-chen', 'te-2'),
    entryDoc('m-chen', {
      date: '2026-10-02',
      minutes: 30,
      units: 5,
      amountCents: 22000,
      narrative: 'Letter to trustee',
    }),
  );
  fs.set(
    pathOf('m-whitfield', 'te-3'),
    entryDoc('m-whitfield', {
      date: '2026-09-29',
      minutes: 120,
      units: 20,
      amountCents: 88000,
      narrative: 'Drafting the inventory',
      status: 'final',
    }),
  );
  fs.set(
    pathOf('m-whitfield', 'te-old'),
    entryDoc('m-whitfield', {
      date: '2026-07-02',
      narrative: 'Initial attendance',
      status: 'billed',
      invoiceId: 'inv-1',
    }),
  );
  const daniel = { uid: DANIEL, rateCents: 20000 };
  fs.set(
    pathOf('m-whitfield', 'te-d1'),
    entryDoc('m-whitfield', {
      ...daniel,
      date: '2026-10-02',
      minutes: 36,
      units: 6,
      amountCents: 12000,
      narrative: 'Searching the register',
    }),
  );
  fs.set(
    pathOf('m-chen', 'te-d2'),
    entryDoc('m-chen', {
      ...daniel,
      date: '2026-10-01',
      minutes: 12,
      units: 2,
      amountCents: 4000,
      narrative: 'Filing',
    }),
  );
  fs.set(
    pathOf('m-chen', 'te-d3'),
    entryDoc('m-chen', {
      ...daniel,
      narrative: 'Phone call',
      rejection: { note: 'Which call?', by: ME, at: SEEN },
    }),
  );
  fs.set(pathOf('m-chen', 'te-p1'), entryDoc('m-chen', { uid: PRIYA, narrative: 'Reviewing the deed' }));
}

/**
 * The review callables as the server runs them: an entry whose `updatedAt` isn't the one the
 * caller saw is left alone and reported in `conflicts`.
 */
function reviewCallables(): Record<string, FakeCallable> {
  const review =
    (patch: (entry: Seed, data: Seed) => Seed): FakeCallable =>
    (data, fs) => {
      const updated: string[] = [];
      const conflicts: string[] = [];
      const seen = (data['expectedUpdatedAt'] ?? {}) as Record<string, number>;
      for (const id of data['entryIds'] as string[]) {
        const path = pathOf(String(data['matterId']), id);
        const entry = fs.get(path) as Seed | undefined;
        if (!entry) continue;
        if (seen[id] !== undefined && seen[id] !== (entry['updatedAt'] as Date).getTime()) {
          conflicts.push(id);
          continue;
        }
        fs.set(path, { ...entry, ...patch(entry, data), updatedAt: new Date('2026-10-04T01:00:00Z') });
        updated.push(id);
      }
      return { updated, skipped: [], conflicts };
    };
  return {
    'time-setStatus': review((_entry, data) => ({ status: data['status'] })),
    'time-writeDown': review((entry, data) =>
      data['writeOff']
        ? { status: 'written_off', writeDown: { reason: data['reason'] } }
        : {
            status: 'final',
            units: data['newUnits'] ?? entry['units'],
            writeDown: { reason: data['reason'], originalUnits: entry['units'] },
          },
    ),
    'time-reject': review((_entry, data) => ({ rejection: { note: data['note'], by: ME, at: new Date() } })),
    'billing-wip': () => WIP,
    'time-exportCsv': () => ({ csv: 'Date,Matter\r\n2026-09-29,M-2026-0142\r\n', rows: 1, truncated: false }),
  };
}

const fee = { arrangement: 'hourly', amountCents: null, capCents: null, rateOverrideCents: null };
const WIP = {
  totalCents: 154000,
  truncated: false,
  rows: [
    {
      matterId: 'm-whitfield',
      number: 'M-2026-0142',
      title: 'Estate of Margaret Whitfield',
      type: 'probate',
      status: 'open',
      responsibleUid: ME,
      privileged: false,
      fee: { ...fee, arrangement: 'fixed', amountCents: 450000 },
      timeCents: 88000,
      disbursementCents: 22000,
      totalCents: 110000,
      entries: 1,
      oldestDate: '2026-09-29',
      ageDays: 5,
      budgetPct: 84,
      lastInvoicedOn: '2026-07-31',
      closed: false,
    },
    {
      matterId: 'm-chen',
      number: 'M-2026-0150',
      title: 'Chen family trust',
      type: 'trust',
      status: 'closed',
      responsibleUid: PRIYA,
      privileged: false,
      fee,
      timeCents: 44000,
      disbursementCents: 0,
      totalCents: 44000,
      entries: 1,
      oldestDate: '2026-07-20',
      ageDays: 76,
      budgetPct: null,
      lastInvoicedOn: null,
      closed: true,
    },
  ],
};

const open = (url = '/billing', options: Parameters<typeof openMatter>[1] = {}) =>
  openMatter(url, { configure: practice, callables: reviewCallables(), ...options });

const stat = (page: Page, id: string) => page.text(page.body.querySelector(`[data-testid="${id}"]`));
const tabs = (page: Page) => [...page.body.querySelectorAll('[role="tab"]')].map((tab) => page.text(tab));
const stored = (page: Page, matterId: string, id: string) => page.firestore.get(pathOf(matterId, id)) as Seed;

/** The person groups on the Approvals tab: name and entry narratives. */
const people = (page: Page) =>
  [...page.body.querySelectorAll('mt-approvals-tab .person')].map((group) => ({
    name: page.text(group.querySelector('h3')),
    entries: [...group.querySelectorAll('mt-time-entry .tt')].map((row) => page.text(row)),
  }));

/** Picks the option starting with `text` in the native select labelled `label`. */
async function choose(page: Page, label: string, text: string): Promise<void> {
  const host = [...page.body.querySelectorAll('mt-select')].find((field) =>
    field.querySelector('.mt-label')?.textContent?.trim().startsWith(label),
  );
  const option = [...(host?.querySelectorAll('option') ?? [])].find((o) => page.text(o).startsWith(text));
  if (!option) throw new Error(`No option "${text}" in "${label}"`);
  await page.fill(label, option.value);
}

async function menuAction(page: Page, narrative: string, action: string): Promise<void> {
  await page.click(`More actions for ${narrative}`);
  await page.click(action);
}

describe('time and billing screen', () => {
  it('shows my week against the daily target, the stats and the FY budget', async () => {
    const page = await open();
    expect(page.text(page.body.querySelector('mt-billing-page h1'))).toBe('Time and billing');
    expect(stat(page, 'billing-subtitle')).toBe('October 2026 · FY2026–27 budget $200,000.00');
    expect(tabs(page)).toEqual(['My time', 'WIP', expect.stringMatching(/^Approvals\s*2$/)]);

    // This week: 1h + 30m drafts and 2h final = 3.5 h of a 35-hour target, all billable.
    expect(stat(page, 'stat-week')).toContain('3.5');
    expect(stat(page, 'stat-week')).toContain('of 35 h');
    expect(stat(page, 'stat-billable')).toContain('100');
    expect(stat(page, 'stat-wip')).toContain('$1,540.00');
    expect(stat(page, 'stat-wip')).toContain('2 matters · 1 closed');

    // FY2026–27: recorded $1,980 (drafts, final and billed) of $200,000, $440 billed.
    expect(stat(page, 'fy-budget')).toContain('FY2026–27 budget');
    const value = page.body.querySelector('[data-testid="fy-budget"] .fy-value');
    expect([...(value?.children ?? [])].map((part) => page.text(part))).toEqual([
      '$1,980.00',
      'recorded of $200,000.00',
    ]);
    expect(stat(page, 'fy-caption')).toBe('1% recorded · $440.00 billed (0%) · 26% of the year gone');
    expect(stat(page, 'fy-budget')).toContain('Behind');

    // The strip: Monday to Sunday, weekdays against 7 hours.
    expect(stat(page, 'week-label')).toBe('28 Sept – 4 Oct 2026');
    const strip = [...page.body.querySelectorAll<HTMLElement>('mt-my-time .day')];
    expect(strip.map((day) => day.dataset['date'])).toEqual([
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
    ]);
    expect(strip[1]?.getAttribute('aria-label')).toBe('Tue 29 Sept: 2 of 7 hours');
    expect(strip[6]?.querySelector('mt-progress')).toBeNull();
    expect(stat(page, 'week-summary')).toBe('3.5 of 35 h target · $1,540.00 billable');
    expect(page.body.querySelector('[data-testid="fy-boundary"]')).toBeNull();

    // Choosing a day shows only its entries.
    strip[3]?.click();
    await page.stable();
    const rows = [...page.body.querySelectorAll('mt-my-time mt-time-entry .tt')].map((row) => page.text(row));
    expect(rows).toEqual(['Perusing and considering the will']);
  });

  it('finalises the week with one call per matter, carrying the updatedAt I saw', async () => {
    const page = await open();
    expect(page.text(page.body.querySelector('mt-my-time .drafts'))).toContain('2 drafts this week to finalise.');
    await page.click('Finalise week');
    expect(page.text(page.dialog())).toContain('Finalise 2 entries?');
    await page.click('Finalise week', page.dialog() ?? page.body);
    const calls = page.calls('time-setStatus');
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          matterId: 'm-whitfield',
          entryIds: ['te-1'],
          status: 'final',
          expectedUpdatedAt: { 'te-1': SEEN.getTime() },
        }),
        expect.objectContaining({ matterId: 'm-chen', entryIds: ['te-2'], status: 'final' }),
      ]),
    );
    expect(calls).toHaveLength(2);
    expect(stored(page, 'm-whitfield', 'te-1')['status']).toBe('final');
    expect(stored(page, 'm-chen', 'te-2')['status']).toBe('final');
    expect(page.text()).toContain('Finalised 2 entries.');
    expect(page.body.querySelector('mt-my-time .drafts')).toBeNull();
  });

  it('marks where a new financial year starts in a week across 30 June, and counts the budget per year', async () => {
    const june = await open('/billing', { providers: [{ provide: MT_TODAY, useValue: () => '2026-06-30' }] });
    expect(stat(june, 'week-label')).toBe('29 June – 5 July 2026');
    const boundary = june.body.querySelector('[data-testid="fy-boundary"]');
    expect(june.text(boundary)).toBe('FY2026–27 starts');
    expect(boundary?.closest<HTMLElement>('.day')?.dataset['date']).toBe('2026-07-01');
    // On 30 June it's still FY2025–26, which has no budget; July's billed entry isn't counted.
    expect(stat(june, 'fy-budget')).toContain('FY2025–26 budget');
    expect(stat(june, 'fy-budget')).toContain('No budget set for this year');
    expect(stat(june, 'fy-budget')).toContain('$0.00');
    cleanUpOverlays();
  });

  it('counts the first day of the new year against the new budget', async () => {
    const july = await open('/billing', { providers: [{ provide: MT_TODAY, useValue: () => '2026-07-02' }] });
    expect(stat(july, 'fy-budget')).toContain('FY2026–27 budget');
    expect(stat(july, 'fy-caption')).toContain('$440.00 billed');
    expect(stat(july, 'fy-caption')).toContain('1% of the year gone');
  });

  it('shows a paralegal their drafts waiting for their supervisor, and notes sent back', async () => {
    const page = await openMatter('/billing?tab=approvals', {
      session: PARALEGAL,
      callables: reviewCallables(),
      configure: (fs) => {
        practice(fs);
        fs.set(pathOf('m-chen', 'te-2'), {
          ...stored({ firestore: fs } as Page, 'm-chen', 'te-2'),
          rejection: { note: 'Say which letter', by: PRIYA, at: SEEN },
        });
      },
    });
    // No WIP or Approvals for a paralegal; ?tab=approvals falls back to My time.
    expect(tabs(page)).toEqual(['My time']);
    expect(page.body.querySelector('[data-testid="stat-wip"]')).toBeNull();
    expect(page.text(page.body.querySelector('mt-my-time .drafts'))).toContain(
      '2 drafts this week waiting for approval from Priya Shah.',
    );
    expect(page.buttons('Finalise week')).toHaveLength(0);
    expect(page.text(page.body.querySelector('[data-testid="sent-back"]'))).toContain(
      'Priya Shah sent back “Letter to trustee”: Say which letter',
    );
  });

  it('lists WIP by matter, flags closed matters, filters and exports', async () => {
    const page = await open('/billing?tab=wip');
    const rows = () =>
      [...page.body.querySelectorAll('mt-wip-tab tbody tr')].map((row) =>
        [...row.querySelectorAll('td')].map((cell) => page.text(cell)),
      );
    expect(rows()).toEqual([
      [
        'M-2026-0142',
        expect.stringContaining('Estate of Margaret Whitfield'),
        expect.stringContaining('84%'),
        '5 days',
        '31 July 2026',
        '$1,100.00',
        'Near estimate',
      ],
      [
        'M-2026-0150',
        expect.stringContaining('Chen family trust'),
        'No estimate',
        expect.stringContaining('76'),
        'Never',
        '$440.00',
        'Matter closedUnbilled 76 days',
      ],
    ]);
    expect(page.text(page.body.querySelector('[data-testid="closed-wip"]'))).toContain(
      '1 closed matter still has unbilled work',
    );
    expect(stat(page, 'wip-total')).toBe('2 matters · $1,540.00');

    await choose(page, 'Matter type', 'Testamentary trust');
    expect(rows().map((row) => row[0])).toEqual(['M-2026-0150']);
    expect(stat(page, 'wip-total')).toBe('1 matter · $440.00');

    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fictional');
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);
    const saved = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    try {
      await page.click('Export');
      expect(page.calls('time-exportCsv')).toEqual([
        expect.objectContaining({ from: '2000-01-01', to: '2026-10-04', unbilledOnly: true, matterType: 'trust' }),
      ]);
      expect(created).toHaveBeenCalled();
      expect(saved).toHaveBeenCalled();
    } finally {
      created.mockRestore();
      revoked.mockRestore();
      saved.mockRestore();
    }

    // A row opens the matter's Time tab.
    page.body.querySelector<HTMLElement>('mt-wip-tab tbody tr')?.click();
    await page.stable();
    expect(page.router.url).toBe('/matters/m-chen/time');
  });

  it('approves my supervisees’ drafts per person, and reports entries changed meanwhile', async () => {
    const server = reviewCallables();
    // Daniel edits the filing entry while I'm approving it.
    const setStatus: FakeCallable = (data, fs) => {
      const path = pathOf('m-chen', 'te-d2');
      if (data['matterId'] === 'm-chen') fs.set(path, { ...fs.get(path), updatedAt: new Date('2026-10-04T00:30:00Z') });
      return server['time-setStatus']?.(data, fs);
    };
    const page = await open('/billing?tab=approvals', { callables: { ...server, 'time-setStatus': setStatus } });
    // Daniel's two drafts; not his sent-back one, nor Priya's (not my team), nor mine.
    expect(people(page)).toEqual([{ name: 'Daniel Kim', entries: ['Filing', 'Searching the register'] }]);

    await page.click('Approve all');
    expect(page.calls('time-setStatus')).toHaveLength(2);
    expect(stored(page, 'm-whitfield', 'te-d1')['status']).toBe('final');
    expect(stored(page, 'm-chen', 'te-d2')['status']).toBe('draft');
    expect(page.text()).toContain('Approved 1 entry. 1 entry was changed by its author meanwhile: review it again.');
    expect(people(page)).toEqual([{ name: 'Daniel Kim', entries: ['Filing'] }]);
  });

  it('writes one entry down to fewer units with a reason', async () => {
    const page = await open('/billing?tab=approvals');
    await menuAction(page, 'Searching the register', 'Write down or off…');
    const dialog = () => page.dialog() ?? page.body;
    expect(page.text(page.dialog())).toContain('Write down this entry');
    await page.fill('New units', '4', dialog());
    expect(page.text(page.body.querySelector('[data-testid="write-down-preview"]'))).toBe('$120.00 becomes $80.00.');
    await page.fill('New units', '8', dialog());
    expect(page.text(page.dialog())).toContain('lower');
    await page.fill('New units', '4', dialog());
    await page.fill('Reason', 'Over-researched for a simple search', dialog());
    await page.submit(page.dialog());
    expect(page.calls('time-writeDown')).toEqual([
      expect.objectContaining({
        matterId: 'm-whitfield',
        entryIds: ['te-d1'],
        newUnits: 4,
        reason: 'Over-researched for a simple search',
        expectedUpdatedAt: { 'te-d1': SEEN.getTime() },
      }),
    ]);
    expect(stored(page, 'm-whitfield', 'te-d1')).toMatchObject({ status: 'final', units: 4 });
    expect(people(page)).toEqual([{ name: 'Daniel Kim', entries: ['Filing'] }]);
  });

  it('writes an entry off, and sends one back with a note', async () => {
    const page = await open('/billing?tab=approvals');
    await menuAction(page, 'Filing', 'Write down or off…');
    await page.click('Write off', page.dialog() ?? page.body);
    expect(page.text(page.body.querySelector('[data-testid="write-down-preview"]'))).toBe('$40.00 comes out of WIP.');
    await page.fill('Reason', 'Administrative work', page.dialog() ?? page.body);
    await page.submit(page.dialog());
    expect(page.calls('time-writeDown')).toEqual([
      expect.objectContaining({ entryIds: ['te-d2'], writeOff: true, reason: 'Administrative work' }),
    ]);
    expect(stored(page, 'm-chen', 'te-d2')['status']).toBe('written_off');

    await menuAction(page, 'Searching the register', 'Send back…');
    expect(page.text(page.dialog())).toContain('Daniel Kim sees your note');
    await page.submit(page.dialog());
    expect(page.text(page.dialog())).toContain('Add a note so they know what to change.');
    await page.fill('Note', 'Which register?', page.dialog() ?? page.body);
    await page.submit(page.dialog());
    expect(page.calls('time-reject')).toEqual([
      expect.objectContaining({ matterId: 'm-whitfield', entryIds: ['te-d1'], note: 'Which register?' }),
    ]);
    expect(stored(page, 'm-whitfield', 'te-d1')['status']).toBe('draft');
  });

  it('lets an owner switch from their team to everyone’s drafts', async () => {
    const page = await open('/billing?tab=approvals', { session: ADMIN });
    // Priya supervises Jordan.
    expect(people(page).map((person) => person.name)).toEqual(['Jordan Price']);
    expect(people(page)[0]?.entries).toEqual(['Perusing and considering the will', 'Letter to trustee']);
    await page.click('Everyone');
    expect(people(page).map((person) => person.name)).toEqual(['Daniel Kim', 'Jordan Price']);
  });

  it('keeps the screen to My time for read-only members', async () => {
    const page = await open('/billing', { session: READONLY });
    expect(tabs(page)).toEqual(['My time']);
    expect(page.buttons('Record time')).toHaveLength(0);
    expect(page.calls('billing-wip')).toHaveLength(0);
    expect(page.firestore.get(MATTER)).toBeDefined();
  });
});
