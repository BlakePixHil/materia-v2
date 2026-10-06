import { signal } from '@angular/core';

import { Connectivity, DATA_CLOCK } from '@materia/data-access';

import { DEVICE_TIME_ZONE } from './today-data';
import {
  ADMIN,
  cleanUpOverlays,
  MATTER,
  matterDoc,
  meta,
  ME,
  openMatter,
  ORG,
  PARALEGAL,
  READONLY,
} from '../matter-detail/testing';

/** The Today screen (CORE-14). Fictional data only. */

afterEach(cleanUpOverlays);

type Page = Awaited<ReturnType<typeof openMatter>>;
type Fs = Page['firestore'];
type Seed = Record<string, unknown>;

/** Monday 5 October 2026, 9 am in Melbourne. */
const NOW = Date.parse('2026-10-04T22:00:00Z');
const OTHER = `orgs/${ORG}/matters/m-ostler`;
const SECRET = `orgs/${ORG}/matters/m-sealed`;
const PERSONAL = `orgs/${ORG}/members/${ME}/tasks`;

function deadlineDoc(title: string, data: Seed = {}): Seed {
  return {
    title,
    kind: 'internal',
    critical: false,
    status: 'upcoming',
    assigneeUid: ME,
    reminders: [],
    pastOnCreation: false,
    orgId: ORG,
    matterId: 'm-whitfield',
    deletedAt: null,
    ...meta,
    ...data,
  };
}

function changeDoc(data: Seed): Seed {
  return {
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
    ...data,
  };
}

function taskDoc(title: string, matterId: string | null, data: Seed = {}): Seed {
  return {
    title,
    status: 'todo',
    priority: 'none',
    order: 1024,
    checklist: [],
    source: 'manual',
    countedOpen: true,
    orgId: ORG,
    matterId,
    assigneeUid: ME,
    deletedAt: null,
    ...meta,
    ...data,
  };
}

/** A busy Monday: something overdue, a change to review, things due today and later this week. */
function busyDay(fs: Fs): void {
  fs.set(OTHER, matterDoc({ number: 'M-2026-0150', title: 'Will for Bram Ostler', type: 'will', deceased: undefined }));
  fs.set(`${MATTER}/deadlines/d-inventory`, deadlineDoc('File the inventory of assets', { dueDate: '2026-10-01' }));
  fs.set(`${MATTER}/deadlineChanges/c-notice`, changeDoc({}));
  fs.set(`${MATTER}/tasks/t-call`, taskDoc('Call the executor', 'm-whitfield', { dueDate: '2026-10-05' }));
  fs.set(
    `${OTHER}/tasks/t-draft`,
    taskDoc('Draft the will', 'm-ostler', { dueDate: '2026-10-05', priority: 'urgent' }),
  );
  fs.set(`${MATTER}/tasks/t-late`, taskDoc('Chase the bank valuation', 'm-whitfield', { dueDate: '2026-09-30' }));
  fs.set(`${PERSONAL}/p-cpd`, taskDoc('Book CPD seminar', null, { dueDate: '2026-10-07' }));
  fs.set(`${MATTER}/tasks/t-next`, taskDoc('Prepare the affidavit', 'm-whitfield', { dueDate: '2026-10-14' }));
  fs.set(`${MATTER}/tasks/t-theirs`, taskDoc('Someone else’s task', 'm-whitfield', { assigneeUid: 'user-daniel' }));
  fs.set(`users/${ME}/recent/${ORG}_m-ostler`, recentDoc('m-ostler', '2026-10-02T00:00:00Z'));
  fs.set(`users/${ME}/recent/${ORG}_m-whitfield`, recentDoc('m-whitfield', '2026-10-03T00:00:00Z'));
}

function entryDoc(data: Seed = {}): Seed {
  return {
    orgId: ORG,
    matterId: 'm-whitfield',
    uid: ME,
    date: '2026-10-02',
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
    ...data,
  };
}

