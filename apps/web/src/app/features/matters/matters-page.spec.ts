import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { TENANCY_PORT } from '@materia/data-access';
import { InMemoryFirestore, provideInMemoryFirestore } from '@materia/data-access/repository';
import { contactSearchTokens, matterSearchTokens, type DateOnly } from '@materia/domain';
import { MT_KEYBOARD_PLATFORM, MT_TODAY } from '@materia/ui';

import {
  bulkStatusSummary,
  cleanFilters,
  formatWip,
  fromTableSort,
  orderForGroups,
  sameView,
  stageLabel,
  toTableSort,
  type MatterRow,
} from './matters-view';
import { App } from '../../app';
import { appRoutes } from '../../app.routes';
import { AUTH_PORT, type AuthSession } from '../../core/auth/auth-port';
import { FakeAuthPort, testSession } from '../../core/auth/testing';
import { provideTestFlags } from '../../core/flags/testing';
import { FakeTenancyPort } from '../../core/orgs/testing';

/** Matters list (CORE-03) against the in-memory Firestore and a fake callable transport. Fictional data only. */

const ORG = 'org-harbour-vine';
const MATTERS = `orgs/${ORG}/matters`;
const TODAY = '2026-10-04' as DateOnly;
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const ME = 'user-jordan';
const PRIYA = 'user-priya';
const LAWYER = testSession();
const PARALEGAL = testSession({ claims: { orgId: ORG, role: 'paralegal', orgName: 'Harbour & Vine Legal' } });
const READONLY = testSession({ claims: { orgId: ORG, role: 'readonly', orgName: 'Harbour & Vine Legal' } });

type Seed = Record<string, unknown>;

const meta = {
  createdAt: new Date('2026-09-01T00:00:00Z'),
  createdBy: ME,
  updatedAt: new Date('2026-09-01T00:00:00Z'),
  updatedBy: ME,
  schemaVersion: 1,
};

/** A stored matter as the server keeps it (search tokens and last activity from matters-denormalise). */
function matterDoc(data: Seed & { number: string; title: string; daysAgo?: number }): Seed {
  const { daysAgo = 1, ...rest } = data;
  return {
    type: 'probate',
    status: 'open',
    jurisdiction: 'VIC',
    responsibleUid: ME,
    teamUids: [],
    clientContactIds: ['c-avery'],
    privileged: false,
    priority: 'medium',
    labels: [],
    openTaskCount: 0,
    wipCents: 0,
    fee: { arrangement: 'hourly', history: [] },
    costsDisclosure: { status: 'sent' },
    conflictCheck: { status: 'clear' },
    search: matterSearchTokens({
      number: data.number,
      title: data.title,
      clientNames: [data['clientContactIds'] ? 'Bram Ostler' : 'Avery Quill'],
    }),
    lastActivityAt: new Date(Date.parse('2026-10-04T00:00:00Z') - daysAgo * 86_400_000),
    // matters-denormalise keeps deletedAt: null on live matters; the list queries for it.
    deletedAt: null,
    ...meta,
    ...rest,
  };
}

