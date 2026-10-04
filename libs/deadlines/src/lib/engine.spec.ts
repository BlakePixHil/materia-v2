import { type DateOnly, dateOnly } from '@materia/domain';

import { buildCalendarSet } from './calendar';
import { VIC_CALENDARS } from './data';
import { compute, diff, evaluateCondition, explain, readFact, renderStep, ruleCalendar, selectAnchor } from './engine';
import { type AnchoredRule, type ComputeInput, type EngineEvent, type Rule, RuleSetSchema } from './model';

const d = dateOnly;

/** The value, or a test failure if it's missing (instead of a non-null assertion). */
function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('Expected a value');
  return value;
}

/** A minimal anchored rule; tests override what they exercise. */
function rule(overrides: Partial<AnchoredRule> & Pick<AnchoredRule, 'id'>): AnchoredRule {
  return {
    title: overrides.id,
    citation: 'Test citation',
    explain: 'Test explanation',
    appliesTo: { matterTypes: ['probate'], jurisdictions: ['VIC'] },
    conditions: [],
    anchor: { event: 'grant_issued' },
    offset: { days: 10 },
    direction: 'after',
    counting: 'exclude_anchor_day',
    monthEnd: 'clamp',
    nonBusinessDay: 'roll_forward',
    calendar: 'VIC_SUPREME_COURT',
    kind: 'statutory',
    critical: true,
    reminders: [],
    verify: false,
    ...overrides,
  };
}

function input(rules: Rule[], events: EngineEvent[], extra: Partial<ComputeInput> = {}): ComputeInput {
  return {
    matter: { type: 'probate', jurisdiction: 'VIC', facts: {} },
    events,
    ruleSet: RuleSetSchema.parse({
      ruleSetId: 'test',
      version: 3,
      jurisdiction: 'VIC',
      published: false,
      practitionerReviewed: false,
      flag: 'deadlines.ruleset.test',
      disclaimer: 'Test only',
      rules,
    }),
    calendars: VIC_CALENDARS,
    today: d('2026-01-01'),
    ...extra,
  };
}

const grant = (date: string, extra: Partial<EngineEvent> = {}): EngineEvent => ({
  id: 'ev-grant',
  kind: 'grant_issued',
  date: d(date),
  ...extra,
});

