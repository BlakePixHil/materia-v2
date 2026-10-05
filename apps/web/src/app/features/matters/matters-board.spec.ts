import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { TENANCY_PORT } from '@materia/data-access';
import { InMemoryFirestore, provideInMemoryFirestore } from '@materia/data-access/repository';
import { contactSearchTokens, matterSearchTokens, ORDER_STEP, type DateOnly } from '@materia/domain';
import { MT_KEYBOARD_PLATFORM, MT_TODAY } from '@materia/ui';

import {
  boardColumns,
  boardFilters,
  boardKind,
  buildLanes,
  cardSpots,
  columnIndex,
  columnOf,
  movedCards,
  onBoard,
  placeCards,
  type BoardCard,
} from './matters-board-view';
import { LAYOUT_KEY, readLayout, readSwimlanes, writeLayout, writeSwimlanes } from './matters-layout';
import type { MatterRow } from './matters-view';
import { App } from '../../app';
import { appRoutes } from '../../app.routes';
import { AUTH_PORT, type AuthSession } from '../../core/auth/auth-port';
import { FakeAuthPort, testSession } from '../../core/auth/testing';
import { provideTestFlags } from '../../core/flags/testing';
import { FakeTenancyPort } from '../../core/orgs/testing';

/** The Matters board (CORE-04) against the in-memory Firestore and a fake callable transport. Fictional data only. */

const ORG = 'org-harbour-vine';
const MATTERS = `orgs/${ORG}/matters`;
const TODAY = '2026-10-04' as DateOnly;
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const ME = 'user-jordan';
const PRIYA = 'user-priya';
const LAWYER = testSession();
const PARALEGAL = testSession({ claims: { orgId: ORG, role: 'paralegal', orgName: 'Harbour & Vine Legal' } });

type Seed = Record<string, unknown>;

const meta = {
  createdAt: new Date('2026-09-01T00:00:00Z'),
  createdBy: ME,
  updatedAt: new Date('2026-09-01T00:00:00Z'),
  updatedBy: ME,
  schemaVersion: 1,
};

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
    search: matterSearchTokens({ number: data.number, title: data.title, clientNames: ['Avery Quill'] }),
    lastActivityAt: new Date(Date.parse('2026-10-04T00:00:00Z') - daysAgo * 86_400_000),
    deletedAt: null,
    ...meta,
    ...rest,
  };
}

function seed(fs: InMemoryFirestore): void {
  const member = (uid: string, displayName: string, role: string) =>
    fs.set(`orgs/${ORG}/members/${uid}`, { displayName, email: `${uid}@example.test`, role, status: 'active' });
  member(ME, 'Jordan Price', 'lawyer');
  member(PRIYA, 'Priya Shah', 'owner');
  fs.set(`orgs/${ORG}/contacts/c-avery`, {
    kind: 'person',
    givenNames: 'Avery',
    familyName: 'Quill',
    emails: [],
    phones: [],
    addresses: [],
    tags: [],
    isReferrer: false,
    search: contactSearchTokens({ givenNames: 'Avery', familyName: 'Quill' }),
    ...meta,
  });
  const matter = (id: string, data: Seed & { number: string; title: string; daysAgo?: number }) =>
    fs.set(`${MATTERS}/${id}`, matterDoc(data));
  matter('m-whitfield', {
    number: 'M-2026-0142',
    title: 'Estate of Margaret Whitfield',
    stageId: 'notice',
    openTaskCount: 3,
    teamUids: [PRIYA],
    nextDeadline: { id: 'd1', dueDate: '2026-10-08', title: 'Advertise notice', critical: false },
    daysAgo: 1,
  });
  matter('m-okafor', { number: 'M-2026-0151', title: 'Harriet and Paul Okafor', type: 'will', daysAgo: 2 });
  matter('m-chen', { number: 'M-2026-0118', title: 'Estate of Robert Chen', responsibleUid: PRIYA, daysAgo: 3 });
  matter('m-lambert', { number: 'M-2026-0160', title: 'Estate of George Lambert', status: 'lead', daysAgo: 4 });
  matter('m-pemble', { number: 'M-2026-0170', title: 'Estate of Cyrus Pemble', status: 'on_hold', daysAgo: 5 });
  matter('m-closed', {
    number: 'M-2026-0101',
    title: 'Estate of Ida Closed',
    status: 'closed',
    closedAt: new Date('2026-09-30T00:00:00Z'),
    daysAgo: 6,
  });
  matter('m-old', {
    number: 'M-2025-0099',
    title: 'Estate of Long Ago',
    status: 'closed',
    closedAt: new Date('2026-06-01T00:00:00Z'),
    daysAgo: 7,
  });
}

