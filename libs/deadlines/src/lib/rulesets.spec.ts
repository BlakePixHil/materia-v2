import { dateOnly } from '@materia/domain';

import { buildCalendarSet } from './calendar';
import { VIC_CALENDARS, VIC_RULESET_V1 } from './data';
import { DeadlineEngineError, type ComputeInput, type RuleSet } from './model';
import {
  BUNDLED_RULE_SETS,
  computeSafely,
  fromRuleSetDoc,
  latestRuleSet,
  RULE_SET_FOR_JURISDICTION,
  ruleSetReadsFacts,
  selectRules,
  statutoryFlagKey,
  storedTrace,
} from './rulesets';
import { toRuleSetDoc } from './storage';

/** CORE-10: choosing the rule set and its rules, and computing without failing a whole matter. Fictional. */

const d = dateOnly;

function input(extra: Partial<ComputeInput> = {}): ComputeInput {
  return {
    matter: { type: 'probate', jurisdiction: 'VIC', facts: {} },
    events: [
      { id: 'ev-dod', kind: 'date_of_death', date: d('2026-03-02') },
      { id: 'ev-grant', kind: 'grant_issued', date: d('2026-06-15') },
    ],
    ruleSet: VIC_RULESET_V1,
    calendars: VIC_CALENDARS,
    localityCalendar: 'VIC_GREATER_GEELONG',
    today: d('2026-10-05'),
    ...extra,
  };
}

describe('rule sets', () => {
  it('bundles Victoria v1 and maps VIC to it', () => {
    expect(BUNDLED_RULE_SETS).toContain(VIC_RULESET_V1);
    expect(RULE_SET_FOR_JURISDICTION.VIC).toBe('vic');
    expect(statutoryFlagKey(VIC_RULESET_V1)).toBe('deadlines.ruleset.vic.v1');
  });

  it('reads a stored version back, defaulting the flag and disclaimer', () => {
    const doc = toRuleSetDoc(VIC_RULESET_V1) as unknown as Record<string, unknown>;
    expect(fromRuleSetDoc(doc)).toEqual(VIC_RULESET_V1);
    const { flag, disclaimer, ...bare } = doc;
    void flag;
    void disclaimer;
    const read = fromRuleSetDoc({ ...bare, practitionerReviewed: undefined, version: 2 });
    expect(read.flag).toBe('deadlines.ruleset.vic');
    expect(read.practitionerReviewed).toBe(false);
    expect(read.disclaimer).toMatch(/Illustrative/);
    expect(() => fromRuleSetDoc({ ...doc, rules: 'nope' })).toThrow();
  });

  it('picks the latest published version, bundled or stored', () => {
    expect(latestRuleSet('vic')).toBe(VIC_RULESET_V1);
    const v2: RuleSet = { ...VIC_RULESET_V1, version: 2 };
    const draft: RuleSet = { ...VIC_RULESET_V1, version: 3, published: false };
    expect(latestRuleSet('vic', [v2, draft])).toBe(v2);
    expect(latestRuleSet('nsw')).toBeUndefined();
  });

  it('skips statutory rules (and composites built on them) while the flag is off', () => {
    const off = selectRules(VIC_RULESET_V1, { statutoryEnabled: false });
    expect([...off.skipped].sort()).toEqual(
      VIC_RULESET_V1.rules
        .filter((r) => r.kind === 'statutory')
        .map((r) => r.id)
        .sort(),
    );
    expect(off.ruleSet.rules.every((r) => r.kind !== 'statutory')).toBe(true);
    const on = selectRules(VIC_RULESET_V1, { statutoryEnabled: true, ruleIds: ['org.executor_year'] });
    expect(on.skipped.size).toBe(0);
    expect(on.ruleSet.rules.map((r) => r.id)).toEqual(['org.executor_year']);
  });

  it('skips a non-statutory composite whose part is statutory', () => {
    const composite = {
      ...(VIC_RULESET_V1.rules.find((r) => r.id === 'vic.distribution.earliest') as RuleSet['rules'][number]),
      kind: 'internal' as const,
    };
    const set: RuleSet = {
      ...VIC_RULESET_V1,
      rules: VIC_RULESET_V1.rules.map((r) => (r.id === composite.id ? composite : r)),
    };
    expect(selectRules(set, { statutoryEnabled: false }).skipped.has('vic.distribution.earliest')).toBe(true);
  });
});