function seed(fs: InMemoryFirestore): void {
  const member = (uid: string, displayName: string, role: string, status = 'active') =>
    fs.set(`orgs/${ORG}/members/${uid}`, { displayName, email: `${uid}@example.test`, role, status });
  member(ME, 'Jordan Price', 'lawyer');
  member(PRIYA, 'Priya Shah', 'owner');
  member('user-sam', 'Sam Lee', 'readonly');
  const contact = (id: string, givenNames: string, familyName: string) =>
    fs.set(`orgs/${ORG}/contacts/${id}`, {
      kind: 'person',
      givenNames,
      familyName,
      emails: [],
      phones: [],
      addresses: [],
      tags: [],
      isReferrer: false,
      search: contactSearchTokens({ givenNames, familyName }),
      ...meta,
    });
  contact('c-avery', 'Avery', 'Quill');
  contact('c-bram', 'Bram', 'Ostler');
  fs.set(
    `${MATTERS}/m-whitfield`,
    matterDoc({
      number: 'M-2026-0142',
      title: 'Estate of Margaret Whitfield',
      wipCents: 486_000,
      stageId: 'notice-period',
      priority: 'high',
      labels: ['grant'],
      nextDeadline: { id: 'd1', dueDate: '2026-10-02', title: 'Advertise notice', critical: true },
      daysAgo: 1,
    }),
  );
  fs.set(
    `${MATTERS}/m-okafor`,
    matterDoc({
      number: 'M-2026-0151',
      title: 'Harriet and Paul Okafor',
      type: 'will',
      wipCents: 220_000,
      clientContactIds: ['c-bram'],
      nextDeadline: { id: 'd2', dueDate: '2026-10-08', title: 'Signing', critical: false },
      daysAgo: 2,
    }),
  );
  fs.set(
    `${MATTERS}/m-chen`,
    matterDoc({
      number: 'M-2026-0118',
      title: 'Estate of Robert Chen',
      type: 'admin',
      responsibleUid: PRIYA,
      daysAgo: 3,
    }),
  );
  fs.set(
    `${MATTERS}/m-lambert`,
    matterDoc({ number: 'M-2026-0160', title: 'Estate of George Lambert', status: 'lead', daysAgo: 4 }),
  );
  fs.set(
    `${MATTERS}/m-brennan`,
    matterDoc({
      number: 'M-2026-0171',
      title: 'Doyle v Brennan',
      type: 'contest',
      jurisdiction: 'NSW',
      status: 'on_hold',
      responsibleUid: PRIYA,
      daysAgo: 5,
    }),
  );
  fs.set(
    `${MATTERS}/m-deleted`,
    matterDoc({ number: 'M-2026-0001', title: 'Deleted fictional matter', deletedAt: new Date(), daysAgo: 0 }),
  );
}

interface Options {
  configure?: (port: FakeAuthPort, firestore: InMemoryFirestore) => void;
}

async function open(url: string, session: AuthSession = LAWYER, options: Options = {}) {
  const port = new FakeAuthPort(session);
  const firestore = new InMemoryFirestore();
  options.configure?.(port, firestore);
  TestBed.configureTestingModule({
    imports: [App],
    providers: [
      provideRouter(appRoutes),
      { provide: MT_KEYBOARD_PLATFORM, useValue: 'other' },
      { provide: MT_TODAY, useValue: () => TODAY },
      { provide: AUTH_PORT, useValue: port },
      { provide: TENANCY_PORT, useValue: new FakeTenancyPort() },
      provideInMemoryFirestore(firestore),
      ...provideTestFlags(),
    ],
  });
  const fixture = TestBed.createComponent(App);
  const router = TestBed.inject(Router);
  await router.navigateByUrl(url);
  await fixture.whenStable();
  const body = document.body;
  const stable = async (ms = 0) => {
    await settle(ms);
    await fixture.whenStable();
    await settle();
    await fixture.whenStable();
  };
  await stable();
  const dialog = () => body.querySelector<HTMLElement>('.mt-dialog');
  const buttons = (text: string, root: ParentNode = body) =>
    [...root.querySelectorAll<HTMLElement>('button, a')].filter((b) => b.textContent?.trim().startsWith(text));
  const click = async (text: string, root: ParentNode = dialog() ?? body) => {
    const found = buttons(text, root)[0];
    if (!found) throw new Error(`No button "${text}"`);
    found.click();
    await stable();
  };
  /** Opens a chip's menu and picks an item. */
  const pick = async (chip: string, item: string) => {
    await click(chip, body.querySelector('[aria-label="View and filters"]') ?? body);
    const items = [...body.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
    const found = items.find((i) => i.textContent?.trim() === item);
    if (!found) throw new Error(`No menu item "${item}" in ${items.map((i) => i.textContent?.trim()).join(', ')}`);
    found.click();
    await stable();
    // Checkbox menus stay open: close them as a person would.
    const menu = body.querySelector('[role="menu"]');
    if (menu) {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await stable();
    }
  };
  const press = async (key: string, target: EventTarget = document.activeElement ?? body) => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    await stable();
  };
  const rows = () => [...body.querySelectorAll<HTMLElement>('mt-table tbody tr[data-index]')];
  const titles = () => rows().map((row) => row.querySelector('.title')?.textContent?.trim());
  const groups = () =>
    [...body.querySelectorAll('mt-table tbody tr.group')].map((row) => row.textContent?.replace(/\s+/g, ' ').trim());
  const type = async (value: string) => {
    const input = body.querySelector<HTMLInputElement>('input[aria-label="Filter matters"]');
    if (!input) throw new Error('No filter box');
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await stable(250);
  };
  const submitDialog = async (value: string) => {
    const input = dialog()?.querySelector<HTMLInputElement>('input');
    if (!input) throw new Error(`No dialog input: ${dialog()?.outerHTML.slice(0, 1500) ?? 'no dialog'}`);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await stable();
    dialog()?.querySelector('form')?.dispatchEvent(new Event('submit'));
    await stable();
  };
  return {
    port,
    firestore,
    router,
    body,
    dialog,
    stable,
    buttons,
    click,
    pick,
    press,
    rows,
    titles,
    groups,
    type,
    submitDialog,
    view: () => new URL(router.url, 'http://x').searchParams.get('view'),
    text: () => body.textContent?.replace(/\s+/g, ' ') ?? '',
  };
}

