import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { TENANCY_PORT } from '@materia/data-access';
import { InMemoryFirestore, provideInMemoryFirestore } from '@materia/data-access/repository';
import {
  DomainError,
  contactDedupeKey,
  contactDisplayName,
  contactSearchTokens,
  type Contact,
  type ContactActivityLine,
  type ContactActivityResult,
} from '@materia/domain';
import { MT_KEYBOARD_PLATFORM } from '@materia/ui';

import {
  appendLines,
  CONTACT_ACTIVITY_SETTLE_MS,
  contactActivityItem,
  contactActivitySummary,
} from './contact-activity';
import { refusingReferences } from './contact-delete-dialog';
import { clearedFields, contactFromForm, createContactForm, parseDateInput, phoneGroup } from './contact-form';
import { duplicateReasons } from './contact-form-dialog';
import { mergeErrorCopy } from './contact-merge-dialog';
import { App } from '../../app';
import { appRoutes } from '../../app.routes';
import { AUTH_PORT, type AuthSession } from '../../core/auth/auth-port';
import { FakeAuthPort, testSession } from '../../core/auth/testing';
import { provideTestFlags } from '../../core/flags/testing';
import { FakeTenancyPort } from '../../core/orgs/testing';

/** Contacts screen (CORE-01) against the in-memory Firestore and a fake callable transport. Fictional people only. */

const ORG = 'org-harbour-vine';
const CONTACTS = `orgs/${ORG}/contacts`;
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const LAWYER = testSession();
const OWNER = testSession({ claims: { orgId: ORG, role: 'owner', orgName: 'Harbour & Vine Legal' } });
const READONLY = testSession({ claims: { orgId: ORG, role: 'readonly', orgName: 'Harbour & Vine Legal' } });

type Seed = Record<string, unknown>;

/** A stored contact as the server would keep it: search tokens, dedupe key and sortName. */
function contactDoc(data: Seed): Record<string, unknown> {
  const contact = {
    kind: 'person' as const,
    emails: [],
    phones: [],
    addresses: [],
    tags: [],
    isReferrer: false,
    ...data,
  };
  return {
    ...contact,
    search: contactSearchTokens(contact as Partial<Contact>),
    dedupeKey: contactDedupeKey(contact as Partial<Contact>),
    sortName: contactDisplayName(contact as Partial<Contact>).toLowerCase(),
    createdAt: new Date('2026-09-01T00:00:00Z'),
    createdBy: 'user-jordan',
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    updatedBy: 'user-jordan',
    schemaVersion: 1,
  };
}

function seedPeople(fs: InMemoryFirestore): void {
  fs.set(
    `${CONTACTS}/c-avery`,
    contactDoc({
      givenNames: 'Avery',
      familyName: 'Quill',
      dateOfBirth: '1961-03-04',
      phones: [{ type: 'mobile', number: '+61412345678' }],
      emails: [{ type: 'personal', address: 'avery.quill@example.test' }],
      addresses: [
        {
          type: 'residential',
          line1: '9 Fictional St',
          suburb: 'Geelong',
          state: 'VIC',
          postcode: '3220',
          country: 'AU',
        },
      ],
      tags: ['client'],
      notes: 'Prefers calls after 3 pm.',
    }),
  );
  fs.set(`${CONTACTS}/c-bram`, contactDoc({ givenNames: 'Bram', familyName: 'Ostler', tags: ['executor'] }));
  fs.set(
    `${CONTACTS}/c-coastal`,
    contactDoc({ kind: 'organisation', orgName: 'Coastal Fictional Accounting', abn: '12345678901', isReferrer: true }),
  );
  fs.set(`${CONTACTS}/c-gone`, { ...contactDoc({ givenNames: 'Gone', familyName: 'Merged' }), mergedInto: 'c-avery' });
  fs.set(`${CONTACTS}/c-del`, {
    ...contactDoc({ givenNames: 'Deleted', familyName: 'Person' }),
    deletedAt: new Date(),
  });
}

function seedMatter(fs: InMemoryFirestore): void {
  fs.set(`orgs/${ORG}/matters/m-1`, {
    number: 'WE-0142',
    title: 'Estate of Fictional Quill',
    type: 'probate',
    status: 'open',
  });
  fs.set(`orgs/${ORG}/matters/m-1/parties/p-1`, {
    contactId: 'c-avery',
    role: 'executor',
    orgId: ORG,
    matterId: 'm-1',
  });
  fs.set(`orgs/${ORG}/matters/m-1/parties/p-2`, {
    contactId: 'c-avery',
    role: 'beneficiary',
    share: '50%',
    orgId: ORG,
    matterId: 'm-1',
  });
  // Another org's party for the same id never shows.
  fs.set(`orgs/org-other/matters/m-9/parties/p-9`, {
    contactId: 'c-avery',
    role: 'client',
    orgId: 'org-other',
    matterId: 'm-9',
  });
}

interface Options {
  configure?: (port: FakeAuthPort, firestore: InMemoryFirestore) => void;
  /** Answers `contacts-activity` (CORE-01a); those calls go to `activityCalls`, not `port.calls`. */
  activity?: (input: { contactId: string; limit: number; cursor?: string }) => Promise<ContactActivityResult>;
}

