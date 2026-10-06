import { INBOX_DETAIL_QUERY } from './inbox-page';
import { NOTIFICATIONS_START_DELAY_MS } from '../../core/notifications/notifications-store';
import { cleanUpOverlays, MATTER, meta, ME, openMatter, ORG, PRIYA } from '../matter-detail/testing';

/** The Inbox (CORE-22) and the bell's popover. Fictional data only. */

afterEach(() => {
  cleanUpOverlays();
  delete (window as { matchMedia?: unknown }).matchMedia;
});

type Page = Awaited<ReturnType<typeof openMatter>>;
type Fs = Page['firestore'];
type Seed = Record<string, unknown>;

const N = `orgs/${ORG}/notifications`;

/** A notification of mine, sent at `at` (Melbourne is UTC+10 until 4 October 2026 at 2 am, then +11). */
function notification(id: string, at: string, data: Seed = {}): [string, Seed] {
  const createdAt = new Date(at);
  return [
    `${N}/${id}`,
    {
      kind: 'task_assigned',
      taskId: 't-cert',
      matterId: 'm-whitfield',
      recipientUid: ME,
      title: `Notification ${id}`,
      body: 'Order the death certificate',
      link: '/matters/m-whitfield/tasks',
      channels: ['inapp'],
      priority: 'normal',
      readAt: null,
      summaryId: null,
      ...meta,
      createdAt,
      updatedAt: createdAt,
      schemaVersion: 2,
      ...data,
    },
  ];
}

function inbox(fs: Fs): void {
  const add = (entry: [string, Seed]) => fs.set(...entry);
  add(
    notification('n-mention', '2026-10-03T22:14:00Z', {
      kind: 'mention',
      noteId: 'note-1',
      title: 'Priya Shah mentioned you',
    }),
  );
  add(
    notification('n-escalation', '2026-10-03T21:00:00Z', {
      kind: 'deadline_escalation',
      deadlineId: 'd-notice',
      title: 'Critical deadline in 3 days, not acknowledged',
      priority: 'critical',
      channels: ['inapp', 'email'],
    }),
  );
  add(
    notification('n-change', '2026-10-03T20:00:00Z', {
      kind: 'deadline_changed',
      deadlineId: 'd-notice',
      changeId: 'c-notice',
      title: 'A deadline date changed',
    }),
  );
  add(
    notification('n-read', '2026-10-03T05:00:00Z', { readAt: new Date('2026-10-02T06:00:00Z'), title: 'Read already' }),
  );
  add(
    notification('n-archived', '2026-10-02T04:00:00Z', {
      hiddenAt: new Date(),
      readAt: new Date(),
      title: 'Archived already',
    }),
  );
  add(notification('n-email-only', '2026-10-02T03:00:00Z', { channels: ['email'], title: 'Email only' }));
  add(notification('n-theirs', '2026-10-02T03:00:00Z', { recipientUid: PRIYA, title: 'Someone else’s' }));
  add(
    notification('n-burst', '2026-09-30T01:00:00Z', {
      kind: 'system',
      matterId: undefined,
      taskId: undefined,
      title: 'Lots of notifications at once',
      body: 'More arrived in a minute than we send one by one.',
      link: '/inbox',
      collapsedCount: 2,
    }),
  );
  add(notification('n-member-1', '2026-09-30T01:00:01Z', { summaryId: 'n-burst', title: 'Burst member one' }));
  add(notification('n-member-2', '2026-09-30T01:00:02Z', { summaryId: 'n-burst', title: 'Burst member two' }));
  fs.set(`${MATTER}/deadlineChanges/c-notice`, {
    orgId: ORG,
    matterId: 'm-whitfield',
    deadlineId: 'd-notice',
    ruleId: 'vic.probate.advert',
    title: 'Advertise notice of intended application',
    kind: 'moved',
    cause: 'event',
    status: 'pending',
    earlier: false,
    intoPast: false,
    fromDueDate: '2026-10-08',
    toDueDate: '2026-10-15',
    assigneeUid: ME,
    recomputeVersion: 2,
    critical: false,
    ...meta,
  });
}

