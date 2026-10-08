import { Calendar, dateOnly, RuleSetVersion } from '@materia/domain';

import {
  addBusinessDays,
  addMonthsClamped,
  afterFyEnd,
  buildCalendarSet,
  calendarYear,
  isBusinessDay,
  nonBusinessReason,
  rollToBusinessDay,
  weekdayName,
} from './calendar';
import { CALENDAR_YEARS, VIC_CALENDARS, VIC_RULESET_V1 } from './data';
import { type CalendarYear, CalendarYearSchema, DeadlineEngineError } from './model';
import { calendarDocId, toCalendarDoc, toRuleSetDoc } from './storage';
import official from '../../data/calendars/official-vic-holidays.json';

const d = dateOnly;
const IDS = ['VIC_SUPREME_COURT', 'VIC_COUNTY_COURT', 'VIC_MELBOURNE', 'VIC_GREATER_GEELONG'];
const YEARS = [2025, 2026, 2027, 2028];

describe('calendar data', () => {
  it('has every calendar for 2025–2028, all schema-valid and verified by a person (CORE-09a)', () => {
    for (const id of IDS) for (const year of YEARS) expect(VIC_CALENDARS[id]?.[year], `${id}-${year}`).toBeDefined();
    expect(CALENDAR_YEARS).toHaveLength(16);
    expect(CALENDAR_YEARS.every((c) => c.verified === true)).toBe(true);
  });

  it('matches the official Victorian holiday list (Melbourne, and the courts plus closures)', () => {
    for (const year of YEARS) {
      const expected = (official.years as Record<string, { date: string; name: string }[]>)[String(year)]?.map(
        (h) => h.date,
      );
      for (const id of ['VIC_MELBOURNE', 'VIC_SUPREME_COURT', 'VIC_COUNTY_COURT']) {
        expect(
          VIC_CALENDARS[id]?.[year]?.holidays.map((h) => h.date),
          `${id}-${year}`,
        ).toEqual(expected);
      }
      expect(VIC_CALENDARS['VIC_SUPREME_COURT']?.[year]?.closures.length).toBeGreaterThan(0);
      expect(VIC_CALENDARS['VIC_MELBOURNE']?.[year]?.closures).toEqual([]);
    }
  });

  it('substitutes Geelong Cup Day for Melbourne Cup in Greater Geelong', () => {
    for (const year of YEARS) {
      const geelong = VIC_CALENDARS['VIC_GREATER_GEELONG']?.[year]?.holidays ?? [];
      const melbourne = VIC_CALENDARS['VIC_MELBOURNE']?.[year]?.holidays ?? [];
      const cup = melbourne.find((h) => h.name === 'Melbourne Cup')?.date;
      const geelongCup = (official.geelongCupDay as Record<string, string>)[String(year)];
      expect(geelong.some((h) => h.date === cup)).toBe(false);
      expect(geelong.find((h) => h.date === geelongCup)?.name).toMatch(/Geelong Cup/);
      expect(geelong).toHaveLength(melbourne.length);
      // Melbourne Cup is the first Tuesday in November; Geelong Cup Day a Wednesday.
      expect(weekdayName(d(cup ?? ''))).toBe('Tuesday');
      expect(weekdayName(d(geelongCup ?? ''))).toBe('Wednesday');
    }
  });

  it('puts the movable holidays on the right weekdays', () => {
    const weekdays: Record<string, string> = {
      'Labour Day': 'Monday',
      "King's Birthday": 'Monday',
      'Good Friday': 'Friday',
      'Easter Monday': 'Monday',
      'Friday before the AFL Grand Final': 'Friday',
    };
    for (const year of YEARS) {
      for (const h of VIC_CALENDARS['VIC_MELBOURNE']?.[year]?.holidays ?? []) {
        if (weekdays[h.name]) expect(weekdayName(h.date), `${h.name} ${h.date}`).toBe(weekdays[h.name]);
        if (h.name.includes('additional') || h.name.includes('observed'))
          expect(['Monday', 'Tuesday']).toContain(weekdayName(h.date));
      }
    }
  });

  it('rejects malformed calendar data', () => {
    const bad = {
      calendarId: 'VIC_X',
      year: 2026,
      kind: 'court',
      jurisdiction: 'VIC',
      holidays: [{ date: '2027-01-01', name: 'x' }],
      closures: [{ from: '2026-12-31', to: '2026-12-01', name: 'y' }],
      source: 's',
      verified: false,
    };
    const result = CalendarYearSchema.safeParse(bad);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.message).join(' ')).toMatch(/outside the year.*ends before it starts/);
  });
});