async function open(url: string, session: AuthSession, options: Options = {}) {
  const port = new FakeAuthPort(session);
  const firestore = new InMemoryFirestore();
  options.configure?.(port, firestore);
  const activityCalls: unknown[] = [];
  const call = port.call.bind(port);
  port.call = async <T>(name: string, data: unknown): Promise<T> => {
    if (name !== 'contacts-activity') return call<T>(name, data);
    activityCalls.push(data);
    const answer = options.activity ?? (async () => ({ lines: [], nextCursor: null }));
    return (await answer(data as { contactId: string; limit: number })) as T;
  };
  TestBed.configureTestingModule({
    imports: [App],
    providers: [
      provideRouter(appRoutes),
      { provide: MT_KEYBOARD_PLATFORM, useValue: 'other' },
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
  const scope = () => dialog() ?? body;
  const field = (label: string, index = 0) => {
    const hosts = [...scope().querySelectorAll('mt-text-field, mt-select, mt-textarea, mt-search-field')].filter(
      (f) =>
        f.querySelector('label, .mt-label')?.textContent?.trim().startsWith(label) ||
        f.querySelector('input')?.getAttribute('aria-label') === label,
    );
    const control = hosts[index]?.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      'input, select, textarea',
    );
    if (!control) throw new Error(`No field "${label}"`);
    return control;
  };
  const type = async (label: string, value: string, index = 0) => {
    const control = field(label, index) as HTMLInputElement;
    control.value = value;
    control.dispatchEvent(new Event('input'));
    control.dispatchEvent(new Event('blur'));
    await stable();
  };
  const choose = async (label: string, optionText: string) => {
    const select = field(label) as HTMLSelectElement;
    const option = [...select.options].find((o) => o.textContent?.trim() === optionText);
    if (!option) throw new Error(`No option "${optionText}" in ${label}`);
    select.value = option.value;
    select.dispatchEvent(new Event('change'));
    await stable();
  };
  const buttons = (text: string, root: ParentNode = body) =>
    [...root.querySelectorAll<HTMLElement>('button, a')].filter((b) => b.textContent?.trim().startsWith(text));
  const button = (text: string, root: ParentNode = scope()) => {
    const found = buttons(text, root)[0];
    if (!found) throw new Error(`No button "${text}"`);
    return found;
  };
  const click = async (text: string, root?: ParentNode) => {
    button(text, root).click();
    await stable();
  };
  const press = async (key: string, target: EventTarget = body) => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    await stable();
  };
  const submit = async () => {
    scope().querySelector('form')?.dispatchEvent(new Event('submit'));
    await stable();
  };
  const listNames = () =>
    [...body.querySelectorAll('mt-table tbody tr[data-index] .mt-contacts-name')].map((n) => n.textContent?.trim());
  const detail = () => body.querySelector('mt-contact-detail')?.textContent?.replace(/\s+/g, ' ') ?? '';
  return {
    port,
    activityCalls,
    firestore,
    router,
    body,
    dialog,
    stable,
    field,
    type,
    choose,
    buttons,
    button,
    click,
    press,
    submit,
    listNames,
    detail,
    selected: () => new URL(router.url, 'http://x').searchParams.get('contact'),
    text: () => body.textContent?.replace(/\s+/g, ' ') ?? '',
  };
}

afterEach(() => {
  document.querySelectorAll('.mt-overlay, .mt-toast-region').forEach((node) => node.remove());
});

describe('contacts list', () => {
  it('lists contacts by name, hides merged and deleted ones, and opens the first', async () => {
    const page = await open('/contacts', LAWYER, { configure: (_p, fs) => seedPeople(fs) });
    expect(page.listNames()).toEqual(['Avery Quill', 'Bram Ostler', 'Coastal Fictional Accounting']);
    expect(page.text()).not.toContain('Gone Merged');
    expect(page.text()).not.toContain('Deleted Person');
    expect(page.selected()).toBe('c-avery');
    // One h1 (Contacts); the open contact's name is an h2 and its sections h3 (SEC-06b).
    expect(page.body.querySelector('mt-person-header h2')?.textContent).toContain('Avery Quill');
    expect([...page.body.querySelectorAll('h1')].map((h) => h.textContent?.trim())).toEqual(['Contacts']);
    expect(page.body.querySelector('mt-contact-detail h3')?.textContent?.trim()).toBe('Details');
  });

  it('shows the loading, empty, error and offline states', async () => {
    const loading = await open('/contacts', LAWYER, {
      configure: (_p, fs) => {
        fs.stalled = true;
      },
    });
    expect(loading.text()).toContain('Loading contacts…');
    TestBed.resetTestingModule();

    const empty = await open('/contacts', LAWYER);
    expect(empty.text()).toContain('No contacts yet');
    expect(empty.buttons('New contact').length).toBeGreaterThan(0);
    TestBed.resetTestingModule();

    const failing = await open('/contacts', LAWYER, {
      configure: (_p, fs) => {
        seedPeople(fs);
        fs.failNext({ code: 'unavailable' }, 'contacts');
      },
    });
    expect(failing.text()).toContain('This service is temporarily unavailable');
    await failing.click('Try again');
    expect(failing.listNames()).toContain('Avery Quill');
    TestBed.resetTestingModule();

    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      const offline = await open('/contacts', LAWYER, {
        configure: (_p, fs) => {
          seedPeople(fs);
          fs.offline = true;
        },
      });
      expect(offline.text()).toContain('You’re offline. These are your contacts as they were');
      expect(offline.listNames()).toContain('Avery Quill');
    } finally {
      onLine.mockRestore();
    }
  });

  it('searches by name and filters by kind, tag and referrer', async () => {
    const page = await open('/contacts', LAWYER, { configure: (_p, fs) => seedPeople(fs) });
    await page.type('Search contacts', 'ostl');
    await page.stable(250);
    expect(page.listNames()).toEqual(['Bram Ostler']);
    await page.type('Search contacts', 'avery zz');
    await page.stable(250);
    expect(page.listNames()).toEqual([]);
    expect(page.text()).toContain('No contacts match');
    await page.type('Search contacts', '');
    await page.stable(250);

    const chip = async (text: string) => {
      page.buttons(text)[0]?.click();
      await page.stable();
    };
    await chip('Organisations');
    expect(page.listNames()).toEqual(['Coastal Fictional Accounting']);
    await chip('All');
    await page.choose('Tag', 'executor');
    expect(page.listNames()).toEqual(['Bram Ostler']);
    await page.choose('Tag', 'Any tag');
    await chip('Referrers');
    expect(page.listNames()).toEqual(['Coastal Fictional Accounting']);
  });

  it('filters by role in matters, showing the roles held (CORE-01a)', async () => {
    const page = await open('/contacts', LAWYER, {
      configure: (_p, fs) => {
        seedPeople(fs);
        fs.set(`${CONTACTS}/c-avery`, {
          ...(fs.get(`${CONTACTS}/c-avery`) as Seed),
          matterRoles: ['executor', 'beneficiary'],
        });
        fs.set(`${CONTACTS}/c-bram`, { ...(fs.get(`${CONTACTS}/c-bram`) as Seed), matterRoles: ['beneficiary'] });
      },
    });
    const roles = [...(page.field('Role in matters') as HTMLSelectElement).options].map((o) => o.textContent?.trim());
    expect(roles.slice(1, 5)).toEqual(['Any role', 'Client', 'Testator', 'Deceased']);
    await page.choose('Role in matters', 'Executor');
    expect(page.listNames()).toEqual(['Avery Quill']);
    expect(page.body.querySelector('.mt-contacts-caption')?.textContent?.trim()).toBe('Executor, Beneficiary');
    await page.choose('Role in matters', 'Beneficiary');
    expect(page.listNames()).toEqual(['Avery Quill', 'Bram Ostler']);
    await page.choose('Role in matters', 'Trustee');
    expect(page.text()).toContain('No contacts match');
    await page.choose('Role in matters', 'Any role');
    expect(page.listNames()).toHaveLength(3);
  });

  it('moves with j and k, focuses search with /, and creates with c', async () => {
    const page = await open('/contacts', LAWYER, { configure: (_p, fs) => seedPeople(fs) });
    expect(page.selected()).toBe('c-avery');
    await page.press('j');
    expect(page.selected()).toBe('c-bram');
    await page.press('j');
    expect(page.selected()).toBe('c-coastal');
    await page.press('j');
    expect(page.selected()).toBe('c-coastal');
    await page.press('k', page.body);
    expect(page.selected()).toBe('c-bram');
    expect(page.detail()).toContain('Bram Ostler');

    await page.press('/');
    expect(document.activeElement).toBe(page.field('Search contacts'));
    // Typing in the search box doesn't trigger shortcuts.
    await page.press('c', page.field('Search contacts'));
    expect(page.dialog()).toBeNull();

    await page.press('c');
    expect(page.dialog()?.textContent).toContain('New contact');
  });
});