/** Pretends the window is wide (the detail pane shows) or narrow. */
function screen(wide: boolean): void {
  window.matchMedia = ((query: string) =>
    ({
      matches: query === INBOX_DETAIL_QUERY ? wide : false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      onchange: null,
      dispatchEvent: () => false,
    }) as MediaQueryList) as typeof window.matchMedia;
}

async function openInbox(configure: (fs: Fs) => void = inbox, options: { wide?: boolean } = {}): Promise<Page> {
  screen(options.wide ?? false);
  return openMatter('/inbox', {
    configure,
    providers: [{ provide: NOTIFICATIONS_START_DELAY_MS, useValue: 0 }],
  });
}

const rowTitles = (page: Page) =>
  [...page.body.querySelectorAll('.mt-inbox mt-notification-row .tt')].map((el) => el.textContent?.trim());
const row = (page: Page, id: string) =>
  page.body.querySelector<HTMLElement>(`.mt-inbox mt-notification-row[data-id="${id}"]`) as HTMLElement;
const chip = (page: Page, filter: string) =>
  page.body.querySelector<HTMLButtonElement>(`.mt-inbox .mt-chip[data-filter="${filter}"]`) as HTMLButtonElement;

describe('the Inbox (CORE-22)', () => {
  it('lists my in-app notifications by day, newest first, leaving out archived ones and burst members', async () => {
    const page = await openInbox();
    expect(rowTitles(page)).toEqual([
      'Priya Shah mentioned you',
      'Critical deadline in 3 days, not acknowledged',
      'A deadline date changed',
      'Read already',
      'Lots of notifications at once',
    ]);
    const days = [...page.body.querySelectorAll('.mt-inbox .mt-notif-day .t-1')].map((el) => el.textContent?.trim());
    expect(JSON.stringify(days)).toBe(JSON.stringify(['Today · Sun 4 Oct', 'Yesterday', 'Wednesday 30 Sep']));
    // The matter it is about, the unread dot, and the time in Melbourne.
    expect(page.text(row(page, 'n-mention'))).toContain('M-2026-0142');
    expect(row(page, 'n-mention').hasAttribute('data-unread')).toBe(true);
    expect(row(page, 'n-read').hasAttribute('data-unread')).toBe(false);
    expect(page.text(row(page, 'n-mention'))).toContain('9:14 am');
  });

  it('filters by kind and to unread only, with counts', async () => {
    const page = await openInbox();
    expect(page.text(chip(page, 'all'))).toBe('All 5');
    expect(page.text(chip(page, 'deadlines'))).toBe('Deadlines 2');
    chip(page, 'mentions').click();
    await page.stable();
    expect(rowTitles(page)).toEqual(['Priya Shah mentioned you']);
    chip(page, 'clerk').click();
    await page.stable();
    expect(page.text(page.body.querySelector('.mt-inbox'))).toContain('Nothing matches');
    await page.click('Clear filters');
    expect(rowTitles(page)).toHaveLength(5);
    const unread = page.body.querySelector<HTMLButtonElement>(
      '.mt-inbox mt-switch button, .mt-inbox mt-switch [role="switch"]',
    );
    unread?.click();
    await page.stable();
    expect(rowTitles(page)).not.toContain('Read already');
    expect(page.text(chip(page, 'all'))).toBe('All 4');
  });

  it('triages from the keyboard: move, read, unread, select and archive', async () => {
    const page = await openInbox();
    await page.press('j');
    expect(document.activeElement).toBe(row(page, 'n-mention'));
    await page.press('e', {}, row(page, 'n-mention'));
    expect(page.firestore.get(`${N}/n-mention`)?.['readAt']).toBeInstanceOf(Date);
    await page.press('u', {}, row(page, 'n-mention'));
    expect(page.firestore.get(`${N}/n-mention`)?.['readAt']).toBeNull();
    await page.press('j', {}, row(page, 'n-mention'));
    expect(document.activeElement).toBe(row(page, 'n-escalation'));
    await page.press('k', {}, row(page, 'n-escalation'));
    expect(document.activeElement).toBe(row(page, 'n-mention'));

    // Select two, then archive them together.
    await page.press('x', {}, row(page, 'n-mention'));
    await page.press('j', {}, row(page, 'n-mention'));
    await page.press('x', {}, row(page, 'n-escalation'));
    expect(page.text(page.body.querySelector('.mt-inbox .bulk'))).toContain('2 selected');
    await page.press('y', {}, row(page, 'n-escalation'));
    expect(page.firestore.get(`${N}/n-mention`)?.['hiddenAt']).toBeInstanceOf(Date);
    expect(page.firestore.get(`${N}/n-escalation`)?.['hiddenAt']).toBeInstanceOf(Date);
    expect(rowTitles(page)).not.toContain('Priya Shah mentioned you');
    // Archiving reads them too, so they leave the badge.
    expect(page.firestore.get(`${N}/n-mention`)?.['readAt']).toBeInstanceOf(Date);
    expect(page.text(page.body.querySelector('.mt-toaster'))).toContain('2 notifications archived');
  });

  it('marks everything listed read with Shift+E', async () => {
    const page = await openInbox();
    await page.press('E', { shiftKey: true });
    for (const id of ['n-mention', 'n-escalation', 'n-change', 'n-burst']) {
      expect(page.firestore.get(`${N}/${id}`)?.['readAt']).toBeInstanceOf(Date);
    }
    // Not touched: someone else's, and an email-only one the inbox doesn't list.
    expect(page.firestore.get(`${N}/n-theirs`)?.['readAt']).toBeNull();
    expect(page.firestore.get(`${N}/n-email-only`)?.['readAt']).toBeNull();
  });

  it('opens a notification with Enter, marking it read', async () => {
    const page = await openInbox();
    await page.press('Enter', {}, row(page, 'n-mention'));
    expect(page.router.url).toBe('/matters/m-whitfield/tasks');
    expect(page.firestore.get(`${N}/n-mention`)?.['readAt']).toBeInstanceOf(Date);
  });

  it('acknowledges an escalation in its row, and says who did when someone was first', async () => {
    const page = await openInbox();
    await page.click('Acknowledge', row(page, 'n-escalation'));
    expect(page.calls('deadlines-acknowledge')).toEqual([
      expect.objectContaining({ matterId: 'm-whitfield', deadlineId: 'd-notice' }),
    ]);
    expect(page.text(row(page, 'n-escalation'))).toContain('You acknowledged it');
    expect(page.firestore.get(`${N}/n-escalation`)?.['readAt']).toBeInstanceOf(Date);
  });

  it('says who acknowledged an escalation first', async () => {
    const again = await openInbox(inbox);
    again.port.call = async <T>(name: string): Promise<T> => {
      again.port.calls.push({ name, data: {} });
      return { deadlineId: 'd-notice', ackBy: PRIYA, ackAt: '2026-10-03T23:00:00Z', acknowledged: false } as T;
    };
    await again.press('a', {}, row(again, 'n-escalation'));
    expect(again.text(row(again, 'n-escalation'))).toContain('Already acknowledged by Priya Shah');
  });

  it('accepts a proposed deadline change through the same call as the deadline lists', async () => {
    const page = await openInbox();
    await page.click('Accept', row(page, 'n-change'));
    expect(page.calls('deadlines-resolveChange')).toEqual([
      expect.objectContaining({ matterId: 'm-whitfield', changeId: 'c-notice', accept: true }),
    ]);
    expect(page.firestore.get(`${MATTER}/deadlineChanges/c-notice`)?.['status']).toBe('accepted');
    expect(page.text(row(page, 'n-change'))).toContain('You accepted the change');
  });

  it('says so when a change was already decided elsewhere, without calling again', async () => {
    const later = await openInbox((fs) => {
      inbox(fs);
      fs.set(`${MATTER}/deadlineChanges/c-notice`, {
        ...(fs.get(`${MATTER}/deadlineChanges/c-notice`) as Seed),
        status: 'rejected',
      });
    });
    await later.click('Reject', row(later, 'n-change'));
    expect(later.calls('deadlines-resolveChange')).toEqual([]);
    expect(later.text(row(later, 'n-change'))).toContain('Already decided');
  });

  it('says "No longer available" for a matter I can no longer read, and doesn’t open it', async () => {
    const page = await openInbox((fs) => {
      inbox(fs);
      fs.denyRead(MATTER);
    });
    expect(page.text(row(page, 'n-mention'))).toContain('No longer available');
    expect(row(page, 'n-escalation').querySelector('button')).toBeNull();
    await page.press('Enter', {}, row(page, 'n-mention'));
    expect(page.router.url).toBe('/inbox');
    expect(page.text(page.body.querySelector('.mt-toaster'))).toContain('No longer available');
  });

  it('lists a burst’s members under its summary on demand', async () => {
    const page = await openInbox();
    await page.press('Enter', {}, row(page, 'n-burst'));
    expect(rowTitles(page).slice(-3)).toEqual([
      'Lots of notifications at once',
      'Burst member two',
      'Burst member one',
    ]);
    await page.press('Enter', {}, row(page, 'n-burst'));
    expect(rowTitles(page)).not.toContain('Burst member one');
  });

  it('shows the chosen notification beside the list on a wide screen', async () => {
    const page = await openInbox(inbox, { wide: true });
    row(page, 'n-mention').click();
    await page.stable();
    const detail = page.body.querySelector('.mt-inbox .detail');
    expect(page.text(detail)).toContain('Priya Shah mentioned you');
    expect(page.text(detail)).toContain('Estate of');
    expect(page.router.url).toBe('/inbox');
    expect(page.firestore.get(`${N}/n-mention`)?.['readAt']).toBeInstanceOf(Date);
  });

  it('is all caught up when there is nothing', async () => {
    const page = await openInbox(() => undefined);
    expect(page.text(page.body.querySelector('.mt-inbox'))).toContain('You’re all caught up');
  });
});