describe('calendar arithmetic', () => {
  const cal = VIC_CALENDARS;

  it('explains non-business days: weekends, holidays and closures', () => {
    expect(nonBusinessReason(cal, 'VIC_SUPREME_COURT', d('2026-10-03'))).toBe('Saturday');
    expect(nonBusinessReason(cal, 'VIC_SUPREME_COURT', d('2026-10-04'))).toBe('Sunday');
    expect(nonBusinessReason(cal, 'VIC_SUPREME_COURT', d('2026-11-03'))).toBe('Melbourne Cup');
    expect(nonBusinessReason(cal, 'VIC_SUPREME_COURT', d('2026-12-30'))).toBe('Christmas–New Year registry closure');
    expect(nonBusinessReason(cal, 'VIC_MELBOURNE', d('2026-12-30'))).toBeNull();
    expect(isBusinessDay(cal, 'VIC_GREATER_GEELONG', d('2026-11-03'))).toBe(true);
    expect(isBusinessDay(cal, 'VIC_GREATER_GEELONG', d('2026-10-21'))).toBe(false);
  });

  it('fails loudly for a missing year or an unknown calendar', () => {
    expect(() => calendarYear(cal, 'VIC_SUPREME_COURT', d('2029-01-05'))).toThrow(DeadlineEngineError);
    expect(() => calendarYear(cal, 'VIC_SUPREME_COURT', d('2029-01-05'))).toThrow(
      'CALENDAR_MISSING: No VIC_SUPREME_COURT calendar data for 2029',
    );
    try {
      calendarYear(cal, 'NSW_SUPREME_COURT', d('2026-01-05'));
    } catch (error) {
      expect((error as DeadlineEngineError).code).toBe('CALENDAR_UNKNOWN');
      expect((error as DeadlineEngineError).details).toEqual({ calendarId: 'NSW_SUPREME_COURT' });
    }
  });

  it('rolls and counts business days across consecutive holidays', () => {
    // Christmas 2026: Fri 25 holiday, Sat, Sun, Mon 28 Boxing Day (additional), court closed to 2 Jan.
    expect(rollToBusinessDay(cal, 'VIC_MELBOURNE', d('2026-12-25'), 1)).toBe('2026-12-29');
    expect(rollToBusinessDay(cal, 'VIC_SUPREME_COURT', d('2026-12-25'), 1)).toBe('2027-01-04');
    expect(rollToBusinessDay(cal, 'VIC_SUPREME_COURT', d('2026-12-25'), -1)).toBe('2026-12-24');
    expect(addBusinessDays(cal, 'VIC_MELBOURNE', d('2026-12-24'), 2, 1)).toBe('2026-12-30');
    expect(addBusinessDays(cal, 'VIC_MELBOURNE', d('2026-12-30'), 2, -1)).toBe('2026-12-24');
    expect(addBusinessDays(cal, 'VIC_MELBOURNE', d('2026-12-30'), 0, 1)).toBe('2026-12-30');
  });

  it('clamps months and finds the date after the financial year end', () => {
    expect(addMonthsClamped(d('2026-01-31'), 1)).toEqual({ date: '2026-02-28', clamped: true });
    expect(addMonthsClamped(d('2028-02-29'), 12)).toEqual({ date: '2029-02-28', clamped: true });
    expect(addMonthsClamped(d('2026-08-30'), 6)).toEqual({ date: '2027-02-28', clamped: true });
    expect(addMonthsClamped(d('2026-03-14'), 6)).toEqual({ date: '2026-09-14', clamped: false });
    const tax = { month: 10, day: 31, fyStartMonth: 7 };
    expect(afterFyEnd(d('2026-03-14'), tax)).toBe('2026-10-31');
    expect(afterFyEnd(d('2026-07-01'), tax)).toBe('2027-10-31');
    expect(afterFyEnd(d('2026-06-30'), tax)).toBe('2026-10-31');
    // A calendar-year FY, a target before the FY end month, and a day clamped to the month.
    expect(afterFyEnd(d('2026-05-01'), { month: 3, day: 31, fyStartMonth: 1 })).toBe('2027-03-31');
    expect(afterFyEnd(d('2026-08-01'), { month: 2, day: 31, fyStartMonth: 7 })).toBe('2028-02-29');
  });

  it('builds a calendar set by id and year', () => {
    const set = buildCalendarSet(CALENDAR_YEARS.slice(0, 2));
    expect(Object.keys(set)).toEqual(['VIC_SUPREME_COURT']);
    expect(Object.keys(set['VIC_SUPREME_COURT'] ?? {})).toEqual(['2025', '2026']);
  });
});

describe('storage mappers', () => {
  it('maps calendars and rule sets to their Firestore documents', () => {
    const meta = {
      createdAt: new Date(0),
      createdBy: 'system',
      updatedAt: new Date(0),
      updatedBy: 'system',
      schemaVersion: 1,
    };
    const geelong = VIC_CALENDARS['VIC_GREATER_GEELONG']?.[2026] as CalendarYear;
    expect(calendarDocId(geelong)).toBe('VIC_GREATER_GEELONG-2026');
    const calendarDoc = toCalendarDoc(geelong);
    expect(Calendar.schema.parse({ ...calendarDoc, ...meta })).toMatchObject({
      calendarId: 'VIC_GREATER_GEELONG',
      kind: 'locality',
      verified: true,
    });
    expect(calendarDoc.holidays.some((h) => h.provisional)).toBe(true);
    const court = toCalendarDoc(VIC_CALENDARS['VIC_SUPREME_COURT']?.[2026] as CalendarYear);
    expect(court.closures[0]?.body).toBe('VIC_SUPREME_COURT');
    const ruleSetDoc = toRuleSetDoc(VIC_RULESET_V1);
    expect(RuleSetVersion.schema.parse({ ...ruleSetDoc, ...meta }).rules).toHaveLength(VIC_RULESET_V1.rules.length);
    expect(ruleSetDoc.rules[0]?.definition).toMatchObject({ anchor: { event: 'notice_published' } });
  });
});
