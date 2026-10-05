import { TIME_ENTRY_MAX_MINUTES } from './schemas/matter-records';
import {
  checkDuration,
  computeTimeEntry,
  dayMinutes,
  defaultBillable,
  isFixedFee,
  matchPhrases,
  memberRateOn,
  parseDuration,
  phraseQueryAt,
  resolveRate,
  SetTimeEntryStatusInput,
  TimeEntryCreateInput,
  timeAmountCents,
  timeByDay,
  timeTotals,
  timeUnits,
  wipContribution,
  withRateChange,
  type RateOrg,
} from './time-entries';
import type { RoundingMode } from './values/minutes';

/** Time entries (BILL-01): units, rates and amounts in integers, the duration parser and WIP. */

const ORG: RateOrg = { billing: { unitMinutes: 6, rounding: 'up', defaultRateCents: 30000 } };
const REQUEST = '6f1f8f0e-7b1a-4c55-9a1e-3d6f5a2b9c10';

describe('units and amounts (table)', () => {
  // [minutes, unitMinutes, rounding, rateCents, units, amountCents]: worked by hand, not by the code.
  const cases: [number, number, RoundingMode, number, number, number][] = [
    [1, 6, 'up', 44000, 1, 4400],
    [6, 6, 'up', 44000, 1, 4400],
    [7, 6, 'up', 44000, 2, 8800],
    [18, 6, 'up', 45000, 3, 13500],
    [15, 6, 'up', 45000, 3, 13500],
    [15, 6, 'nearest', 45000, 3, 13500],
    [14, 6, 'nearest', 45000, 2, 9000],
    [2, 6, 'nearest', 45000, 1, 4500],
    [3, 6, 'nearest', 45000, 1, 4500],
    [9, 6, 'nearest', 45000, 2, 9000],
    [8, 6, 'nearest', 45000, 1, 4500],
    [60, 6, 'up', 44000, 10, 44000],
    [61, 6, 'up', 44000, 11, 48400],
    [0, 6, 'up', 44000, 0, 0],
    [6, 6, 'up', 33333, 1, 3333],
    [6, 6, 'up', 33335, 1, 3334],
    [6, 6, 'up', 1, 1, 0],
    [6, 6, 'up', 5, 1, 1],
    [30, 15, 'up', 40000, 2, 20000],
    [31, 15, 'up', 40000, 3, 30000],
    [37, 15, 'nearest', 40000, 2, 20000],
    [38, 15, 'nearest', 40000, 3, 30000],
    [1, 10, 'up', 44000, 1, 7333],
    [59, 1, 'up', 44000, 59, 43267],
    [6000, 6, 'up', 150000, 1000, 15000000],
    [30, 6, 'up', 0, 5, 0],
    [72, 6, 'up', 38000, 12, 45600],
    [25, 6, 'up', 44000, 5, 22000],
    [25, 6, 'nearest', 44000, 4, 17600],
    [6, 6, 'up', 12345, 1, 1235],
    [6, 6, 'up', 12344, 1, 1234],
  ];

  it.each(cases)(
    '%i min, %i-min units (%s) at %i c/h → %i units, %i c',
    (minutes, unit, rounding, rate, units, amount) => {
      expect(timeUnits(minutes, { unitMinutes: unit, rounding })).toBe(units);
      const result = timeAmountCents(units, rate, unit);
      expect(result).toBe(amount);
      expect(Number.isInteger(result)).toBe(true);
      const computed = computeTimeEntry({
        minutes,
        date: '2026-10-01',
        member: { rates: [{ effectiveFrom: '2026-07-01', rateCents: rate }] },
        matter: { fee: { arrangement: 'hourly' } },
        org: { billing: { unitMinutes: unit, rounding, defaultRateCents: 1 } },
      });
      expect(computed).toEqual({ units, rateCents: rate, amountCents: amount, rateSource: 'member' });
    },
  );

  it('defaults to 6-minute units', () => {
    expect(timeUnits(7, { rounding: 'up' })).toBe(2);
    expect(timeAmountCents(3, 44000)).toBe(13200);
  });
});

