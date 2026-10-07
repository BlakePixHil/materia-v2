import {
  canCompleteDeadline,
  canOverrideDeadline,
  canResolveDeadlineChange,
  CompleteDeadlineInput,
  compareDeadlines,
  computedDeadlineId,
  confirmationMatches,
  deadlineChangePath,
  deadlineChangeSummary,
  deadlineFlags,
  deadlineGroup,
  deadlineMatchesFilters,
  deadlineMatterCopy,
  deadlinePath,
  deadlineTraceText,
  deadlineTraceView,
  groupDeadlines,
  isUrgentChange,
  ManualDeadlineCreateInput,
  ManualDeadlineUpdateInput,
  matterCopyIsCurrent,
  matterEventPath,
  monthCalendar,
  needsReview,
  nextDeadlineOf,
  OverrideDeadlineInput,
  ProposeRulesetUpgradeInput,
  requiresTypedConfirmation,
  ruleSetFlagKey,
  UpsertEventInput,
  type DeadlineLike,
} from './deadlines';
import { FLAGS } from './flags';
import { Deadline, DeadlineChange } from './schemas/matter-records';
import { dateOnly } from './values/date-only';

/** CORE-10: the Deadlines screen's helpers and the callables' inputs. Fictional data only. */

const d = dateOnly;
const TODAY = d('2026-10-07'); // a Wednesday
const REQUEST = '4f8e2c1a-6b3d-4e5f-9a7b-1c2d3e4f5a6b';

const row = (id: string, dueDate: string | undefined, extra: Partial<DeadlineLike> = {}): DeadlineLike => ({
  id,
  title: `Fictional deadline ${id}`,
  dueDate,
  kind: 'internal',
  critical: false,
  status: 'upcoming',
  ...extra,
});

describe('paths and names', () => {
  it('builds paths and ids', () => {
    expect(matterEventPath('o', 'm')).toBe('orgs/o/matters/m/events');
    expect(matterEventPath('o', 'm', 'e')).toBe('orgs/o/matters/m/events/e');
    expect(deadlinePath('o', 'm', 'x')).toBe('orgs/o/matters/m/deadlines/x');
    expect(deadlinePath('o', 'm')).toBe('orgs/o/matters/m/deadlines');
    expect(deadlineChangePath('o', 'm', 'c')).toBe('orgs/o/matters/m/deadlineChanges/c');
    expect(deadlineChangePath('o', 'm')).toBe('orgs/o/matters/m/deadlineChanges');
    expect(computedDeadlineId('vic.fp.limitation')).toBe('rule-vic.fp.limitation');
  });

  it('names the statutory flag of a rule set version, which the registry defines for Victoria v1', () => {
    expect(ruleSetFlagKey('deadlines.ruleset.vic', 1)).toBe('deadlines.ruleset.vic.v1');
    expect(FLAGS['deadlines.ruleset.vic.v1'].serverEnforced).toBe(true);
  });
});

describe('groups', () => {
  it('puts a date in Overdue, This week (to Sunday), Next 30 days or Later', () => {
    expect(deadlineGroup(d('2026-10-06'), TODAY)).toBe('overdue');
    expect(deadlineGroup(TODAY, TODAY)).toBe('this_week');
    expect(deadlineGroup(d('2026-10-11'), TODAY)).toBe('this_week');
    expect(deadlineGroup(d('2026-10-12'), TODAY)).toBe('next_30_days');
    expect(deadlineGroup(d('2026-11-06'), TODAY)).toBe('next_30_days');
    expect(deadlineGroup(d('2026-11-07'), TODAY)).toBe('later');
  });

  it('groups live upcoming dated deadlines, sorted, keeping empty groups', () => {
    const groups = groupDeadlines(
      [
        row('b', '2026-10-09'),
        row('a', '2026-10-09', { critical: true }),
        row('late', '2026-10-01'),
        row('done', '2026-10-02', { status: 'done' }),
        row('blocked', undefined, { status: 'blocked' }),
        row('gone', '2026-10-08', { deletedAt: new Date() }),
        row('far', '2027-01-01'),
      ],
      TODAY,
    );
    expect(groups.map((g) => [g.id, g.label, g.deadlines.map((x) => x.id)])).toEqual([
      ['overdue', 'Overdue', ['late']],
      ['this_week', 'This week', ['a', 'b']],
      ['next_30_days', 'Next 30 days', []],
      ['later', 'Later', ['far']],
    ]);
  });

  it('sorts by date, time (untimed last), critical, title then id', () => {
    const sorted = [
      row('z', undefined),
      row('c', '2026-10-09'),
      row('t2', '2026-10-09', { dueTime: '16:00' }),
      row('t1', '2026-10-09', { dueTime: '09:00' }),
      row('crit', '2026-10-09', { critical: true }),
      row('same', '2026-10-09', { title: 'Fictional deadline c' }),
    ].sort(compareDeadlines);
    expect(sorted.map((x) => x.id)).toEqual(['t1', 't2', 'crit', 'c', 'same', 'z']);
  });
});

