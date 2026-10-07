import { TestBed } from '@angular/core/testing';

import type { InMemoryFirestore } from '@materia/data-access/repository';
import { matterSearchTokens } from '@materia/domain';

import { KEYBOARD_INSET_VAR, MOBILE_QUERY, PhoneLayout } from './phone-layout';
import { storedDocument } from '../../features/documents/testing';
import {
  cleanUpOverlays,
  contactDoc,
  MATTER,
  matterDoc,
  ME,
  meta,
  noteDoc,
  openMatter,
  ORG,
  READONLY,
} from '../../features/matter-detail/testing';

/** The phone screens (MOB-02) against the in-memory Firestore. Every matter and person is fictional. */

type Page = Awaited<ReturnType<typeof openMatter>>;
type Seed = Record<string, unknown>;

const OSTLER = `orgs/${ORG}/matters/m-ostler`;

let restoreMedia: (() => void) | null = null;

/** The window is phone-sized (or not) until the test ends; `change` resizes it. */
function asPhone(matches = true) {
  const original = window.matchMedia;
  const listeners = new Set<(event: { matches: boolean }) => void>();
  window.matchMedia = ((query: string) => ({
    matches: query === MOBILE_QUERY ? matches : false,
    media: query,
    addEventListener: (_: string, listener: (event: { matches: boolean }) => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: (event: { matches: boolean }) => void) => listeners.delete(listener),
  })) as unknown as typeof window.matchMedia;
  restoreMedia = () => (window.matchMedia = original);
  return { change: (next: boolean) => listeners.forEach((listener) => listener({ matches: next })) };
}

afterEach(() => {
  restoreMedia?.();
  restoreMedia = null;
  cleanUpOverlays();
});

function recentDoc(matterId: string, at: string): Seed {
  return {
    orgId: ORG,
    kind: 'matter',
    matterId,
    expireAt: new Date('2026-12-31T00:00:00Z'),
    ...meta,
    updatedAt: new Date(at),
  };
}

/** A second matter, both recently opened, and the client's number and email. */
function practice(fs: InMemoryFirestore): void {
  // The Matters list reads the most recently active first.
  fs.set(MATTER, { ...(fs.get(MATTER) as Seed), lastActivityAt: new Date('2026-10-02T00:00:00Z') });
  fs.set(
    OSTLER,
    matterDoc({
      number: 'M-2026-0150',
      title: 'Will for Bram Ostler',
      type: 'will',
      deceased: undefined,
      lastActivityAt: new Date('2026-10-03T00:00:00Z'),
      search: matterSearchTokens({ number: 'M-2026-0150', title: 'Will for Bram Ostler', clientNames: [] }),
    }),
  );
  fs.set(`users/${ME}/recent/${ORG}_m-ostler`, recentDoc('m-ostler', '2026-10-03T00:00:00Z'));
  fs.set(`users/${ME}/recent/${ORG}_m-whitfield`, recentDoc('m-whitfield', '2026-10-02T00:00:00Z'));
  fs.set(
    `orgs/${ORG}/contacts/c-avery`,
    contactDoc('Avery', 'Quill', {
      phones: [
        { type: 'home', number: '+61352001234' },
        { type: 'mobile', number: '+61412345678' },
      ],
      emails: [{ type: 'personal', address: 'avery.quill@example.test' }],
    }),
  );
}

/** Opens the matter's actions sheet from the top bar's "…". */
async function openActions(page: Page): Promise<HTMLElement> {
  await page.click('Matter actions');
  const sheet = await vi.waitFor(
    () => page.body.querySelector<HTMLElement>('.mt-sheet') ?? Promise.reject(new Error('No sheet yet')),
  );
  await page.stable(20);
  return sheet;
}

async function openPhone(url: string, options: Parameters<typeof openMatter>[1] = {}): Promise<Page> {
  asPhone();
  const page = await openMatter(url, {
    ...options,
    configure: (fs, port) => (practice(fs), options.configure?.(fs, port)),
  });
  await page.stable(20);
  await page.stable(20);
  return page;
}

const texts = (page: Page, selector: string, root: ParentNode = page.body) =>
  [...root.querySelectorAll(selector)].map((node) => page.text(node));

