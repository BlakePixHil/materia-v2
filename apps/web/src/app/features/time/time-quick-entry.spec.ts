import { cleanUpOverlays, MATTER, ME, meta, openMatter, READONLY } from '../matter-detail/testing';

/** Quick time entry from anywhere (BILL-01): `t` and ⌘K "Log time". Fictional data only. */

afterEach(cleanUpOverlays);

const ORG = 'org-harbour-vine';
type Page = Awaited<ReturnType<typeof openMatter>>;
type Seed = Record<string, unknown>;

function practice(fs: Page['firestore']): void {
  fs.set(`orgs/${ORG}`, {
    name: 'Harbour & Vine Legal',
    billing: { unitMinutes: 6, rounding: 'up', defaultRateCents: 30000, gstRegistered: true },
  });
  fs.set(`orgs/${ORG}/members/${ME}`, {
    displayName: 'Jordan Price',
    email: `${ME}@example.test`,
    role: 'lawyer',
    status: 'active',
    rates: [{ effectiveFrom: '2026-07-01', rateCents: 44000 }],
  });
  fs.set(`users/${ME}/recent/m-whitfield`, {
    orgId: ORG,
    kind: 'matter',
    matterId: 'm-whitfield',
    expireAt: new Date('2027-01-01T00:00:00Z'),
    ...meta,
  });
}

const created = (page: Page) =>
  page.firestore.writes
    .filter((write) => write.op === 'create' && write.path.includes('/timeEntries/'))
    .map((write) => ({ path: write.path, ...(page.firestore.get(write.path) as Seed) }));

async function narrate(page: Page, text: string): Promise<void> {
  const input = page.dialog()?.querySelector<HTMLInputElement>('mt-narrative-field input') as HTMLInputElement;
  input.value = text;
  input.dispatchEvent(new Event('input'));
  await page.stable();
}

/** Waits for the lazily loaded dialog. */
async function opened(page: Page): Promise<HTMLElement> {
  for (let i = 0; i < 20 && !page.dialog(); i++) await page.stable(10);
  await page.stable();
  return page.dialog() as HTMLElement;
}

describe('quick time entry', () => {
  it('`t` on a matter logs time on it: duration focused, Enter saves', async () => {
    const page = await openMatter('/matters/m-whitfield/overview', { configure: practice });
    await page.press('t');
    const dialog = await opened(page);
    expect(page.text(dialog)).toContain('Log time');
    expect(page.text(dialog.querySelector('.picked'))).toContain('M-2026-0142');
    await page.stable(10);
    expect(document.activeElement).toBe(dialog.querySelector('.duration input'));
    await page.fill('Time', '1:12', dialog);
    await narrate(page, 'Attendance on executor');
    await page.submit(dialog.querySelector('mt-time-entry-form'));
    expect(created(page)).toEqual([
      expect.objectContaining({
        path: expect.stringContaining(`${MATTER}/timeEntries/`),
        minutes: 72,
        units: 12,
        amountCents: 52800,
        narrative: 'Attendance on executor',
        status: 'draft',
      }),
    ]);
    expect(page.dialog()).toBeNull();
  });

  it('from anywhere, picks a recent matter first', async () => {
    const page = await openMatter('/matters', { configure: practice });
    await page.press('t');
    const dialog = await opened(page);
    expect(dialog.querySelector('.picked')).toBeNull();
    expect(page.text(dialog.querySelector('[aria-label="Recent matters"]'))).toContain('M-2026-0142');
    await page.click('M-2026-0142', dialog);
    await page.stable(10);
    await page.fill('Time', '18m', dialog);
    await narrate(page, 'Letter to the bank');
    await page.submit(dialog.querySelector('mt-time-entry-form'));
    expect(created(page)).toEqual([expect.objectContaining({ minutes: 18, units: 3, amountCents: 13200 })]);
  });

  it('⌘K “Log time” opens it', async () => {
    const page = await openMatter('/matters', { configure: practice });
    await page.press('k', { ctrlKey: true });
    await vi.waitFor(() => expect(document.querySelector('input[role="combobox"]')).not.toBeNull());
    const input = document.querySelector<HTMLInputElement>('input[role="combobox"]') as HTMLInputElement;
    input.value = 'log time';
    input.dispatchEvent(new Event('input'));
    await page.stable();
    expect(document.querySelector('[role="option"]')?.textContent).toContain('Log time');
    await page.press('Enter', {}, input);
    await page.stable(50);
    await vi.waitFor(() => expect(page.text(page.dialog())).toContain('Record time on a matter.'));
  });

  it('a read-only member gets no quick entry', async () => {
    const page = await openMatter('/matters/m-whitfield/overview', { configure: practice, session: READONLY });
    await page.press('t');
    await page.stable(20);
    expect(page.dialog()).toBeNull();
  });
});