describe('compute: offsets', () => {
  it('adds days excluding the anchor day, or counting it', () => {
    const [excluded, included] = compute(
      input([rule({ id: 'a.excl' }), rule({ id: 'a.incl', counting: 'include_anchor_day' })], [grant('2026-03-02')]),
    );
    expect(excluded?.dueDate).toBe('2026-03-12');
    expect(included?.dueDate).toBe('2026-03-11');
    expect(explain(must(included))).toContain('+ 10 days, counting the anchor day → 2026-03-11 (Wednesday)');
  });

  it('counts backwards for "before" rules, and handles a 1-day period counting the anchor day', () => {
    const [before, one] = compute(
      input(
        [
          rule({ id: 'a.before', direction: 'before', offset: { days: 14 } }),
          rule({ id: 'a.one', offset: { days: 0 }, counting: 'include_anchor_day' }),
        ],
        [grant('2026-03-20')],
      ),
    );
    expect(before?.dueDate).toBe('2026-03-06');
    expect(one?.dueDate).toBe('2026-03-20');
  });

  it('adds business days on the rule calendar, in both directions', () => {
    const [fwd, back] = compute(
      input(
        [
          rule({ id: 'a.bd', offset: { businessDays: 3 } }),
          rule({ id: 'a.bdback', offset: { businessDays: 3 }, direction: 'before' }),
        ],
        [grant('2026-11-02')],
      ),
    );
    // Tue 3 Nov is Melbourne Cup on the court calendar.
    expect(fwd?.dueDate).toBe('2026-11-06');
    expect(back?.dueDate).toBe('2026-10-28');
    expect(explain(must(fwd))[1]).toBe('+ 3 business days on VIC_SUPREME_COURT → 2026-11-06 (Friday)');
  });

  it('adds months and years with month-end clamping', () => {
    const [months, years] = compute(
      input(
        [rule({ id: 'a.m', offset: { months: 1 } }), rule({ id: 'a.y', offset: { years: 1 }, nonBusinessDay: 'none' })],
        [grant('2027-01-31')],
        { today: d('2027-01-01') },
      ),
    );
    expect(months?.dueDate).toBe('2027-03-01');
    expect(explain(must(months))).toContain('+ 1 month (clamped to month end) → 2027-02-28 (Sunday)');
    expect(years?.dueDate).toBe('2028-01-31');
    const [back] = compute(
      input(
        [rule({ id: 'a.mb', offset: { months: 2 }, direction: 'before', nonBusinessDay: 'none' })],
        [grant('2026-04-30')],
      ),
    );
    expect(back?.dueDate).toBe('2026-02-28');
    expect(explain(must(back))[1]).toBe('− 2 months (clamped to month end) → 2026-02-28 (Saturday)');
  });

  it('computes a fixed date after the financial year end', () => {
    const [tax] = compute(
      input(
        [
          rule({
            id: 'a.tax',
            anchor: { event: 'date_of_death' },
            offset: { afterFyEnd: { month: 10, day: 31, fyStartMonth: 7 } },
          }),
        ],
        [{ id: 'dod', kind: 'date_of_death', date: d('2025-11-20') }],
      ),
    );
    // 31 Oct 2026 is a Saturday: rolled to Monday 2 Nov.
    expect(tax?.dueDate).toBe('2026-11-02');
    expect(explain(must(tax))[1]).toBe('31/10 after the financial year end → 2026-10-31 (Saturday)');
  });

  it('reads amounts from facts and event meta, with defaults, or blocks without them', () => {
    const rules = [
      rule({ id: 'a.fact', offset: { months: { fact: 'org.promptFilingMonths', default: 6 } } }),
      rule({ id: 'a.meta', offset: { days: { eventMeta: 'days' } } }),
      rule({ id: 'a.metadef', offset: { days: { eventMeta: 'periodDays', default: 14 } } }),
    ];
    const withFacts = compute(
      input(rules, [grant('2026-03-02', { meta: { days: 21 } })], {
        matter: { type: 'probate', jurisdiction: 'VIC', facts: { org: { promptFilingMonths: 3 } } },
      }),
    );
    expect(withFacts.map((r) => r.dueDate)).toEqual(['2026-06-02', '2026-03-23', '2026-03-16']);
    expect(withFacts[0]?.inputs).toMatchObject({ months: 3, anchor: '2026-03-02' });
    expect(withFacts[1]?.inputs).toMatchObject({ days: 21 });

    const defaults = compute(
      input(rules, [grant('2026-03-02', { meta: { days: -1 } })], {
        matter: { type: 'probate', jurisdiction: 'VIC', facts: { org: { promptFilingMonths: 'six' } } },
      }),
    );
    expect(defaults[0]?.dueDate).toBe('2026-09-02');
    expect(defaults[1]).toMatchObject({ status: 'blocked', reason: "the days on the grant isn't recorded" });
    const order = compute(
      input(
        [rule({ id: 'a.order', anchor: { event: 'hearing' }, offset: { days: { eventMeta: 'days' } } })],
        [{ kind: 'hearing', date: d('2026-03-02') }],
      ),
    );
    expect(order[0]?.reason).toBe("the days on the hearing isn't recorded");
  });
});

describe('compute: rolling', () => {
  it('rolls forward, back, or not at all, and says why', () => {
    // Anchor + 1 day lands on Melbourne Cup (Tue 3 Nov 2026) on the court calendar.
    const rules = [
      rule({ id: 'r.fwd', offset: { days: 1 } }),
      rule({ id: 'r.back', offset: { days: 1 }, nonBusinessDay: 'roll_back' }),
      rule({ id: 'r.none', offset: { days: 1 }, nonBusinessDay: 'none' }),
      rule({ id: 'r.geelong', offset: { days: 1 }, calendar: 'VIC_GREATER_GEELONG' }),
    ];
    const [fwd, back, none, geelong] = compute(input(rules, [grant('2026-11-02')]));
    expect([fwd?.dueDate, back?.dueDate, none?.dueDate, geelong?.dueDate]).toEqual([
      '2026-11-04',
      '2026-11-02',
      '2026-11-03',
      '2026-11-03',
    ]);
    expect(explain(must(fwd))).toContain(
      '2026-11-03 is Melbourne Cup on VIC_SUPREME_COURT → rolled forward to 2026-11-04 (Wednesday)',
    );
    expect(explain(must(back))).toContain(
      '2026-11-03 is Melbourne Cup on VIC_SUPREME_COURT → rolled back to 2026-11-02 (Monday)',
    );
    expect(explain(must(none))).toContain(
      '2026-11-03 is Melbourne Cup on VIC_SUPREME_COURT → not rolled (rule says none)',
    );
    expect(explain(must(geelong))).toContain('business day on VIC_GREATER_GEELONG → no roll');
  });

  it("uses the org's locality calendar for locality rules and reminders", () => {
    const r = rule({ id: 'r.loc', calendar: 'locality', offset: { days: 1 }, reminders: [13] });
    const [geelong] = compute(input([r], [grant('2026-11-02')], { localityCalendar: 'VIC_GREATER_GEELONG' }));
    const [melbourne] = compute(input([r], [grant('2026-11-02')]));
    expect(geelong?.dueDate).toBe('2026-11-03');
    expect(melbourne?.dueDate).toBe('2026-11-04');
    // 13 days before 3 Nov is Wed 21 Oct: Geelong Cup Day in Geelong, so the reminder moves back a day.
    expect(geelong?.reminders).toEqual([{ offsetDays: 13, date: '2026-10-20' }]);
    expect(ruleCalendar(r, input([r], []))).toBe('VIC_MELBOURNE');
  });

  it('fails loudly when a needed calendar year is missing', () => {
    expect(() => compute(input([rule({ id: 'r.missing' })], [grant('2028-12-28')]))).toThrow(
      'CALENDAR_MISSING: No VIC_SUPREME_COURT calendar data for 2029',
    );
    const partial = buildCalendarSet([must(VIC_CALENDARS['VIC_SUPREME_COURT']?.[2026])]);
    expect(() =>
      compute(
        input([rule({ id: 'r.unknown', calendar: 'VIC_MELBOURNE' })], [grant('2026-03-02')], { calendars: partial }),
      ),
    ).toThrow('CALENDAR_UNKNOWN');
  });
});