describe('PhoneLayout', () => {
  it('follows the window between phone and bigger sizes', () => {
    const media = asPhone(false);
    const layout = TestBed.inject(PhoneLayout);
    expect(layout.phone()).toBe(false);
    media.change(true);
    expect(layout.phone()).toBe(true);
  });

  it('keeps how much the on-screen keyboard covers in a CSS variable', () => {
    const viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0 });
    const original = Object.getOwnPropertyDescriptor(window, 'visualViewport');
    Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true });
    const height = vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800);
    try {
      TestBed.inject(PhoneLayout);
      const root = document.documentElement;
      viewport.height = 460;
      viewport.dispatchEvent(new Event('resize'));
      expect(root.style.getPropertyValue(KEYBOARD_INSET_VAR)).toBe('340px');
      viewport.height = 800;
      viewport.dispatchEvent(new Event('resize'));
      expect(root.style.getPropertyValue(KEYBOARD_INSET_VAR)).toBe('');
    } finally {
      height.mockRestore();
      if (original) Object.defineProperty(window, 'visualViewport', original);
      else delete (window as { visualViewport?: unknown }).visualViewport;
    }
  });
});

describe('More (MOB-02)', () => {
  it('lists my account, every page the TabBar has no room for, the theme and Sign out', async () => {
    const page = await openPhone('/more');
    const more = page.body.querySelector('mt-more-page') as HTMLElement;
    expect([...more.querySelectorAll('[data-more]')].map((row) => row.getAttribute('data-more'))).toEqual([
      'profile',
      'tasks',
      'deadlines',
      'contacts',
      'safe-custody',
      'billing',
      'insights',
      'settings',
      'theme',
      'sign-out',
    ]);
    expect(more.querySelector('[data-more="contacts"]')?.getAttribute('href')).toBe('/contacts');
    expect(page.text(more.querySelector('[data-more="theme"]'))).toMatch(/^Use (dark|light) theme$/);
    expect(page.body.querySelector('.mt-tabbar a[href="/more"]')?.getAttribute('aria-current')).toBe('page');
  });

  it('signs out', async () => {
    const page = await openPhone('/more');
    (page.body.querySelector('[data-more="sign-out"]') as HTMLElement).click();
    await page.stable(20);
    await page.stable(20);
    expect(page.router.url).toBe('/auth/sign-in');
  });
});

describe('Record (MOB-02)', () => {
  it('records on a recent matter: its chip, then Note opens the matter’s Notes ready to write', async () => {
    const page = await openPhone('/record');
    const record = page.body.querySelector('mt-record-page') as HTMLElement;
    expect(texts(page, '.chips .mt-chip', record)).toEqual([
      'M-2026-0150 Will for Bram Ostler',
      'M-2026-0142 Estate of Margaret Whitfield',
    ]);
    expect(page.text(record.querySelector('.hint'))).toBe('Pick a recent matter, or choose one as you record.');
    await page.click('M-2026-0150', record);
    expect(page.buttons('M-2026-0150', record)[0]?.getAttribute('aria-pressed')).toBe('true');
    expect(page.text(record.querySelector('.hint'))).toBe('Recording on M-2026-0150, Will for Bram Ostler.');

    (record.querySelector('[data-record="note"]') as HTMLElement).click();
    await page.stable(20);
    await page.stable(20);
    expect(page.router.url).toBe('/matters/m-ostler/notes');
    expect(document.activeElement).toBe(page.body.querySelector('mt-matter-notes .composer textarea'));
  });

  it('logs time on the chosen matter in quick entry', async () => {
    const page = await openPhone('/record');
    const record = page.body.querySelector('mt-record-page') as HTMLElement;
    await page.click('M-2026-0142', record);
    (record.querySelector('[data-record="time"]') as HTMLElement).click();
    const dialog = await vi.waitFor(() => page.dialog() ?? Promise.reject(new Error('No dialog yet')));
    await page.stable(20);
    expect(page.text(dialog.querySelector('h2'))).toBe('Log time');
    expect(texts(page, '.picked > span', dialog)).toEqual(['M-2026-0142', 'Estate of Margaret Whitfield']);
  });

  it('asks which matter a note is for when none is chosen', async () => {
    const page = await openPhone('/record');
    (page.body.querySelector('[data-record="note"]') as HTMLElement).click();
    const dialog = await vi.waitFor(() => page.dialog() ?? Promise.reject(new Error('No dialog yet')));
    await page.stable(20);
    expect(page.text(dialog.querySelector('h2'))).toBe('Add a note');
  });

  it('has nothing to record for a read-only role', async () => {
    const page = await openPhone('/record', { session: READONLY });
    expect(page.body.querySelector('[data-record]')).toBeNull();
    expect(page.text(page.body.querySelector('mt-record-page mt-empty-state'))).toContain('Nothing to record here');
  });
});

