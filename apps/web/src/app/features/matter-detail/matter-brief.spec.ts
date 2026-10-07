import { TestBed } from '@angular/core/testing';

import { readText } from './matter-brief';
import {
  BRIEF,
  BRIEF_NOW,
  briefServerCallable,
  type BriefRows,
  cleanUpOverlays,
  openMatter,
  READONLY,
  type OpenOptions,
} from './testing';
import { ClerkPanel } from '../../core/clerk/clerk-panel';

/** The brief on a matter's Overview (AI-06c). Fictional data only. */

const SEEN_KEY = 'materia.matterBrief.seen';

afterEach(() => {
  cleanUpOverlays();
  localStorage.removeItem(SEEN_KEY);
});

const CLERK_ON = { 'clerk.enabled': true, 'clerk.features.matterBrief': true, 'clerk.features.chat': true };

const ROWS: BriefRows = {
  deadlines: [
    { id: 'dl-advert', title: 'Advertise for creditors', dueDate: '2026-10-01', status: 'upcoming' },
    {
      id: 'dl-grant',
      title: 'File the probate application',
      dueDate: '2026-10-16',
      status: 'upcoming',
      critical: true,
    },
  ],
  tasks: [{ id: 't-valuation', title: 'Request the date-of-death valuation', status: 'todo' }],
  documents: [
    {
      id: 'doc-will',
      name: 'Will of Fictional Whitfield.pdf',
      category: 'will',
      createdAt: new Date('2026-10-02T03:00:00Z'),
      privileged: false,
    },
  ],
};

async function open(options: OpenOptions = {}, rows: BriefRows = ROWS) {
  const page = await openMatter('/matters/m-whitfield/overview', {
    ...options,
    callables: { 'clerk-matterBrief': briefServerCallable(rows), ...options.callables },
  });
  await page.stable();
  const card = () => page.body.querySelector<HTMLElement>('[data-testid="matter-brief"]');
  const chips = () => [...(card()?.querySelectorAll<HTMLElement>('mt-citation') ?? [])];
  return { ...page, card, chips };
}