interface Options {
  configure?: (port: FakeAuthPort, firestore: InMemoryFirestore) => void;
  flags?: Record<string, boolean>;
}

async function open(url: string, session: AuthSession = LAWYER, options: Options = {}) {
  const port = new FakeAuthPort(session);
  const firestore = new InMemoryFirestore();
  seed(firestore);
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
      ...provideTestFlags(options.flags ?? {}),
    ],
  });
  const fixture = TestBed.createComponent(App);
  const router = TestBed.inject(Router);
  await router.navigateByUrl(url);
  const body = document.body;
  const stable = async (ms = 0) => {
    await settle(ms);
    await fixture.whenStable();
    await settle();
    await fixture.whenStable();
  };
  await stable(20);
  // The board is loaded on first use.
  for (
    let i = 0;
    i < 50 && router.url.startsWith('/matters/board') && !body.querySelector('mt-matters-board .column');
    i++
  ) {
    await stable(20);
  }
  const columns = () => [...body.querySelectorAll<HTMLElement>('mt-matters-board .column')];
  const column = (title: string) =>
    columns().find((c) => c.querySelector('.col-title')?.textContent?.trim() === title) ?? null;
  const cards = (title: string) =>
    [...(column(title)?.querySelectorAll<HTMLElement>('.card') ?? [])].map((c) =>
      c.querySelector('.name')?.textContent?.trim(),
    );
  const card = (name: string) =>
    [...body.querySelectorAll<HTMLElement>('mt-matters-board .card')].find(
      (c) => c.querySelector('.name')?.textContent?.trim() === name,
    ) ?? null;
  const press = async (
    key: string,
    init: KeyboardEventInit = {},
    target: EventTarget | null = document.activeElement,
  ) => {
    (target ?? body).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
    await stable();
  };
  const menuItem = (text: string) =>
    [...body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent?.trim() === text) ?? null;
  const focus = async (name: string) => {
    card(name)?.querySelector<HTMLElement>('.name')?.focus();
    await stable();
  };
  /** Focuses a card, presses `m` and picks a column from "Move to…". */
  const moveWithMenu = async (name: string, to: string) => {
    await focus(name);
    await press('m');
    const item = menuItem(to);
    if (!item)
      throw new Error(
        `No "${to}" in ${[...body.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent?.trim())}`,
      );
    item.click();
    await stable(10);
  };
  return {
    port,
    firestore,
    router,
    body,
    stable,
    columns,
    column,
    cards,
    card,
    press,
    menuItem,
    focus,
    moveWithMenu,
    live: () => body.querySelector('mt-matters-board [aria-live]')?.textContent?.trim() ?? '',
    text: () => body.textContent?.replace(/\s+/g, ' ') ?? '',
    titles: () => columns().map((c) => c.querySelector('.col-title')?.textContent?.trim()),
  };
}

beforeEach(() => localStorage.clear());

afterEach(() => {
  document.querySelectorAll('.mt-overlay, .mt-toast-region, [data-overlay]').forEach((node) => node.remove());
});