describe('Matters on a phone (MOB-02)', () => {
  it('leads with search, then my recent matters, then the view, without the filter bar or table', async () => {
    const page = await openPhone('/matters');
    const list = page.body.querySelector('mt-phone-matters') as HTMLElement;
    expect(list).not.toBeNull();
    expect(page.body.querySelector('mt-matters-page mt-table, .mt-matters-bar')).toBeNull();
    expect(list.querySelector('input[aria-label="Search matters"]')).not.toBeNull();
    expect(texts(page, '[data-recent] .tt', list)).toEqual(['Will for Bram Ostler', 'Estate of Margaret Whitfield']);
    expect(page.text(list.querySelector('#phone-matters-view'))).toBe('My open matters');
    expect(texts(page, '[data-matter] .ts', list).sort()).toEqual(['M-2026-0142', 'M-2026-0150']);
    expect(list.querySelector('[data-matter]')?.getAttribute('href')).toMatch(/^\/matters\/m-/);
    // The desktop's layout switch and export stay off the phone's top bar; New matter stays.
    expect(page.body.querySelector('.mt-topbar mt-segmented-control, .mt-topbar mt-export-button')).toBeNull();
    expect(page.buttons('New matter')[0]?.getAttribute('href')).toBe('/matters/new');
  });

  it('searches every matter by number or name, and opens a result', async () => {
    const page = await openPhone('/matters');
    const list = page.body.querySelector('mt-phone-matters') as HTMLElement;
    await page.fill('Search matters', 'ostler', list);
    await page.stable(300);
    await page.stable(20);
    expect(page.body.querySelector('[data-recent]')).toBeNull();
    expect(texts(page, '[data-result] .tt', list)).toEqual(['Will for Bram Ostler']);
    expect(page.text(list.querySelector('[role="status"]'))).toBe('1 matter found.');

    await page.fill('Search matters', 'nobody-here', list);
    await page.stable(300);
    await page.stable(20);
    expect(page.text(list.querySelector('mt-empty-state'))).toContain('No matters match');

    await page.fill('Search matters', 'ostler', list);
    await page.stable(300);
    await page.stable(20);
    (list.querySelector('[data-result]') as HTMLElement).click();
    await page.stable(20);
    await page.stable(20);
    expect(page.router.url).toBe('/matters/m-ostler/overview');
  });

  it('keeps the table on bigger screens', async () => {
    asPhone(false);
    const page = await openMatter('/matters', { configure: practice });
    await page.stable(20);
    expect(page.body.querySelector('mt-phone-matters')).toBeNull();
    expect(page.body.querySelector('mt-matters-page mt-table')).not.toBeNull();
  });
});