describe('parseDuration', () => {
  it.each([
    ['0.3', 18],
    ['.5', 30],
    ['0.25', 15],
    ['0.33', 20],
    ['1.5h', 90],
    ['2', 120],
    ['2 hrs', 120],
    ['18m', 18],
    ['45 min', 45],
    ['90 minutes', 90],
    ['1h 12m', 72],
    ['1h12m', 72],
    ['1h12', 72],
    ['1 hour 5 mins', 65],
    ['1:12', 72],
    ['0:06', 6],
    ['  1H 12M ', 72],
    ['0', 0],
  ])('%j is %i minutes', (text, minutes) => {
    expect(parseDuration(text)).toBe(minutes);
  });

  it.each(['', 'abc', '1:75', '1.2.3', '-1', '1h -5m', 'h', '12:3', '10000'])('%j is not a duration', (text) => {
    expect(parseDuration(text)).toBeNull();
  });

  it('turns 0.25 h into 15 minutes and 3 units', () => {
    const minutes = parseDuration('0.25') ?? 0;
    expect(minutes).toBe(15);
    expect(timeUnits(minutes, { rounding: 'up' })).toBe(3);
  });

  it('says why a duration is refused', () => {
    expect(checkDuration('0.3')).toEqual({ minutes: 18, problem: null });
    expect(checkDuration('0')).toEqual({ minutes: null, problem: 'zero' });
    expect(checkDuration('0m')).toEqual({ minutes: null, problem: 'zero' });
    expect(checkDuration('nope')).toEqual({ minutes: null, problem: 'invalid' });
    expect(checkDuration(`${TIME_ENTRY_MAX_MINUTES + 1}m`)).toEqual({ minutes: null, problem: 'too_long' });
  });
});

describe('resolveRate', () => {
  const member = {
    defaultRateCents: 48000,
    rates: [
      { effectiveFrom: '2026-10-15', rateCents: 48000 },
      { effectiveFrom: '2026-07-01', rateCents: 44000 },
    ],
  };

  it('prefers the matter override', () => {
    expect(
      resolveRate({ member, matter: { fee: { rateOverrideCents: 35000 } }, date: '2026-10-20', org: ORG }),
    ).toEqual({
      rateCents: 35000,
      source: 'matter',
    });
  });

  it('honours a zero override (no charge on this matter)', () => {
    expect(
      resolveRate({ member, matter: { fee: { rateOverrideCents: 0 } }, date: '2026-10-20', org: ORG }).rateCents,
    ).toBe(0);
  });

  it('uses the member rate in force on the entry date (a mid-month change)', () => {
    expect(resolveRate({ member, matter: {}, date: '2026-10-14', org: ORG })).toEqual({
      rateCents: 44000,
      source: 'member',
    });
    expect(resolveRate({ member, matter: {}, date: '2026-10-15', org: ORG })).toEqual({
      rateCents: 48000,
      source: 'member',
    });
  });

  it('uses the earliest rate before the history starts', () => {
    expect(memberRateOn(member, '2026-01-01')).toBe(44000);
  });

  it('falls back to the single default rate, then the org default', () => {
    expect(memberRateOn({ defaultRateCents: 41000 }, '2026-10-01')).toBe(41000);
    expect(memberRateOn({ defaultRateCents: 0, rates: [] }, '2026-10-01')).toBeNull();
    expect(resolveRate({ member: { defaultRateCents: 0 }, matter: null, date: '2026-10-01', org: ORG })).toEqual({
      rateCents: 30000,
      source: 'org',
    });
    expect(resolveRate({ member: null, matter: null, date: '2026-10-01', org: ORG }).source).toBe('org');
  });

  it('keeps a rate for non-billable time (reporting)', () => {
    const values = computeTimeEntry({
      minutes: 30,
      date: '2026-10-01',
      member,
      matter: { fee: { arrangement: 'fixed' } },
      org: ORG,
    });
    expect(values).toEqual({ units: 5, rateCents: 44000, amountCents: 22000, rateSource: 'member' });
  });
});

describe('withRateChange', () => {
  it('keeps the rate a first change replaces, so earlier entries still find it', () => {
    expect(withRateChange({ defaultRateCents: 44000, rates: [] }, 48000, '2026-10-15')).toEqual([
      { effectiveFrom: '2000-01-01', rateCents: 44000 },
      { effectiveFrom: '2026-10-15', rateCents: 48000 },
    ]);
  });

  it('replaces a change made the same day and keeps the history in date order', () => {
    const rates = [
      { effectiveFrom: '2026-10-15', rateCents: 48000 },
      { effectiveFrom: '2026-07-01', rateCents: 44000 },
    ];
    expect(withRateChange({ defaultRateCents: 48000, rates }, 50000, '2026-10-15')).toEqual([
      { effectiveFrom: '2026-07-01', rateCents: 44000 },
      { effectiveFrom: '2026-10-15', rateCents: 50000 },
    ]);
  });

  it('starts a history without a previous rate', () => {
    expect(withRateChange({ defaultRateCents: 0 }, 40000, '2026-10-15')).toEqual([
      { effectiveFrom: '2026-10-15', rateCents: 40000 },
    ]);
  });
});

