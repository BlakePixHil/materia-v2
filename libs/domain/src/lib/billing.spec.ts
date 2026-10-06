import {
  awaitingApproval,
  billableShare,
  centsToDecimal,
  csvCell,
  dayTotals,
  fyBoundaryIn,
  fyBudgetSummary,
  fyTotals,
  fyWindow,
  isUnbilledWip,
  planWriteDown,
  RejectTimeEntriesInput,
  sentBack,
  TimeExportInput,
  timeEntriesCsv,
  TimeWriteDownInput,
  weekDatesOf,
  weekStartOf,
  wipByMatter,
  wipRows,
  type BillingEntryLike,
  type WipMatterLike,
} from './billing';
import { dateOnly, today, type DateOnly } from './values/date-only';

/** BILL-03 domain rules. Every person, matter and amount is fictional. */
const d = (value: string) => dateOnly(value);
const REQUEST = '7f0c1a52-5d0b-4f60-9a43-0d1bb1e5a6f1';

const entry = (extra: Partial<BillingEntryLike> = {}): BillingEntryLike => ({
  date: '2026-10-01',
  minutes: 30,
  units: 5,
  amountCents: 22000,
  billable: true,
  status: 'draft',
  ...extra,
});

describe('financial years', () => {
  it('runs July to June, with 30 June and 1 July in different years', () => {
    expect(fyWindow(d('2026-06-30'))).toEqual({
      startYear: 2025,
      start: '2025-07-01',
      end: '2026-06-30',
      label: 'FY2025–26',
    });
    expect(fyWindow(d('2026-07-01'))).toEqual({
      startYear: 2026,
      start: '2026-07-01',
      end: '2027-06-30',
      label: 'FY2026–27',
    });
  });

  it('follows the org’s start month, including a calendar year', () => {
    expect(fyWindow(d('2026-03-15'), 1)).toMatchObject({ startYear: 2026, start: '2026-01-01', end: '2026-12-31' });
    expect(fyWindow(d('2026-03-15'), 4)).toMatchObject({ startYear: 2025, start: '2025-04-01', end: '2026-03-31' });
  });
});

describe('weeks', () => {
  it('starts on Monday and finds the FY boundary inside a week', () => {
    expect(weekStartOf(d('2026-07-01'))).toBe('2026-06-29');
    expect(weekStartOf(d('2026-06-29'))).toBe('2026-06-29');
    expect(weekStartOf(d('2026-07-05'))).toBe('2026-06-29');
    const week = weekDatesOf(d('2026-07-01'));
    expect(week).toEqual([
      '2026-06-29',
      '2026-06-30',
      '2026-07-01',
      '2026-07-02',
      '2026-07-03',
      '2026-07-04',
      '2026-07-05',
    ]);
    expect(fyBoundaryIn(week)).toBe('2026-07-01');
    expect(fyBoundaryIn(weekDatesOf(d('2026-10-07')))).toBeNull();
  });
});

describe('totals', () => {
  it('splits billable minutes from the rest and ignores deleted entries', () => {
    expect(
      billableShare([
        entry({ minutes: 90 }),
        entry({ minutes: 30, billable: false }),
        entry({ minutes: 600, deletedAt: new Date() }),
      ]),
    ).toEqual({ minutes: 120, billableMinutes: 90, pct: 75 });
    expect(billableShare([]).pct).toBeNull();
  });

  it('counts recorded value in the year (not written off, not non-billable) and billed value', () => {
    const window = fyWindow(d('2026-07-01'));
    expect(
      fyTotals(
        [
          entry({ date: '2026-06-30', amountCents: 50000 }),
          entry({ date: '2026-07-01', amountCents: 10000 }),
          entry({ date: '2026-08-01', amountCents: 20000, status: 'final' }),
          entry({ date: '2026-09-01', amountCents: 30000, status: 'billed' }),
          entry({ date: '2026-09-02', amountCents: 40000, status: 'written_off' }),
          entry({ date: '2026-09-03', amountCents: 5000, billable: false }),
          entry({ date: '2026-09-04', amountCents: 7000, deletedAt: new Date() }),
          entry({ date: '2027-07-01', amountCents: 9000 }),
        ],
        window,
      ),
    ).toEqual({ recordedCents: 60000, billedCents: 30000 });
  });
});