describe('compute: applicability, anchors and statuses', () => {
  it('skips rules for other matter types, jurisdictions or failed conditions', () => {
    const rules = [
      rule({ id: 'x.type', appliesTo: { matterTypes: ['will'], jurisdictions: ['VIC'] } }),
      rule({ id: 'x.juris', appliesTo: { matterTypes: ['probate'], jurisdictions: ['NSW'] } }),
      rule({ id: 'x.cond', conditions: [{ fact: 'estate.hasMainResidence', eq: true }] }),
      rule({
        id: 'x.ok',
        conditions: [
          { fact: 'estate.hasMainResidence', eq: false },
          { fact: 'grant.type', in: ['probate', 'loa'] },
          { fact: 'grant.filed', exists: false },
        ],
      }),
    ];
    const results = compute(
      input(rules, [grant('2026-03-02')], {
        matter: {
          type: 'probate',
          jurisdiction: 'VIC',
          facts: { estate: { hasMainResidence: false }, grant: { type: 'probate' } },
        },
      }),
    );
    expect(results.map((r) => r.ruleId)).toEqual(['x.ok']);
    expect(explain(must(results[0])).slice(0, 3)).toEqual([
      'condition estate.hasMainResidence = false: yes (false)',
      'condition grant.type in [probate, loa]: yes ("probate")',
      'condition grant.filed is absent: yes (absent)',
    ]);
  });

  it('evaluates conditions and reads dotted facts', () => {
    expect(readFact({ a: { b: { c: 3 } } }, 'a.b.c')).toBe(3);
    expect(readFact({ a: 1 }, 'a.b')).toBeUndefined();
    expect(readFact({ a: null }, 'a.b')).toBeUndefined();
    expect(evaluateCondition({ fact: 'a', exists: true }, { a: 0 }).passed).toBe(true);
    expect(evaluateCondition({ fact: 'a', exists: true }, { a: null }).passed).toBe(false);
    expect(evaluateCondition({ fact: 'a', in: [1, 2] }, { a: 3 }).passed).toBe(false);
  });

  it('blocks when the anchor is missing, with the rule reason or a generic one', () => {
    const task = { title: 'Advise', dedupeKey: 'task:advise' };
    const [fp, other] = compute(
      input(
        [
          rule({ id: 'b.fp', blockedReason: 'No grant yet', createsTask: task }),
          rule({ id: 'b.custom', anchor: { event: 'custom' } }),
        ],
        [],
      ),
    );
    expect(fp?.task).toBeUndefined();
    expect(fp).toMatchObject({ status: 'blocked', reason: 'No grant yet' });
    expect(fp?.dueDate).toBeUndefined();
    expect(other?.reason).toBe('No custom yet');
    expect(explain(must(fp))).toEqual(['blocked: No grant yet', 'rule b.fp · test v3 · Test citation']);
  });

  it('marks a future date of death invalid', () => {
    const [r] = compute(
      input(
        [rule({ id: 'b.dod', anchor: { event: 'date_of_death' } })],
        [{ kind: 'date_of_death', date: d('2026-02-01') }],
      ),
    );
    expect(r).toMatchObject({ status: 'invalid', reason: 'The date of death (2026-02-01) is in the future' });
    expect(explain(must(r))).toContain('invalid: The date of death (2026-02-01) is in the future');
  });

  it('computes the earliest possible date from an approximate anchor, and flags it', () => {
    const [month, year] = compute(
      input(
        [
          rule({ id: 'p.month', anchor: { event: 'date_of_death' }, offset: { months: 12 } }),
          rule({ id: 'p.year', anchor: { event: 'will_located' }, offset: { months: 12 } }),
        ],
        [
          { id: 'dod', kind: 'date_of_death', date: d('2025-08-17'), meta: { datePrecision: 'month' } },
          { id: 'will', kind: 'will_located', date: d('2025-06-30'), meta: { datePrecision: 'year' } },
        ],
      ),
    );
    expect(month).toMatchObject({ approximate: true, dueDate: '2026-08-03' });
    expect(explain(must(month))).toContain(
      'approximate date (month only): using the earliest possible date 2025-08-01',
    );
    // 2025-01-01 + 12 months is New Year's Day 2026, inside the court's closure to 2 Jan.
    expect(year?.dueDate).toBe('2026-01-05');
  });

  it('prefers the anchor recorded for the matter jurisdiction (reseal), then the latest, ignoring deleted events', () => {
    const r = rule({ id: 's.anchor' });
    const events: EngineEvent[] = [
      grant('2026-01-10', { id: 'nsw', meta: { jurisdiction: 'NSW' } }),
      grant('2026-03-02', { id: 'vic', meta: { jurisdiction: 'VIC' } }),
      grant('2026-05-01', { id: 'deleted', meta: { jurisdiction: 'VIC' }, deleted: true }),
    ];
    expect(selectAnchor(events, r, 'VIC')?.id).toBe('vic');
    expect(selectAnchor([must(events[0]), grant('2026-02-01', { id: 'later' })], r, 'VIC')?.id).toBe('later');
    expect(selectAnchor([], r, 'VIC')).toBeUndefined();
    const [result] = compute(input([r], events));
    expect(result).toMatchObject({ anchorEventId: 'vic', dueDate: '2026-03-12' });
    expect(explain(must(result))[0]).toBe('anchor grant_issued = 2026-03-02 (Monday) · event vic');
    const [noId] = compute(input([r], [{ kind: 'grant_issued', date: d('2026-03-02') }]));
    expect(explain(must(noId))[0]).toBe('anchor grant_issued = 2026-03-02 (Monday)');
  });

  it('flags deadlines already past on computation for review, and adds dueTime, reminders and tasks', () => {
    const r = rule({
      id: 't.all',
      dueTime: '16:00',
      reminders: [7, 1],
      createsTask: { title: 'Do it', dedupeKey: 'task:do' },
    });
    const [past] = compute(input([r], [grant('2025-10-01')]));
    expect(past).toMatchObject({
      pastOnCreation: true,
      dueTime: '16:00',
      task: { title: 'Do it', dedupeKey: 'task:do' },
    });
    expect(explain(must(past))).toContain('already past on 2026-01-01: needs review (not marked missed)');
    // Due Sat 11 Oct rolls to Mon 13 Oct; the 1-day reminder (Sun 12) moves back to Fri 10.
    expect(past?.dueDate).toBe('2025-10-13');
    expect(past?.reminders).toEqual([
      { offsetDays: 7, date: '2025-10-06' },
      { offsetDays: 1, date: '2025-10-10' },
    ]);
  });

  it('de-duplicates tasks by dedupeKey, keeping the first rule', () => {
    const task = { title: 'Plan the distribution', dedupeKey: 'task:plan' };
    const [first, second] = compute(
      input(
        [rule({ id: 'd.one', createsTask: task }), rule({ id: 'd.two', createsTask: task })],
        [grant('2026-03-02')],
      ),
    );
    expect(first?.task).toEqual(task);
    expect(second?.task).toBeUndefined();
    expect(explain(must(second))).toContain('task "task:plan" already proposed by d.one');
  });
});

