import {
  compareDates,
  computedDeadlineId,
  type DateOnly,
  type DeadlineBlockedCode,
  type DeadlineChangeKind,
  type DeadlineComputed,
  type DeadlineStatus,
} from '@materia/domain';

import type { ComputedDeadline } from './model';
import { storedTrace, type EngineResult } from './rulesets';

/**
 * How a recompute changes a matter's persisted deadlines (CORE-10), as a pure plan the recompute
 * transaction writes: new deadlines, in-place updates that never move a date in force, proposals
 * (`deadlineChanges`) for date moves and removals, pending proposals that no longer hold, and the
 * tasks rules create. Running it again on its own result plans nothing, so recomputes are idempotent.
 */

/** A stored computed deadline, as the planner reads it. */
export interface ExistingDeadline {
  id: string;
  status: DeadlineStatus;
  dueDate?: string | undefined;
  deleted: boolean;
  title: string;
  critical: boolean;
  kind: string;
  dueTime?: string | undefined;
  blockedReason?: string | undefined;
  blockedCode?: string | undefined;
  computed: DeadlineComputed;
  override?: { dueDate: string } | undefined;
  overrideConflict?: boolean | undefined;
  declined?: { kind: DeadlineChangeKind; dueDate?: string | undefined } | undefined;
  reminders?: readonly { offsetDays: number }[] | undefined;
}

/** A pending `deadlineChanges` document. */
export interface PendingChange {
  id: string;
  deadlineId: string;
  kind: DeadlineChangeKind;
  toDueDate?: string | undefined;
}

/** The fields a computed deadline document gets from its rule (the writer adds ids, assignee and meta). */
export interface ComputedDeadlineFields {
  title: string;
  kind: ComputedDeadline['kind'];
  critical: boolean;
  status: 'upcoming' | 'blocked';
  dueDate?: DateOnly;
  dueTime?: string;
  blockedReason?: string;
  blockedCode?: DeadlineBlockedCode;
  computed: DeadlineComputed;
  reminders: { offsetDays: number }[];
  pastOnCreation: boolean;
}

export interface PlannedCreate {
  id: string;
  fields: ComputedDeadlineFields;
}

export interface PlannedUpdate {
  id: string;
  /** `dated`: a blocked deadline got its date; `revived`: a superseded one applies again. */
  reason: 'dated' | 'revived' | 'blocked' | 'superseded' | 'provenance' | 'override';
  set: Record<string, unknown>;
  /** Fields to delete. */
  remove: string[];
}

export interface PlannedProposal {
  deadlineId: string;
  ruleId: string;
  title: string;
  critical: boolean;
  kind: DeadlineChangeKind;
  fromDueDate: DateOnly;
  toDueDate?: DateOnly;
  earlier: boolean;
  intoPast: boolean;
  reason?: string;
  computed?: DeadlineComputed;
}

/** A task a rule creates (`createsTask`) for an upcoming deadline; the writer skips existing ones. */
export interface PlannedTask {
  deadlineId: string;
  dedupeKey: string;
  title: string;
  stage?: string;
  dueDate: DateOnly;
  /** The deadline is critical (the task gets a high priority). */
  critical: boolean;
}

export interface RecomputePlan {
  creates: PlannedCreate[];
  updates: PlannedUpdate[];
  proposals: PlannedProposal[];
  /** Pending proposal ids that no longer hold. */
  supersede: string[];
  /** Deadlines whose engine date has just become earlier than their override. */
  overrideConflicts: string[];
  tasks: PlannedTask[];
  /** Rules blocked by a missing calendar year (an ops alert). */
  calendarMissing: { ruleId: string; deadlineId: string; calendarId: string; year: number }[];
}

export interface RecomputePlanInput {
  results: readonly EngineResult[];
  /** Rules not evaluated (statutory rules with their flag off): their deadlines are left as they are. */
  skipped: ReadonlySet<string>;
  existing: readonly ExistingDeadline[];
  pending: readonly PendingChange[];
  today: DateOnly;
}

const NO_LONGER_APPLIES = 'The rule no longer applies to this matter';
const EXCLUSIVE_FIELDS = ['blockedReason', 'blockedCode', 'override', 'overrideConflict', 'declined', 'missedCheck'];

/** The provenance a deadline stores for an engine result. */
export function provenance(deadline: ComputedDeadline): DeadlineComputed {
  return {
    ruleId: deadline.ruleId,
    ruleSetId: deadline.ruleSetId,
    ruleSetVersion: deadline.ruleSetVersion,
    ...(deadline.anchorEventId ? { anchorEventId: deadline.anchorEventId } : {}),
    inputs: { ...deadline.inputs },
    trace: storedTrace(deadline),
    citation: deadline.citation,
    explain: deadline.explain,
    ...(deadline.dueDate ? { dueDate: deadline.dueDate } : {}),
    approximate: deadline.approximate,
    verify: deadline.verify,
  };
}