/** My time this month (drafts, final, billed, written off, non-billable), last month's and a colleague's. */
function myTime(fs: Fs): void {
  const entry = (id: string, data: Seed) => fs.set(`${MATTER}/timeEntries/${id}`, entryDoc(data));
  entry('te-draft', {});
  entry('te-final', { date: '2026-10-05', status: 'final', amountCents: 30000 });
  entry('te-billed', { status: 'billed', invoiceId: 'inv-1' });
  entry('te-off', { status: 'written_off' });
  entry('te-free', { billable: false });
  entry('te-september', { date: '2026-09-30' });
  entry('te-theirs', { uid: 'user-daniel' });
}

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

/** Nothing of mine is due: the seeded deadline is done. */
function clearDay(fs: Fs): void {
  fs.set(`${MATTER}/deadlines/d-notice`, { ...(fs.get(`${MATTER}/deadlines/d-notice`) as Seed), status: 'done' });
}

const clock = (at = NOW) => ({ provide: DATA_CLOCK, useValue: () => at });
const device = (zone: string) => ({ provide: DEVICE_TIME_ZONE, useValue: zone });

async function openToday(options: Parameters<typeof openMatter>[1] = {}): Promise<Page> {
  const page = await openMatter('/today', {
    ...options,
    providers: [clock(), device('Australia/Melbourne'), ...(options.providers ?? [])],
  });
  await page.stable(20);
  await page.stable(20);
  return page;
}

const card = (page: Page, section: string) => page.body.querySelector<HTMLElement>(`[data-section="${section}"]`);
const items = (page: Page, section: string) =>
  [...(card(page, section)?.querySelectorAll<HTMLElement>('[data-today-item]') ?? [])].map((item) =>
    page.text(item.querySelector('[data-today-focus], .mt-task-title')),
  );
const stats = (page: Page) =>
  [...(card(page, 'stats')?.querySelectorAll('.mt-stat') ?? [])].map((stat) =>
    ['.k', '.v', '.f'].map((part) => page.text(stat.querySelector(part))),
  );
const focused = (page: Page) => page.text(document.activeElement);

