import { planWriteDown, type WriteDownChange } from '@materia/domain';

import { cleanUpOverlays, MATTER, meta, ME, openMatter, PARALEGAL, PRIYA, READONLY } from '../matter-detail/testing';

/** The matter's Time tab (BILL-01). Fictional data only. */

afterEach(cleanUpOverlays);

const URL = '/matters/m-whitfield/time';
const ORG = 'org-harbour-vine';
type Page = Awaited<ReturnType<typeof openMatter>>;
type Seed = Record<string, unknown>;

function entryDoc(data: Seed = {}): Seed {
  return {
    orgId: ORG,
    matterId: 'm-whitfield',
    uid: ME,
    date: '2026-10-04',
    minutes: 18,
    units: 3,
    rateCents: 44000,
    amountCents: 13200,
    narrative: 'Perusing and considering the will',
    billable: true,
    status: 'draft',
    source: 'manual',
    wipCountedCents: 13200,
    deletedAt: null,
    ...meta,
    ...data,
  };
}

/** The practice's billing settings, my rate, and entries on two days (one from Priya, one final). */
function practice(fs: Page['firestore']): void {
  fs.set(`orgs/${ORG}`, {
    name: 'Harbour & Vine Legal',
    timezone: 'Australia/Melbourne',
    billing: { unitMinutes: 6, rounding: 'up', defaultRateCents: 30000, gstRegistered: true },
  });
  fs.set(`orgs/${ORG}/members/${ME}`, {
    displayName: 'Jordan Price',
    email: `${ME}@example.test`,
    role: 'lawyer',
    status: 'active',
    defaultRateCents: 44000,
    rates: [{ effectiveFrom: '2026-07-01', rateCents: 44000 }],
  });
  fs.set(`${MATTER}/timeEntries/te-1`, entryDoc());
  fs.set(
    `${MATTER}/timeEntries/te-2`,
    entryDoc({
      date: '2026-10-02',
      minutes: 60,
      units: 10,
      amountCents: 44000,
      narrative: 'Attendance on executor',
      uid: PRIYA,
    }),
  );
  fs.set(
    `${MATTER}/timeEntries/te-3`,
    entryDoc({
      date: '2026-10-02',
      minutes: 6,
      units: 1,
      amountCents: 4400,
      narrative: 'Email to bank',
      status: 'final',
    }),
  );
}

/** The time-setStatus callable as the server runs it (drafts ⇄ final). */
const setStatus = (data: Seed, fs: Page['firestore']) => {
  const updated: string[] = [];
  for (const id of data['entryIds'] as string[]) {
    const path = `${MATTER}/timeEntries/${id}`;
    const entry = fs.get(path);
    if (!entry) continue;
    fs.set(path, { ...entry, status: data['status'] });
    updated.push(id);
  }
  return { updated, skipped: [] };
};

/** The time-writeDown callable as the server runs it (fewer units, or written off). */
const writeDown = (data: Seed, fs: Page['firestore']) => {
  const updated: string[] = [];
  for (const id of data['entryIds'] as string[]) {
    const path = `${MATTER}/timeEntries/${id}`;
    const entry = fs.get(path) as (Seed & Parameters<typeof planWriteDown>[0]) | undefined;
    const change = (data['writeOff'] ? { writeOff: true } : { newUnits: data['newUnits'] }) as WriteDownChange;
    const { plan } = entry
      ? planWriteDown(entry, change, { by: ME, reason: String(data['reason']), unitMinutes: 6 })
      : {};
    if (!plan) continue;
    fs.set(path, { ...entry, ...plan });
    updated.push(id);
  }
  return { updated, skipped: [], conflicts: [] };
};

const open = (options: Parameters<typeof openMatter>[1] = {}) =>
  openMatter(URL, {
    configure: practice,
    callables: { 'time-setStatus': setStatus, 'time-writeDown': writeDown },
    ...options,
  });

const days = (page: Page) =>
  [...page.body.querySelectorAll('mt-matter-time .day')].map((day) => ({
    heading: [...(day.querySelector('h3')?.children ?? [])].map((part) => page.text(part)).join(' '),
    rows: [...day.querySelectorAll('mt-time-entry .tt')].map((row) => page.text(row)),
  }));

const addRow = (page: Page) => page.body.querySelector<HTMLElement>('mt-matter-time .add') as HTMLElement;

/** Entries created in the test, as stored. */
const entries = (page: Page) =>
  page.firestore.writes
    .filter((write) => write.op === 'create' && write.path.includes('/timeEntries/'))
    .map((write) => page.firestore.get(write.path) as Seed);