beforeEach(() => localStorage.clear());

afterEach(() => {
  document.querySelectorAll('.mt-overlay, .mt-toast-region, [data-overlay]').forEach((node) => node.remove());
});

describe('matters list', () => {
  it('opens on "My open matters": my open matters, most recent first, with every column', async () => {
    const page = await open('/matters', LAWYER, { configure: (_p, fs) => seed(fs) });
    expect(page.router.url).toBe('/matters');
    expect(page.titles()).toEqual(['Estate of Margaret Whitfield', 'Harriet and Paul Okafor']);
    const first = page.rows()[0]?.textContent?.replace(/\s+/g, ' ') ?? '';
    expect(first).toContain('M-2026-0142');
    expect(first).toContain('Probate');
    expect(first).toContain('Avery Quill');
    expect(first).toContain('Notice period');
    expect(first).toContain('$4,860');
    expect(first).toContain('Yesterday');
    expect(page.rows()[0]?.querySelector('mt-deadline-chip')?.getAttribute('data-urgency')).toBe('overdue');
    expect(page.rows()[0]?.querySelector('mt-avatar')?.getAttribute('aria-label')).toBe('Jordan Price');
    expect(page.rows()[1]?.textContent).toContain('Bram Ostler');
    expect(page.text()).toContain('My open matters');
    expect(page.text()).not.toContain('Deleted fictional matter');
    expect(page.body.querySelector('.mt-matters-notice')).toBeNull();
    expect(page.firestore.listenerCount).toBeGreaterThan(0);
  });

  it('shows the loading and error states', async () => {
    const loading = await open('/matters', LAWYER, {
      configure: (_p, fs) => {
        fs.stalled = true;
      },
    });
    expect(loading.text()).toContain('Loading matters…');
    TestBed.resetTestingModule();

    const failing = await open('/matters', LAWYER, {
      configure: (_p, fs) => {
        seed(fs);
        // Fail the matters query's first read (not the saved views' or members').
        const real = fs.driver;
        let failed = false;
        (fs as unknown as { driver: typeof real }).driver = (path, opts) => {
          const driver = real(path, opts);
          if (path === MATTERS && !failed) {
            failed = true;
            fs.failNext({ code: 'unavailable' });
          }
          return driver;
        };
      },
    });
    expect(failing.text()).toContain('This service is temporarily unavailable');
    await failing.click('Try again');
    expect(failing.titles()).toContain('Estate of Margaret Whitfield');
  });

  it('switches views and filters by status, type and responsible', async () => {
    const page = await open('/matters', LAWYER, { configure: (_p, fs) => seed(fs) });
    await page.pick('My open matters', 'All open');
    expect(page.view()).toBe('all-open');
    expect(page.titles()).toEqual(['Estate of Margaret Whitfield', 'Harriet and Paul Okafor', 'Estate of Robert Chen']);

    await page.pick('Open', 'Lead');
    expect(page.titles()).toContain('Estate of George Lambert');
    expect(page.text()).toContain('All open (edited)');

    await page.pick('Type', 'Will');
    expect(page.titles()).toEqual(['Harriet and Paul Okafor']);
    // Status + type is indexed for one status only; two statuses with a type: an `in` and an equality.
    await page.pick('Will', 'Will');

    await page.pick('Anyone', 'Priya Shah');
    expect(page.titles()).toEqual(['Estate of Robert Chen']);
  });

  it('filters by label and overdue', async () => {
    const page = await open('/matters?view=all-open', LAWYER, { configure: (_p, fs) => seed(fs) });
    await page.pick('Open', 'Lead');
    await page.pick('Label', 'grant');
    expect(page.titles()).toEqual(['Estate of Margaret Whitfield']);
    await page.pick('Label: grant', 'Any label');

    await page.click('Has overdue', page.body);
    expect(page.titles()).toEqual(['Estate of Margaret Whitfield']);
    // Overdue is worked out here, over the 500 most recent matters: the notice says so.
    expect(page.body.querySelector('.mt-matters-notice')?.textContent).toContain('500');
  });

  it('filters by jurisdiction across every status', async () => {
    const page = await open('/matters?view=all-open', LAWYER, { configure: (_p, fs) => seed(fs) });
    await page.pick('Open', 'Lead');
    await page.pick('Status: 2', 'Open');
    await page.pick('Lead', 'Lead');
    await page.pick('Jurisdiction', 'NSW');
    expect(page.titles()).toEqual(['Doyle v Brennan']);
  });

  it('searches by number, title or client', async () => {
    const page = await open('/matters?view=all-open', LAWYER, { configure: (_p, fs) => seed(fs) });
    await page.type('okafor');
    expect(page.titles()).toEqual(['Harriet and Paul Okafor']);
    await page.type('0118');
    expect(page.titles()).toEqual(['Estate of Robert Chen']);
    await page.type('avery quill');
    expect(page.titles()).toEqual(['Estate of Margaret Whitfield', 'Estate of Robert Chen']);
    await page.type('ostler');
    expect(page.titles()).toEqual(['Harriet and Paul Okafor']);
  });

  it('shows an empty state with "Clear filters" when nothing matches, and one when there are no matters', async () => {
    const page = await open('/matters', LAWYER, { configure: (_p, fs) => seed(fs) });
    await page.pick('Jurisdiction', 'WA');
    expect(page.rows()).toHaveLength(0);
    expect(page.text()).toContain('No matters match');
    const empty = page.body.querySelector('mt-empty-state');
    await page.click('Clear filters', empty ?? page.body);
    expect(page.titles()).toHaveLength(5);
    expect(page.text()).not.toContain('No matters match');
    TestBed.resetTestingModule();
    localStorage.clear();

    // "My open matters" filters, so an empty practice still offers to clear them first.
    const none = await open('/matters');
    expect(none.text()).toContain('No matters match');
    await none.click('Clear filters', none.body.querySelector('mt-empty-state') ?? none.body);
    expect(none.text()).toContain('No matters yet');
    expect(none.buttons('New matter').length).toBeGreaterThan(0);
  });

  it('groups by status in lifecycle order, by type and by responsible', async () => {
    const page = await open('/matters?view=all-open', LAWYER, { configure: (_p, fs) => seed(fs) });
    await page.pick('Open', 'Lead');
    await page.pick('Group: No grouping', 'Status');
    expect(page.groups()).toEqual(['Lead1', 'Open3']);
    expect(page.titles()[0]).toBe('Estate of George Lambert');
    await page.pick('Group: Status', 'Responsible');
    expect(page.groups()).toEqual(['Jordan Price3', 'Priya Shah1']);
    await page.pick('Group: Responsible', 'Type');
    expect(page.groups()).toEqual(['Estate admin1', 'Probate2', 'Will1']);
  });

  it('sorts by any column: indexed sorts in Firestore, the rest here', async () => {
    const page = await open('/matters?view=all-open', LAWYER, { configure: (_p, fs) => seed(fs) });
    const header = (name: string) =>
      [...page.body.querySelectorAll<HTMLButtonElement>('th button.mt-table-sort')].find((b) =>
        b.textContent?.includes(name),
      );
    header('Ref')?.click();
    await page.stable();
    expect(page.titles()).toEqual(['Estate of Robert Chen', 'Estate of Margaret Whitfield', 'Harriet and Paul Okafor']);
    expect(page.body.querySelector('.mt-matters-notice')).toBeNull();
    header('WIP')?.click();
    await page.stable();
    header('WIP')?.click();
    await page.stable();
    expect(page.titles()).toEqual(['Estate of Margaret Whitfield', 'Harriet and Paul Okafor', 'Estate of Robert Chen']);
    expect(page.body.querySelector('.mt-matters-notice')).not.toBeNull();
    header('Client')?.click();
    await page.stable();
    expect(page.titles()[0]).toBe('Estate of Margaret Whitfield');
  });

  it('pages 50 at a time and loads more on request', async () => {
    const page = await open('/matters?view=all-open', LAWYER, {
      configure: (_p, fs) => {
        seed(fs);
        for (let i = 0; i < 60; i++) {
          const n = String(i + 1).padStart(4, '0');
          fs.set(
            `${MATTERS}/m-bulk-${n}`,
            matterDoc({ number: `M-2025-${n}`, title: `Fictional estate ${n}`, daysAgo: 10 + i }),
          );
        }
      },
    });
    // Live matters only (deletedAt == null): the soft-deleted one never takes a place in the page.
    expect(page.rows()).toHaveLength(50);
    await page.click('Show more matters', page.body);
    expect(page.rows()).toHaveLength(63);
    expect(page.buttons('Show more matters')).toHaveLength(0);
  });
});