/** A new deadline document's fields for an engine result. */
export function computedDeadlineFields(result: EngineResult): ComputedDeadlineFields {
  const d = result.deadline;
  const dated = d.status === 'computed' && !!d.dueDate;
  return {
    title: d.title,
    kind: d.kind,
    critical: d.critical,
    status: dated ? 'upcoming' : 'blocked',
    ...(dated ? { dueDate: d.dueDate as DateOnly } : {}),
    ...(d.dueTime ? { dueTime: d.dueTime } : {}),
    ...(dated
      ? {}
      : { blockedReason: d.reason ?? 'Not computed yet', blockedCode: result.blockedCode ?? 'anchor_missing' }),
    computed: provenance(d),
    reminders: d.reminders.map((r) => ({ offsetDays: r.offsetDays })),
    pastOnCreation: dated && d.pastOnCreation,
  };
}

/** Stable JSON (sorted keys), to compare provenance without caring about key order. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The rule-owned fields of a deadline, compared to decide whether its provenance changed. */
function ruleFields(fields: {
  title: string;
  critical: boolean;
  kind: string;
  dueTime?: string | undefined;
  computed: DeadlineComputed;
  reminders?: readonly { offsetDays: number }[] | undefined;
}): string {
  return stable({
    title: fields.title,
    critical: fields.critical,
    kind: fields.kind,
    dueTime: fields.dueTime ?? null,
    computed: fields.computed,
    reminders: (fields.reminders ?? []).map((r) => r.offsetDays),
  });
}

/** Sets a new date and provenance on a deadline that had none in force (blocked or superseded). */
function datedUpdate(id: string, reason: 'dated' | 'revived', fields: ComputedDeadlineFields): PlannedUpdate {
  return {
    id,
    reason,
    set: {
      status: 'upcoming',
      dueDate: fields.dueDate,
      title: fields.title,
      critical: fields.critical,
      kind: fields.kind,
      computed: fields.computed,
      reminders: fields.reminders,
      pastOnCreation: fields.pastOnCreation,
      ...(fields.dueTime ? { dueTime: fields.dueTime } : {}),
    },
    remove: [...EXCLUSIVE_FIELDS, ...(fields.dueTime ? [] : ['dueTime'])],
  };
}