describe('fyBudgetSummary', () => {
  const budgets = { '2025': 36_500_00, '2026': 62_000_000 };
  const entries = [
    entry({ date: '2026-06-30', amountCents: 1_000_000, status: 'billed' }),
    entry({ date: '2026-07-01', amountCents: 200_000, status: 'final' }),
    entry({ date: '2026-07-02', amountCents: 100_000, status: 'billed' }),
  ];

  it('on 30 June reads last year’s budget and entries, all of the year gone (fake clock)', () => {
    const now = new Date('2026-06-30T13:59:00Z'); // 11:59 pm on 30 June in Melbourne
    const summary = fyBudgetSummary({ budgets, entries, today: today('Australia/Melbourne', now) });
    expect(summary.window.startYear).toBe(2025);
    expect(summary).toMatchObject({
      budgetCents: 36_500_00,
      recordedCents: 1_000_000,
      billedCents: 1_000_000,
      recordedPct: 27,
      elapsedPct: 100,
      expectedCents: 36_500_00,
      status: 'behind',
    });
  });

  it('a minute later, on 1 July, starts the new year from its own budget (fake clock)', () => {
    const now = new Date('2026-06-30T14:00:00Z'); // midnight on 1 July in Melbourne
    const summary = fyBudgetSummary({ budgets, entries, today: today('Australia/Melbourne', now) });
    expect(summary.window).toMatchObject({ startYear: 2026, label: 'FY2026–27' });
    expect(summary).toMatchObject({
      budgetCents: 62_000_000,
      recordedCents: 300_000,
      billedCents: 100_000,
      recordedPct: 0,
      billedPct: 0,
      elapsedPct: 0,
      expectedCents: Math.round(62_000_000 / 365),
      status: 'on_track',
    });
  });

  it('pro-rates the budget through the year and flags being behind under 90%', () => {
    const mid = fyBudgetSummary({
      budgets: { '2026': 36_500_000 },
      entries: [entry({ date: '2026-07-15', amountCents: 9_000_000, status: 'final' })],
      today: d('2026-09-30'),
    });
    // 92 of 365 days: expected $92,000; $90,000 recorded is on track (over 90% of expected).
    expect(mid).toMatchObject({ expectedCents: 9_200_000, recordedPct: 25, elapsedPct: 25, status: 'on_track' });
    const behind = fyBudgetSummary({
      budgets: { '2026': 36_500_000 },
      entries: [entry({ date: '2026-07-15', amountCents: 8_000_000, status: 'final' })],
      today: d('2026-09-30'),
    });
    expect(behind.status).toBe('behind');
  });

  it('has no meter without a positive budget for the year', () => {
    for (const value of [undefined, null, {}, { '2026': 0 }, { '2026': 1.5 }]) {
      expect(fyBudgetSummary({ budgets: value as never, entries, today: d('2026-10-01') })).toMatchObject({
        budgetCents: null,
        recordedPct: null,
        billedPct: null,
        expectedCents: null,
        status: 'no_budget',
      });
    }
  });
});

describe('dayTotals', () => {
  it('compares each day with the target on weekdays only', () => {
    const days = dayTotals(
      [
        entry({ date: '2026-10-05', minutes: 240 }),
        entry({ date: '2026-10-05', minutes: 60, billable: false, status: 'final' }),
        entry({ date: '2026-10-10', minutes: 30 }),
      ],
      [d('2026-10-05'), d('2026-10-06'), d('2026-10-10')],
      360,
    );
    expect(days).toEqual([
      { date: '2026-10-05', minutes: 300, billableMinutes: 240, drafts: 1, targetMinutes: 360, pct: 83 },
      { date: '2026-10-06', minutes: 0, billableMinutes: 0, drafts: 0, targetMinutes: 360, pct: 0 },
      { date: '2026-10-10', minutes: 30, billableMinutes: 30, drafts: 1, targetMinutes: 0, pct: null },
    ]);
    expect(dayTotals([], [d('2026-10-05')])[0]?.targetMinutes).toBe(360);
  });
});

describe('approvals', () => {
  const at = new Date('2026-10-05T01:00:00Z');
  it('waits for approval until sent back, and again once edited', () => {
    expect(awaitingApproval({ status: 'draft' })).toBe(true);
    expect(awaitingApproval({ status: 'final' })).toBe(false);
    expect(awaitingApproval({ status: 'draft', deletedAt: at })).toBe(false);
    expect(awaitingApproval({ status: 'draft', rejection: { at }, updatedAt: at })).toBe(false);
    expect(sentBack({ status: 'draft', rejection: { at }, updatedAt: at })).toBe(true);
    const edited = { status: 'draft', rejection: { at }, updatedAt: new Date(at.getTime() + 1000) };
    expect(awaitingApproval(edited)).toBe(true);
    expect(sentBack(edited)).toBe(false);
    expect(awaitingApproval({ status: 'draft', rejection: { at } })).toBe(false);
  });
});