describe('nextDeadlineOf', () => {
  it('picks the soonest live upcoming dated deadline, overdue included', () => {
    expect(
      nextDeadlineOf([
        row('later', '2026-11-01'),
        row('done', '2026-09-01', { status: 'done' }),
        row('blocked', undefined, { status: 'blocked' }),
        row('gone', '2026-09-02', { deletedAt: new Date() }),
        row('late', '2026-10-01', { critical: true }),
      ]),
    ).toEqual({ id: 'late', dueDate: '2026-10-01', title: 'Fictional deadline late', critical: true });
  });

  it('is undefined with nothing open', () => {
    expect(nextDeadlineOf([row('done', '2026-10-01', { status: 'waived' })])).toBeUndefined();
  });
});

describe('filters', () => {
  const context = {
    uid: 'u-jordan',
    matter: { jurisdiction: 'VIC' as const, responsibleUid: 'u-priya', teamUids: ['u-jordan'] },
  };

  it('filters mine, team, critical, kind and jurisdiction', () => {
    const mine = row('m', '2026-10-09', { assigneeUid: 'u-jordan', critical: true, kind: 'statutory' });
    expect(deadlineMatchesFilters(mine, {}, context)).toBe(true);
    expect(deadlineMatchesFilters(mine, { mine: true }, context)).toBe(true);
    expect(deadlineMatchesFilters(row('x', '2026-10-09', { assigneeUid: 'u-priya' }), { mine: true }, context)).toBe(
      false,
    );
    expect(deadlineMatchesFilters(mine, { team: true }, context)).toBe(true);
    expect(deadlineMatchesFilters(mine, { team: true }, { uid: 'u-priya', matter: context.matter })).toBe(true);
    expect(
      deadlineMatchesFilters(mine, { team: true }, { uid: 'u-daniel', matter: { responsibleUid: 'u-priya' } }),
    ).toBe(false);
    expect(deadlineMatchesFilters(mine, { team: true }, { uid: 'u-daniel' })).toBe(false);
    expect(deadlineMatchesFilters(mine, { critical: true }, context)).toBe(true);
    expect(deadlineMatchesFilters(row('n', '2026-10-09'), { critical: true }, context)).toBe(false);
    expect(deadlineMatchesFilters(mine, { kinds: ['statutory', 'court'] }, context)).toBe(true);
    expect(deadlineMatchesFilters(mine, { kinds: ['court'] }, context)).toBe(false);
    expect(deadlineMatchesFilters(mine, { kinds: [] }, context)).toBe(true);
    expect(deadlineMatchesFilters(mine, { jurisdictions: ['VIC'] }, context)).toBe(true);
    expect(deadlineMatchesFilters(mine, { jurisdictions: ['NSW'] }, context)).toBe(false);
    expect(deadlineMatchesFilters(mine, { jurisdictions: ['VIC'] }, { uid: 'u-jordan' })).toBe(false);
  });

  it('copies a matter onto its deadlines, and knows when a copy is current (SEC-07c)', () => {
    const matter = {
      number: 'M-2026-0142',
      title: 'Estate of Margaret Whitfield',
      jurisdiction: 'VIC',
      responsibleUid: 'u-priya',
      teamUids: ['u-priya', 'u-jordan'],
      status: 'active',
    };
    const copy = deadlineMatterCopy(matter);
    expect(copy).toEqual({
      number: 'M-2026-0142',
      title: 'Estate of Margaret Whitfield',
      jurisdiction: 'VIC',
      responsibleUid: 'u-priya',
      teamUids: ['u-priya', 'u-jordan'],
    });
    // The copy is what the filters need.
    expect(
      deadlineMatchesFilters(row('t', '2026-10-09'), { team: true }, { uid: 'u-jordan', matter: copy ?? undefined }),
    ).toBe(true);
    expect(Deadline.schema.shape.matter.parse(copy)).toEqual(copy);
    expect(
      deadlineMatterCopy({ number: 'M-1', title: 'A matter', jurisdiction: 'XX', teamUids: [1, '', 'u-a'] }),
    ).toEqual({
      number: 'M-1',
      title: 'A matter',
      teamUids: ['u-a'],
    });
    expect(deadlineMatterCopy({ title: 'No number' })).toBeNull();
    expect(deadlineMatterCopy({ number: 'M-1', title: '  ' })).toBeNull();

    // Field by field, whatever order the stored map's keys come back in.
    const stored = {
      teamUids: ['u-priya', 'u-jordan'],
      title: matter.title,
      number: matter.number,
      responsibleUid: 'u-priya',
      jurisdiction: 'VIC',
    };
    expect(matterCopyIsCurrent(stored, copy)).toBe(true);
    expect(matterCopyIsCurrent(undefined, copy)).toBe(false);
    expect(matterCopyIsCurrent({ ...stored, title: 'Renamed' }, copy)).toBe(false);
    expect(matterCopyIsCurrent({ ...stored, teamUids: ['u-jordan', 'u-priya'] }, copy)).toBe(false);
    expect(matterCopyIsCurrent({ ...stored, responsibleUid: undefined }, copy)).toBe(false);
    expect(matterCopyIsCurrent({ ...stored, jurisdiction: null }, copy)).toBe(false);
    expect(
      matterCopyIsCurrent(
        { number: 'M-1', title: 'A matter', teamUids: [], jurisdiction: null },
        deadlineMatterCopy({ number: 'M-1', title: 'A matter' }),
      ),
    ).toBe(true);
    // Nothing to copy: nothing to write.
    expect(matterCopyIsCurrent(undefined, null)).toBe(true);
  });

  it('finds the review queue and the flags', () => {
    expect(needsReview(row('p', '2026-01-01', { pastOnCreation: true }))).toBe(true);
    expect(needsReview(row('p', '2026-01-01', { pastOnCreation: true, status: 'done' }))).toBe(false);
    expect(needsReview(row('p', '2026-01-01', { pastOnCreation: true, deletedAt: new Date() }))).toBe(false);
    expect(needsReview(row('p', '2026-01-01'))).toBe(false);
    expect(
      deadlineFlags(
        row('f', '2026-01-01', { pastOnCreation: true, overrideConflict: true, missedCheck: { since: '2026-01-01' } }),
      ),
    ).toEqual(['past_on_creation', 'override_conflict', 'missed_check']);
    expect(deadlineFlags(row('f', '2026-01-01'))).toEqual([]);
  });
});