describe('compute: composite rules', () => {
  const a = rule({ id: 'c.a', offset: { days: 10 } });
  const b = rule({ id: 'c.b', anchor: { event: 'statutory_notice_published' }, offset: { days: 60 } });
  const composite = (op: 'max' | 'min'): Rule => ({
    id: `c.${op}`,
    title: op,
    citation: 'Composite',
    explain: 'Composite',
    appliesTo: { matterTypes: ['probate'], jurisdictions: ['VIC'] },
    conditions: [],
    composite: { op, of: ['c.a', 'c.b'] },
    nonBusinessDay: 'none',
    calendar: 'VIC_SUPREME_COURT',
    kind: 'statutory',
    critical: false,
    reminders: [],
    verify: false,
  });

  it('takes the later or earlier of its parts', () => {
    const events = [
      grant('2026-03-02'),
      { id: 'n', kind: 'statutory_notice_published' as const, date: d('2026-02-01'), meta: { datePrecision: 'month' } },
    ];
    const results = compute(input([a, b, composite('max'), composite('min')], events));
    expect(results.map((r) => r.dueDate)).toEqual(['2026-03-12', '2026-04-02', '2026-04-02', '2026-03-12']);
    expect(results[2]?.approximate).toBe(true);
    expect(explain(must(results[2]))[0]).toBe('later of c.a 2026-03-12 and c.b 2026-04-02 → 2026-04-02');
    expect(explain(must(results[3]))[0]).toBe('earlier of c.a 2026-03-12 and c.b 2026-04-02 → 2026-03-12');
  });

  it('blocks when a part is blocked or does not apply', () => {
    const [, , blocked] = compute(input([a, b, composite('max')], [grant('2026-03-02')]));
    expect(blocked?.reason).toBe('Waiting on c.b: No statutory notice yet');
    const willOnly = rule({ ...b, appliesTo: { matterTypes: ['will'], jurisdictions: ['VIC'] } });
    const [, notApplicable] = compute(input([a, willOnly, composite('max')], [grant('2026-03-02')]));
    expect(notApplicable?.reason).toBe("Waiting on c.b: c.b doesn't apply to this matter");
  });
});

