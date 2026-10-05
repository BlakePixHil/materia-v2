import { cleanUpOverlays, MATTER, ME, noteDoc, openMatter, PRIYA, READONLY } from './testing';

/** The Activity tab and the Overview's pinned notes and latest activity (CORE-13). Fictional data only. */

afterEach(cleanUpOverlays);

type Page = Awaited<ReturnType<typeof openMatter>>;

/** 30 activity lines, a minute apart, alternating between Jordan and Priya. */
function seedActivity(fs: Page['firestore']): void {
  for (let n = 1; n <= 30; n++) {
    fs.set(`${MATTER}/activity/b${String(n).padStart(2, '0')}`, {
      kind: n % 2 ? 'note.created' : 'task.completed',
      summary: n % 2 ? 'Added a note' : `Completed “Task ${n}”`,
      actorUid: n % 2 ? ME : PRIYA,
      at: new Date(Date.UTC(2026, 9, 4, 0, n)),
      refs: {},
    });
  }
}

const titles = (page: Page) =>
  [...page.body.querySelectorAll('mt-matter-activity .mt-tl .tt')].map((title) =>
    page.text(title).replace(/^\w+: /, ''),
  );

describe('matter activity tab', () => {
  it('lists the feed newest first with names, 25 at a time', async () => {
    const page = await openMatter('/matters/m-whitfield/activity', { configure: seedActivity });
    await page.stable(10);
    expect(page.text(page.body.querySelector('mt-matter-activity h2'))).toBe('Activity');
    expect(titles(page)).toHaveLength(25);
    expect(titles(page).slice(0, 2)).toEqual(['Priya Shah completed “Task 30”', 'Jordan Price added a note']);
    // Grouped by day: the seeded lines are on two days in Melbourne.
    expect(page.body.querySelectorAll('mt-matter-activity .mt-timeline-date').length).toBeGreaterThan(0);
    // The node says what kind of line it is.
    expect(page.body.querySelector('mt-matter-activity .mt-tl')?.getAttribute('data-kind')).toBe('activity');
    expect(page.body.querySelectorAll('mt-matter-activity .mt-tl[data-kind="note"]').length).toBeGreaterThan(0);

    await page.click('Load more');
    await page.stable(10);
    expect(titles(page)).toHaveLength(31);
    expect(titles(page).at(-1)).toBe('Priya Shah opened the matter');
    expect(page.buttons('Load more')).toEqual([]);
  });

  it('says so when there is nothing yet', async () => {
    const page = await openMatter('/matters/m-whitfield/activity', {
      session: READONLY,
      configure: (fs) => fs.delete(`${MATTER}/activity/a1`),
    });
    await page.stable(10);
    expect(page.text(page.body.querySelector('mt-matter-activity'))).toContain('Nothing yet');
  });
});

describe('matter overview (CORE-13)', () => {
  it('shows pinned notes on top and the three latest activity lines', async () => {
    const page = await openMatter('/matters/m-whitfield/overview', {
      configure: (fs) => {
        seedActivity(fs);
        fs.set(`${MATTER}/notes/n-1`, noteDoc('Will is in the **safe**. Ask @[user-priya].', { pinned: true }));
        fs.set(`${MATTER}/notes/n-2`, noteDoc('Not pinned'));
        fs.set(`${MATTER}/notes/n-3`, noteDoc('Pinned but deleted', { pinned: true, deletedAt: new Date() }));
      },
    });
    await page.stable(10);
    const overview = page.body.querySelector('mt-matter-overview') as HTMLElement;
    const pinned = overview.querySelector('.pinned') as HTMLElement;
    expect(overview.firstElementChild).toBe(pinned);
    expect(page.text(pinned)).toContain('Pinned notes');
    expect(page.text(pinned)).toContain('Will is in the safe. Ask @Priya Shah.');
    expect(page.text(pinned)).toContain('Jordan Price');
    expect(page.text(pinned)).not.toContain('Not pinned');
    expect(page.text(pinned)).not.toContain('Pinned but deleted');
    expect(pinned.querySelector('b')?.textContent).toBe('safe');

    const activity = overview.querySelector('[aria-labelledby="mt-ov-activity"]') as HTMLElement;
    const lines = [...activity.querySelectorAll('li .mt-grow')].map((line) => page.text(line));
    expect(lines).toEqual([
      'Priya Shah completed “Task 30”',
      'Jordan Price added a note',
      'Priya Shah completed “Task 28”',
    ]);
  });

  it('has no pinned notes card without pinned notes', async () => {
    const page = await openMatter('/matters/m-whitfield/overview');
    await page.stable(10);
    expect(page.body.querySelector('mt-matter-overview .pinned')).toBeNull();
  });
});