describe('monthCalendar', () => {
  it('lays a month out in Monday-first weeks with each day’s deadlines', () => {
    const weeks = monthCalendar(
      '2026-10',
      [
        row('a', '2026-10-07'),
        row('b', '2026-10-07', { critical: true }),
        row('c', '2026-09-28'),
        row('x', undefined),
        row('gone', '2026-10-08', { deletedAt: new Date() }),
      ],
      TODAY,
    );
    expect(weeks).toHaveLength(5);
    expect(weeks[0]?.[0]).toMatchObject({ date: '2026-09-28', inMonth: false, deadlines: [{ id: 'c' }] });
    const day = weeks.flat().find((x) => x.date === '2026-10-07');
    expect(day).toMatchObject({ inMonth: true, isToday: true });
    expect(day?.deadlines.map((x) => x.id)).toEqual(['b', 'a']);
    expect(weeks.flat().find((x) => x.date === '2026-10-08')?.deadlines).toEqual([]);
    expect(weeks.at(-1)?.at(-1)?.date).toBe('2026-11-01');
    // A month starting on a Monday and one ending on a Sunday need no padding there.
    expect(monthCalendar('2026-06', [], TODAY)[0]?.[0]?.date).toBe('2026-06-01');
    expect(monthCalendar('2026-05', [], TODAY).at(-1)?.at(-1)?.date).toBe('2026-05-31');
    expect(() => monthCalendar('2026-13', [], TODAY)).toThrow('YYYY-MM');
  });
});