/** A Clerk suggestion on the Whitfield matter, as AI-07 stores it. */
function suggestion(fs: Fs, data: Seed = {}): void {
  fs.set(`${MATTER}/suggestions/s-valuation`, {
    kind: 'task',
    payload: { title: 'Request the date-of-death valuation', priority: 'medium' },
    rationale: 'The will leaves the house at 14 Fictional St to the residuary beneficiaries.',
    citations: [],
    status: 'proposed',
    promptId: 'suggest',
    promptVersion: '1.0.0',
    model: 'test-model',
    privileged: false,
    basis: 'b-1',
    basisParts: {},
    dedupeKey: 'task:valuation',
    expiresAt: new Date('2099-01-01T00:00:00Z'),
    orgId: ORG,
    matterId: 'm-whitfield',
    ...meta,
    createdBy: 'clerk',
    ...data,
  });
}

function withSuggestion(data: Seed | null = {}) {
  return (fs: Fs) => {
    fs.set(
      ...notification('n-suggest', '2026-10-03T23:00:00Z', {
        kind: 'suggestion',
        taskId: undefined,
        suggestionId: 's-valuation',
        title: 'Clerk suggests a task',
        link: '/matters/m-whitfield/overview',
      }),
    );
    if (data) suggestion(fs, data);
  };
}