describe('computeSafely', () => {
  it('returns the engine results with blocked codes', () => {
    const results = computeSafely(input());
    const fp = results.find((r) => r.deadline.ruleId === 'vic.fp.limitation');
    expect(fp?.deadline.dueDate).toBe('2026-12-15');
    expect(fp?.blockedCode).toBeUndefined();
    const advert = results.find((r) => r.deadline.ruleId === 'vic.probate.advert_min');
    expect(advert?.blockedCode).toBe('anchor_missing');
  });

  it('marks a missing event detail and a future date of death as invalid input', () => {
    const results = computeSafely(
      input({
        matter: { type: 'fp', jurisdiction: 'VIC', facts: {} },
        events: [{ id: 'ev-order', kind: 'order_made', date: d('2026-09-01') }],
      }),
    );
    expect(results.find((r) => r.deadline.ruleId === 'vic.order.compliance')?.blockedCode).toBe('invalid_input');
    const future = computeSafely(input({ events: [{ id: 'ev-dod', kind: 'date_of_death', date: d('2026-12-01') }] }));
    expect(future.find((r) => r.deadline.ruleId === 'org.executor_year')?.blockedCode).toBe('invalid_input');
  });

  it('blocks only the rules whose calendar year is missing', () => {
    // A grant late in 2028: six months on is 2029, which has no calendar data.
    const results = computeSafely(
      input({
        events: [
          { id: 'ev-dod', kind: 'date_of_death', date: d('2027-01-04') },
          { id: 'ev-grant', kind: 'grant_issued', date: d('2028-09-01') },
          { id: 'ev-notice', kind: 'notice_published', date: d('2027-02-01') },
        ],
        today: d('2027-01-05'),
      }),
    );
    const fp = results.find((r) => r.deadline.ruleId === 'vic.fp.limitation');
    expect(fp).toMatchObject({
      blockedCode: 'calendar_missing',
      calendarMissing: { calendarId: 'VIC_SUPREME_COURT', year: 2029 },
      deadline: { status: 'blocked', reason: 'No VIC_SUPREME_COURT calendar data for 2029' },
    });
    expect(results.find((r) => r.deadline.ruleId === 'vic.distribution.earliest')?.blockedCode).toBe(
      'calendar_missing',
    );
    // Others still compute, and the shared distribution task is proposed once.
    expect(results.find((r) => r.deadline.ruleId === 'org.executor_year')?.deadline.dueDate).toBe('2028-01-04');
    const advert = results.find((r) => r.deadline.ruleId === 'vic.probate.advert_min');
    expect(advert?.deadline.task?.dedupeKey).toBe('task:file-grant');
    // Rules that don't apply (conditions, matter type) stay out.
    expect(results.some((r) => r.deadline.ruleId === 'au.cgt.main_residence')).toBe(false);
    expect(results.some((r) => r.deadline.ruleId === 'vic.offer.o26_expiry')).toBe(false);
  });

  it('drops a duplicate task in the rule-by-rule fallback', () => {
    const results = computeSafely(
      input({
        events: [
          { id: 'ev-grant', kind: 'grant_issued', date: d('2028-05-01') },
          { id: 'ev-stat', kind: 'statutory_notice_published', date: d('2028-11-15') },
        ],
        today: d('2028-01-05'),
      }),
    );
    const tasks = results.flatMap((r) => (r.deadline.task ? [r.deadline.task.dedupeKey] : []));
    expect(tasks.filter((key) => key === 'task:plan-distribution')).toHaveLength(1);
    expect(results.find((r) => r.deadline.ruleId === 'vic.distribution.s33_notice')?.blockedCode).toBe(
      'calendar_missing',
    );
  });

  it('reports an unknown calendar as blocked, and rethrows anything else', () => {
    const set: RuleSet = {
      ...VIC_RULESET_V1,
      rules: VIC_RULESET_V1.rules.map((r) => (r.id === 'org.executor_year' ? { ...r, calendar: 'NOWHERE' } : r)),
    };
    const results = computeSafely(input({ ruleSet: set }));
    expect(results.find((r) => r.deadline.ruleId === 'org.executor_year')?.deadline.reason).toBe(
      "No calendar NOWHERE: the rule can't be computed",
    );
    const broken = () =>
      computeSafely(
        input({
          calendars: buildCalendarSet([]),
          ruleSet: {
            ...VIC_RULESET_V1,
            rules: [
              {
                ...(VIC_RULESET_V1.rules.find((r) => r.id === 'vic.distribution.earliest') as RuleSet['rules'][number]),
              },
            ],
          },
        }),
      );
    // A composite whose parts aren't in the set is blocked (not thrown) by the engine itself.
    expect(broken()[0]?.blockedCode).toBe('anchor_missing');
    const original = VIC_RULESET_V1.rules;
    expect(() =>
      computeSafely(
        input({
          ruleSet: {
            ...VIC_RULESET_V1,
            get rules() {
              throw new DeadlineEngineError('RULE_UNKNOWN', 'boom');
            },
          } as unknown as RuleSet,
        }),
      ),
    ).toThrow('RULE_UNKNOWN');
    expect(original).toBe(VIC_RULESET_V1.rules);
  });
});