/** Types a narrative (the phrase-library field). */
async function narrate(page: Page, text: string, root: HTMLElement): Promise<void> {
  const input = root.querySelector<HTMLInputElement>('mt-narrative-field input') as HTMLInputElement;
  input.value = text;
  input.dispatchEvent(new Event('input'));
  await page.stable();
}

describe('matter time tab', () => {
  it('groups entries by day, newest first, with day and matter totals', async () => {
    const page = await open();
    expect(page.text(page.body.querySelector('mt-matter-time h2'))).toBe('Time');
    expect(days(page)).toEqual([
      { heading: 'Today 0.3 h · $132.00', rows: ['Perusing and considering the will'] },
      {
        heading: expect.stringContaining('Fri 2 Oct 1.1 h · $484.00'),
        rows: ['Attendance on executor', 'Email to bank'],
      },
    ]);
    expect(page.text(page.body.querySelector('[data-testid="time-totals"]'))).toBe('1.4 h · $616.00');
    // Who and the status (final) on each row.
    const rows = [...page.body.querySelectorAll('mt-time-entry .ts')].map((row) => page.text(row));
    expect(rows).toEqual(['Jordan Price · 18m', 'Priya Shah · 1h 00m', 'Jordan Price · 6m · Final']);
  });

  it('records time from the add row: `t` focuses it, 0.25 is 15 minutes and 3 units, Enter saves', async () => {
    const page = await open();
    await page.press('t');
    const duration = addRow(page).querySelector<HTMLInputElement>('.duration input');
    expect(document.activeElement).toBe(duration);
    expect(addRow(page).querySelector<HTMLInputElement>('.date input')?.value).toBe('04/10/2026');
    await page.fill('Time', '0.25', addRow(page));
    // The preview: 3 units at my rate.
    expect(page.text(addRow(page))).toContain('0.3 h');
    expect(page.text(addRow(page))).toContain('$132.00');
    await narrate(page, 'Letter to beneficiaries', addRow(page));
    await page.submit(addRow(page));
    const added = entries(page).find((entry) => entry['narrative'] === 'Letter to beneficiaries');
    expect(added).toMatchObject({
      uid: ME,
      date: '2026-10-04',
      minutes: 15,
      units: 3,
      rateCents: 44000,
      amountCents: 13200,
      billable: true,
      status: 'draft',
      source: 'manual',
      wipCountedCents: 0,
    });
    // The row starts again for the next entry, focused.
    expect(addRow(page).querySelector<HTMLInputElement>('.duration input')?.value).toBe('');
    expect(days(page)[0]?.rows).toContain('Letter to beneficiaries');
  });

  it('types / for a phrase: arrows choose, Enter inserts it', async () => {
    const page = await open();
    const input = addRow(page).querySelector<HTMLInputElement>('mt-narrative-field input') as HTMLInputElement;
    input.focus();
    input.value = 'Draft /attend';
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event('input'));
    await page.stable();
    const options = [...addRow(page).querySelectorAll('[role="option"]')].map((option) => page.text(option));
    expect(options.length).toBeGreaterThan(1);
    expect(options.every((option) => option.toLowerCase().includes('attend'))).toBe(true);
    await page.press('ArrowDown', {}, input);
    await page.press('Enter', {}, input);
    // The phrase replaces `/attend`, ready for the rest of the sentence.
    expect(input.value).toBe(`Draft ${options[1]?.replace(/…$/, '')} `);
    expect(addRow(page).querySelector('[role="listbox"]')).toBeNull();
  });

  it('accepts 18m, 1h 12m and 1:12, and rejects zero', async () => {
    const page = await open();
    for (const [text, minutes] of [
      ['18m', 18],
      ['1h 12m', 72],
      ['1:12', 72],
    ] as const) {
      await page.fill('Time', text, addRow(page));
      await narrate(page, `Fictional ${text}`, addRow(page));
      await page.submit(addRow(page));
      expect(entries(page).find((entry) => entry['narrative'] === `Fictional ${text}`)?.['minutes']).toBe(minutes);
    }
    await page.fill('Time', '0', addRow(page));
    await page.submit(addRow(page));
    expect(page.text(addRow(page))).toContain('Enter a duration of at least a minute');
  });

  it('asks before saving more than 24 hours on a day', async () => {
    const page = await open();
    await page.fill('Time', '23:50', addRow(page));
    await page.submit(addRow(page));
    // 18 minutes already today: 24h 08m.
    expect(page.text(addRow(page))).toContain('That makes 24h 08m on today, over 24 hours. Save anyway?');
    expect(entries(page)).toHaveLength(0);
    expect(page.buttons('Save anyway', addRow(page))).toHaveLength(1);
    await page.submit(addRow(page));
    expect(entries(page)).toHaveLength(1);
  });

  it('edits and deletes my drafts from the row menu; final entries have no edit', async () => {
    const page = await open();
    await page.click('More actions for Perusing and considering the will');
    await page.click('Edit');
    const form = page.body.querySelector<HTMLElement>('.rows mt-time-entry-form') as HTMLElement;
    expect(form.querySelector<HTMLInputElement>('.duration input')?.value).toBe('18m');
    await page.fill('Time', '30m', form);
    await page.submit(form);
    expect(page.firestore.get(`${MATTER}/timeEntries/te-1`)).toMatchObject({
      minutes: 30,
      units: 5,
      amountCents: 22000,
    });

    await page.click('More actions for Email to bank');
    expect(page.buttons('Edit')).toHaveLength(0);
    expect(page.buttons('Back to draft')).toHaveLength(1);
    await page.press('Escape');

    await page.click('More actions for Perusing and considering the will');
    await page.click('Delete');
    await page.click('Delete entry', page.dialog() as HTMLElement);
    expect(page.firestore.get(`${MATTER}/timeEntries/te-1`)?.['deletedAt']).toBeTruthy();
    expect(days(page)[0]?.heading).toContain('Fri 2 Oct');
  });

  it('marks a draft final through time-setStatus (approvers only)', async () => {
    const page = await open();
    await page.click('More actions for Attendance on executor');
    await page.click('Mark final');
    expect(page.calls('time-setStatus')).toEqual([
      expect.objectContaining({ matterId: 'm-whitfield', entryIds: ['te-2'], status: 'final' }),
    ]);
    expect(page.firestore.get(`${MATTER}/timeEntries/te-2`)?.['status']).toBe('final');
  });

  it('writes an approved entry off from its row menu (approvers only, BILL-07b)', async () => {
    const page = await open();
    await page.click('More actions for Perusing and considering the will');
    // Drafts aren't written down here; they're approved or edited first.
    expect(page.buttons('Write down or off…')).toHaveLength(0);
    await page.press('Escape');

    await page.click('More actions for Email to bank');
    await page.click('Write down or off…');
    expect(page.text(page.dialog())).toContain('Write down this entry');
    await page.click('Write off', page.dialog() ?? page.body);
    await page.fill('Reason', 'Administrative work', page.dialog() ?? page.body);
    await page.submit(page.dialog());
    expect(page.calls('time-writeDown')).toEqual([
      expect.objectContaining({
        matterId: 'm-whitfield',
        entryIds: ['te-3'],
        writeOff: true,
        reason: 'Administrative work',
      }),
    ]);
    expect(page.firestore.get(`${MATTER}/timeEntries/te-3`)?.['status']).toBe('written_off');
  });

  it('a paralegal edits only their own drafts and can’t approve', async () => {
    const page = await open({ session: PARALEGAL });
    // Not theirs: no menu at all.
    expect(page.buttons('More actions for Attendance on executor')).toHaveLength(0);
    expect(addRow(page)).not.toBeNull();
  });

  it('filters by person', async () => {
    const page = await open();
    // The native picker's options are Everyone, Jordan Price, Priya Shah.
    await page.fill('Person', '2');
    expect(days(page)).toEqual([{ heading: expect.stringContaining('Fri 2 Oct'), rows: ['Attendance on executor'] }]);
    expect(page.text(page.body.querySelector('[data-testid="time-totals"]'))).toBe('1.0 h · $440.00');
  });

  it('a read-only member sees the time but records none', async () => {
    const page = await open({ session: READONLY });
    expect(addRow(page)).toBeNull();
    expect(days(page)).toHaveLength(2);
    expect(page.buttons('More actions for Perusing and considering the will')).toHaveLength(0);
  });

  it('on a fixed-fee matter, new time starts not billable and shows “Fixed fee”', async () => {
    const page = await open({ matter: { fee: { arrangement: 'fixed', amountCents: 165000, history: [] } } });
    expect(addRow(page).querySelector('.billable button')?.getAttribute('aria-checked')).toBe('false');
    await page.fill('Time', '6m', addRow(page));
    expect(page.text(addRow(page))).toContain('Fixed fee');
  });
});
