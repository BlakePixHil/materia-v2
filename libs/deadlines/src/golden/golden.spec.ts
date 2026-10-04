import { type DateOnly, dateOnly, type EventKind } from '@materia/domain';

import { GOLDEN, type GoldenScenario } from './scenarios';
import { VIC_CALENDARS, VIC_RULESET_V1 } from '../lib/data';
import { compute, explain } from '../lib/engine';
import type { ComputedDeadline } from '../lib/model';

function run(scenario: GoldenScenario): ComputedDeadline[] {
  return compute({
    matter: { type: scenario.matterType, jurisdiction: 'VIC', facts: scenario.facts ?? {} },
    events: scenario.events.map((e) => ({ ...e, kind: e.kind as EventKind, date: dateOnly(e.date) })),
    ruleSet: VIC_RULESET_V1,
    calendars: VIC_CALENDARS,
    localityCalendar: scenario.locality,
    today: dateOnly(scenario.today ?? '2026-10-04') as DateOnly,
  });
}

describe('golden scenarios (Victoria v1)', () => {
  it('has at least 40 scenarios with unique names', () => {
    expect(GOLDEN.length).toBeGreaterThanOrEqual(40);
    expect(new Set(GOLDEN.map((s) => s.name)).size).toBe(GOLDEN.length);
  });

  it.each(GOLDEN.map((s) => [s.name, s] as const))('%s', (_name, scenario) => {
    if (scenario.throws) {
      expect(() => run(scenario)).toThrow(scenario.throws);
      return;
    }
    const results = run(scenario);
    const byRule = new Map(results.map((r) => [r.ruleId, r]));
    for (const [ruleId, expected] of Object.entries(scenario.expect)) {
      const result = byRule.get(ruleId);
      if (expected === 'omit') {
        expect(result, ruleId).toBeUndefined();
        continue;
      }
      expect(result, `${ruleId} should apply`).toBeDefined();
      if (expected === 'blocked' || expected === 'invalid') expect(result?.status, ruleId).toBe(expected);
      else expect({ ruleId, dueDate: result?.dueDate }).toEqual({ ruleId, dueDate: expected });
    }
    for (const [ruleId, flags] of Object.entries(scenario.flags ?? {})) {
      const result = byRule.get(ruleId);
      expect({ ruleId, past: result?.pastOnCreation, approximate: result?.approximate }).toEqual({
        ruleId,
        past: flags.includes('past'),
        approximate: flags.includes('approximate'),
      });
    }
    for (const [ruleId, dates] of Object.entries(scenario.reminders ?? {}))
      expect(byRule.get(ruleId)?.reminders.map((r) => r.date)).toEqual(dates);
    for (const [ruleId, time] of Object.entries(scenario.dueTime ?? {})) expect(byRule.get(ruleId)?.dueTime).toBe(time);
    if (scenario.tasksFrom) expect(results.filter((r) => r.task).map((r) => r.ruleId)).toEqual(scenario.tasksFrom);

    // Every result and its trace, for practitioner review (golden.spec.ts.snap).
    expect(
      results.map((r) => ({
        rule: r.ruleId,
        status: r.status,
        due: r.dueDate ?? null,
        reason: r.reason ?? null,
        trace: explain(r),
      })),
    ).toMatchSnapshot();
  });
});
