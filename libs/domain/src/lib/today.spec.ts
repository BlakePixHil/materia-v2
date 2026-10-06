import { recentEntryId, recentMatterExpireAt, recentMatterId, RecentMatter } from './schemas/views';
import {
  compareDueItems,
  deadlinePriority,
  dueThisWeek,
  greeting,
  greetingFor,
  groupDueItems,
  hourIn,
  longDayLabel,
  monthWindow,
  needsAttention,
  onboardingSteps,
  RECENT_MATTERS_SHOWN,
  TODAY_SECTION_LIMIT,
  TODAY_TASKS_SHOWN,
  timeZoneCity,
  timeZoneHint,
  todayItemKey,
  todayWindow,
  wipThisMonth,
  type TodayChangeLike,
  type TodayDeadlineLike,
  type TodayEscalationLike,
  type TodayTaskLike,
} from './today';
import { dateOnly } from './values/date-only';

/** Today is Monday 5 October 2026 in Melbourne; the week ends Sunday 11 October. Fictional data. */
const TODAY = dateOnly('2026-10-05');
const WINDOW = todayWindow(TODAY);

function deadline(id: string, dueDate: string | undefined, data: Partial<TodayDeadlineLike> = {}): TodayDeadlineLike {
  return { id, matterId: 'm-doyle', title: `Deadline ${id}`, dueDate, critical: false, status: 'upcoming', ...data };
}

function task(id: string, dueDate: string | undefined, data: Partial<TodayTaskLike> = {}): TodayTaskLike {
  return { id, matterId: 'm-doyle', title: `Task ${id}`, dueDate, priority: 'none', status: 'todo', ...data };
}

function change(id: string, data: Partial<TodayChangeLike> = {}): TodayChangeLike {
  return {
    id,
    matterId: 'm-doyle',
    title: `Change ${id}`,
    critical: false,
    intoPast: false,
    status: 'pending',
    ...data,
  };
}

describe('today window', () => {
  it('runs from today to Sunday', () => {
    expect(WINDOW).toEqual({ today: '2026-10-05', weekEnd: '2026-10-11' });
    expect(todayWindow(dateOnly('2026-10-11'))).toEqual({ today: '2026-10-11', weekEnd: '2026-10-11' });
  });

  it('has the documented limits', () => {
    expect(TODAY_SECTION_LIMIT).toBe(50);
    expect(TODAY_TASKS_SHOWN).toBe(8);
    expect(RECENT_MATTERS_SHOWN).toBe(8);
  });

  it('keys rows by kind, matter and id', () => {
    expect(todayItemKey('deadline', { id: 'd-1', matterId: 'm-1' })).toBe('deadline:m-1/d-1');
    expect(todayItemKey('task', { id: 't-1', matterId: null })).toBe('task:personal/t-1');
  });
});

describe('needs attention', () => {
  it('puts urgent changes, escalations, overdue deadlines, then other changes', () => {
    const escalations: TodayEscalationLike[] = [
      { id: 'e-1', matterId: 'm-doyle', title: 'Escalated: serve affidavit' },
    ];
    const section = needsAttention(
      {
        overdue: [
          deadline('late-2', '2026-10-03'),
          deadline('late-1', '2026-10-01'),
          deadline('late-crit', '2026-10-03', { critical: true }),
          deadline('today', '2026-10-05'),
          deadline('done', '2026-10-01', { status: 'done' }),
          deadline('deleted', '2026-10-01', { deletedAt: new Date() }),
          deadline('blocked', undefined, { status: 'blocked' }),
        ],
        changes: [
          change('c-plain'),
          change('c-urgent', { critical: true, intoPast: true }),
          change('c-decided', { status: 'accepted' }),
        ],
        escalations,
      },
      TODAY,
    );
    expect(section.items.map((item) => `${item.kind}:${item.row.id}`)).toEqual([
      'change:c-urgent',
      'escalation:e-1',
      'overdue:late-1',
      'overdue:late-crit',
      'overdue:late-2',
      'change:c-plain',
    ]);
    expect(section.items[0]).toMatchObject({ urgent: true, key: 'change:m-doyle/c-urgent' });
    expect(section.items.at(-1)).toMatchObject({ urgent: false });
    expect(section).toMatchObject({ total: 6, truncated: false });
  });

  it('is empty on a clear day', () => {
    expect(needsAttention({ overdue: [], changes: [], escalations: [] }, TODAY)).toEqual({
      items: [],
      total: 0,
      truncated: false,
    });
  });

  it('shows at most the limit and says how many there were', () => {
    const overdue = Array.from({ length: 55 }, (_, i) => deadline(`d-${String(i).padStart(2, '0')}`, '2026-10-01'));
    const section = needsAttention({ overdue, changes: [change('c-1')], escalations: [] }, TODAY);
    expect(section.items).toHaveLength(TODAY_SECTION_LIMIT);
    expect(section).toMatchObject({ total: 56, truncated: true });
    expect(needsAttention({ overdue, changes: [], escalations: [] }, TODAY, 3).items).toHaveLength(3);
  });

  it('orders overdue deadlines on a day by time, then title', () => {
    const section = needsAttention(
      {
        overdue: [
          deadline('b', '2026-10-02', { title: 'B', dueTime: '14:00' }),
          deadline('a', '2026-10-02', { title: 'A' }),
          deadline('c', '2026-10-02', { title: 'C', dueTime: '09:00' }),
          deadline('d', '2026-10-02', { title: 'A' }),
        ],
        changes: [],
        escalations: [],
      },
      TODAY,
    );
    expect(section.items.map((item) => item.row.id)).toEqual(['c', 'b', 'a', 'd']);
  });
});