describe('keyboard', () => {
  it('moves with j and k, selects with x, opens with Enter, filters with / and creates with c', async () => {
    const page = await open('/matters?view=all-open', LAWYER, { configure: (_p, fs) => seed(fs) });
    await page.press('j', page.body);
    expect(document.activeElement?.getAttribute('data-index')).toBe('0');
    await page.press('j');
    expect(document.activeElement?.getAttribute('data-index')).toBe('1');
    await page.press('k');
    expect(document.activeElement?.getAttribute('data-index')).toBe('0');
    await page.press('x');
    expect(page.body.querySelector('[aria-label="Bulk actions"]')?.textContent).toContain('1 selected');
    await page.press('x');
    expect(page.body.querySelector('[aria-label="Bulk actions"]')).toBeNull();
    await page.press('x');
    (document.activeElement as HTMLElement | null)?.blur();
    await page.press('Escape', page.body);
    expect(page.body.querySelector('[aria-label="Bulk actions"]')).toBeNull();

    await page.press('/', page.body);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Filter matters');
    (document.activeElement as HTMLElement | null)?.blur();

    await page.press('k', page.body);
    await page.press('Enter');
    expect(page.router.url).toBe('/matters/m-whitfield/overview');

    await page.router.navigateByUrl('/matters');
    await page.stable();
    await page.press('c', page.body);
    expect(page.router.url).toBe('/matters/new');
    expect(page.text()).toContain('What kind of matter is it?');
  });
});