/** The `suggestions-*` callables, marking the suggestion as the server would. */
const SUGGESTION_CALLABLES = {
  'suggestions-accept': (data: Seed, fs: Fs) => {
    const path = `${MATTER}/suggestions/${String(data['suggestionId'])}`;
    fs.set(path, { ...fs.get(path), status: 'accepted', resolvedBy: ME, resolvedAt: new Date() });
    return { suggestionId: data['suggestionId'], status: 'accepted', resultRef: `${MATTER}/tasks/t-new` };
  },
  'suggestions-dismiss': (data: Seed, fs: Fs) => {
    const path = `${MATTER}/suggestions/${String(data['suggestionId'])}`;
    fs.set(path, { ...fs.get(path), status: 'dismissed', resolvedBy: ME, resolvedAt: new Date() });
    return { suggestionId: data['suggestionId'], status: 'dismissed' };
  },
};

async function openWithSuggestion(data: Seed | null = {}, options: { wide?: boolean } = {}): Promise<Page> {
  screen(options.wide ?? false);
  return openMatter('/inbox', {
    configure: withSuggestion(data),
    callables: SUGGESTION_CALLABLES,
    providers: [{ provide: NOTIFICATIONS_START_DELAY_MS, useValue: 0 }],
  });
}

describe('reviewing Clerk suggestions in the Inbox (CORE-22a)', () => {
  it('shows the suggestion beside the list on a wide screen, and accepts it there', async () => {
    const page = await openWithSuggestion({}, { wide: true });
    row(page, 'n-suggest').click();
    await page.stable(10);
    const detail = page.body.querySelector('.mt-inbox .detail') as HTMLElement;
    expect(page.text(detail.querySelector('mt-suggestion-card'))).toContain('Request the date-of-death valuation');
    await page.click('Add task', detail.querySelector<HTMLElement>('mt-suggestion-card') ?? undefined);
    await page.stable(10);
    expect(page.calls('suggestions-accept')).toEqual([
      expect.objectContaining({ matterId: 'm-whitfield', suggestionId: 's-valuation' }),
    ]);
    expect(page.text(row(page, 'n-suggest'))).toContain('You accepted it');
    expect(page.text(detail)).toContain('You accepted it');
    expect(page.router.url).toBe('/inbox');
    expect(page.firestore.get(`${N}/n-suggest`)?.['readAt']).toBeInstanceOf(Date);
  });

  it('reviews in a dialog on a narrow screen, and dismisses with a reason', async () => {
    const page = await openWithSuggestion();
    await page.click('Review', row(page, 'n-suggest'));
    await page.stable(10);
    const dialog = () => page.body.querySelector<HTMLElement>('mt-inbox-suggestion-dialog') ?? undefined;
    expect(page.text(dialog())).toContain('Review suggestion');
    expect(page.text(dialog())).toContain('Request the date-of-death valuation');
    await page.click('Dismiss', dialog());
    await page.submit(dialog() ?? null);
    await page.stable(10);
    expect(page.calls('suggestions-dismiss')).toEqual([expect.objectContaining({ suggestionId: 's-valuation' })]);
    expect(dialog()).toBeUndefined();
    expect(page.text(row(page, 'n-suggest'))).toContain('You dismissed it');
    expect(row(page, 'n-suggest').querySelector('button')).toBeNull();
    expect(page.router.url).toBe('/inbox');
    expect(page.firestore.get(`${N}/n-suggest`)?.['readAt']).toBeInstanceOf(Date);
  });

  it('says who already decided a suggestion, without its actions', async () => {
    const page = await openWithSuggestion(
      { status: 'accepted', resolvedBy: PRIYA, resolvedAt: new Date('2026-10-03T23:30:00Z') },
      { wide: true },
    );
    row(page, 'n-suggest').click();
    await page.stable(10);
    const detail = page.body.querySelector('.mt-inbox .detail') as HTMLElement;
    expect(page.text(detail)).toContain('Already accepted by Priya Shah');
    const buttons = [...detail.querySelectorAll('mt-suggestion-card button')].map((b) => b.textContent?.trim());
    expect(buttons).not.toContain('Add task');
  });

  it('says a removed suggestion is no longer available', async () => {
    const page = await openWithSuggestion(null, { wide: true });
    row(page, 'n-suggest').click();
    await page.stable(10);
    expect(page.text(page.body.querySelector('.mt-inbox .detail'))).toContain('No longer available');
  });
});

describe('the bell (CORE-22)', () => {
  it('shows my newest unread notifications, opens one and leads to the Inbox', async () => {
    const page = await openMatter('/today', {
      configure: inbox,
      providers: [{ provide: NOTIFICATIONS_START_DELAY_MS, useValue: 0 }],
    });
    const bell = page.body.querySelector<HTMLButtonElement>('[data-bell]') as HTMLButtonElement;
    expect(bell.getAttribute('aria-label')).toBe('Notifications, 4 unread');
    bell.click();
    await page.stable();
    const popover = page.body.querySelector('.mt-bell') as HTMLElement;
    expect(page.text(popover)).toContain('Priya Shah mentioned you');
    expect(page.text(popover)).not.toContain('Read already');
    (popover.querySelector('mt-notification-row') as HTMLElement).click();
    await page.stable();
    expect(page.router.url).toBe('/matters/m-whitfield/tasks');
    expect(page.firestore.get(`${N}/n-mention`)?.['readAt']).toBeInstanceOf(Date);
  });
});