describe('WIP', () => {
  const wipEntry = (matterId: string, date: string, amountCents: number, extra: Record<string, unknown> = {}) => ({
    matterId,
    date,
    amountCents,
    billable: true,
    status: 'final',
    ...extra,
  });

  it('counts final, billable, live, uninvoiced time per matter with the oldest date', () => {
    expect(isUnbilledWip(wipEntry('m1', '2026-09-01', 100))).toBe(true);
    expect(isUnbilledWip(wipEntry('m1', '2026-09-01', 100, { invoiceId: 'inv-1' }))).toBe(false);
    const wip = wipByMatter([
      wipEntry('m1', '2026-09-10', 13200),
      wipEntry('m1', '2026-08-20', 8800),
      wipEntry('m2', '2026-10-01', 50000),
      wipEntry('m2', '2026-07-01', 99999, { status: 'draft' }),
      wipEntry('m2', '2026-07-01', 99999, { status: 'billed' }),
      wipEntry('m3', '2026-07-01', 99999, { billable: false }),
      wipEntry('m3', '2026-07-01', 99999, { deletedAt: new Date() }),
      wipEntry('m3', '2026-07-01', 1.5),
    ]);
    expect(wip).toEqual([
      { matterId: 'm2', timeCents: 50000, entries: 1, oldestDate: '2026-10-01' },
      { matterId: 'm1', timeCents: 22000, entries: 2, oldestDate: '2026-08-20' },
    ]);
  });

  it('builds rows with disbursements, budget, age and a closed flag, most WIP first', () => {
    const matter = (extra: Partial<WipMatterLike> = {}): WipMatterLike => ({
      number: 'WE-118',
      title: 'Estate of Robert Chen',
      type: 'probate',
      status: 'open',
      responsibleUid: 'user-lawyer',
      fee: { arrangement: 'hourly', rateOverrideCents: 44000 },
      ...extra,
    });
    const rows = wipRows(
      [
        { matterId: 'm1', timeCents: 22000 as never, entries: 2, oldestDate: d('2026-08-20') },
        { matterId: 'm2', timeCents: 50000 as never, entries: 1, oldestDate: d('2026-10-01') },
        { matterId: 'gone', timeCents: 10000 as never, entries: 1, oldestDate: d('2026-10-01') },
        { matterId: 'deleted', timeCents: 10000 as never, entries: 1, oldestDate: d('2026-10-01') },
      ],
      new Map<string, WipMatterLike>([
        ['m1', matter({ disbursementWipCents: 40000, budget: { pct: 86.4 }, lastInvoicedOn: '2026-06-30' })],
        [
          'm2',
          matter({
            number: 'WE-097',
            status: 'closed',
            budget: {},
            fee: { arrangement: 'fixed', amountCents: 220000 },
          }),
        ],
        ['m4', matter({ number: 'WE-200', disbursementWipCents: 5000 })],
        ['m5', matter({ number: 'WE-201', disbursementWipCents: 0 })],
        ['deleted', matter({ deletedAt: new Date() })],
      ]),
      d('2026-10-06'),
    );
    expect(rows.map((row) => [row.matterId, row.totalCents])).toEqual([
      ['m1', 62000],
      ['m2', 50000],
      ['m4', 5000],
    ]);
    expect(rows[0]).toMatchObject({
      timeCents: 22000,
      disbursementCents: 40000,
      ageDays: 47,
      budgetPct: 86,
      lastInvoicedOn: '2026-06-30',
      closed: false,
      fee: { arrangement: 'hourly', rateOverrideCents: 44000, amountCents: null, capCents: null },
    });
    expect(rows[1]).toMatchObject({ closed: true, budgetPct: null, lastInvoicedOn: null, ageDays: 5 });
    expect(rows[2]).toMatchObject({ entries: 0, oldestDate: null, ageDays: null, privileged: false });
  });
});