describe('matters board', () => {
  it('shows the view’s matters as cards in status columns, closed only for 30 days', async () => {
    const page = await open('/matters/board?view=all-open');
    expect(page.router.url).toBe('/matters/board?view=all-open');
    expect(page.titles()).toEqual(['Lead', 'Open', 'On hold', 'Closed']);
    expect(page.cards('Lead')).toEqual(['Estate of George Lambert']);
    expect(page.cards('Open')).toEqual([
      'Estate of Margaret Whitfield',
      'Harriet and Paul Okafor',
      'Estate of Robert Chen',
    ]);
    expect(page.cards('On hold')).toEqual(['Estate of Cyrus Pemble']);
    expect(page.cards('Closed')).toEqual(['Estate of Ida Closed']);
    // The status filter gives way to the board's columns, and says so.
    expect(page.text()).toContain('the status filter applies to the list only');
    const whitfield = page.card('Estate of Margaret Whitfield');
    expect(whitfield?.textContent).toContain('M-2026-0142');
    expect(whitfield?.textContent).toContain('Avery Quill');
    expect(whitfield?.textContent).toContain('Probate');
    expect(whitfield?.textContent).toContain('3 open tasks');
    expect(whitfield?.querySelector('mt-deadline-chip')).not.toBeNull();
    expect(
      whitfield?.querySelectorAll('mt-avatar-group [aria-label], mt-avatar-group mt-avatar').length,
    ).toBeGreaterThan(0);
    // The layout is remembered: /matters reopens the board.
    expect(localStorage.getItem(LAYOUT_KEY)).toBe('board');
  });

  it('switches between the list and the board, keeping the view', async () => {
    const page = await open('/matters?view=leads');
    expect(page.columns()).toHaveLength(0);
    const board = [...page.body.querySelectorAll<HTMLElement>('.mt-seg-item')].find(
      (b) => b.textContent?.trim() === 'Board',
    );
    board?.click();
    await page.stable(20);
    expect(page.router.url).toBe('/matters/board?view=leads');
    expect(page.cards('Lead')).toEqual(['Estate of George Lambert']);
    TestBed.resetTestingModule();

    const again = await open('/matters?view=leads');
    expect(again.router.url).toBe('/matters/board?view=leads');
    const list = [...again.body.querySelectorAll<HTMLElement>('.mt-seg-item')].find(
      (b) => b.textContent?.trim() === 'List',
    );
    list?.click();
    await again.stable(20);
    expect(again.router.url).toBe('/matters?view=leads');
    expect(readLayout()).toBe('list');
  });

  it('moves a card with the keyboard: m opens "Move to…", the server validates, the order is saved', async () => {
    const page = await open('/matters/board?view=all-open', LAWYER, {
      configure: (port) => {
        port.call = async <T>(name: string, data: unknown): Promise<T> => {
          port.calls.push({ name, data });
          return { matterId: (data as { matterId: string }).matterId, status: 'on_hold' } as T;
        };
      },
    });
    await page.moveWithMenu('Estate of Margaret Whitfield', 'On hold');
    expect(page.port.calls[0]?.name).toBe('matters-changeStatus');
    expect(page.port.calls[0]?.data).toMatchObject({ matterId: 'm-whitfield', to: 'on_hold' });
    // Shown in On hold straight away (the server's write comes back through the listener).
    expect(page.cards('On hold')).toEqual(['Estate of Margaret Whitfield', 'Estate of Cyrus Pemble']);
    // Pemble has no order yet, so the column is rebalanced in its order on screen.
    expect(page.port.calls.length).toBe(2);
    expect(page.port.calls[1]).toMatchObject({
      name: 'matters-rebalanceBoard',
      data: { matterIds: ['m-whitfield', 'm-pemble'] },
    });
    expect(page.live()).toBe('Moved M-2026-0142 to On hold, 1 of 2.');
    expect(document.activeElement?.textContent?.trim()).toBe('Estate of Margaret Whitfield');
  });

  it('puts a refused move back and says why', async () => {
    const page = await open('/matters/board?view=all-open', LAWYER, {
      configure: (port) => {
        port.call = async <T>(name: string, data: unknown): Promise<T> => {
          port.calls.push({ name, data });
          throw {
            code: 'functions/failed-precondition',
            details: { code: 'FAILED_PRECONDITION', reason: 'conflict_check_not_clear', conflictStatus: 'pending' },
          };
        };
      },
    });
    await page.moveWithMenu('Estate of George Lambert', 'Open');
    expect(page.cards('Lead')).toEqual(['Estate of George Lambert']);
    expect(page.cards('Open')).not.toContain('Estate of George Lambert');
    expect(page.text()).toContain('Couldn’t move M-2026-0160 to Open');
    expect(page.text()).toContain('The conflict check needs a lawyer’s determination before the matter can open.');
    expect(page.live()).toContain('Couldn’t move M-2026-0160 to Open.');
    expect(page.firestore.writes.filter((w) => w.op === 'update')).toEqual([]);
  });

  it('reorders within a column with Alt+↑/↓, writing the midpoint', async () => {
    const page = await open('/matters/board?view=all-open', LAWYER, {
      configure: (_port, fs) => {
        fs.set(`${MATTERS}/m-whitfield`, { ...fs.get(`${MATTERS}/m-whitfield`), boardOrder: ORDER_STEP });
        fs.set(`${MATTERS}/m-okafor`, { ...fs.get(`${MATTERS}/m-okafor`), boardOrder: 2 * ORDER_STEP });
        fs.set(`${MATTERS}/m-chen`, { ...fs.get(`${MATTERS}/m-chen`), boardOrder: 3 * ORDER_STEP });
      },
    });
    await page.focus('Estate of Margaret Whitfield');
    await page.press('ArrowDown', { altKey: true });
    await page.stable(10);
    expect(page.cards('Open')).toEqual([
      'Harriet and Paul Okafor',
      'Estate of Margaret Whitfield',
      'Estate of Robert Chen',
    ]);
    expect(page.firestore.writes.filter((w) => w.op === 'update').map((w) => [w.path, w.data?.['boardOrder']])).toEqual(
      [[`${MATTERS}/m-whitfield`, 2.5 * ORDER_STEP]],
    );
    expect(page.port.calls).toEqual([]);
    expect(page.live()).toBe('Moved M-2026-0142 to Open, 2 of 3.');
    expect(document.activeElement?.textContent?.trim()).toBe('Estate of Margaret Whitfield');

    // Arrows move focus; the last card can't go further down.
    await page.press('ArrowDown');
    expect(document.activeElement?.textContent?.trim()).toBe('Estate of Robert Chen');
    await page.press('ArrowDown', { altKey: true });
    expect(page.live()).toBe('M-2026-0118 is already last in Open.');
    await page.press('ArrowLeft');
    expect(document.activeElement?.textContent?.trim()).toBe('Estate of George Lambert');
    await page.press('ArrowRight');
    expect(document.activeElement?.textContent?.trim()).toBe('Harriet and Paul Okafor');
  });

  it('flashes a card someone else moved', async () => {
    const page = await open('/matters/board?view=all-open');
    page.firestore.set(`${MATTERS}/m-chen`, { ...page.firestore.get(`${MATTERS}/m-chen`), status: 'on_hold' });
    await page.stable(10);
    expect(page.cards('On hold')).toContain('Estate of Robert Chen');
    expect(page.card('Estate of Robert Chen')?.hasAttribute('data-flash')).toBe(true);
    expect(page.card('Estate of Cyrus Pemble')?.hasAttribute('data-flash')).toBe(false);
  });

  it('groups rows by responsible lawyer with swimlanes', async () => {
    const page = await open('/matters/board?view=all-open');
    const toggle = [...page.body.querySelectorAll<HTMLElement>('button')].find((b) =>
      b.textContent?.includes('Swimlanes by responsible'),
    );
    toggle?.click();
    await page.stable();
    expect(toggle?.getAttribute('aria-pressed')).toBe('true');
    expect(readSwimlanes()).toBe(true);
    const lanes = [...page.body.querySelectorAll<HTMLElement>('mt-matters-board .lane-head')].map((h) =>
      [...h.querySelectorAll(':scope > span')].map((s) => s.textContent?.trim()).join(' '),
    );
    expect(lanes).toEqual(['Jordan Price 5', 'Priya Shah 1']);
    expect(page.columns()).toHaveLength(8);
  });

  it('by stage when one type is filtered: refused moves name what to record', async () => {
    const page = await open('/matters/board?view=all-open', LAWYER, {
      configure: (port, fs) => {
        fs.set(`users/${ME}/views/v-probate`, {
          orgId: ORG,
          list: 'matters',
          name: 'Probate',
          filters: { type: ['probate'] },
          sort: { field: 'lastActivity', dir: 'desc' },
          groupBy: 'none',
          ...meta,
        });
        port.call = async <T>(name: string, data: unknown): Promise<T> => {
          port.calls.push({ name, data });
          throw {
            code: 'functions/failed-precondition',
            details: { code: 'MATTER_STAGE_REQUIREMENTS', requirements: ['grantDate'], events: [] },
          };
        };
      },
    });
    await page.router.navigateByUrl('/matters/board?view=v-probate');
    await page.stable(20);
    expect(page.titles()[0]).toBe('Intake');
    expect(page.cards('Intake')).toEqual([
      'Estate of Robert Chen',
      'Estate of George Lambert',
      'Estate of Cyrus Pemble',
    ]);
    // Whitfield's stage isn't one of probate's: it shows under "Other stages".
    expect(page.cards('Other stages')).toEqual(['Estate of Margaret Whitfield']);
    const target = 'Grant issued';
    await page.moveWithMenu('Estate of Margaret Whitfield', target);
    expect(page.port.calls[0]).toMatchObject({ name: 'matters-changeStage', data: { matterId: 'm-whitfield' } });
    expect(page.text()).toContain(`Couldn’t move M-2026-0142 to ${target}`);
    expect(page.text()).toContain('Record first: Grant date.');
  });

  it('paralegals reorder and move stages, but not statuses', async () => {
    const page = await open('/matters/board?view=all-open', PARALEGAL);
    await page.focus('Estate of Margaret Whitfield');
    await page.press('m');
    expect(
      page.menuItem('On hold')?.getAttribute('aria-disabled') ?? page.menuItem('On hold')?.hasAttribute('disabled'),
    ).toBeTruthy();
  });
});