describe('traces', () => {
  const computed = {
    ruleId: 'vic.fp.limitation',
    ruleSetId: 'vic',
    ruleSetVersion: 1,
    trace: ['anchor grant_issued = 2026-06-15 (Monday)', '+ 6 months → 2026-12-15 (Tuesday)'],
    citation: 'Administration and Probate Act 1958 (Vic) s 99',
    dueDate: '2026-12-15',
  };

  it('shows a computed deadline’s rule, citation and steps', () => {
    expect(deadlineTraceView({ status: 'upcoming', dueDate: '2026-12-15', computed })).toEqual({
      heading: 'Computed by rule vic.fp.limitation (vic v1)',
      citation: 'Administration and Probate Act 1958 (Vic) s 99',
      lines: computed.trace,
      notes: [],
    });
  });

  it('adds notes for an override, a conflict, an approximate anchor, verification and past-on-creation', () => {
    const view = deadlineTraceView({
      status: 'upcoming',
      dueDate: '2027-01-10',
      computed: { ...computed, approximate: true, verify: true, citation: undefined },
      override: { dueDate: '2027-01-10', reason: 'Extension by consent (fictional)' },
      overrideConflict: true,
      pastOnCreation: true,
    });
    expect(view.citation).toBeUndefined();
    expect(view.notes).toEqual([
      'Overridden to 2027-01-10: Extension by consent (fictional)',
      'The rule computes 2026-12-15',
      'The computed date is now earlier than the override',
      'Computed from an approximate date: the earliest possible date',
      'This rule needs practitioner verification',
      'Already past when it was computed: review it',
    ]);
  });

  it('describes blocked and manual deadlines, and renders text', () => {
    expect(deadlineTraceView({ status: 'blocked', blockedReason: 'No grant yet', computed }).heading).toBe(
      'Waiting: No grant yet',
    );
    expect(deadlineTraceView({ status: 'blocked', computed }).heading).toBe('Waiting: not computed yet');
    expect(deadlineTraceView({ status: 'upcoming', override: { dueDate: '2026-11-01', reason: 'x' } })).toEqual({
      heading: 'Entered manually',
      lines: [],
      notes: ['Overridden to 2026-11-01: x'],
    });
    expect(deadlineTraceText({ status: 'upcoming', computed })).toBe(
      [
        'Computed by rule vic.fp.limitation (vic v1)',
        'Administration and Probate Act 1958 (Vic) s 99',
        ...computed.trace,
      ].join('\n'),
    );
    expect(deadlineTraceText({ status: 'upcoming' })).toBe('Entered manually');
  });
});

describe('pending changes', () => {
  const moved = {
    kind: 'moved' as const,
    critical: true,
    fromDueDate: '2026-12-15',
    toDueDate: '2026-09-01',
    earlier: true,
    intoPast: true,
  };

  it('summarises moves and removals', () => {
    expect(deadlineChangeSummary(moved)).toBe('Moves earlier: 2026-12-15 → 2026-09-01');
    expect(deadlineChangeSummary({ ...moved, earlier: false, toDueDate: undefined })).toBe(
      'Moves later: 2026-12-15 → ?',
    );
    expect(deadlineChangeSummary({ ...moved, kind: 'removed', reason: 'No grant yet' })).toBe(
      'Remove (mark superseded): No grant yet',
    );
    expect(deadlineChangeSummary({ ...moved, kind: 'removed' })).toBe('Remove (mark superseded)');
  });

  it('asks a typed matter number for critical deadlines and flags urgent ones', () => {
    expect(requiresTypedConfirmation(moved)).toBe(true);
    expect(requiresTypedConfirmation({ critical: false })).toBe(false);
    expect(confirmationMatches(' hv-2026-0001 ', 'HV-2026-0001')).toBe(true);
    expect(confirmationMatches('HV-2026-0002', 'HV-2026-0001')).toBe(false);
    expect(confirmationMatches(undefined, 'HV-2026-0001')).toBe(false);
    expect(isUrgentChange(moved)).toBe(true);
    expect(isUrgentChange({ ...moved, intoPast: false })).toBe(false);
  });
});

