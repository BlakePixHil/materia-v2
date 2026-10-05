import { dateOnly, type DateOnly } from '@materia/domain';

import { VIC_CALENDARS, VIC_RULESET_V1 } from './data';
import type { ComputeInput, EngineEvent } from './model';
import {
  computedDeadlineFields,
  type ExistingDeadline,
  isEmptyPlan,
  linkedTaskId,
  planRecompute,
  provenance,
  type RecomputePlan,
} from './persist';
import { computeSafely, selectRules, type EngineResult } from './rulesets';

/** CORE-10: what a recompute writes. Fictional matter, illustrative rules. */

const d = dateOnly;
const TODAY = d('2026-10-05');

function results(events: EngineEvent[], today: DateOnly = TODAY, extra: Partial<ComputeInput> = {}): EngineResult[] {
  return computeSafely({
    matter: { type: 'probate', jurisdiction: 'VIC', facts: {} },
    events,
    ruleSet: VIC_RULESET_V1,
    calendars: VIC_CALENDARS,
    localityCalendar: 'VIC_GREATER_GEELONG',
    today,
    ...extra,
  });
}

const dod = (date: string): EngineEvent => ({ id: 'ev-dod', kind: 'date_of_death', date: d(date) });
const grant = (date: string): EngineEvent => ({ id: 'ev-grant', kind: 'grant_issued', date: d(date) });
const notice = (date: string): EngineEvent => ({ id: 'ev-notice', kind: 'notice_published', date: d(date) });

/** The documents a plan's creates and updates leave behind, as the next recompute reads them. */
function apply(existing: ExistingDeadline[], plan: RecomputePlan): ExistingDeadline[] {
  const docs = new Map(existing.map((e) => [e.id, { ...e }]));
  for (const create of plan.creates) {
    docs.set(create.id, { id: create.id, deleted: false, ...create.fields });
  }
  for (const update of plan.updates) {
    const doc = docs.get(update.id) as Record<string, unknown>;
    const kept = Object.fromEntries(Object.entries(doc).filter(([key]) => !update.remove.includes(key)));
    docs.set(update.id, { ...kept, ...update.set } as unknown as ExistingDeadline);
  }
  return [...docs.values()];
}

function plan(
  r: EngineResult[],
  existing: ExistingDeadline[] = [],
  extra: Partial<Parameters<typeof planRecompute>[0]> = {},
) {
  return planRecompute({ results: r, skipped: new Set(), existing, pending: [], today: TODAY, ...extra });
}

const byId = (docs: ExistingDeadline[], id: string) => docs.find((doc) => doc.id === id) as ExistingDeadline;