describe('pinning (CORE-23)', () => {
  /** My profile, with these pins in the practice. */
  const profile = (ids: string[]) => (_port: FakeAuthPort, fs: InMemoryFirestore) => {
    seed(fs);
    fs.set(`users/${ME}`, {
      email: 'lawyer@harbourvine.example',
      displayName: 'Jordan Price',
      orgIds: [ORG],
      activeOrgId: ORG,
      pinnedMatterIds: { [ORG]: ids },
      ...meta,
    });
  };
  const pins = (page: Awaited<ReturnType<typeof open>>) =>
    (page.firestore.get(`users/${ME}`) as { pinnedMatterIds: Record<string, string[]> }).pinnedMatterIds[ORG] ?? [];
  const marked = (page: Awaited<ReturnType<typeof open>>) =>
    page
      .rows()
      .flatMap((row) =>
        row.querySelector('.mt-matters-pinned')
          ? [row.querySelector('.mt-matters-title .title')?.textContent?.trim()]
          : [],
      );

  it('pins and unpins from a row’s menu, and marks pinned rows', async () => {
    const page = await open('/matters?view=all-open', LAWYER, { configure: profile(['m-chen']) });
    expect(marked(page)).toEqual(['Estate of Robert Chen']);
    const menu = page.body.querySelector<HTMLElement>('button[aria-label="More actions for M-2026-0151"]');
    expect(menu?.getAttribute('tabindex')).toBe('-1');
    menu?.click();
    await page.stable();
    await page.click('Pin matter', page.body.querySelector('[role="menu"]') ?? page.body);
    expect(pins(page)).toEqual(['m-chen', 'm-okafor']);
    expect(marked(page)).toEqual(['Harriet and Paul Okafor', 'Estate of Robert Chen']);
    expect(page.text()).toContain('Pinned M-2026-0151');

    page.body.querySelector<HTMLElement>('button[aria-label="More actions for M-2026-0118"]')?.click();
    await page.stable();
    await page.click('Unpin matter', page.body.querySelector('[role="menu"]') ?? page.body);
    expect(pins(page)).toEqual(['m-okafor']);
  });

  it('pins the focused row with p', async () => {
    const page = await open('/matters?view=all-open', LAWYER, { configure: profile([]) });
    await page.press('j', page.body);
    await page.press('p');
    expect(pins(page)).toEqual(['m-whitfield']);
    await page.press('p');
    expect(pins(page)).toEqual([]);
  });

  it('read-only members pin too: pins are their own', async () => {
    const page = await open('/matters?view=all-open', READONLY, { configure: profile([]) });
    page.body.querySelector<HTMLElement>('button[aria-label="More actions for M-2026-0142"]')?.click();
    await page.stable();
    await page.click('Pin matter', page.body.querySelector('[role="menu"]') ?? page.body);
    expect(pins(page)).toEqual(['m-whitfield']);
  });

  it('leads the list with my pinned matters, for phones', async () => {
    const page = await open('/matters', LAWYER, { configure: profile(['m-okafor', 'm-deleted', 'm-chen']) });
    const strip = page.body.querySelector('.mt-matters-pins');
    const links = [...(strip?.querySelectorAll('a') ?? [])];
    expect(links.map((link) => link.textContent?.trim())).toEqual(['Harriet and Paul Okafor', 'Estate of Robert Chen']);
    expect(links[0]?.getAttribute('href')).toBe('/matters/m-okafor');
  });
});