describe('storedTrace', () => {
  it('leaves out the already-past step', () => {
    const [executor] = computeSafely(
      input({
        ruleSet: { ...VIC_RULESET_V1, rules: VIC_RULESET_V1.rules.filter((r) => r.id === 'org.executor_year') },
        today: d('2027-06-01'),
      }),
    );
    const deadline = (executor as { deadline: Parameters<typeof storedTrace>[0] }).deadline;
    expect(deadline.pastOnCreation).toBe(true);
    const lines = storedTrace(deadline);
    expect(lines.some((line) => line.startsWith('already past'))).toBe(false);
    expect(lines.at(-1)).toMatch(/^rule org.executor_year/);
  });
});

describe('ruleSetReadsFacts (CORE-16)', () => {
  const ESTATE_VALUES = ['estate.grossValueCents', 'estate.netValueCents'];
  const base = VIC_RULESET_V1.rules.find((rule) => 'offset' in rule) as RuleSet['rules'][number];

  it('is false for the Victorian rule set, which reads no estate values', () => {
    expect(ruleSetReadsFacts(VIC_RULESET_V1, ESTATE_VALUES)).toBe(false);
    expect(ruleSetReadsFacts(VIC_RULESET_V1, ['estate.hasMainResidence'])).toBe(true);
  });

  it('finds a fact in a condition or an offset amount', () => {
    const condition = { ...base, conditions: [{ fact: 'estate.netValueCents', exists: true }] } as RuleSet['rules'][number];
    const offset = { ...base, conditions: [], offset: { days: { fact: 'estate.grossValueCents', default: 0 } } } as RuleSet['rules'][number];
    expect(ruleSetReadsFacts({ rules: [condition] }, ESTATE_VALUES)).toBe(true);
    expect(ruleSetReadsFacts({ rules: [offset] }, ESTATE_VALUES)).toBe(true);
    expect(ruleSetReadsFacts({ rules: [{ ...base, conditions: [], offset: { days: 3 } } as RuleSet['rules'][number]] }, ESTATE_VALUES)).toBe(false);
  });
});