describe('due today and this week', () => {
  it('merges deadlines and tasks by due date, then priority', () => {
    const section = dueThisWeek(
      {
        deadlines: [
          deadline('d-wed', '2026-10-07'),
          deadline('d-today-crit', '2026-10-05', { critical: true }),
          deadline('d-today', '2026-10-05'),
          deadline('d-overdue', '2026-10-02'),
          deadline('d-next-week', '2026-10-12'),
          deadline('d-done', '2026-10-06', { status: 'done' }),
          deadline('d-deleted', '2026-10-06', { deletedAt: new Date() }),
          deadline('d-blocked', undefined, { status: 'blocked' }),
        ],
        tasks: [
          task('t-today-urgent', '2026-10-05', { priority: 'urgent' }),
          task('t-today-high', '2026-10-05', { priority: 'high' }),
          task('t-today-low', '2026-10-05', { priority: 'low' }),
          task('t-sun', '2026-10-11', { priority: 'medium', matterId: null }),
          task('t-wed', '2026-10-07', { priority: 'urgent' }),
          task('t-done', '2026-10-06', { status: 'done' }),
          task('t-blocked', '2026-10-06', { status: 'blocked' }),
          task('t-undated', undefined),
          task('t-overdue', '2026-10-01'),
          task('t-deleted', '2026-10-06', { deletedAt: new Date() }),
        ],
      },
      WINDOW,
    );
    expect(section.items.map((item) => item.row.id)).toEqual([
      'd-today-crit',
      't-today-urgent',
      'd-today',
      't-today-high',
      't-today-low',
      't-blocked',
      't-wed',
      'd-wed',
      't-sun',
    ]);
    expect(section.items.find((item) => item.row.id === 't-sun')?.key).toBe('task:personal/t-sun');
    expect(section.truncated).toBe(false);
  });

  it('ties on a day: deadlines by time, tasks by order, then title', () => {
    const section = dueThisWeek(
      {
        deadlines: [
          deadline('late', '2026-10-06', { dueTime: '16:00', title: 'A' }),
          deadline('early', '2026-10-06', { dueTime: '09:00', title: 'Z' }),
        ],
        tasks: [
          task('second', '2026-10-06', { priority: 'high', order: 2 }),
          task('first', '2026-10-06', { priority: 'high', order: 1 }),
          task('beta', '2026-10-06', { priority: 'low', title: 'Beta' }),
          task('alpha', '2026-10-06', { priority: 'low', title: 'Alpha' }),
        ],
      },
      WINDOW,
    );
    expect(section.items.map((item) => item.row.id)).toEqual(['early', 'late', 'first', 'second', 'alpha', 'beta']);
  });

  it('cuts at the limit', () => {
    const tasks = Array.from({ length: 60 }, (_, i) => task(`t-${i}`, '2026-10-06'));
    const section = dueThisWeek({ deadlines: [deadline('d', '2026-10-06')], tasks }, WINDOW, TODAY_SECTION_LIMIT);
    expect(section.items).toHaveLength(50);
    expect(section).toMatchObject({ total: 61, truncated: true });
    expect(section.items[0]?.kind).toBe('deadline');
  });

  it('ranks a critical deadline above urgent tasks and any other deadline with high ones', () => {
    expect(deadlinePriority({ critical: true })).toBeLessThan(0);
    expect(deadlinePriority({ critical: false })).toBe(1);
    const a = { kind: 'task' as const, key: 'task:m/a', dueDate: TODAY, rank: 1, row: task('a', TODAY) };
    const b = { kind: 'task' as const, key: 'task:m/b', dueDate: TODAY, rank: 1, row: task('b', TODAY) };
    expect(compareDueItems(a, b)).toBeLessThan(0);
    expect(compareDueItems(b, a)).toBeGreaterThan(0);
    expect(compareDueItems(a, a)).toBe(0);
  });

  it('groups into Today and Later this week, leaving out empty headings', () => {
    const items = dueThisWeek(
      { deadlines: [deadline('d', '2026-10-05')], tasks: [task('t', '2026-10-08')] },
      WINDOW,
    ).items;
    expect(groupDueItems(items, TODAY).map((g) => `${g.label}: ${g.items.map((i) => i.row.id).join(',')}`)).toEqual([
      'Today: d',
      'Later this week: t',
    ]);
    expect(groupDueItems(items.slice(1), TODAY).map((g) => g.id)).toEqual(['this_week']);
    expect(groupDueItems([], TODAY)).toEqual([]);
  });
});