describe('saved views', () => {
  it('saves, reopens, updates, renames and deletes a view of my own', async () => {
    const page = await open('/matters', LAWYER, { configure: (_p, fs) => seed(fs) });
    await page.pick('Group: No grouping', 'Status');
    await page.click('Save view', page.body);
    expect(page.dialog()?.textContent).toContain('Save view');
    await page.submitDialog('');
    expect(page.dialog()?.textContent).toContain('Enter a view name.');
    await page.submitDialog('Mine by status');
    expect(page.dialog()).toBeNull();
    const created = page.firestore.writes.find((w) => w.op === 'create');
    expect(created?.path).toMatch(new RegExp(`^users/${ME}/views/`));
    expect(created?.data).toMatchObject({
      orgId: ORG,
      list: 'matters',
      name: 'Mine by status',
      filters: { status: ['open'], responsible: 'me' },
      sort: { field: 'lastActivity', dir: 'desc' },
      groupBy: 'status',
    });
    const id = created?.path.split('/').pop();
    expect(page.view()).toBe(id);
    expect(page.text()).toContain('Mine by status');
    expect(page.text()).not.toContain('(edited)');
    expect(page.groups()).toEqual(['Open2']);

    // Another view, then back: it's in the picker.
    await page.pick('Mine by status', 'Leads');
    expect(page.titles()).toEqual(['Estate of George Lambert']);
    await page.pick('Leads', 'Mine by status');
    expect(page.groups()).toEqual(['Open2']);

    // Change it and save the change into the view.
    await page.pick('Group: Status', 'No grouping');
    await page.pick('Mine by status (edited)', 'Save changes to this view');
    expect(page.firestore.get(`users/${ME}/views/${id}`)).toMatchObject({ groupBy: 'none' });

    await page.pick('Mine by status', 'Rename view…');
    await page.submitDialog('Just mine');
    expect(page.firestore.get(`users/${ME}/views/${id}`)).toMatchObject({ name: 'Just mine' });
    expect(page.text()).toContain('Just mine');

    await page.pick('Just mine', 'Delete view');
    await page.click('Delete view');
    expect(page.firestore.get(`users/${ME}/views/${id}`)).toBeUndefined();
    expect(page.view()).toBeNull();
    expect(page.text()).toContain('My open matters');
  });

  it('opens a saved view from the URL, and ignores views from another org', async () => {
    const view = (orgId: string, name: string) => ({
      orgId,
      list: 'matters',
      name,
      filters: { status: ['on_hold'] },
      sort: { field: 'title', dir: 'asc' },
      groupBy: 'none',
      ...meta,
    });
    const page = await open('/matters?view=v-held', LAWYER, {
      configure: (_p, fs) => {
        seed(fs);
        fs.set(`users/${ME}/views/v-held`, view(ORG, 'Held'));
        fs.set(`users/${ME}/views/v-elsewhere`, view('org-other', 'Elsewhere'));
      },
    });
    expect(page.titles()).toEqual(['Doyle v Brennan']);
    expect(page.text()).toContain('Held');
    await page.click('Held', page.body);
    expect(page.text()).not.toContain('Elsewhere');
  });
});