describe('planWriteDown', () => {
  const final = { status: 'final', units: 10, amountCents: 44000, rateCents: 44000 };
  const context = { by: 'user-partner', reason: 'Over the estimate', unitMinutes: 6 };

  it('writes down to new units at the entry’s rate and approves it', () => {
    expect(planWriteDown({ ...final, status: 'draft' }, { newUnits: 6 }, context)).toEqual({
      plan: {
        status: 'final',
        units: 6,
        amountCents: 26400,
        writeDown: { originalUnits: 10, originalAmountCents: 44000, by: 'user-partner', reason: 'Over the estimate' },
      },
      problem: null,
    });
  });

  it('writes down by a percentage, rounding half up, and keeps the first originals', () => {
    const once = planWriteDown({ ...final, units: 3, amountCents: 13200 }, { percent: 50 }, context).plan;
    expect(once).toMatchObject({ units: 2, amountCents: 6600 });
    const again = planWriteDown(
      { ...final, units: 2, amountCents: 6600, writeDown: { originalUnits: 3, originalAmountCents: 13200 } },
      { percent: 100 },
      context,
    ).plan;
    expect(again).toMatchObject({
      units: 0,
      amountCents: 0,
      writeDown: { originalUnits: 3, originalAmountCents: 13200 },
    });
  });

  it('writes off at the recorded value, and refuses billed entries and increases', () => {
    expect(planWriteDown(final, { writeOff: true }, context).plan).toMatchObject({
      status: 'written_off',
      units: 10,
      amountCents: 44000,
    });
    expect(planWriteDown({ ...final, status: 'billed' }, { writeOff: true }, context).problem).toBe('status');
    expect(planWriteDown(final, { newUnits: 10 }, context).problem).toBe('not_lower');
    expect(planWriteDown(final, { newUnits: 12 }, context).problem).toBe('not_lower');
    expect(planWriteDown({ ...final, amountCents: 0, units: 0 }, { percent: 10 }, context).problem).toBe('not_lower');
  });
});

describe('callable inputs', () => {
  const base = { requestId: REQUEST, matterId: 'm1', entryIds: ['e1'], reason: 'Duplicated work' };
  it('takes exactly one of new units, a percentage or a write-off', () => {
    expect(TimeWriteDownInput.safeParse({ ...base, newUnits: 2 }).success).toBe(true);
    expect(TimeWriteDownInput.safeParse({ ...base, percent: 20, expectedUpdatedAt: { e1: 1 } }).success).toBe(true);
    expect(TimeWriteDownInput.safeParse({ ...base, writeOff: true }).success).toBe(true);
    expect(TimeWriteDownInput.safeParse(base).success).toBe(false);
    expect(TimeWriteDownInput.safeParse({ ...base, newUnits: 2, percent: 20 }).success).toBe(false);
    expect(TimeWriteDownInput.safeParse({ ...base, entryIds: ['e1', 'e2'], newUnits: 2 }).success).toBe(false);
    expect(TimeWriteDownInput.safeParse({ ...base, reason: '  ', percent: 10 }).success).toBe(false);
  });

  it('needs a note to send time back, and a date range to export', () => {
    expect(RejectTimeEntriesInput.safeParse({ ...base, note: 'Which call?' }).success).toBe(true);
    expect(RejectTimeEntriesInput.safeParse({ ...base, note: ' ' }).success).toBe(false);
    expect(TimeExportInput.safeParse({ from: '2026-07-01', to: '2026-06-30' }).success).toBe(false);
    expect(TimeExportInput.safeParse({ from: '2026-07-01', to: '2026-07-31', unbilledOnly: true }).success).toBe(true);
  });
});

describe('CSV', () => {
  it('quotes cells, defuses formulas and writes dollars', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('Call, then "letter"')).toBe('"Call, then ""letter"""');
    expect(csvCell(null)).toBe('');
    expect(centsToDecimal(13205)).toBe('132.05');
    expect(centsToDecimal(-5)).toBe('-0.05');
    const csv = timeEntriesCsv([
      {
        date: '2026-10-01' as DateOnly,
        matterNumber: 'WE-118',
        matterTitle: 'Estate of Robert Chen',
        person: 'Jordan Price',
        narrative: 'Letter to executor, re: assets',
        minutes: 18,
        units: 3,
        unitMinutes: 6,
        rateCents: 44000,
        amountCents: 13200,
        billable: true,
        status: 'final',
      },
      {
        date: '2026-10-02',
        matterNumber: 'WE-118',
        matterTitle: 'Estate of Robert Chen',
        person: 'Jordan Price',
        narrative: '-',
        minutes: 30,
        units: 3,
        unitMinutes: 6,
        rateCents: 44000,
        amountCents: 13200,
        billable: false,
        status: 'final',
        originalAmountCents: 22000,
        writeDownReason: 'Training',
      },
    ]).split('\r\n');
    expect(csv[0]).toBe(
      'Date,Matter,Matter title,Person,Narrative,Minutes,Units,Hours,Rate,Amount,Billable,Status,Written down from,Write-down reason',
    );
    expect(csv[1]).toBe(
      '2026-10-01,WE-118,Estate of Robert Chen,Jordan Price,"Letter to executor, re: assets",18,3,0.30,440.00,132.00,Yes,final,,',
    );
    expect(csv[2]).toBe(
      "2026-10-02,WE-118,Estate of Robert Chen,Jordan Price,'-,30,3,0.30,440.00,132.00,No,final,220.00,Training",
    );
  });
});
