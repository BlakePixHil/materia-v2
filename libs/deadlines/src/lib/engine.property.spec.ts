import fc from 'fast-check';

import { addDays, type DateOnly, dateOnly } from '@materia/domain';

import { isBusinessDay } from './calendar';
import { VIC_CALENDARS } from './data';
import { compute } from './engine';
import { type AnchoredRule, type CalendarSet, type ComputeInput, RuleSetSchema } from './model';

const CALENDAR_IDS = ['VIC_SUPREME_COURT', 'VIC_COUNTY_COURT', 'VIC_MELBOURNE', 'VIC_GREATER_GEELONG'] as const;

/** Anchors from 2025 to mid-2027, so every offset and roll stays inside the 2025–2028 calendar data. */
const anchorArb = fc.integer({ min: 0, max: 910 }).map((n) => addDays(dateOnly('2025-01-01'), n));

const offsetArb = fc.oneof(
  fc.integer({ min: 0, max: 120 }).map((days) => ({ days })),
  fc.integer({ min: 0, max: 40 }).map((businessDays) => ({ businessDays })),
  fc.integer({ min: 0, max: 12 }).map((months) => ({ months })),
);

const ruleArb = fc.record({
  offset: offsetArb,
  counting: fc.constantFrom('exclude_anchor_day' as const, 'include_anchor_day' as const),
  calendar: fc.constantFrom(...CALENDAR_IDS),
});

function run(
  rule: Pick<AnchoredRule, 'offset' | 'counting' | 'calendar'>,
  anchor: DateOnly,
  calendars: CalendarSet,
): DateOnly | undefined {
  const input: ComputeInput = {
    matter: { type: 'probate', jurisdiction: 'VIC', facts: {} },
    events: [{ kind: 'grant_issued', date: anchor }],
    ruleSet: RuleSetSchema.parse({
      ruleSetId: 'prop',
      version: 1,
      jurisdiction: 'VIC',
      published: false,
      practitionerReviewed: false,
      flag: 'f',
      disclaimer: 'd',
      rules: [
        {
          id: 'prop.rule',
          title: 'Property',
          citation: 'c',
          explain: 'e',
          appliesTo: { matterTypes: ['probate'], jurisdictions: ['VIC'] },
          anchor: { event: 'grant_issued' },
          direction: 'after',
          monthEnd: 'clamp',
          nonBusinessDay: 'roll_forward',
          kind: 'statutory',
          critical: true,
          ...rule,
        },
      ],
    }),
    calendars,
    today: dateOnly('2025-01-01'),
  };
  return compute(input)[0]?.dueDate;
}

/** The calendars with one extra holiday added to one calendar. */
function withHoliday(calendarId: string, date: DateOnly): CalendarSet {
  const year = Number(date.slice(0, 4));
  const calendar = VIC_CALENDARS[calendarId] ?? {};
  const data = calendar[year];
  if (!data) return VIC_CALENDARS;
  return {
    ...VIC_CALENDARS,
    [calendarId]: { ...calendar, [year]: { ...data, holidays: [...data.holidays, { date, name: 'Extra holiday' }] } },
  };
}

describe('deadline engine properties', () => {
  it('never lands on a non-business day when rolling forward', () => {
    fc.assert(
      fc.property(ruleArb, anchorArb, (rule, anchor) => {
        const due = run(rule, anchor, VIC_CALENDARS);
        return due !== undefined && isBusinessDay(VIC_CALENDARS, rule.calendar, due);
      }),
      { numRuns: 500 },
    );
  });

  it('adding a holiday never makes a deadline earlier when rolling forward', () => {
    fc.assert(
      fc.property(ruleArb, anchorArb, fc.integer({ min: 0, max: 400 }), (rule, anchor, holidayOffset) => {
        const before = run(rule, anchor, VIC_CALENDARS) as DateOnly;
        const after = run(rule, anchor, withHoliday(rule.calendar, addDays(anchor, holidayOffset))) as DateOnly;
        return after >= before;
      }),
      { numRuns: 500 },
    );
  });

  it('is deterministic and never before the anchor for "after" rules', () => {
    fc.assert(
      fc.property(ruleArb, anchorArb, (rule, anchor) => {
        const first = run(rule, anchor, VIC_CALENDARS) as DateOnly;
        return first === run(rule, anchor, VIC_CALENDARS) && first >= anchor;
      }),
      { numRuns: 300 },
    );
  });
});