describe('remembering the view', () => {
  it('reopens the view the list was left on, edits and cleared filters included', async () => {
    const page = await open('/matters', LAWYER, { configure: (_p, fs) => seed(fs) });
    await page.pick('My open matters', 'All open');
    await page.pick('Type', 'Will');
    expect(page.titles()).toEqual(['Harriet and Paul Okafor']);

    await page.router.navigateByUrl('/contacts');
    await page.stable();
    await page.router.navigateByUrl('/matters');
    await page.stable();
    expect(page.view()).toBe('all-open');
    expect(page.titles()).toEqual(['Harriet and Paul Okafor']);
    expect(page.text()).toContain('All open (edited)');

    // Cleared filters on the default view stay cleared.
    await page.pick('All open', 'My open matters');
    await page.click('Clear filters', page.body.querySelector('[aria-label="View and filters"]') ?? page.body);
    expect(page.titles()).toHaveLength(5);
    await page.router.navigateByUrl('/contacts');
    await page.stable();
    await page.router.navigateByUrl('/matters');
    await page.stable();
    expect(page.view()).toBeNull();
    expect(page.titles()).toHaveLength(5);

    // A link naming a view wins over the remembered one.
    await page.router.navigateByUrl('/contacts');
    await page.stable();
    await page.router.navigateByUrl('/matters?view=leads');
    await page.stable();
    expect(page.titles()).toEqual(['Estate of George Lambert']);
  });

  it('forgets unreadable remembered views', async () => {
    localStorage.setItem('materia.matters.view', '{not json');
    const page = await open('/matters', LAWYER, { configure: (_p, fs) => seed(fs) });
    expect(page.view()).toBeNull();
    expect(page.titles()).toEqual(['Estate of Margaret Whitfield', 'Harriet and Paul Okafor']);
  });
});