describe('planRecompute', () => {
  it('creates a deadline per applicable rule: dated ones upcoming, the rest blocked', () => {
    const p = plan(results([dod('2026-03-02')]));
    const ids = p.creates.map((c) => c.id);
    expect(ids).toContain('rule-org.executor_year');
    const executor = p.creates.find((c) => c.id === 'rule-org.executor_year');
    expect(executor?.fields).toMatchObject({
      status: 'upcoming',
      dueDate: '2027-03-02',
      kind: 'internal',
      critical: false,
      pastOnCreation: false,
      reminders: [{ offsetDays: 30 }],
      computed: { ruleId: 'org.executor_year', ruleSetId: 'vic', ruleSetVersion: 1, anchorEventId: 'ev-dod' },
    });
    expect(executor?.fields.computed.trace.at(-1)).toMatch(/^rule org.executor_year · vic v1/);
    const fp = p.creates.find((c) => c.id === 'rule-vic.fp.limitation');
    expect(fp?.fields).toMatchObject({
      status: 'blocked',
      blockedReason: 'No grant yet',
      blockedCode: 'anchor_missing',
    });
    expect(fp?.fields.dueDate).toBeUndefined();
    expect(p.proposals).toEqual([]);
    expect(isEmptyPlan(p)).toBe(false);
  });

  it('is idempotent: a second run on its own result plans nothing', () => {
    const r = results([dod('2026-03-02'), notice('2026-09-20')]);
    const first = plan(r);
    const second = plan(r, apply([], first));
    expect(isEmptyPlan(second)).toBe(true);
    // Tasks are planned every time; the writer creates only the missing ones.
    expect(second.tasks.map((t) => t.dedupeKey)).toEqual(['task:file-grant']);
    expect(second.tasks[0]).toMatchObject({
      deadlineId: 'rule-vic.probate.advert_min',
      title: 'File the application for a grant',
      stage: 'grant',
    });
  });

  it('flags a deadline already past on creation and never as missed', () => {
    const p = plan(results([dod('2025-02-10')], d('2026-10-05')));
    const executor = p.creates.find((c) => c.id === 'rule-org.executor_year');
    expect(executor?.fields).toMatchObject({ status: 'upcoming', dueDate: '2026-02-10', pastOnCreation: true });
    expect(executor?.fields.computed.trace.some((line) => line.startsWith('already past'))).toBe(false);
  });

  it('proposes a date change instead of moving an upcoming deadline', () => {
    const before = apply([], plan(results([dod('2026-03-02')])));
    const p = plan(results([dod('2026-02-20')]), before);
    const moved = p.proposals.find((x) => x.deadlineId === 'rule-org.executor_year');
    expect(moved).toMatchObject({
      kind: 'moved',
      fromDueDate: '2027-03-02',
      toDueDate: '2027-02-22',
      earlier: true,
      intoPast: false,
      ruleId: 'org.executor_year',
      computed: { anchorEventId: 'ev-dod' },
    });
    expect(p.updates.some((u) => u.id === 'rule-org.executor_year')).toBe(false);
    expect(p.creates).toEqual([]);
  });

  it('marks a proposal into the past', () => {
    const before = apply([], plan(results([dod('2025-11-20')], d('2025-11-21'))));
    const p = plan(results([dod('2025-09-01')]), before);
    expect(p.proposals.find((x) => x.deadlineId === 'rule-org.executor_year')).toMatchObject({
      fromDueDate: '2026-11-20',
      toDueDate: '2026-09-01',
      intoPast: true,
      earlier: true,
    });
  });

  it('keeps a pending proposal that still holds and supersedes one that no longer does', () => {
    const before = apply([], plan(results([dod('2026-03-02')])));
    const same = plan(results([dod('2026-02-20')]), before, {
      pending: [{ id: 'chg-1', deadlineId: 'rule-org.executor_year', kind: 'moved', toDueDate: '2027-02-22' }],
    });
    expect(same.proposals.some((x) => x.deadlineId === 'rule-org.executor_year')).toBe(false);
    expect(same.supersede).toEqual([]);
    const reverted = plan(results([dod('2026-03-02')]), before, {
      pending: [{ id: 'chg-1', deadlineId: 'rule-org.executor_year', kind: 'moved', toDueDate: '2027-02-22' }],
    });
    expect(reverted.proposals).toEqual([]);
    expect(reverted.supersede).toEqual(['chg-1']);
    const different = plan(results([dod('2026-02-10')]), before, {
      pending: [{ id: 'chg-1', deadlineId: 'rule-org.executor_year', kind: 'moved', toDueDate: '2027-02-22' }],
    });
    expect(different.supersede).toEqual(['chg-1']);
    expect(different.proposals.find((x) => x.deadlineId === 'rule-org.executor_year')?.toDueDate).toBe('2027-02-10');
  });

  it('does not propose again what the lawyer declined', () => {
    const before = apply([], plan(results([dod('2026-03-02')])));
    const executor = byId(before, 'rule-org.executor_year');
    executor.declined = { kind: 'moved', dueDate: '2027-02-22' };
    expect(plan(results([dod('2026-02-20')]), before).proposals.some((x) => x.deadlineId === executor.id)).toBe(false);
    expect(plan(results([dod('2026-02-10')]), before).proposals.some((x) => x.deadlineId === executor.id)).toBe(true);
  });

  it('proposes removal when the anchor is deleted, unless declined', () => {
    const before = apply([], plan(results([dod('2026-03-02')])));
    const p = plan(results([]), before);
    expect(p.proposals.find((x) => x.deadlineId === 'rule-org.executor_year')).toMatchObject({
      kind: 'removed',
      fromDueDate: '2027-03-02',
      reason: "The date of death isn't recorded",
    });
    byId(before, 'rule-org.executor_year').declined = { kind: 'removed' };
    expect(plan(results([]), before).proposals.some((x) => x.deadlineId === 'rule-org.executor_year')).toBe(false);
  });

  it('proposes removal when a rule no longer applies, and supersedes blocked ones silently', () => {
    const before = apply([], plan(results([dod('2026-03-02')])));
    const only = selectRules(VIC_RULESET_V1, { statutoryEnabled: true, ruleIds: ['vic.probate.prompt_filing'] });
    const p = plan(results([dod('2026-03-02')], TODAY, { ruleSet: only.ruleSet }), before);
    expect(p.proposals.find((x) => x.deadlineId === 'rule-org.executor_year')?.reason).toBe(
      'The rule no longer applies to this matter',
    );
    expect(p.updates.find((u) => u.id === 'rule-vic.fp.limitation')).toMatchObject({
      reason: 'superseded',
      set: { status: 'superseded' },
    });
  });

  it('leaves the deadlines of skipped rules alone', () => {
    const before = apply([], plan(results([dod('2026-03-02'), grant('2026-06-15')])));
    const off = selectRules(VIC_RULESET_V1, { statutoryEnabled: false });
    const p = plan(results([dod('2026-03-02'), grant('2026-06-15')], TODAY, { ruleSet: off.ruleSet }), before, {
      skipped: off.skipped,
    });
    expect(isEmptyPlan(p)).toBe(true);
  });

  it('dates a blocked deadline in place when its anchor arrives, and creates its task', () => {
    const before = apply([], plan(results([dod('2026-03-02')])));
    expect(byId(before, 'rule-vic.fp.limitation').status).toBe('blocked');
    const p = plan(results([dod('2026-03-02'), grant('2026-06-15')]), before);
    const fp = p.updates.find((u) => u.id === 'rule-vic.fp.limitation');
    expect(fp).toMatchObject({
      reason: 'dated',
      set: { status: 'upcoming', dueDate: '2026-12-15', pastOnCreation: false },
    });
    expect(fp?.remove).toEqual(expect.arrayContaining(['blockedReason', 'blockedCode', 'override', 'dueTime']));
    expect(p.tasks.map((t) => t.deadlineId)).toEqual(
      expect.arrayContaining(['rule-vic.fp.limitation', 'rule-vic.distribution.s99a']),
    );
    expect(p.proposals).toEqual([]);
  });

  it('updates a blocked reason, and revives a superseded deadline when its rule computes again', () => {
    const before = apply([], plan(results([dod('2026-03-02')])));
    const fp = byId(before, 'rule-vic.fp.limitation');
    fp.blockedReason = 'Something older';
    expect(plan(results([dod('2026-03-02')]), before).updates.find((u) => u.id === fp.id)).toMatchObject({
      reason: 'blocked',
      set: { blockedReason: 'No grant yet' },
    });
    fp.status = 'superseded';
    expect(plan(results([dod('2026-03-02')]), before).updates.some((u) => u.id === fp.id)).toBe(false);
    expect(
      plan(results([dod('2026-03-02'), grant('2026-06-15')]), before).updates.find((u) => u.id === fp.id),
    ).toMatchObject({ reason: 'revived', set: { status: 'upcoming', dueDate: '2026-12-15' } });
  });

  it('never touches done, waived or missed deadlines, nor deleted ones', () => {
    const before = apply([], plan(results([dod('2026-03-02')])));
    for (const status of ['done', 'waived', 'missed'] as const) {
      byId(before, 'rule-org.executor_year').status = status;
      expect(
        plan(results([dod('2026-02-01')]), before).proposals.some((x) => x.deadlineId === 'rule-org.executor_year'),
      ).toBe(false);
    }
    const deleted = before.map((e) => ({ ...e, deleted: true }));
    // A deleted deadline is as good as absent: its rule creates it again under the same id.
    expect(plan(results([dod('2026-03-02')]), deleted).creates.length).toBeGreaterThan(0);
  });

  it('keeps an override, refreshes the engine date behind it and flags it when earlier', () => {
    const before = apply([], plan(results([dod('2026-03-02')])));
    const executor = byId(before, 'rule-org.executor_year');
    executor.override = { dueDate: '2027-03-20' };
    executor.dueDate = '2027-03-20';
    // The override was set later than the engine's date: not a conflict until the engine moves earlier.
    const same = plan(results([dod('2026-03-02')]), before);
    expect(same.updates.find((u) => u.id === executor.id)).toBeUndefined();
    const earlier = plan(results([dod('2026-02-20')]), before);
    expect(earlier.proposals.some((x) => x.deadlineId === executor.id)).toBe(false);
    expect(earlier.updates.find((u) => u.id === executor.id)).toMatchObject({
      reason: 'override',
      set: { overrideConflict: true, computed: { dueDate: '2027-02-22' } },
    });
    expect(earlier.overrideConflicts).toEqual([executor.id]);
    // Already flagged: no second notification.
    const flagged = apply(before, earlier);
    expect(plan(results([dod('2026-02-20')]), flagged).overrideConflicts).toEqual([]);
    // The engine moving back past the override clears the flag.
    expect(
      plan(results([dod('2026-03-02')]), flagged).updates.find((u) => u.id === executor.id)?.set['overrideConflict'],
    ).toBe(true);
    const cleared = plan(results([dod('2026-03-25')]), flagged);
    expect(cleared.updates.find((u) => u.id === executor.id)?.set['overrideConflict']).toBe(false);
  });

  it('refreshes provenance when the date stays the same (a new rule-set version)', () => {
    const before = apply([], plan(results([dod('2026-03-02')])));
    const v2 = { ...VIC_RULESET_V1, version: 2 };
    const p = plan(results([dod('2026-03-02')], TODAY, { ruleSet: v2 }), before);
    const update = p.updates.find((u) => u.id === 'rule-org.executor_year');
    expect(update).toMatchObject({ reason: 'provenance', set: { computed: { ruleSetVersion: 2 } } });
    expect(update?.remove).toEqual(['dueTime']);
    expect(p.proposals).toEqual([]);
  });

  it('keeps the date in force when a calendar year goes missing, and reports it', () => {
    const events = [dod('2027-01-04'), grant('2028-02-01')];
    const before = apply([], plan(results(events, d('2027-01-05'))));
    expect(byId(before, 'rule-vic.fp.limitation').dueDate).toBe('2028-08-01');
    const moved = [dod('2027-01-04'), grant('2028-09-01')];
    const p = plan(results(moved, d('2027-01-05')), before);
    expect(p.proposals.some((x) => x.deadlineId === 'rule-vic.fp.limitation')).toBe(false);
    expect(p.calendarMissing).toEqual(
      expect.arrayContaining([
        {
          ruleId: 'vic.fp.limitation',
          deadlineId: 'rule-vic.fp.limitation',
          calendarId: 'VIC_SUPREME_COURT',
          year: 2029,
        },
      ]),
    );
  });

  it('keeps a timed rule’s due time', () => {
    const offer: EngineEvent = { id: 'ev-offer', kind: 'offer_made', date: d('2026-10-01'), meta: { periodDays: 28 } };
    const p = plan(results([offer], TODAY, { matter: { type: 'contest', jurisdiction: 'VIC', facts: {} } }));
    expect(p.creates.find((c) => c.id === 'rule-vic.offer.o26_expiry')?.fields).toMatchObject({
      dueTime: '16:00',
      critical: true,
      kind: 'court',
    });
    const before = apply([], p);
    const v2 = { ...VIC_RULESET_V1, version: 2 };
    const again = plan(
      results([offer], TODAY, { ruleSet: v2, matter: { type: 'contest', jurisdiction: 'VIC', facts: {} } }),
      before,
    );
    expect(again.updates.find((u) => u.id === 'rule-vic.offer.o26_expiry')?.set['dueTime']).toBe('16:00');
  });
});

describe('helpers', () => {
  it('provenance and fields carry the rule’s record', () => {
    const [first] = results([dod('2026-03-02')]);
    const deadline = (first as EngineResult).deadline;
    expect(provenance(deadline)).toMatchObject({
      ruleId: deadline.ruleId,
      citation: deadline.citation,
      explain: deadline.explain,
    });
    expect(
      computedDeadlineFields({ deadline: { ...deadline, status: 'blocked', reason: undefined, dueDate: undefined } }),
    ).toMatchObject({
      status: 'blocked',
      blockedReason: 'Not computed yet',
      blockedCode: 'anchor_missing',
    });
  });

  it('names linked tasks from their dedupe key', () => {
    expect(linkedTaskId('task:file-grant')).toBe('dlt-file-grant');
    expect(linkedTaskId('odd key/1')).toBe('dlt-odd-key-1');
  });
});
