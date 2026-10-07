import { TestBed } from '@angular/core/testing';

import type { InMemoryFirestore } from '@materia/data-access/repository';
import { DEFAULT_NOTIFICATION_PREFS } from '@materia/domain';

import { cleanUpOverlays, matterDoc, ME, meta, openMatter, ORG, READONLY } from '../../features/matter-detail/testing';
import { PINS_STORAGE_PREFIX, SIDEBAR_STORAGE_PREFIX } from '../../shell/app-shell';
import { CommandRegistry } from '../commands/command-registry';

/** Pinned matters in the sidebar (CORE-23), against the in-memory Firestore. Fictional data only. */

const USER = `users/${ME}`;
const ELSEWHERE = { 'org-other': ['m-elsewhere'] };

afterEach(() => {
  cleanUpOverlays();
  localStorage.removeItem(PINS_STORAGE_PREFIX + ME);
  localStorage.removeItem(SIDEBAR_STORAGE_PREFIX + ME);
});

/** My profile with these pins in the practice, plus the other matters they point at. */
function seedPins(ids: string[]) {
  return (fs: InMemoryFirestore) => {
    fs.set(USER, {
      email: 'lawyer@harbourvine.example',
      displayName: 'Jordan Price',
      firstName: 'Jordan',
      lastName: 'Price',
      orgIds: [ORG],
      activeOrgId: ORG,
      prefs: { theme: 'system', density: 'comfortable', shortcuts: true, notifications: DEFAULT_NOTIFICATION_PREFS },
      pinnedMatterIds: { ...ELSEWHERE, [ORG]: ids },
      ...meta,
    });
    const matter = (id: string, data: Record<string, unknown>) =>
      fs.set(`orgs/${ORG}/matters/${id}`, matterDoc({ conflictCheck: { status: 'clear' }, ...data }));
    matter('m-okafor', { number: 'M-2026-0151', title: 'Harriet and Paul Okafor', type: 'will' });
    matter('m-nguyen', { number: 'M-2026-0160', title: 'Nguyen v Nguyen', type: 'fp', status: 'closed' });
    matter('m-gone', { number: 'M-2026-0099', title: 'Estate of Deleted Fictional', deletedAt: new Date() });
    matter('m-secret', { number: 'M-2026-0101', title: 'Privileged Fictional', privileged: true });
    fs.denyRead(`orgs/${ORG}/matters/m-secret`);
  };
}

type Page = Awaited<ReturnType<typeof openMatter>>;
const pinnedNav = (page: Page) => page.body.querySelector<HTMLElement>('nav[aria-label="Pinned matters"]');
const pinnedTitles = (page: Page) => [...(pinnedNav(page)?.querySelectorAll('a') ?? [])].map((link) => page.text(link));
const stored = (page: Page) => (page.firestore.get(USER) as { pinnedMatterIds?: unknown }).pinnedMatterIds;

describe('pinned matters', () => {
  it('lists my pins in order, skips the ones I can’t open, and keeps closed matters', async () => {
    const page = await openMatter(undefined, {
      configure: seedPins(['m-okafor', 'm-gone', 'm-secret', 'm-missing', 'm-nguyen']),
    });
    expect(page.router.url).toBe('/matters/m-whitfield/overview');
    expect(pinnedTitles(page)).toEqual(['Harriet and Paul Okafor', 'Nguyen v Nguyen']);
    const okafor = pinnedNav(page)?.querySelector<HTMLElement>('a');
    expect(okafor?.getAttribute('href')).toBe('/matters/m-okafor');
    expect(okafor?.querySelector<HTMLElement>('.mt-dot')?.style.background).toBe('var(--matter-will)');
    const toggle = page.buttons('Pinned')[0];
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
  });

  it('pins from the header’s menu, pruning what’s gone, and unpins again', async () => {
    const page = await openMatter(undefined, { configure: seedPins(['m-okafor', 'm-gone', 'm-secret']) });
    await page.click('More matter actions');
    await page.click('Pin matter', page.body.querySelector('[role="menu"]') ?? page.body);
    expect(stored(page)).toEqual({ ...ELSEWHERE, [ORG]: ['m-okafor', 'm-whitfield'] });
    expect(pinnedTitles(page)).toEqual(['Harriet and Paul Okafor', 'Estate of Margaret Whitfield']);
    expect(page.text(page.body)).toContain('Pinned M-2026-0142');
    // The open matter is the current page in Pinned, so Matters isn't as well.
    const current = [...page.body.querySelectorAll('aside [aria-current="page"]')].map((link) => page.text(link));
    expect(current).toEqual(['Estate of Margaret Whitfield']);

    await page.click('More matter actions');
    await page.click('Unpin matter', page.body.querySelector('[role="menu"]') ?? page.body);
    expect(stored(page)).toEqual({ ...ELSEWHERE, [ORG]: ['m-okafor'] });
    expect(pinnedTitles(page)).toEqual(['Harriet and Paul Okafor']);
    const matters = [...page.body.querySelectorAll('aside a')].find((link) => page.text(link) === 'Matters');
    expect(matters?.getAttribute('aria-current')).toBe('page');
  });

  it('offers Pin matter and Unpin matter in ⌘K, to any role', async () => {
    const page = await openMatter(undefined, { session: READONLY, configure: seedPins([]) });
    const commands = TestBed.inject(CommandRegistry);
    const titles = () => commands.available().map((command) => command.title);
    expect(titles()).toContain('Pin matter');
    expect(titles()).not.toContain('Unpin matter');
    expect(pinnedNav(page)).toBeNull();
    expect(page.buttons('Pinned')).toHaveLength(0);

    commands
      .available()
      .find((command) => command.id === 'this-matter.pin')
      ?.run();
    await page.stable();
    expect(stored(page)).toEqual({ ...ELSEWHERE, [ORG]: ['m-whitfield'] });
    expect(titles()).toContain('Unpin matter');
    expect(titles()).not.toContain('Pin matter');

    commands
      .available()
      .find((command) => command.id === 'this-matter.unpin')
      ?.run();
    await page.stable();
    expect(stored(page)).toEqual(ELSEWHERE);
    expect(pinnedNav(page)).toBeNull();
  });

  it('refuses an eleventh pin', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => `m-${i}`);
    const page = await openMatter(undefined, {
      configure: (fs) => {
        seedPins(ten)(fs);
        ten.forEach((id) => fs.set(`orgs/${ORG}/matters/${id}`, matterDoc({ title: `Fictional ${id}` })));
      },
    });
    expect(pinnedTitles(page)).toHaveLength(10);
    await page.click('More matter actions');
    await page.click('Pin matter', page.body.querySelector('[role="menu"]') ?? page.body);
    expect(page.text(page.body)).toContain('You can pin up to 10 matters');
    expect(stored(page)).toEqual({ ...ELSEWHERE, [ORG]: ten });
  });

  it('collapses the section and remembers it, and hides it in the rail', async () => {
    const page = await openMatter(undefined, { configure: seedPins(['m-okafor']) });
    await page.click('Pinned');
    expect(page.buttons('Pinned')[0]?.getAttribute('aria-expanded')).toBe('false');
    expect(pinnedNav(page)?.parentElement?.hasAttribute('data-closed')).toBe(true);
    expect(localStorage.getItem(PINS_STORAGE_PREFIX + ME)).toBe('1');
    await page.click('Pinned');
    expect(pinnedNav(page)?.parentElement?.hasAttribute('data-closed')).toBe(false);

    await page.click('Collapse sidebar');
    expect(pinnedNav(page)).toBeNull();
    expect(page.buttons('Pinned')).toHaveLength(0);
  });
});