describe('bulk actions', () => {
  it('assigns the selected matters client-direct', async () => {
    const page = await open('/matters?view=all-open', PARALEGAL, { configure: (_p, fs) => seed(fs) });
    const check = (index: number) => page.rows()[index]?.querySelector<HTMLElement>('[role="checkbox"]')?.click();
    check(0);
    check(1);
    await page.stable();
    const bar = page.body.querySelector<HTMLElement>('[aria-label="Bulk actions"]');
    expect(bar?.textContent).toContain('2 selected');
    // Paralegals edit but don't change status.
    expect(bar?.textContent).not.toContain('Change status');
    await page.click('Assign', bar ?? page.body);
    [...page.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((i) => i.textContent?.includes('Priya'))
      ?.click();
    await page.stable();
    const updates = page.firestore.writes.filter((w) => w.op === 'update');
    expect(updates.map((w) => [w.path, w.data?.['responsibleUid']])).toEqual([
      [`${MATTERS}/m-whitfield`, PRIYA],
      [`${MATTERS}/m-okafor`, PRIYA],
    ]);
    expect(page.text()).toContain('Assigned 2 matters to Priya Shah');
    expect(page.body.querySelector('[aria-label="Bulk actions"]')).toBeNull();
    expect(page.rows()[0]?.querySelector('mt-avatar')?.getAttribute('aria-label')).toBe('Priya Shah');
  });

  it('adds a label to the selected matters', async () => {
    const page = await open('/matters?view=all-open', LAWYER, { configure: (_p, fs) => seed(fs) });
    page.rows()[0]?.querySelector<HTMLElement>('[role="checkbox"]')?.click();
    page.rows()[2]?.querySelector<HTMLElement>('[role="checkbox"]')?.click();
    await page.stable();
    await page.click('Add label', page.body.querySelector('[aria-label="Bulk actions"]') ?? page.body);
    await page.submitDialog('grant');
    // Whitfield already has it: only Chen is written.
    expect(page.firestore.writes.filter((w) => w.op === 'update').map((w) => [w.path, w.data?.['labels']])).toEqual([
      [`${MATTERS}/m-chen`, ['grant']],
    ]);
    expect(page.text()).toContain('Added “grant” to 2 matters');
  });

  it('changes status through matters-changeStatus, one call per matter, summarising refusals', async () => {
    const page = await open('/matters?view=all-open', LAWYER, {
      configure: (port, fs) => {
        seed(fs);
        port.call = async <T>(name: string, data: unknown): Promise<T> => {
          port.calls.push({ name, data });
          const { matterId } = data as { matterId: string };
          if (matterId === 'm-okafor') {
            throw { code: 'functions/failed-precondition', details: { code: 'MATTER_INVALID_TRANSITION' } };
          }
          return { matterId, status: 'on_hold' } as T;
        };
      },
    });
    page.rows()[0]?.querySelector<HTMLElement>('[role="checkbox"]')?.click();
    page.rows()[1]?.querySelector<HTMLElement>('[role="checkbox"]')?.click();
    await page.stable();
    await page.click('Change status', page.body.querySelector('[aria-label="Bulk actions"]') ?? page.body);
    [...page.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((i) => i.textContent?.trim() === 'On hold')
      ?.click();
    await page.stable();
    expect(page.port.calls.map((c) => [c.name, (c.data as { matterId: string }).matterId])).toEqual([
      ['matters-changeStatus', 'm-whitfield'],
      ['matters-changeStatus', 'm-okafor'],
    ]);
    expect(page.port.calls[0]?.data).toMatchObject({ to: 'on_hold', requestId: expect.any(String) });
    const text = page.text();
    expect(text).toContain('Moved 1 matter to On hold; 1 couldn’t move');
    expect(text).toContain('M-2026-0151: The matter can’t move to that status from where it is now.');
    // The refused one stays selected.
    expect(page.body.querySelector('[aria-label="Bulk actions"]')?.textContent).toContain('1 selected');
  });

  it('read-only members look but cannot change anything', async () => {
    const page = await open('/matters?view=all-open', READONLY, { configure: (_p, fs) => seed(fs) });
    expect(page.buttons('New matter')).toHaveLength(0);
    page.rows()[0]?.querySelector<HTMLElement>('[role="checkbox"]')?.click();
    await page.stable();
    const bar = page.body.querySelector('[aria-label="Bulk actions"]');
    expect(bar?.textContent).not.toContain('Assign');
    expect(bar?.textContent).not.toContain('Change status');
    // Without privileged.view the query proves privileged == false, as the rules require.
    expect(page.titles()).toContain('Estate of Margaret Whitfield');
  });
});

describe('matters view helpers', () => {
  it('formats WIP and stages, compares views and maps sorts', () => {
    expect(formatWip(486_050)).toBe('$4,861');
    expect(stageLabel('notice-period')).toBe('Notice period');
    expect(stageLabel(undefined)).toBe('');
    const view = {
      filters: { status: ['open' as const], hasOverdue: false },
      sort: fromTableSort(null),
      groupBy: 'none' as const,
    };
    expect(sameView(view, { ...view, filters: { status: ['open'] } })).toBe(true);
    expect(sameView(view, { ...view, groupBy: 'status' })).toBe(false);
    expect(cleanFilters({ status: [], label: '', query: 'x', hasOverdue: true })).toEqual({ hasOverdue: true });
    expect(toTableSort({ field: 'lastActivity', dir: 'desc' })).toBeNull();
    expect(toTableSort({ field: 'wip', dir: 'asc' })).toEqual({ column: 'wip', direction: 'asc' });
    expect(fromTableSort({ column: 'title', direction: 'desc' })).toEqual({ field: 'title', dir: 'desc' });
  });

  it('orders groups and words bulk results', () => {
    const row = (id: string, status: MatterRow['status']) => ({ id, status }) as MatterRow;
    const ordered = orderForGroups([row('a', 'closed'), row('b', 'lead'), row('c', 'open')], 'status', () => '');
    expect(ordered.map((r) => r.id)).toEqual(['b', 'c', 'a']);
    expect(bulkStatusSummary('closed', 2, [])).toEqual({ title: 'Moved 2 matters to Closed', tone: 'success' });
    expect(bulkStatusSummary('open', 0, [{ number: 'M-1', message: 'No.' }])).toMatchObject({
      title: 'Couldn’t move 1 matter to Open',
      tone: 'danger',
    });
  });
});