describe('matters board helpers', () => {
  const row = (id: string, extra: Partial<MatterRow> = {}) =>
    ({
      id,
      status: 'open',
      responsibleUid: ME,
      lastActivityAt: new Date('2026-10-01T00:00:00Z'),
      ...extra,
    }) as MatterRow;
  const card = (id: string, column: string, boardOrder?: number): BoardCard => ({
    row: row(id),
    column,
    boardOrder,
  });

  it('remembers the layout and swimlanes', () => {
    expect(readLayout()).toBe('list');
    writeLayout('board');
    expect(readLayout()).toBe('board');
    writeSwimlanes(true);
    expect(readSwimlanes()).toBe(true);
    writeSwimlanes(false);
    expect(readSwimlanes()).toBe(false);
  });

  it('picks status or stage columns and the filters to read with', () => {
    expect(boardKind({ type: ['probate'] })).toBe('stage');
    expect(boardKind({ type: ['probate', 'will'] })).toBe('status');
    expect(boardColumns(null, false).map((c) => c.id)).toEqual([
      'status:lead',
      'status:open',
      'status:on_hold',
      'status:closed',
    ]);
    const stages = boardColumns('will', true);
    expect(stages.at(-1)).toMatchObject({ id: 'stage:__other', droppable: false });
    expect(stages[0]?.kind).toBe('stage');
    expect(boardFilters({ status: ['open'], closedWithinDays: 30, label: 'x' }, 'status')).toEqual({
      status: ['lead', 'open', 'on_hold', 'closed'],
      label: 'x',
    });
    expect(boardFilters({ type: ['will'] }, 'stage')).toEqual({ type: ['will'], status: ['lead', 'open', 'on_hold'] });
    expect(boardFilters({ type: ['will'], status: ['closed'] }, 'stage')).toEqual({
      type: ['will'],
      status: ['closed'],
    });
  });

  it('places matters in columns, closed ones only for 30 days', () => {
    const now = new Date('2026-10-04T00:00:00Z');
    expect(onBoard(row('a', { status: 'closed', closedAt: new Date('2026-09-10T00:00:00Z') }), 'status', now)).toBe(
      true,
    );
    expect(onBoard(row('a', { status: 'closed', closedAt: new Date('2026-08-10T00:00:00Z') }), 'status', now)).toBe(
      false,
    );
    expect(onBoard(row('a', { status: 'closed' }), 'status', now)).toBe(false);
    expect(onBoard(row('a', { status: 'closed' }), 'stage', now)).toBe(true);
    const stages = boardColumns('probate', false);
    expect(columnOf({ status: 'open', stageId: undefined }, stages)).toBe(stages[0]?.id);
    expect(columnOf({ status: 'open', stageId: 'nowhere' }, stages)).toBe('stage:__other');
    expect(columnOf({ status: 'lead', stageId: 'x' }, boardColumns(null, false))).toBe('status:lead');
    expect(columnOf({ status: 'lead', stageId: 'x' }, [])).toBe('stage:__other');
    // "Other stages" shows only when a card is in it.
    const lanes = buildLanes(placeCards([row('a', { stageId: 'nowhere' })], stages, new Map()), stages, null);
    expect(lanes[0]?.cells.at(-1)?.column.id).toBe('stage:__other');
    expect(buildLanes([], stages, null)[0]?.cells.some((c) => c.column.id === 'stage:__other')).toBe(false);
  });

  it('maps a drop in a swimlane to the whole column', () => {
    const column = [card('a', 'c', 1), card('b', 'c', 2), card('x', 'c', 3), card('c', 'c', 4)];
    const lane = [card('a', 'c', 1), card('c', 'c', 4)];
    expect(columnIndex(column, lane, 'x', 0)).toBe(0);
    expect(columnIndex(column, lane, 'x', 1)).toBe(1);
    expect(columnIndex(column, lane, 'x', 2)).toBe(3);
    expect(columnIndex(column, [], 'x', 0)).toBe(3);
  });

  it('spots cards someone else moved, but not a rebalance', () => {
    const columns = boardColumns(null, false);
    const before = cardSpots(
      [row('a', { boardOrder: 1 }), row('b', { boardOrder: 2 }), row('c', { status: 'lead' })],
      columns,
    );
    const rebalanced = cardSpots(
      [row('a', { boardOrder: 1024 }), row('b', { boardOrder: 2048 }), row('c', { status: 'lead' })],
      columns,
    );
    expect(movedCards(before, rebalanced)).toEqual([]);
    const swapped = cardSpots(
      [row('a', { boardOrder: 3 }), row('b', { boardOrder: 2 }), row('c', { status: 'open' })],
      columns,
    );
    expect(movedCards(before, swapped).sort()).toEqual(['a', 'c']);
    expect(movedCards(new Map(), swapped)).toEqual([]);
  });
});