export function planRecompute(input: RecomputePlanInput): RecomputePlan {
  const plan: RecomputePlan = {
    creates: [],
    updates: [],
    proposals: [],
    supersede: [],
    overrideConflicts: [],
    tasks: [],
    calendarMissing: [],
  };
  const byRule = new Map<string, ExistingDeadline>();
  for (const deadline of input.existing) {
    if (deadline.deleted) continue;
    if (!byRule.has(deadline.computed.ruleId)) byRule.set(deadline.computed.ruleId, deadline);
  }
  const seen = new Set<string>();
  const proposals: PlannedProposal[] = [];

  const propose = (existing: ExistingDeadline, proposal: Omit<PlannedProposal, 'deadlineId' | 'ruleId' | 'title'>) => {
    proposals.push({
      deadlineId: existing.id,
      ruleId: existing.computed.ruleId,
      title: existing.title,
      ...proposal,
    });
  };
  const removal = (existing: ExistingDeadline, reason: string) => {
    if (existing.declined?.kind === 'removed') return;
    propose(existing, {
      critical: existing.critical,
      kind: 'removed',
      fromDueDate: existing.dueDate as DateOnly,
      earlier: false,
      intoPast: false,
      reason,
    });
  };
  const task = (deadlineId: string, deadline: ComputedDeadline, dueDate: DateOnly) => {
    if (!deadline.task) return;
    plan.tasks.push({
      deadlineId,
      dedupeKey: deadline.task.dedupeKey,
      title: deadline.task.title,
      ...(deadline.task.stage ? { stage: deadline.task.stage } : {}),
      dueDate,
      critical: deadline.critical,
    });
  };

  for (const result of input.results) {
    const d = result.deadline;
    const fields = computedDeadlineFields(result);
    const existing = byRule.get(d.ruleId);
    const id = existing?.id ?? computedDeadlineId(d.ruleId);
    seen.add(d.ruleId);
    if (result.calendarMissing)
      plan.calendarMissing.push({ ruleId: d.ruleId, deadlineId: id, ...result.calendarMissing });
    const dated = fields.status === 'upcoming';

    if (!existing) {
      plan.creates.push({ id, fields });
      if (dated) task(id, d, fields.dueDate as DateOnly);
      continue;
    }
    if (existing.status === 'done' || existing.status === 'waived' || existing.status === 'missed') continue;

    if (existing.status === 'superseded' || existing.status === 'blocked') {
      if (dated) {
        plan.updates.push(datedUpdate(id, existing.status === 'blocked' ? 'dated' : 'revived', fields));
        task(id, d, fields.dueDate as DateOnly);
      } else if (
        existing.status === 'blocked' &&
        (existing.blockedReason !== fields.blockedReason ||
          existing.blockedCode !== fields.blockedCode ||
          ruleFields(existing) !== ruleFields(fields))
      ) {
        plan.updates.push({
          id,
          reason: 'blocked',
          set: {
            blockedReason: fields.blockedReason,
            blockedCode: fields.blockedCode,
            title: fields.title,
            critical: fields.critical,
            kind: fields.kind,
            computed: fields.computed,
            reminders: fields.reminders,
          },
          remove: [],
        });
      }
      continue;
    }

    // Upcoming, with a date in force.
    if (!dated) {
      // A missing calendar year leaves the date in force alone (the ops alert covers it).
      if (result.blockedCode !== 'calendar_missing') removal(existing, fields.blockedReason as string);
      continue;
    }
    const next = fields.dueDate as DateOnly;
    if (existing.override) {
      // Flagged when the engine's date moves earlier and lands before the override; it stays flagged
      // until the engine's date is no longer before the override (or the override changes).
      const before = compareDates(next, existing.override.dueDate as DateOnly) < 0;
      const previous = existing.computed.dueDate as DateOnly | undefined;
      const conflict = before && (!!existing.overrideConflict || (!!previous && compareDates(next, previous) < 0));
      if (ruleFields(existing) !== ruleFields(fields) || !!existing.overrideConflict !== conflict) {
        plan.updates.push({
          id,
          reason: 'override',
          set: {
            title: fields.title,
            critical: fields.critical,
            kind: fields.kind,
            computed: fields.computed,
            reminders: fields.reminders,
            overrideConflict: conflict,
          },
          remove: [],
        });
      }
      if (conflict && !existing.overrideConflict) plan.overrideConflicts.push(id);
      task(id, d, existing.dueDate as DateOnly);
      continue;
    }
    task(id, d, existing.dueDate as DateOnly);
    if (next === existing.dueDate) {
      if (ruleFields(existing) !== ruleFields(fields)) {
        plan.updates.push({
          id,
          reason: 'provenance',
          set: {
            title: fields.title,
            critical: fields.critical,
            kind: fields.kind,
            computed: fields.computed,
            reminders: fields.reminders,
            ...(fields.dueTime ? { dueTime: fields.dueTime } : {}),
          },
          remove: fields.dueTime ? [] : ['dueTime'],
        });
      }
      continue;
    }
    if (existing.declined?.kind === 'moved' && existing.declined.dueDate === next) continue;
    propose(existing, {
      critical: existing.critical || fields.critical,
      kind: 'moved',
      fromDueDate: existing.dueDate as DateOnly,
      toDueDate: next,
      earlier: compareDates(next, existing.dueDate as DateOnly) < 0,
      intoPast: compareDates(next, input.today) < 0,
      computed: fields.computed,
    });
  }

  // Deadlines whose rule no longer applies (and wasn't skipped by a flag).
  for (const [ruleId, existing] of byRule) {
    if (seen.has(ruleId) || input.skipped.has(ruleId)) continue;
    if (existing.status === 'upcoming') removal(existing, NO_LONGER_APPLIES);
    else if (existing.status === 'blocked') {
      plan.updates.push({ id: existing.id, reason: 'superseded', set: { status: 'superseded' }, remove: [] });
    }
  }

  // A pending proposal stands while the same one would be made again; otherwise it is superseded.
  const pendingByDeadline = new Map<string, PendingChange[]>();
  for (const change of input.pending) {
    const list = pendingByDeadline.get(change.deadlineId) ?? [];
    list.push(change);
    pendingByDeadline.set(change.deadlineId, list);
  }
  const kept = new Set<string>();
  for (const proposal of proposals) {
    const same = (pendingByDeadline.get(proposal.deadlineId) ?? []).find(
      (change) => change.kind === proposal.kind && (change.toDueDate ?? null) === (proposal.toDueDate ?? null),
    );
    if (same) kept.add(same.id);
    else plan.proposals.push(proposal);
  }
  plan.supersede = input.pending.filter((change) => !kept.has(change.id)).map((change) => change.id);
  return plan;
}

/** Whether a plan changes any deadline or proposal (tasks are checked against what exists). */
export function isEmptyPlan(plan: RecomputePlan): boolean {
  return !plan.creates.length && !plan.updates.length && !plan.proposals.length && !plan.supersede.length;
}

/** The id of the task a rule creates, from its dedupe key (`task:file-grant` → `dlt-file-grant`). */
export function linkedTaskId(dedupeKey: string): string {
  return `dlt-${dedupeKey.replace(/^task:/, '').replace(/[^A-Za-z0-9_-]/g, '-')}`;
}