describe('permissions', () => {
  it('lets lawyers and above override, resolve, waive and confirm missed; paralegals mark done', () => {
    expect(canOverrideDeadline('lawyer')).toBe(true);
    expect(canOverrideDeadline('paralegal')).toBe(false);
    expect(canResolveDeadlineChange('admin')).toBe(true);
    expect(canResolveDeadlineChange('readonly')).toBe(false);
    expect(canCompleteDeadline('paralegal', 'done')).toBe(true);
    expect(canCompleteDeadline('paralegal', 'waived')).toBe(false);
    expect(canCompleteDeadline('lawyer', 'missed')).toBe(true);
    expect(canCompleteDeadline('readonly', 'done')).toBe(false);
  });
});

describe('inputs', () => {
  it('validates event upserts', () => {
    expect(
      UpsertEventInput.safeParse({ requestId: REQUEST, matterId: 'm', kind: 'grant_issued', date: '2026-06-15' })
        .success,
    ).toBe(true);
    expect(
      UpsertEventInput.safeParse({ requestId: REQUEST, matterId: 'm', kind: 'nope', date: '2026-06-15' }).success,
    ).toBe(false);
    expect(
      UpsertEventInput.safeParse({
        requestId: REQUEST,
        matterId: 'm',
        kind: 'hearing',
        date: '2026-06-15',
        time: '25:00',
      }).success,
    ).toBe(false);
  });

  it('needs a reason to override (not to clear) and to waive', () => {
    const base = { requestId: REQUEST, matterId: 'm', deadlineId: 'd' };
    expect(OverrideDeadlineInput.safeParse({ ...base, dueDate: '2026-12-01' }).error?.issues[0]?.path).toEqual([
      'reason',
    ]);
    expect(OverrideDeadlineInput.safeParse({ ...base, dueDate: '2026-12-01', reason: 'Court extension' }).success).toBe(
      true,
    );
    expect(OverrideDeadlineInput.safeParse({ ...base, dueDate: null }).success).toBe(true);
    expect(CompleteDeadlineInput.safeParse({ ...base, outcome: 'waived' }).error?.issues[0]?.path).toEqual(['reason']);
    expect(CompleteDeadlineInput.parse({ ...base, outcome: 'done' }).completeLinkedTasks).toBe(false);
    expect(ProposeRulesetUpgradeInput.parse({ requestId: REQUEST }).limit).toBe(200);
  });

  it('accepts manual deadlines of manual kinds only, with no server fields', () => {
    const manual = {
      orgId: 'o',
      matterId: 'm',
      title: 'Settlement deadline under the deed (fictional)',
      dueDate: '2026-11-20',
      kind: 'contractual',
      assigneeUid: 'u-jordan',
      privileged: false,
    };
    expect(ManualDeadlineCreateInput.parse(manual)).toMatchObject({
      status: 'upcoming',
      critical: false,
      reminders: [],
      privileged: false,
    });
    // The matter's flag is always copied (CORE-10b).
    expect(ManualDeadlineCreateInput.safeParse({ ...manual, privileged: undefined }).success).toBe(false);
    expect(ManualDeadlineCreateInput.safeParse({ ...manual, kind: 'statutory' }).success).toBe(false);
    expect(ManualDeadlineCreateInput.safeParse({ ...manual, computed: {} }).success).toBe(false);
    expect(ManualDeadlineUpdateInput.safeParse({ kind: 'statutory' }).success).toBe(false);
    expect(ManualDeadlineUpdateInput.safeParse({ title: 'Renamed', dueDate: '2026-11-21' }).success).toBe(true);
  });
});

describe('schemas', () => {
  it('keeps server-owned deadline fields out of client updates', () => {
    expect(Object.keys(Deadline.update.shape).sort()).toEqual(
      ['ackAt', 'ackBy', 'assigneeUid', 'critical', 'dueDate', 'dueTime', 'kind', 'reminders', 'title'].sort(),
    );
    expect(Object.keys(DeadlineChange.update.shape)).toEqual([]);
  });
});