describe('WIP this month', () => {
  const entry = (date: string, amountCents: number, data: Record<string, unknown> = {}) => ({
    date,
    minutes: 60,
    units: 10,
    amountCents,
    billable: true,
    status: 'draft',
    ...data,
  });

  it('runs from the first to the last day of the month', () => {
    expect(monthWindow(TODAY)).toEqual({ start: '2026-10-01', end: '2026-10-31' });
    expect(monthWindow(dateOnly('2026-02-14'))).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(monthWindow(dateOnly('2028-02-29'))).toEqual({ start: '2028-02-01', end: '2028-02-29' });
    expect(monthWindow(dateOnly('2026-12-31'))).toEqual({ start: '2026-12-01', end: '2026-12-31' });
  });

  it('adds up billable drafts and final time this month that isn’t billed', () => {
    const entries = [
      entry('2026-10-01', 44000),
      entry('2026-10-31', 30000, { status: 'final' }),
      // A write-down counts at its reduced value.
      entry('2026-10-05', 12500, { status: 'final', units: 5 }),
      entry('2026-10-02', 22000, { status: 'billed' }),
      entry('2026-10-02', 22000, { status: 'written_off' }),
      entry('2026-10-02', 8800, { billable: false }),
      entry('2026-10-02', 8800, { deletedAt: new Date('2026-10-03T00:00:00Z') }),
      entry('2026-09-30', 44000),
      entry('2026-11-01', 44000),
    ];
    expect(wipThisMonth(entries, TODAY)).toBe(86500);
  });

  it('is nothing without time this month', () => {
    expect(wipThisMonth([], TODAY)).toBe(0);
  });
});

describe('the header', () => {
  it('greets by the time of day in the org’s time zone', () => {
    // 21:30 UTC on 4 October is 8:30 am on 5 October in Melbourne (AEDT, UTC+11).
    const instant = new Date('2026-10-04T21:30:00Z');
    expect(hourIn(instant, 'Australia/Melbourne')).toBe(8);
    expect(hourIn(instant, 'Europe/London')).toBe(22);
    expect(hourIn(new Date('2026-10-04T13:00:00Z'), 'Australia/Melbourne')).toBe(0);
    expect(greetingFor(0)).toBe('Good morning');
    expect(greetingFor(11)).toBe('Good morning');
    expect(greetingFor(12)).toBe('Good afternoon');
    expect(greetingFor(17)).toBe('Good afternoon');
    expect(greetingFor(18)).toBe('Good evening');
    expect(greeting(9, 'Jordan Price')).toBe('Good morning, Jordan');
    expect(greeting(14, '  Priya  ')).toBe('Good afternoon, Priya');
    expect(greeting(20, '')).toBe('Good evening');
    expect(greeting(20, null)).toBe('Good evening');
    expect(greeting(9, 'lawyer@harbourvine.example')).toBe('Good morning');
  });

  it('reads the date as Monday 5 October', () => {
    expect(longDayLabel(TODAY)).toBe('Monday 5 October');
    expect(longDayLabel(dateOnly('2027-01-01'))).toBe('Friday 1 January');
  });

  it('names a time zone by its city', () => {
    expect(timeZoneCity('Australia/Melbourne')).toBe('Melbourne');
    expect(timeZoneCity('America/Argentina/Buenos_Aires')).toBe('Buenos Aires');
    expect(timeZoneCity('UTC')).toBe('UTC');
  });

  it('hints when the device’s time zone shows a different time', () => {
    const now = new Date('2026-10-04T21:30:00Z');
    expect(timeZoneHint('Australia/Melbourne', 'Australia/Melbourne', now)).toBeNull();
    expect(timeZoneHint('Australia/Melbourne', null, now)).toBeNull();
    // Hobart keeps the same clock as Melbourne: no hint.
    expect(timeZoneHint('Australia/Melbourne', 'Australia/Hobart', now)).toBeNull();
    expect(timeZoneHint('Australia/Melbourne', 'Europe/London', now)).toEqual({
      org: 'Melbourne',
      device: 'London',
      deviceToday: '2026-10-04',
    });
    // Brisbane has no daylight saving: an hour behind Melbourne in October.
    expect(timeZoneHint('Australia/Melbourne', 'Australia/Brisbane', now)).toMatchObject({ device: 'Brisbane' });
    expect(timeZoneHint('Australia/Melbourne', 'Not/AZone', now)).toBeNull();
  });
});