describe('rule set validation', () => {
  const base = {
    ruleSetId: 't',
    version: 1,
    jurisdiction: 'VIC',
    published: true,
    practitionerReviewed: false,
    flag: 'f',
    disclaimer: 'd',
  };
  it('rejects duplicate ids, unknown composite parts and nested composites', () => {
    const composite = (id: string, of: string[]) => ({ ...rule({ id: 'tmp.x' }), id, composite: { op: 'max', of } });
    const strip = (r: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(r).filter(([key]) => !['anchor', 'offset', 'direction', 'counting', 'monthEnd'].includes(key)),
      );
    const result = RuleSetSchema.safeParse({
      ...base,
      rules: [
        rule({ id: 'a.one' }),
        rule({ id: 'a.one' }),
        strip(composite('a.c1', ['a.one', 'a.missing'])),
        strip(composite('a.c2', ['a.one', 'a.c1'])),
      ],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.message)).toEqual([
      'Duplicate rule id a.one',
      'a.c1 refers to unknown rule a.missing',
      "a.c2: composite rules can't nest (a.c1)",
    ]);
  });
});

describe('diff', () => {
  it('reports added, removed, moved (earlier or later) and status changes', () => {
    const rules = [rule({ id: 'f.a' }), rule({ id: 'f.b' }), rule({ id: 'f.c', anchor: { event: 'caveat_lodged' } })];
    const previous = compute(input(rules, [grant('2026-03-02')]));
    const next = compute(
      input(
        [must(rules[0]), rule({ id: 'f.c', anchor: { event: 'caveat_lodged' } }), rule({ id: 'f.d' })],
        [grant('2026-02-02'), { kind: 'caveat_lodged', date: d('2026-02-02') }],
      ),
    );
    const changes = diff(previous, next);
    expect(changes.map((c) => [c.type, c.ruleId])).toEqual([
      ['moved', 'f.a'],
      ['status', 'f.c'],
      ['added', 'f.d'],
      ['removed', 'f.b'],
    ]);
    expect(changes[0]).toMatchObject({ earlier: true });
    const later = diff(next, previous).find((c) => c.type === 'moved');
    expect(later).toMatchObject({ earlier: false });
    expect(diff(previous, previous)).toEqual([]);
  });
});

describe('renderStep', () => {
  it('renders a condition on an absent fact', () => {
    expect(renderStep({ kind: 'condition', fact: 'x', test: 'exists', actual: undefined, passed: false })).toBe(
      'condition x exists: no (absent)',
    );
  });

  it('renders the rule step with version and citation', () => {
    const dateStep = { kind: 'past' as const, today: d('2026-01-01') as DateOnly };
    expect(renderStep(dateStep)).toMatch(/already past/);
  });
});