describe('fixed fees and WIP', () => {
  it('starts fixed-fee and pro bono time non-billable', () => {
    expect(defaultBillable({ fee: { arrangement: 'fixed' } })).toBe(false);
    expect(defaultBillable({ fee: { arrangement: 'pro_bono' } })).toBe(false);
    expect(defaultBillable({ fee: { arrangement: 'capped' } })).toBe(true);
    expect(defaultBillable(null)).toBe(true);
    expect(isFixedFee({ fee: { arrangement: 'fixed' } })).toBe(true);
  });

  it('counts billable, unbilled, live entries', () => {
    const entry = { billable: true, status: 'draft', amountCents: 13200 };
    expect(wipContribution(entry)).toBe(13200);
    expect(wipContribution({ ...entry, status: 'final' })).toBe(13200);
    expect(wipContribution({ ...entry, status: 'billed' })).toBe(0);
    expect(wipContribution({ ...entry, status: 'written_off' })).toBe(0);
    expect(wipContribution({ ...entry, billable: false })).toBe(0);
    expect(wipContribution({ ...entry, deletedAt: new Date() })).toBe(0);
    expect(wipContribution({ ...entry, amountCents: 1.5 })).toBe(0);
    expect(wipContribution(undefined)).toBe(0);
  });
});

describe('days and totals', () => {
  const row = (id: string, date: string, minutes: number, billable = true, uid = 'u-a') => ({
    id,
    uid,
    date,
    minutes,
    units: Math.ceil(minutes / 6),
    amountCents: Math.ceil(minutes / 6) * 4400,
    billable,
  });
  const rows = [
    row('1', '2026-10-01', 18),
    row('2', '2026-10-03', 30),
    row('3', '2026-10-01', 6, false),
    row('4', '2026-10-01', 60, true, 'u-b'),
  ];

  it('groups by date, newest first, with day totals of billable value', () => {
    const days = timeByDay(rows);
    expect(days.map((day) => day.date)).toEqual(['2026-10-03', '2026-10-01']);
    expect(days[1]).toMatchObject({ minutes: 84, units: 14, amountCents: 13200 + 44000 });
    expect(days[1]?.entries.map((entry) => entry.id)).toEqual(['1', '3', '4']);
  });

  it('totals units and billable value', () => {
    expect(timeTotals(rows)).toEqual({
      minutes: 114,
      units: 19,
      amountCents: 13200 + 22000 + 44000,
      nonBillableUnits: 1,
    });
  });

  it("sums a person's minutes on a day, leaving out the one being edited", () => {
    expect(dayMinutes(rows, 'u-a', '2026-10-01')).toBe(24);
    expect(dayMinutes(rows, 'u-a', '2026-10-01', '1')).toBe(6);
    expect(dayMinutes([...rows, { ...row('5', '2026-10-01', 600), deletedAt: new Date() }], 'u-a', '2026-10-01')).toBe(
      24,
    );
  });
});

describe('narrative phrases', () => {
  it('matches word starts', () => {
    expect(matchPhrases('pe con')).toEqual(['Perusing and considering ']);
    expect(matchPhrases('att')).toContain('Attendance on client ');
    expect(matchPhrases('', undefined, 3)).toHaveLength(3);
    expect(matchPhrases('zzz')).toEqual([]);
  });

  it('finds the / query at the caret', () => {
    expect(phraseQueryAt('/per', 4)).toEqual({ start: 0, query: 'per' });
    expect(phraseQueryAt('Call re estate /att on', 22)).toEqual({ start: 15, query: 'att on' });
    expect(phraseQueryAt('and/or', 6)).toBeNull();
    expect(phraseQueryAt('no slash', 8)).toBeNull();
  });
});

describe('inputs', () => {
  it('creates drafts only, with at least a minute', () => {
    const base = {
      orgId: 'o',
      matterId: 'm',
      uid: 'u',
      date: '2026-10-01',
      minutes: 18,
      units: 3,
      rateCents: 44000,
      amountCents: 13200,
      narrative: 'x',
      billable: true,
    };
    expect(TimeEntryCreateInput.parse(base)).toMatchObject({ status: 'draft', source: 'manual', wipCountedCents: 0 });
    expect(TimeEntryCreateInput.safeParse({ ...base, minutes: 0 }).success).toBe(false);
    expect(TimeEntryCreateInput.safeParse({ ...base, status: 'billed' }).success).toBe(false);
    expect(TimeEntryCreateInput.safeParse({ ...base, wipCountedCents: 100 }).success).toBe(false);
  });

  it('sets status to draft or final only', () => {
    expect(
      SetTimeEntryStatusInput.safeParse({ requestId: REQUEST, matterId: 'm', entryIds: ['a'], status: 'final' })
        .success,
    ).toBe(true);
    expect(
      SetTimeEntryStatusInput.safeParse({ requestId: REQUEST, matterId: 'm', entryIds: ['a'], status: 'billed' })
        .success,
    ).toBe(false);
    expect(
      SetTimeEntryStatusInput.safeParse({ requestId: REQUEST, matterId: 'm', entryIds: [], status: 'final' }).success,
    ).toBe(false);
  });
});