describe('onboarding', () => {
  it('asks a new practice’s owner to create a matter, invite the team and (soon) connect a calendar', () => {
    const steps = onboardingSteps({ matterCount: 0, memberCount: 1, canCreateMatter: true, canInvite: true });
    expect(steps.map((s) => [s.id, s.done, s.comingSoon])).toEqual([
      ['matter', false, false],
      ['team', false, false],
      ['calendar', false, true],
    ]);
    for (const step of steps) expect(`${step.label} ${step.description}`).not.toContain('!');
  });

  it('ticks what is done and leaves out what the role can’t do', () => {
    const owner = onboardingSteps({ matterCount: 1, memberCount: 3, canCreateMatter: true, canInvite: true });
    expect(owner.filter((s) => s.done).map((s) => s.id)).toEqual(['matter', 'team']);
    const readonly = onboardingSteps({ matterCount: 0, memberCount: 3, canCreateMatter: false, canInvite: false });
    expect(readonly.map((s) => s.id)).toEqual(['calendar']);
  });
});

describe('recent matters', () => {
  it('has one entry per org and matter that expires 90 days after it was opened', () => {
    expect(recentMatterId('org-hv', 'm-doyle')).toBe('org-hv_m-doyle');
    const opened = new Date('2026-10-05T00:00:00Z');
    expect(recentMatterExpireAt(opened).toISOString()).toBe('2027-01-03T00:00:00.000Z');
    const meta = { createdAt: opened, createdBy: 'u', updatedAt: opened, updatedBy: 'u', schemaVersion: 1 };
    const valid = { orgId: 'org-hv', matterId: 'm-doyle', expireAt: recentMatterExpireAt(opened), ...meta };
    // Entries from before CORE-15 have no kind: they are matters.
    expect(RecentMatter.schema.parse(valid).kind).toBe('matter');
    expect(RecentMatter.schema.safeParse({ ...valid, title: 'Estate of Margaret Doyle' }).success).toBe(false);
    expect(RecentMatter.schema.safeParse({ ...valid, matterId: 'a/b' }).success).toBe(false);
    expect(RecentMatter.schema.safeParse({ ...valid, kind: 'invoice' }).success).toBe(false);
    expect(Object.keys(RecentMatter.update.shape).sort()).toEqual([
      'entityId',
      'expireAt',
      'kind',
      'matterId',
      'orgId',
    ]);
  });

  it('names contacts, tasks and documents by kind, matter and id (CORE-15)', () => {
    expect(recentEntryId('org-hv', { kind: 'matter', matterId: 'm-doyle' })).toBe('org-hv_m-doyle');
    expect(recentEntryId('org-hv', { kind: 'contact', entityId: 'c-1' })).toBe('org-hv_contact_c-1');
    expect(recentEntryId('org-hv', { kind: 'task', matterId: 'm-doyle', entityId: 'tpl-grant' })).toBe(
      'org-hv_task_m-doyle_tpl-grant',
    );
    expect(recentEntryId('org-hv', { kind: 'task', entityId: 't-1' })).toBe('org-hv_task_t-1');
    expect(recentEntryId('org-hv', { kind: 'document', matterId: 'm-doyle', entityId: 'd-1' })).toBe(
      'org-hv_document_m-doyle_d-1',
    );
  });
});