describe('A matter on a phone (MOB-02)', () => {
  const withNotes = (fs: InMemoryFirestore) => {
    fs.set(
      `${MATTER}/notes/n-1`,
      noteDoc('Called **Avery** about the will.', { createdAt: new Date('2026-10-03T00:00:00Z') }),
    );
    fs.set(`${MATTER}/documents/doc-1`, storedDocument('doc-1', 'Will of Margaret Whitfield.pdf'));
  };

  it('shows one scroll with quick actions and folding sections instead of the tabs', async () => {
    const page = await openPhone('/matters/m-whitfield/overview', { configure: withNotes });
    const phone = page.body.querySelector('mt-phone-matter') as HTMLElement;
    expect(phone).not.toBeNull();
    expect(page.body.querySelector('nav[mttabnav]')).toBeNull();
    expect(page.body.querySelector('mt-matter-overview')).toBeNull();

    const call = phone.querySelector<HTMLAnchorElement>('[data-act="call"]');
    expect(call?.getAttribute('href')).toBe('tel:+61412345678');
    expect(call?.getAttribute('aria-label')).toBe('Call Avery Quill, client');
    expect(texts(page, '.acts .act', phone)).toEqual(['Call client', 'Log time', 'Add note']);
    expect(phone.querySelector('[data-act="note"]')?.getAttribute('href')).toBe(
      '/matters/m-whitfield/notes?do=add-note',
    );

    const sections = [...phone.querySelectorAll<HTMLDetailsElement>('details[data-section]')];
    expect(sections.map((section) => [section.dataset['section'], section.open])).toEqual([
      ['facts', true],
      ['deadlines', true],
      ['tasks', true],
      ['documents', false],
      ['notes', false],
    ]);
    const section = (name: string) => phone.querySelector(`[data-section="${name}"]`) as HTMLElement;
    expect(page.text(section('deadlines'))).toContain('Advertise notice of intended application');
    expect(page.text(section('tasks'))).toContain('Order the death certificate');
    expect(page.text(section('documents'))).toContain('Will of Margaret Whitfield.pdf');
    expect(page.text(section('notes'))).toContain('Called Avery about the will.');
    expect(section('documents').querySelector('a.all')?.getAttribute('href')).toBe('/matters/m-whitfield/documents');
    expect(phone.querySelector('[data-tab="parties"]')?.getAttribute('href')).toBe('/matters/m-whitfield/parties');
    expect(phone.querySelector('[data-tab="overview"]')).toBeNull();
  });

  it('opens with the matter’s brief, without “Ask a follow-up” (no Clerk panel on a phone)', async () => {
    const page = await openPhone('/matters/m-whitfield/overview', {
      flags: { 'clerk.enabled': true, 'clerk.features.matterBrief': true, 'clerk.features.chat': true },
    });
    const phone = page.body.querySelector('mt-phone-matter') as HTMLElement;
    const brief = await vi.waitFor(
      () => phone.querySelector<HTMLElement>('[data-testid="matter-brief"]') ?? Promise.reject(new Error('No brief')),
    );
    await page.stable(20);
    expect(brief.getAttribute('aria-label')).toBe('Matter brief');
    // After the quick actions, before Key facts.
    const facts = phone.querySelector('[data-section="facts"]') as HTMLElement;
    const acts = phone.querySelector('.acts') as HTMLElement;
    expect(acts.compareDocumentPosition(brief) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(brief.compareDocumentPosition(facts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(page.buttons('Refresh', brief)).toHaveLength(1);
    expect(page.buttons('Ask a follow-up')).toHaveLength(0);
  });

  it('names the matter in the top bar and folds its header to fit a phone', async () => {
    const page = await openPhone('/matters/m-whitfield/overview');
    // The Overview is the matter itself: its number, and back to Matters.
    const title = page.body.querySelector('.mt-topbar-title');
    expect(page.text(title)).toBe('M-2026-0142');
    expect(title?.classList.contains('mono')).toBe(true);
    const back = page.body.querySelector<HTMLAnchorElement>('.mt-topbar [data-back]');
    expect(back?.getAttribute('href')).toBe('/matters');

    const head = page.body.querySelector('mt-matter-header') as HTMLElement;
    // The top bar has the timer; the people and labels fold under who's responsible.
    expect(head.querySelector('[iconstart="timer"]')).toBeNull();
    const details = head.querySelector<HTMLDetailsElement>('details.people-more');
    expect(details?.open).toBe(false);
    expect(page.text(details?.querySelector('summary') ?? null)).toMatch(/^Details\s/);
    expect(details?.querySelector('[aria-label="Change responsible lawyer"]')).not.toBeNull();

    // The stages are a track and a menu: six labels don't fit side by side.
    const stages = page.body.querySelector('mt-estate-stepper') as HTMLElement;
    expect(stages.querySelector('.mt-stepper')).toBeNull();
    expect(page.text(stages.querySelector('.mt-stepper-now'))).toMatch(/^Stage 1 of \d+ · /);
  });

  it('opens the matter’s actions in a sheet: call or email the client, add a note', async () => {
    const page = await openPhone('/matters/m-whitfield/overview');
    const sheet = await openActions(page);
    expect(page.text(sheet.querySelector('h2'))).toBe('M-2026-0142');
    expect(sheet.querySelector('[data-action="call"]')?.getAttribute('href')).toBe('tel:+61412345678');
    expect(texts(page, '[data-action="call"] :is(.tt, .ts)', sheet)).toEqual([
      'Call Avery Quill',
      'Client · 0412 345 678',
    ]);
    expect(sheet.querySelector('[data-action="email"]')?.getAttribute('href')).toBe('mailto:avery.quill@example.test');
    (sheet.querySelector('[data-action="note"]') as HTMLElement).click();
    await page.stable(20);
    await page.stable(20);
    expect(page.router.url).toBe('/matters/m-whitfield/notes');
  });

  it('offers no call without a number, and nothing to write for a read-only role', async () => {
    const page = await openPhone('/matters/m-whitfield/overview', {
      session: READONLY,
      configure: (fs) => fs.set(`orgs/${ORG}/contacts/c-avery`, contactDoc('Avery', 'Quill')),
    });
    expect(page.body.querySelector('mt-phone-matter .acts')).toBeNull();
    const sheet = await openActions(page);
    expect(sheet.querySelector('[data-action]')).toBeNull();
    expect(page.text(sheet)).toContain('No phone number or email for the client on this matter yet.');
  });

  it('keeps the tabs on a matter’s other pages', async () => {
    const page = await openPhone('/matters/m-whitfield/tasks');
    expect(page.body.querySelector('mt-phone-matter')).toBeNull();
    expect(page.body.querySelector('nav[mttabnav]')).not.toBeNull();
  });
});