describe('matter brief (AI-06c)', () => {
  it('shows the matter’s own summary with Clerk off: the plain card, its sources, no placeholder', async () => {
    const page = await open();
    const card = page.card();
    expect(card).not.toBeNull();
    expect(card?.hasAttribute('data-plain')).toBe(true);
    expect(card?.getAttribute('aria-label')).toBe('Matter brief');
    expect(page.text(card)).toContain('1 item overdue and 1 due in the next 14 days.');
    expect(page.text(card)).toContain('Overdue. Deadline “Advertise for creditors” was due Thu 1 Oct.');
    expect(page.text(card)).toContain('Due soon. Deadline “File the probate application” is due Fri 16 Oct.');
    expect(page.text(card)).toContain('Built from the matter’s deadlines, tasks and activity, not by Clerk');
    expect(page.chips().map((chip) => chip.getAttribute('aria-label'))).toContain('Source 1: Advertise for creditors');
    // Clerk is off: nothing to refresh, nothing to ask.
    expect(page.buttons('Refresh', card ?? undefined)).toHaveLength(0);
    expect(page.buttons('Ask a follow-up')).toHaveLength(0);
    expect(page.text()).not.toContain('Coming in AI-06');
    // Asked once, as the tab opened.
    expect(page.calls('clerk-matterBrief')).toEqual([{ matterId: 'm-whitfield', mode: 'open' }]);
  });

  it('shows the kept brief at once while the callable checks it', async () => {
    let release: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => (release = resolve));
    const server = briefServerCallable(ROWS);
    const page = await open({
      configure: (fs) => {
        void server({ matterId: 'm-whitfield', mode: 'open' }, fs);
      },
      callables: {
        'clerk-matterBrief': async (data, fs) => {
          await waiting;
          return server(data, fs);
        },
      },
    });
    expect(page.text(page.card())).toContain('Advertise for creditors');
    release();
    await page.stable();
    expect(page.text(page.card())).toContain('Advertise for creditors');
  });

  it('opens a source where the record lives: a deadline its tab, a document its page', async () => {
    const page = await open();
    page.chips()[0]?.click();
    await page.stable();
    expect(page.router.url).toBe('/matters/m-whitfield/deadlines');

    await page.router.navigateByUrl('/matters/m-whitfield/overview');
    await page.stable();
    const will = page.chips().find((chip) => chip.textContent?.includes('Will of Fictional Whitfield.pdf'));
    will?.click();
    await page.stable();
    expect(page.router.url).toBe('/matters/m-whitfield/documents/doc-will');
  });

  it('shows Clerk’s brief with Refresh (three a day) and Ask a follow-up, and marks what’s new', async () => {
    // Last here before the will was added.
    localStorage.setItem(SEEN_KEY, JSON.stringify({ 'user-jordan:m-whitfield': Date.parse('2026-10-01T00:00:00Z') }));
    const clerk = {
      headline: 'The probate application is due Fri 16 Oct, and one deadline is overdue.',
      items: [
        {
          kind: 'due' as const,
          text: 'Advertise for creditors: it was due Thu 1 Oct.',
          tone: 'danger' as const,
          refs: [{ kind: 'deadline' as const, id: 'dl-advert', label: 'Advertise for creditors' }],
        },
        {
          kind: 'changed' as const,
          text: 'The will was added on Fri 2 Oct.',
          refs: [{ kind: 'document' as const, id: 'doc-will', label: 'Will of Fictional Whitfield.pdf' }],
          at: '2026-10-02T03:00:00.000Z',
        },
      ],
    };
    const page = await open({
      flags: CLERK_ON,
      callables: { 'clerk-matterBrief': briefServerCallable(ROWS, clerk) },
    });
    const card = page.card();
    expect(card?.hasAttribute('data-plain')).toBe(false);
    expect(card?.getAttribute('aria-label')).toBe('Clerk brief');
    expect(page.text(card)).toContain(clerk.headline);
    expect(page.text(card)).toContain('Overdue. Advertise for creditors: it was due Thu 1 Oct.');
    expect(page.text(card)).toContain('New since your last visit. The will was added on Fri 2 Oct.');
    expect(page.text(card)).toContain('Clerk read 2 deadlines, 1 task and 1 document');
    expect(page.text(card)).toContain('Clerk can be wrong; check the sources.');

    // Ask a follow-up: ⌘J on this matter.
    await page.click('Ask a follow-up', card ?? undefined);
    expect(TestBed.inject(ClerkPanel).open()).toBe(true);

    // Refresh: three a day, then the button says why it's off.
    for (let i = 0; i < 3; i++) await page.click('Refresh', page.card() ?? undefined);
    expect(page.calls('clerk-matterBrief').filter((call) => call['mode'] === 'refresh')).toHaveLength(3);
    const refresh = page.buttons('Refresh', page.card() ?? undefined)[0];
    expect(refresh?.hasAttribute('disabled') || refresh?.getAttribute('aria-disabled') === 'true').toBe(true);
    expect(refresh?.getAttribute('title')).toContain('refreshed 3 times today');
    expect((page.firestore.get(BRIEF)?.['refreshes'] as { count: number }).count).toBe(3);
  });

  it('leaves out next steps that only cite suggestions when the role can’t act on them', async () => {
    const rows: BriefRows = {
      ...ROWS,
      suggestions: [
        {
          id: 's-task',
          kind: 'task',
          payload: { title: 'Write to the bank', priority: 'none' },
          status: 'proposed',
          privileged: false,
          expiresAt: new Date('2099-01-01T00:00:00Z'),
        },
      ],
    };
    const lawyer = await open({ flags: { 'clerk.features.suggestions': true } }, rows);
    expect(lawyer.text(lawyer.card())).toContain('Review Clerk’s suggestion: task “Write to the bank”.');
    cleanUpOverlays();
    TestBed.resetTestingModule();

    const readonly = await open({ session: READONLY, flags: { 'clerk.features.suggestions': true } }, rows);
    expect(readonly.text(readonly.card())).toContain('Advertise for creditors');
    expect(readonly.text(readonly.card())).not.toContain('Write to the bank');
  });

  it('says so when no brief could be read, and tries again', async () => {
    let fail = true;
    const server = briefServerCallable(ROWS);
    const page = await open({
      callables: {
        'clerk-matterBrief': (data, fs) => {
          if (fail) throw { code: 'functions/unavailable', details: { code: 'UNAVAILABLE' } };
          return server(data, fs);
        },
      },
    });
    expect(page.card()).toBeNull();
    expect(page.body.querySelector('[data-testid="matter-brief-problem"]')).not.toBeNull();
    fail = false;
    await page.click('Try again');
    expect(page.text(page.card())).toContain('Advertise for creditors');
  });

  it('describes what it was built from', () => {
    expect(readText({ deadlines: 2, tasks: 1, changes: 0, documents: 1, suggestions: 0 })).toBe(
      '2 deadlines, 1 task and 1 document',
    );
    expect(readText({ deadlines: 0, tasks: 0, changes: 3, documents: 0, suggestions: 0 })).toBe('3 changes');
    expect(readText({ deadlines: 0, tasks: 0, changes: 0, documents: 0, suggestions: 0 })).toBe('nothing yet');
    expect(BRIEF_NOW.toISOString()).toBe('2026-10-04T00:30:00.000Z');
  });
});