describe('today', () => {
  it('greets me with the date in the org’s time zone', async () => {
    const page = await openToday();
    expect(page.text(page.body.querySelector('h1'))).toBe('Good morning, Jordan');
    expect(page.text(page.body.querySelector('[data-today-date]'))).toBe('Monday 5 October');
    expect(page.body.querySelector('[data-zone-hint]')).toBeNull();
    expect(page.body.querySelector('[data-offline]')).toBeNull();
    // Every section answered, so they are drawn (together).
    expect(page.body.querySelector('[data-today-loading]')).toBeNull();
  });

  it('shows the cards in the design’s order', async () => {
    const page = await openToday({ configure: busyDay, flags: { 'clerk.features.brief': true } });
    const order = [...page.body.querySelectorAll<HTMLElement>('.mt-today [data-section]')].map(
      (node) => node.dataset['section'],
    );
    expect(order).toEqual(['brief', 'attention', 'tasks', 'stats', 'due', 'recent']);
  });

  it('puts overdue deadlines and changes waiting on me under Needs attention', async () => {
    const page = await openToday({ configure: busyDay });
    expect(items(page, 'attention')).toEqual([
      'Overdue: File the inventory of assets',
      'Change to review: Advertise notice of intended application',
    ]);
    const attention = page.text(card(page, 'attention'));
    expect(attention).toContain('M-2026-0142 · Estate of Margaret Whitfield');
    expect(attention).toContain('Accept');
    expect(page.buttons('Mark done')).toHaveLength(1);
  });

  it('puts an urgent change first, under a banner', async () => {
    const page = await openToday({
      configure: (fs) => {
        busyDay(fs);
        fs.set(
          `${MATTER}/deadlineChanges/c-urgent`,
          changeDoc({
            title: 'Earliest date to file',
            critical: true,
            intoPast: true,
            earlier: true,
            toDueDate: '2026-10-01',
          }),
        );
      },
    });
    expect(items(page, 'attention')[0]).toBe('Change to review: Earliest date to file');
    expect(page.text(card(page, 'attention')?.querySelector('[role="alert"]'))).toContain(
      'A critical deadline would move into the past',
    );
  });

  it('merges this week’s deadlines and tasks by date, then priority', async () => {
    const page = await openToday({ configure: busyDay });
    const due = card(page, 'due');
    expect([...(due?.querySelectorAll('h3') ?? [])].map((h) => page.text(h))).toEqual(['Today', 'Later this week']);
    expect(items(page, 'due')).toEqual([
      'Task: Draft the will',
      'Task: Call the executor',
      'Task: Book CPD seminar',
      'Deadline: Advertise notice of intended application',
    ]);
    expect(page.text(due)).toContain('M-2026-0150 · Will for Bram Ostler');
  });

  it('lists my next tasks and links to all of them', async () => {
    const page = await openToday({ configure: busyDay });
    expect(items(page, 'tasks')).toEqual([
      'Chase the bank valuation',
      'Draft the will',
      'Call the executor',
      'Book CPD seminar',
      'Prepare the affidavit',
    ]);
    expect(page.text(card(page, 'tasks'))).not.toContain('Someone else’s task');
    expect(page.buttons('All my tasks')[0]?.getAttribute('href')).toBe('/tasks');
  });

  it('lists the matters I opened lately, latest first', async () => {
    const page = await openToday({ configure: busyDay });
    expect(
      [...(card(page, 'recent')?.querySelectorAll('[data-today-focus]') ?? [])].map((a) => [
        page.text(a),
        a.getAttribute('href'),
      ]),
    ).toEqual([
      ['M-2026-0142 Estate of Margaret Whitfield', '/matters/m-whitfield'],
      ['M-2026-0150 Will for Bram Ostler', '/matters/m-ostler'],
    ]);
  });

  it('counts my open matters, this week’s deadlines and my WIP this month', async () => {
    const page = await openToday({ configure: busyDay });
    expect(stats(page)).toEqual([
      ['Open matters', '2', 'You’re responsible for'],
      ['Deadlines this week', '1', '1 overdue'],
      ['WIP this month', '$0.00', 'Your time not yet billed'],
    ]);
  });

  it('adds up my unbilled billable time this month', async () => {
    const page = await openToday({
      configure: (fs) => {
        busyDay(fs);
        myTime(fs);
      },
    });
    expect(stats(page)[2]).toEqual(['WIP this month', '$740.00', 'Your time not yet billed']);
  });

  it('shows WIP this month to a paralegal, who records time too', async () => {
    const page = await openToday({ session: PARALEGAL, configure: myTime });
    expect(stats(page).map(([label, value]) => [label, value])).toContainEqual(['WIP this month', '$740.00']);
  });

  it('leaves out WIP this month for roles that don’t record time', async () => {
    const page = await openToday({ session: READONLY, configure: myTime });
    expect(stats(page).map(([label]) => label)).toEqual(['Open matters', 'Deadlines this week']);
    expect(page.body.querySelector('[data-stat="wip"]')).toBeNull();
    // Nothing waits on a read that never starts.
    expect(page.body.querySelector('[data-today-loading]')).toBeNull();
  });

  it('celebrates a clear day in plain words', async () => {
    const page = await openToday({ configure: clearDay });
    expect(page.text(card(page, 'attention'))).toContain('Nothing needs attention');
    expect(page.text(card(page, 'due'))).toContain('Your week is clear');
    expect(page.text(card(page, 'tasks'))).toContain('No open tasks with a date');
    expect(page.text(card(page, 'recent'))).toContain('No matters opened yet');
    expect(page.text(page.body.querySelector('.mt-today'))).not.toContain('!');
    expect(card(page, 'onboarding')).toBeNull();
  });

  it('leaves out rows on matters I can’t read, without saying so', async () => {
    const page = await openToday({
      configure: (fs) => {
        busyDay(fs);
        fs.set(SECRET, matterDoc({ number: 'M-2026-0199', title: 'Sealed estate', privileged: true }));
        fs.set(
          `${SECRET}/deadlines/d-sealed`,
          deadlineDoc('Sealed deadline', { matterId: 'm-sealed', dueDate: '2026-10-02' }),
        );
        fs.set(`${SECRET}/tasks/t-sealed`, taskDoc('Sealed task', 'm-sealed', { dueDate: '2026-10-05' }));
        fs.set(`users/${ME}/recent/${ORG}_m-sealed`, recentDoc('m-sealed', '2026-10-04T00:00:00Z'));
        fs.denyRead(SECRET);
      },
    });
    const text = page.text(page.body.querySelector('.mt-today'));
    expect(text).not.toContain('Sealed');
    expect(text).not.toContain('Restricted');
    expect(items(page, 'attention')).toContain('Overdue: File the inventory of assets');
  });

  it('leaves out rows on deleted matters', async () => {
    const page = await openToday({
      configure: (fs) => {
        busyDay(fs);
        fs.set(OTHER, { ...(fs.get(OTHER) as Seed), deletedAt: new Date('2026-10-03T00:00:00Z') });
      },
    });
    expect(page.text(page.body.querySelector('.mt-today'))).not.toContain('Draft the will');
  });

  it('shows a checklist while the practice has no matters', async () => {
    const page = await openToday({ session: ADMIN, matter: { deletedAt: new Date('2026-10-01T00:00:00Z') } });
    const steps = card(page, 'onboarding');
    expect(steps).not.toBeNull();
    const rows = [...(steps?.querySelectorAll<HTMLElement>('[data-step]') ?? [])];
    expect(rows.map((row) => row.dataset['step'])).toEqual(['matter', 'team', 'calendar']);
    expect(page.buttons('Create a matter', steps as HTMLElement)[0]?.getAttribute('href')).toBe('/matters/new');
    // The seeded practice already has colleagues.
    expect(rows[1]?.hasAttribute('data-done')).toBe(true);
    const calendar = rows[2] as HTMLElement;
    expect(page.text(calendar)).toContain('Coming soon');
    expect(calendar.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true);
  });

  it('hides Clerk’s brief slot with the brief flag off', async () => {
    const page = await openToday();
    expect(card(page, 'brief')).toBeNull();
  });

  it('shows Clerk’s brief slot with the brief flag on', async () => {
    const page = await openToday({ flags: { 'clerk.features.brief': true } });
    expect(page.text(card(page, 'brief'))).toContain('Your morning brief');
  });

  it('follows the org’s time zone, with a hint when the device differs', async () => {
    const page = await openToday({
      configure: (fs) => fs.set(`orgs/${ORG}`, { name: 'Harbour & Vine Legal', timezone: 'Australia/Perth', ...meta }),
      // 23:30 UTC on Sunday is Monday 7:30 am in Perth and Sunday evening in London.
      providers: [clock(Date.parse('2026-10-04T23:30:00Z')), device('Europe/London')],
    });
    expect(page.text(page.body.querySelector('[data-today-date]'))).toBe('Monday 5 October');
    expect(page.text(page.body.querySelector('h1'))).toBe('Good morning, Jordan');
    expect(page.text(page.body.querySelector('[data-zone-hint]'))).toBe(
      'Dates follow Perth time, the practice’s time zone. This device is on London time.',
    );
  });

  it('says when it is showing what this device saved', async () => {
    const page = await openToday({
      configure: busyDay,
      providers: [{ provide: Connectivity, useValue: { online: signal(false).asReadonly() } }],
    });
    expect(page.text(page.body.querySelector('[data-offline]'))).toContain('You’re offline');
    expect(items(page, 'attention')).toContain('Overdue: File the inventory of assets');
    // Counts need the server.
    expect(stats(page).map(([label, value]) => [label, value])).toEqual([
      ['Open matters', '—'],
      ['Deadlines this week', '—'],
      ['WIP this month', '—'],
    ]);
  });

  it('moves through every row with j and k', async () => {
    const page = await openToday({ configure: busyDay });
    await page.press('j');
    expect(focused(page)).toBe('Overdue: File the inventory of assets');
    await page.press('j', {}, document.activeElement as HTMLElement);
    expect(focused(page)).toBe('Change to review: Advertise notice of intended application');
    await page.press('j', {}, document.activeElement as HTMLElement);
    expect(focused(page)).toBe('Chase the bank valuation');
    await page.press('k', {}, document.activeElement as HTMLElement);
    expect(focused(page)).toBe('Change to review: Advertise notice of intended application');
    for (let i = 0; i < 20; i++) await page.press('j', {}, document.activeElement as HTMLElement);
    expect(focused(page)).toBe('M-2026-0150 Will for Bram Ostler');
  });

  it('completes the focused task with Space, and focus stays in its place', async () => {
    const page = await openToday({ configure: busyDay });
    for (let i = 0; i < 3; i++) await page.press('j', {}, (document.activeElement ?? page.body) as HTMLElement);
    expect(focused(page)).toBe('Chase the bank valuation');
    await page.press(' ', {}, document.activeElement as HTMLElement);
    await page.stable(20);
    await page.stable(20);
    expect((page.firestore.get(`${MATTER}/tasks/t-late`) as Seed)['status']).toBe('done');
    expect(items(page, 'tasks')).not.toContain('Chase the bank valuation');
    expect(focused(page)).toBe('Draft the will');
  });

  it('lists a critical deadline escalated to me, and acknowledges it (CORE-11)', async () => {
    const escalated = (fs: Fs) => {
      busyDay(fs);
      fs.set(
        `${MATTER}/deadlines/d-grant`,
        deadlineDoc('Apply for the grant', {
          dueDate: '2026-10-08',
          critical: true,
          assigneeUid: 'user-daniel',
          escalatedAt: new Date('2026-10-04T21:00:00Z'),
          escalatedTo: [ME],
        }),
      );
      fs.set(
        `${MATTER}/deadlines/d-seen`,
        deadlineDoc('Already acknowledged', {
          dueDate: '2026-10-08',
          critical: true,
          escalatedTo: [ME],
          ackBy: ME,
          ackAt: new Date('2026-10-04T22:00:00Z'),
        }),
      );
    };
    const page = await openToday({ configure: escalated });
    expect(items(page, 'attention')).toEqual([
      'Escalation: Apply for the grant',
      'Overdue: File the inventory of assets',
      'Change to review: Advertise notice of intended application',
    ]);
    await page.click('Acknowledge', card(page, 'attention') as HTMLElement);
    await page.stable(20);
    expect(page.calls('deadlines-acknowledge')).toEqual([
      expect.objectContaining({ matterId: 'm-whitfield', deadlineId: 'd-grant' }),
    ]);
    expect(items(page, 'attention')).toEqual([
      'Overdue: File the inventory of assets',
      'Change to review: Advertise notice of intended application',
    ]);
  });

  it('acknowledges the focused escalation with a', async () => {
    const page = await openToday({
      configure: (fs) => {
        busyDay(fs);
        fs.set(
          `${MATTER}/deadlines/d-grant`,
          deadlineDoc('Apply for the grant', { dueDate: '2026-10-08', critical: true, escalatedTo: [ME] }),
        );
      },
    });
    await page.press('j', {}, (document.activeElement ?? page.body) as HTMLElement);
    expect(focused(page)).toBe('Escalation: Apply for the grant');
    await page.press('a', {}, document.activeElement as HTMLElement);
    await page.stable(20);
    expect(page.calls('deadlines-acknowledge')).toHaveLength(1);
  });

  it('accepts a change waiting on me', async () => {
    const page = await openToday({ configure: busyDay });
    await page.click('Accept', card(page, 'attention') as HTMLElement);
    await page.stable(20);
    expect(page.calls('deadlines-resolveChange')).toEqual([
      expect.objectContaining({ matterId: 'm-whitfield', changeId: 'c-notice', accept: true }),
    ]);
    expect(items(page, 'attention')).toEqual(['Overdue: File the inventory of assets']);
  });
});

describe('recent matters', () => {
  it('records each matter I open', async () => {
    const page = await openMatter('/matters/m-whitfield/overview', { providers: [clock()] });
    await page.stable(20);
    const recent = page.firestore.get(`users/${ME}/recent/${ORG}_m-whitfield`) as Seed | undefined;
    expect(recent?.['orgId']).toBe(ORG);
    expect(recent?.['matterId']).toBe('m-whitfield');
    expect((recent?.['expireAt'] as Date).toISOString()).toBe('2027-01-02T22:00:00.000Z');
  });
});