describe('contact detail', () => {
  it('shows details, formatted phones, and the matters with roles from the parties collection group', async () => {
    const page = await open('/contacts?contact=c-avery', LAWYER, {
      configure: (_p, fs) => {
        seedPeople(fs);
        seedMatter(fs);
      },
    });
    const detail = page.detail();
    expect(detail).toContain('0412 345 678');
    expect(detail).toContain('avery.quill@example.test');
    expect(detail).toContain('9 Fictional St, Geelong VIC 3220');
    expect(detail).toContain('4 Mar 1961');
    expect(detail).toContain('Prefers calls after 3 pm.');
    expect(detail).toContain('Estate of Fictional Quill');
    expect(detail).toContain('Executor, Beneficiary 50%');
    expect(detail).not.toContain('Client');
    const roles = [...page.body.querySelectorAll('mt-person-header .mt-role')].map((r) =>
      r.textContent?.replace(/\s+/g, ' ').trim(),
    );
    expect(roles).toEqual(['Executor WE-0142', 'Beneficiary 50% WE-0142']);
    expect(page.body.querySelector('a[href="/matters/m-1"]')).not.toBeNull();
  });

  it('lists the contact’s activity from contacts-activity, with matter links, and pages (CORE-01a)', async () => {
    const line = (id: string, extra: Partial<ContactActivityLine>): ContactActivityLine => ({
      id,
      at: '2026-10-05T01:00:00.000Z',
      actorUid: 'user-jordan',
      kind: 'created',
      ...extra,
    });
    const pages: Record<string, ContactActivityResult> = {
      first: {
        lines: [
          line('l-1', {
            kind: 'party_added',
            role: 'executor',
            matter: { id: 'm-1', number: 'WE-0142', title: 'Estate of Fictional Quill' },
          }),
          line('l-2', { kind: 'updated', fields: ['phones', 'emails'], actorUid: 'user-gone' }),
        ],
        nextCursor: 'cursor-2',
      },
      second: {
        // l-2 again (an event across the page break) shows once.
        lines: [line('l-2', { kind: 'updated', fields: ['phones'] }), line('l-3', { at: '2026-08-03T00:00:00.000Z' })],
        nextCursor: null,
      },
    };
    const page = await open('/contacts?contact=c-avery', LAWYER, {
      configure: (_port, fs) => {
        seedPeople(fs);
        seedMatter(fs);
        fs.set(`orgs/${ORG}/members/user-jordan`, {
          displayName: 'Jordan Price',
          email: 'lawyer@harbourvine.example',
          role: 'lawyer',
          status: 'active',
        });
      },
      activity: async (input) => (input.cursor ? pages['second'] : pages['first']) as ContactActivityResult,
    });
    const items = () =>
      [...page.body.querySelectorAll('[data-testid="contact-activity"] li')].map((li) =>
        [...li.children].map((part) => part.textContent?.replace(/\s+/g, ' ').trim()).join(' '),
      );
    expect(page.activityCalls).toEqual([{ contactId: 'c-avery', limit: 20 }]);
    expect(items()).toEqual([
      'Jordan Price added this contact as executor on WE-0142 Estate of Fictional Quill 5 Oct 2026',
      'Former member updated the phone and email 5 Oct 2026',
    ]);
    expect(
      page.body.querySelector('[data-testid="contact-activity"] a[href="/matters/m-1"]')?.textContent?.trim(),
    ).toBe('WE-0142 Estate of Fictional Quill');
    await page.click('Show older activity');
    expect(page.activityCalls.at(-1)).toEqual({ contactId: 'c-avery', limit: 20, cursor: 'cursor-2' });
    expect(items()).toHaveLength(3);
    expect(items()[2]).toBe('Jordan Price added the contact 3 Aug 2026');
    expect(page.buttons('Show older activity')).toHaveLength(0);
  });

  it('looks at the activity again shortly after the contact’s matters change (CORE-01a)', async () => {
    const page = await open('/contacts?contact=c-avery', LAWYER, {
      configure: (_port, fs) => {
        seedPeople(fs);
        seedMatter(fs);
      },
    });
    expect(page.activityCalls).toHaveLength(1);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // A party added elsewhere: its audit entry lands just after, so the list looks twice.
      page.firestore.set(`orgs/${ORG}/matters/m-1/parties/p-3`, {
        contactId: 'c-avery',
        role: 'trustee',
        orgId: ORG,
        matterId: 'm-1',
      });
      await vi.advanceTimersByTimeAsync(CONTACT_ACTIVITY_SETTLE_MS[0]);
      expect(page.activityCalls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(CONTACT_ACTIVITY_SETTLE_MS[1] - CONTACT_ACTIVITY_SETTLE_MS[0]);
      expect(page.activityCalls).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(page.activityCalls).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says so when the activity can’t load, and tries again', async () => {
    let fail = true;
    const page = await open('/contacts?contact=c-avery', LAWYER, {
      configure: (_port, fs) => seedPeople(fs),
      activity: async () => {
        if (fail) throw new DomainError('UNAVAILABLE', 'down');
        return { lines: [], nextCursor: null };
      },
    });
    expect(page.detail()).toContain('This service is temporarily unavailable');
    fail = false;
    await page.click('Try again', page.body.querySelector('mt-contact-activity') as ParentNode);
    expect(page.detail()).toContain('No activity yet.');
  });

  it('shows an organisation with its ABN and referrer badge', async () => {
    const page = await open('/contacts?contact=c-coastal', LAWYER, { configure: (_p, fs) => seedPeople(fs) });
    expect(page.detail()).toContain('Organisation · ABN 12 345 678 901');
    expect(page.detail()).toContain('Referrer');
    expect(page.detail()).toContain('Not on any matters yet.');
    expect(page.detail()).toContain('No referred matters yet.');
  });

  it('lists the matters a referrer referred, newest first, with totals (CORE-18)', async () => {
    const referred = (id: string, extra: Seed) => ({
      number: `WE-${id}`,
      type: 'will',
      status: 'open',
      privileged: false,
      referrerContactId: 'c-coastal',
      deletedAt: null,
      ...extra,
    });
    const budget = (billedCents: number) => ({ recordedCents: billedCents + 22000, billedCents });
    const seed = (fs: InMemoryFirestore) => {
      seedPeople(fs);
      fs.set(
        `orgs/${ORG}/matters/m-r1`,
        referred('0101', {
          title: 'Will of Fictional Ash',
          createdAt: new Date('2026-03-02T00:00:00Z'),
          budget: budget(44000),
        }),
      );
      fs.set(
        `orgs/${ORG}/matters/m-r2`,
        referred('0102', {
          title: 'Estate of Fictional Birch',
          type: 'probate',
          status: 'closed',
          createdAt: new Date('2026-08-20T00:00:00Z'),
          budget: budget(385000),
        }),
      );
      fs.set(
        `orgs/${ORG}/matters/m-r3`,
        referred('0103', { title: 'Hidden privileged matter', privileged: true, budget: budget(110000) }),
      );
      fs.set(
        `orgs/${ORG}/matters/m-r4`,
        referred('0104', { title: 'Deleted referral', deletedAt: new Date(), budget: budget(99900) }),
      );
      fs.set(`orgs/${ORG}/matters/m-x`, referred('0105', { title: 'Someone else’s', referrerContactId: 'c-bram' }));
    };
    const page = await open('/contacts?contact=c-coastal', READONLY, { configure: (_p, fs) => seed(fs) });
    const section = page.body.querySelector('[data-testid="contact-referrals"]')?.textContent?.replace(/\s+/g, ' ');
    expect(section).toContain('Referrals 2');
    // Without billing.view, nothing about what was billed.
    expect(section).toContain('2 matters referred · 1 active · last on 20 Aug 2026');
    expect(section).not.toContain('billed');
    expect(section).toContain('Will · Open · Opened 2 Mar 2026');
    expect(section).toContain('Probate · Closed · Opened 20 Aug 2026');
    expect(section).not.toContain('Hidden privileged matter');
    expect(section).not.toContain('Deleted referral');
    expect(section).not.toContain('Someone else’s');
    const titles = [...page.body.querySelectorAll('[data-testid="contact-referrals"] a.label')].map((a) =>
      a.textContent?.trim(),
    );
    expect(titles).toEqual(['Estate of Fictional Birch', 'Will of Fictional Ash']);
    TestBed.resetTestingModule();

    // A lawyer (privileged.view, billing.view) sees the privileged one too, and what was billed on all
    // three; a contact who isn't a referrer has no section.
    const lawyer = await open('/contacts?contact=c-coastal', LAWYER, { configure: (_p, fs) => seed(fs) });
    expect(lawyer.detail()).toContain('Hidden privileged matter');
    expect(lawyer.body.querySelector('[data-testid="referral-totals"]')?.textContent?.trim()).toBe(
      '3 matters referred · 2 active · $5,390.00 billed · last on 20 Aug 2026',
    );
    await lawyer.router.navigateByUrl('/contacts?contact=c-avery');
    await lawyer.stable();
    expect(lawyer.body.querySelector('[data-testid="contact-referrals"]')).toBeNull();
  });
});

describe('referrers (CORE-18)', () => {
  const seedReferrers = (fs: InMemoryFirestore) => {
    seedPeople(fs);
    fs.set(
      `${CONTACTS}/c-planner`,
      contactDoc({
        givenNames: 'Dana',
        familyName: 'Wren',
        isReferrer: true,
        referrerMeta: { company: 'Fictional Wealth Partners', industry: 'financial_planner' },
      }),
    );
    fs.set(
      `${CONTACTS}/c-funeral`,
      contactDoc({
        kind: 'organisation',
        orgName: 'Quiet Fictional Funerals',
        isReferrer: true,
        referrerMeta: { industry: 'funeral_director' },
      }),
    );
    fs.set(`orgs/${ORG}`, {
      name: 'Harbour & Vine Legal',
      settings: { clerk: { model: 'claude-sonnet-5-5', enabled: true } },
    });
  };

  it('filters referrers by industry and shows their industry and company', async () => {
    const page = await open('/contacts', LAWYER, { configure: (_p, fs) => seedReferrers(fs) });
    page.buttons('Referrers')[0]?.click();
    await page.stable();
    expect(page.listNames()).toEqual(['Coastal Fictional Accounting', 'Dana Wren', 'Quiet Fictional Funerals']);
    expect(page.text()).toContain('Financial planner · Fictional Wealth Partners');
    await page.choose('Industry', 'Funeral director');
    expect(page.listNames()).toEqual(['Quiet Fictional Funerals']);
    await page.choose('Industry', 'Any industry');
    expect(page.listNames()).toHaveLength(3);
    // A lawyer can't change the org's setting.
    expect(page.text()).not.toContain('Thank-you task for referrers');
  });

  it('lets an owner turn the thank-you task on, keeping the other settings', async () => {
    const page = await open('/contacts', OWNER, { configure: (_p, fs) => seedReferrers(fs) });
    page.buttons('Referrers')[0]?.click();
    await page.stable();
    const toggle = page.body.querySelector<HTMLInputElement>(
      'mt-referral-settings input[type="checkbox"], mt-referral-settings [role="switch"]',
    );
    expect(toggle).not.toBeNull();
    toggle?.click();
    await page.stable();
    expect(page.firestore.get(`orgs/${ORG}`)?.['settings']).toMatchObject({
      clerk: { model: 'claude-sonnet-5-5', enabled: true },
      referrals: { thankYouTask: true },
    });
  });
});

describe('create', () => {
  const fillPerson = async (page: Awaited<ReturnType<typeof open>>) => {
    await page.type('Given names', 'Avery');
    await page.type('Family name', 'Quil');
    await page.click('Add phone');
    await page.type('Phone', '0412 345 678');
  };

  it('offers a likely duplicate, and "Use existing" selects it without creating', async () => {
    const page = await open('/contacts?contact=c-bram', LAWYER, {
      configure: (port, fs) => {
        seedPeople(fs);
        port.callResults['contacts-findDuplicates'] = {
          matches: [
            {
              contactId: 'c-avery',
              displayName: 'Avery Quill',
              score: 0.92,
              reasons: ['name', 'phone'],
              dateOfBirth: '1961-03-04',
              phone: '+61412345678',
            },
          ],
        };
      },
    });
    await page.click('New contact');
    await fillPerson(page);
    await page.submit();
    expect(page.port.calls.at(-1)).toEqual({
      name: 'contacts-findDuplicates',
      data: { kind: 'person', givenNames: 'Avery', familyName: 'Quil', emails: [], phones: ['+61412345678'] },
    });
    const dialogText = page.dialog()?.textContent ?? '';
    expect(dialogText).toContain('This might be someone you already have.');
    expect(dialogText).toContain('Similar name, same phone');
    expect(dialogText).toContain('Born 4 Mar 1961 · 0412 345 678');
    await page.click('Use existing');
    expect(page.dialog()).toBeNull();
    expect(page.selected()).toBe('c-avery');
    expect(page.port.calls.map((c) => c.name)).not.toContain('contacts-create');
  });

  it('"Create anyway" creates through contacts-create with a request id, and opens the new contact', async () => {
    const page = await open('/contacts', LAWYER, {
      configure: (port, fs) => {
        seedPeople(fs);
        port.call = async <T>(name: string, data: unknown): Promise<T> => {
          port.calls.push({ name, data });
          if (name === 'contacts-findDuplicates') {
            return {
              matches: [{ contactId: 'c-avery', displayName: 'Avery Quill', score: 0.8, reasons: ['name'] }],
            } as T;
          }
          const { contact } = data as { contact: Seed };
          fs.set(`${CONTACTS}/c-new`, contactDoc(contact));
          return { contactId: 'c-new' } as T;
        };
      },
    });
    await page.click('New contact');
    await fillPerson(page);
    await page.click('Add address');
    await page.type('Address line 1', '1 Example Rd');
    await page.type('Suburb', 'Torquay');
    await page.type('Postcode', '3228');
    await page.type('Tags', 'client, executor, client');
    await page.submit();
    await page.click('Create anyway');
    const create = page.port.calls.at(-1);
    expect(create?.name).toBe('contacts-create');
    expect((create?.data as { requestId: string }).requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect((create?.data as { contact: unknown }).contact).toEqual({
      kind: 'person',
      givenNames: 'Avery',
      familyName: 'Quil',
      emails: [],
      phones: [{ type: 'mobile', number: '+61412345678' }],
      addresses: [
        {
          type: 'residential',
          line1: '1 Example Rd',
          suburb: 'Torquay',
          state: 'VIC',
          postcode: '3228',
          country: 'AU',
        },
      ],
      tags: ['client', 'executor'],
      isReferrer: false,
    });
    expect(page.dialog()).toBeNull();
    expect(page.selected()).toBe('c-new');
    expect(page.text()).toContain('Contact created');
  });

  it('creates without a prompt when nothing matches; a mononym is enough; organisations need a name', async () => {
    const page = await open('/contacts', LAWYER, {
      configure: (port, fs) => {
        seedPeople(fs);
        port.callResults['contacts-findDuplicates'] = { matches: [] };
        port.callResults['contacts-create'] = { contactId: 'c-new' };
      },
    });
    await page.click('New contact');
    await page.submit();
    expect(page.dialog()?.textContent).toContain('Enter a given name or a family name');
    expect(page.port.calls).toEqual([]);
    await page.type('Given names', 'Teuila');
    await page.submit();
    expect(page.port.calls.map((c) => c.name)).toEqual(['contacts-findDuplicates', 'contacts-create']);
    expect(page.port.calls[1]?.data).toMatchObject({ contact: { kind: 'person', givenNames: 'Teuila' } });

    await page.click('New contact');
    await page.click('Organisation');
    await page.type('ABN', '123');
    await page.submit();
    const text = page.dialog()?.textContent ?? '';
    expect(text).toContain('Enter the organisation’s name.');
    expect(text).toContain('An ABN is 11 digits.');
  });

  it('marks the fields a refused create names (INVALID_ARGUMENT details.fields)', async () => {
    const page = await open('/contacts', LAWYER, {
      configure: (port, fs) => {
        seedPeople(fs);
        port.call = async <T>(name: string, data: unknown): Promise<T> => {
          port.calls.push({ name, data });
          if (name === 'contacts-findDuplicates') return { matches: [] } as T;
          throw {
            code: 'functions/invalid-argument',
            details: {
              code: 'INVALID_ARGUMENT',
              fields: { 'contact.familyName': ['Required'], 'contact.phones.0.number': ['Invalid'] },
            },
          };
        };
      },
    });
    await page.click('New contact');
    await page.type('Given names', 'Teuila');
    await page.click('Add phone');
    await page.type('Phone', '0412 345 678');
    await page.submit();
    const text = page.dialog()?.textContent ?? '';
    expect(text).toContain('Some details need fixing. Check the highlighted fields.');
    expect(text).toContain('Check this field; it wasn’t accepted.');
    expect(text).toContain('Enter a valid phone number');
  });

  it('shows inline errors for an invalid phone, a postcode outside the state and a bad date', async () => {
    const page = await open('/contacts', LAWYER, { configure: (_p, fs) => seedPeople(fs) });
    await page.click('New contact');
    await page.type('Given names', 'Avery');
    await page.click('Add phone');
    await page.type('Phone', '12');
    await page.click('Add address');
    await page.type('Address line 1', '1 Example Rd');
    await page.type('Suburb', 'Bondi');
    await page.type('Postcode', '2026');
    await page.type('Date of birth', '31/02/1990');
    await page.submit();
    const text = page.dialog()?.textContent ?? '';
    expect(text).toContain('Enter a valid phone number');
    expect(text).toContain('That postcode isn’t in the state you picked.');
    expect(text).toContain('Enter a date like 14/06/1968.');
    expect(page.port.calls).toEqual([]);
    await page.choose('State', 'NSW');
    expect(page.dialog()?.textContent).not.toContain('That postcode isn’t in the state you picked.');
  });
});

describe('edit, delete and merge', () => {
  it('edits client-direct, clearing removed fields and never writing server-owned ones', async () => {
    const page = await open('/contacts?contact=c-avery', LAWYER, { configure: (_p, fs) => seedPeople(fs) });
    await page.click('Edit', page.body.querySelector('mt-contact-detail') ?? undefined);
    expect(page.dialog()?.textContent).toContain('Edit Avery Quill');
    expect(page.field('Phone').value).toBe('+61412345678');
    await page.type('Family name', 'Quillon');
    await page.type('Notes', '');
    await page.submit();
    expect(page.dialog()).toBeNull();
    const write = page.firestore.writes.at(-1);
    expect(write).toMatchObject({ op: 'update', path: `${CONTACTS}/c-avery`, removed: ['notes'] });
    expect(write?.data).toMatchObject({ familyName: 'Quillon', phones: [{ type: 'mobile', number: '+61412345678' }] });
    for (const key of ['search', 'dedupeKey', 'mergedInto', 'sortName']) expect(write?.data).not.toHaveProperty(key);
    expect(page.detail()).toContain('Avery Quillon');
    expect(page.text()).toContain('Changes saved');
  });

  it('confirms a date of death, then shows the deceased banner with a link to open an estate matter', async () => {
    const page = await open('/contacts?contact=c-bram', LAWYER, { configure: (_p, fs) => seedPeople(fs) });
    await page.click('Edit', page.body.querySelector('mt-contact-detail') ?? undefined);
    await page.type('Date of death', '02/10/2026');
    await page.submit();
    const confirm = [...page.body.querySelectorAll('.mt-dialog')].at(-1);
    expect(confirm?.textContent).toContain('Record Bram Ostler as deceased?');
    await page.click('Cancel', confirm);
    // Nothing saved to the contact (opening it may record it in recents).
    expect(page.firestore.writes.filter((w) => w.path.startsWith(CONTACTS))).toEqual([]);

    await page.submit();
    const again = [...page.body.querySelectorAll('.mt-dialog')].at(-1);
    await page.click('Record date of death', again);
    expect(page.firestore.writes.at(-1)?.data).toMatchObject({ dateOfDeath: '2026-10-02' });
    const banner = page.body.querySelector('[data-testid="deceased-banner"]');
    expect(banner?.textContent).toContain('Bram Ostler died on 2 Oct 2026.');
    const link = banner?.querySelector('a');
    expect(link?.textContent).toContain('Open a probate or administration matter');
    expect(link?.getAttribute('href')).toBe('/matters/new?type=probate&deceased=c-bram');
    expect(page.detail()).toContain('Deceased');
  });

  it('a refused delete lists the matters that still use the contact', async () => {
    const page = await open('/contacts?contact=c-avery', LAWYER, {
      configure: (port, fs) => {
        seedPeople(fs);
        port.call = async (name: string, data: unknown) => {
          port.calls.push({ name, data });
          throw {
            code: 'functions/failed-precondition',
            details: {
              code: 'FAILED_PRECONDITION',
              reason: 'contact_referenced',
              contactId: 'c-avery',
              references: [
                { matterId: 'm-1', matterTitle: 'Estate of Fictional Quill', role: 'executor' },
                { matterId: 'm-2', matterTitle: 'Will of Avery Quill', role: 'client' },
                { matterId: '', matterTitle: 'SC-0042', role: 'safe_custody', safeCustodyId: 'sc-1' },
              ],
            },
          };
        };
      },
    });
    await page.click('Delete', page.body.querySelector('mt-contact-detail') ?? undefined);
    await page.click('Delete contact');
    expect(page.port.calls.at(-1)).toMatchObject({ name: 'contacts-delete', data: { contactId: 'c-avery' } });
    const text = page.dialog()?.textContent?.replace(/\s+/g, ' ') ?? '';
    expect(text).toContain('Avery Quill is still used in 3 places, so they can’t be deleted.');
    expect(text).toContain('Safe custody packet SC-0042');
    expect(text).toContain('Estate of Fictional Quill');
    expect(text).toContain('Will of Avery Quill');
    expect(text).toContain('Executor');
    expect(page.dialog()?.querySelector('a[href="/matters/m-2"]')).not.toBeNull();
  });

  it('deletes and clears the selection', async () => {
    const page = await open('/contacts?contact=c-bram', LAWYER, {
      configure: (port, fs) => {
        seedPeople(fs);
        port.callResults['contacts-delete'] = { deleted: true };
      },
    });
    await page.click('Delete', page.body.querySelector('mt-contact-detail') ?? undefined);
    await page.click('Delete contact');
    expect(page.dialog()).toBeNull();
    expect(page.text()).toContain('Bram Ostler deleted');
  });

  it('offers merge to owners and admins only; merging opens the contact kept and explains queued work', async () => {
    const lawyer = await open('/contacts?contact=c-bram', LAWYER, { configure: (_p, fs) => seedPeople(fs) });
    expect(lawyer.buttons('Merge into').length).toBe(0);
    expect(lawyer.buttons('Delete').length).toBeGreaterThan(0);
    TestBed.resetTestingModule();

    const owner = await open('/contacts?contact=c-bram', OWNER, {
      configure: (port, fs) => {
        seedPeople(fs);
        port.callResults['contacts-merge'] = { repointed: 40, queued: true };
      },
    });
    await owner.click('Merge into', owner.body.querySelector('mt-contact-detail') ?? undefined);
    expect(owner.dialog()?.textContent).toContain('Merge Bram Ostler into…');
    // Only people can take a person's records: the organisation isn't offered.
    await owner.type('Find the contact to keep', 'coastal');
    await owner.stable(250);
    expect(owner.dialog()?.textContent).toContain('No other contact matches');
    await owner.type('Find the contact to keep', 'aver');
    await owner.stable(250);
    await owner.click('Avery Quill');
    await owner.click('Merge into Avery Quill');
    expect(owner.port.calls.at(-1)).toMatchObject({
      name: 'contacts-merge',
      data: { keepId: 'c-avery', mergeId: 'c-bram' },
    });
    expect(owner.selected()).toBe('c-avery');
    expect(owner.text()).toContain('That finishes in the background.');
  });

  it('read-only members can look but not change anything', async () => {
    const page = await open('/contacts?contact=c-avery', READONLY, { configure: (_p, fs) => seedPeople(fs) });
    expect(page.detail()).toContain('Avery Quill');
    for (const label of ['New contact', 'Edit', 'Delete', 'Merge into']) expect(page.buttons(label)).toEqual([]);
    await page.press('c');
    expect(page.dialog()).toBeNull();
  });
});

describe('contact form helpers', () => {
  it('parses Australian and ISO dates, rejecting impossible ones', () => {
    expect(parseDateInput('4/3/1961')).toBe('1961-03-04');
    expect(parseDateInput('1961-03-04')).toBe('1961-03-04');
    expect(parseDateInput('31/02/1990')).toBeNull();
    expect(parseDateInput('')).toBeNull();
  });

  it('guesses a phone type until someone picks one', () => {
    const group = phoneGroup();
    group.controls.number.setValue('(03) 5221 0000');
    expect(group.controls.type.value).toBe('home');
    group.controls.number.setValue('0412 345 678');
    expect(group.controls.type.value).toBe('mobile');
    group.controls.type.setValue('work');
    group.controls.type.markAsDirty();
    group.controls.number.setValue('(03) 5221 0000');
    expect(group.controls.type.value).toBe('work');
  });

  it('maps an organisation without person fields, and lists cleared fields', () => {
    const form = createContactForm();
    form.patchValue({ kind: 'organisation', orgName: ' Fictional Pty Ltd ', abn: '12 345 678 901', givenNames: 'x' });
    const contact = contactFromForm(form);
    expect(contact).toMatchObject({ kind: 'organisation', orgName: 'Fictional Pty Ltd', abn: '12345678901' });
    expect(contact).not.toHaveProperty('givenNames');
    expect(
      clearedFields(contact, {
        kind: 'organisation',
        orgName: 'Old',
        notes: 'x',
        emails: [],
        phones: [],
        addresses: [],
        tags: [],
        isReferrer: false,
        matterRoles: [],
      }),
    ).toEqual(['notes']);
  });

  it('words each kind of activity line (CORE-01a)', () => {
    const at = '2026-10-05T01:00:00.000Z';
    const say = (extra: Partial<ContactActivityLine>) =>
      contactActivitySummary({ id: 'x', at, actorUid: 'u', kind: 'created', ...extra });
    expect(say({})).toBe('Added the contact');
    expect(say({ kind: 'updated', fields: ['name', 'dateOfDeath', 'abn'] })).toBe(
      'Updated the name, date of death and ABN',
    );
    expect(say({ kind: 'deleted' })).toBe('Deleted the contact');
    expect(say({ kind: 'restored' })).toBe('Restored the contact');
    expect(say({ kind: 'merged_in', other: { id: 'c-2', name: 'Avery Q' } })).toBe('Merged Avery Q into this contact');
    expect(say({ kind: 'merged_in' })).toBe('Merged another contact into this one');
    expect(say({ kind: 'merged_away', other: { id: 'c-2', name: 'Avery Quill' } })).toBe(
      'Merged this contact into Avery Quill',
    );
    expect(say({ kind: 'party_updated', role: 'beneficiary' })).toBe(
      'Updated this contact’s details as beneficiary on',
    );
    expect(say({ kind: 'party_role_changed', role: 'executor', previousRole: 'other_side_solicitor' })).toBe(
      'Changed this contact’s role from other side’s solicitor to executor on',
    );
    expect(say({ kind: 'party_removed', role: 'client' })).toBe('Removed this contact as client from');
    expect(
      contactActivityItem(
        {
          id: 'x',
          at,
          actorUid: 'system',
          kind: 'party_added',
          role: 'client',
          matter: { id: 'm', number: null, title: 'Untitled' },
        },
        () => 'n/a',
      ),
    ).toMatchObject({
      text: 'Added this contact as client on',
      matter: { id: 'm', label: 'Untitled' },
      when: '5 Oct 2026',
    });
    const a = { id: 'a', at, actorUid: 'u', kind: 'created' } as const;
    expect(appendLines([a], [a, { ...a, id: 'b' }]).map((l) => l.id)).toEqual(['a', 'b']);
  });

  it('words duplicate reasons, refused-delete references and merge refusals', () => {
    expect(duplicateReasons({ reasons: ['dateOfBirth', 'abn'] })).toBe('Date of birth, same ABN');
    expect(refusingReferences(new Error('x'))).toBeNull();
    expect(mergeErrorCopy(new DomainError('NOT_FOUND'))).toContain('deleted or merged in the meantime');
    expect(mergeErrorCopy(new DomainError('FAILED_PRECONDITION', 'x', { reason: 'kind_mismatch' }))).toContain(
      'A person can only be merged into a person',
    );
    expect(mergeErrorCopy(new DomainError('FAILED_PRECONDITION', 'x', { reason: 'already_merged' }))).toContain(
      'already been merged',
    );
  });
});
