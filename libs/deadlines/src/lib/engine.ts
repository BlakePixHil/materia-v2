import { addDays, compareDates, type DateOnly } from '@materia/domain';

import {
  addBusinessDays,
  addMonthsClamped,
  afterFyEnd,
  nonBusinessReason,
  rollToBusinessDay,
  weekdayName,
} from './calendar';
import type {
  Amount,
  AnchoredRule,
  CompositeRule,
  ComputedDeadline,
  ComputeInput,
  Condition,
  DeadlineChange,
  EngineEvent,
  Rule,
  TraceStep,
} from './model';

/** A rule calendar meaning "the org's locality calendar". */
export const LOCALITY = 'locality';
/** Locality calendar when the org hasn't set one. */
export const DEFAULT_LOCALITY = 'VIC_MELBOURNE';

const EVENT_LABELS: Partial<Record<EngineEvent['kind'], string>> = {
  date_of_death: 'date of death',
  grant_issued: 'grant',
  notice_published: 'probate notice',
  statutory_notice_published: 'statutory notice',
  caveat_lodged: 'caveat',
  offer_made: 'offer',
  order_made: 'order',
};

/** Reads a dotted path (`estate.grantType`) from the matter facts. */
export function readFact(facts: Readonly<Record<string, unknown>>, path: string): unknown {
  let value: unknown = facts;
  for (const key of path.split('.')) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** Evaluates a condition against the facts, for applicability and the trace. */
export function evaluateCondition(
  condition: Condition,
  facts: Readonly<Record<string, unknown>>,
): Extract<TraceStep, { kind: 'condition' }> {
  const actual = readFact(facts, condition.fact);
  if ('eq' in condition)
    return {
      kind: 'condition',
      fact: condition.fact,
      test: `= ${String(condition.eq)}`,
      actual,
      passed: actual === condition.eq,
    };
  if ('in' in condition) {
    return {
      kind: 'condition',
      fact: condition.fact,
      test: `in [${condition.in.join(', ')}]`,
      actual,
      passed: condition.in.some((v) => v === actual),
    };
  }
  const exists = actual !== undefined && actual !== null;
  return {
    kind: 'condition',
    fact: condition.fact,
    test: condition.exists ? 'exists' : 'is absent',
    actual,
    passed: exists === condition.exists,
  };
}

/**
 * The anchor event: events of the rule's kind that aren't deleted, preferring those recorded for the
 * matter's jurisdiction (a Victorian reseal over the original interstate grant), then the latest.
 */
export function selectAnchor(
  events: readonly EngineEvent[],
  rule: AnchoredRule,
  jurisdiction: string,
): EngineEvent | undefined {
  const candidates = events.filter((e) => e.kind === rule.anchor.event && !e.deleted);
  const local = candidates.filter((e) => e.meta?.['jurisdiction'] === jurisdiction);
  const pool = local.length ? local : candidates;
  return [...pool].sort((a, b) => compareDates(b.date, a.date))[0];
}

function resolveAmount(
  amount: Amount,
  input: ComputeInput,
  anchor: EngineEvent,
  inputs: Record<string, string | number | boolean>,
  name: string,
): number | string {
  if (typeof amount === 'number') return amount;
  if ('fact' in amount) {
    const value = readFact(input.matter.facts, amount.fact);
    const n = typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : amount.default;
    inputs[name] = n;
    return n;
  }
  const value = anchor.meta?.[amount.eventMeta];
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    inputs[name] = value;
    return value;
  }
  if (amount.default !== undefined) {
    inputs[name] = amount.default;
    return amount.default;
  }
  return `the ${amount.eventMeta} on the ${EVENT_LABELS[anchor.kind] ?? anchor.kind.replaceAll('_', ' ')} isn't recorded`;
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** The rule's calendar; `locality` means the org's locality calendar (internal practice reminders). */
export function ruleCalendar(rule: Rule, input: ComputeInput): string {
  return rule.calendar === LOCALITY ? (input.localityCalendar ?? DEFAULT_LOCALITY) : rule.calendar;
}

/** Applies the offset from the anchor date, recording each step. Returns a reason string when it can't. */
function applyOffset(
  rule: AnchoredRule,
  from: DateOnly,
  input: ComputeInput,
  anchor: EngineEvent,
  trace: TraceStep[],
  inputs: Record<string, string | number | boolean>,
): { date: DateOnly } | { reason: string } {
  const step = rule.direction === 'after' ? 1 : -1;
  const sign = step === 1 ? '+' : '−';
  const offset = rule.offset;
  if ('afterFyEnd' in offset) {
    const to = afterFyEnd(from, offset.afterFyEnd);
    trace.push({
      kind: 'offset',
      description: `${String(offset.afterFyEnd.day)}/${String(offset.afterFyEnd.month)} after the financial year end`,
      from,
      to,
      clamped: false,
    });
    return { date: to };
  }
  const [unit, amount] = Object.entries(offset)[0] as ['days' | 'businessDays' | 'months' | 'years', Amount];
  const n = resolveAmount(amount, input, anchor, inputs, unit);
  if (typeof n === 'string') return { reason: n };
  if (unit === 'businessDays') {
    const calendar = ruleCalendar(rule, input);
    const to = addBusinessDays(input.calendars, calendar, from, n, step);
    trace.push({
      kind: 'offset',
      description: `${sign} ${plural(n, 'business day')} on ${calendar}`,
      from,
      to,
      clamped: false,
    });
    return { date: to };
  }
  if (unit === 'days') {
    // Counting the anchor day as day 1 makes the period end a day sooner (later, counting backwards).
    const days = rule.counting === 'include_anchor_day' && n > 0 ? n - 1 : n;
    const to = addDays(from, days * step);
    const counting = rule.counting === 'include_anchor_day' ? ', counting the anchor day' : '';
    trace.push({ kind: 'offset', description: `${sign} ${plural(n, 'day')}${counting}`, from, to, clamped: false });
    return { date: to };
  }
  const months = unit === 'years' ? n * 12 : n;
  const { date: to, clamped } = addMonthsClamped(from, months * step);
  trace.push({
    kind: 'offset',
    description: `${sign} ${plural(n, unit === 'years' ? 'year' : 'month')}${clamped ? ' (clamped to month end)' : ''}`,
    from,
    to,
    clamped,
  });
  return { date: to };
}

/** Rolls a non-business date per the rule's policy, recording why. */
function roll(rule: Rule, date: DateOnly, input: ComputeInput, trace: TraceStep[]): DateOnly {
  const calendar = ruleCalendar(rule, input);
  const reason = nonBusinessReason(input.calendars, calendar, date);
  if (reason === null || rule.nonBusinessDay === 'none') {
    trace.push({ kind: 'roll', calendar, policy: rule.nonBusinessDay, from: date, to: date, reason });
    return date;
  }
  const to = rollToBusinessDay(input.calendars, calendar, date, rule.nonBusinessDay === 'roll_forward' ? 1 : -1);
  trace.push({ kind: 'roll', calendar, policy: rule.nonBusinessDay, from: date, to, reason });
  return to;
}

function base(rule: Rule, input: ComputeInput): ComputedDeadline {
  return {
    ruleId: rule.id,
    ruleSetId: input.ruleSet.ruleSetId,
    ruleSetVersion: input.ruleSet.version,
    title: rule.title,
    citation: rule.citation,
    explain: rule.explain,
    kind: rule.kind,
    critical: rule.critical,
    status: 'computed',
    ...(rule.dueTime ? { dueTime: rule.dueTime } : {}),
    inputs: {},
    reminders: [],
    ...(rule.createsTask ? { task: { ...rule.createsTask } } : {}),
    approximate: false,
    pastOnCreation: false,
    verify: rule.verify,
    trace: [],
  };
}

function finish(result: ComputedDeadline, rule: Rule, input: ComputeInput, date: DateOnly): ComputedDeadline {
  result.dueDate = date;
  const locality = input.localityCalendar ?? DEFAULT_LOCALITY;
  // Reminders fall on the org's working days: rolled back to its locality calendar's business day.
  result.reminders = rule.reminders.map((offsetDays) => ({
    offsetDays,
    date: rollToBusinessDay(input.calendars, locality, addDays(date, -offsetDays), -1),
  }));
  if (compareDates(date, input.today) < 0) {
    result.pastOnCreation = true;
    result.trace.push({ kind: 'past', today: input.today });
  }
  return result;
}

function block(result: ComputedDeadline, reason: string, status: 'blocked' | 'invalid' = 'blocked'): ComputedDeadline {
  result.status = status;
  result.reason = reason;
  // No date, no task: the task is proposed once the deadline can be computed.
  delete result.task;
  result.trace.push({ kind: status, reason });
  return result;
}

function computeAnchored(rule: AnchoredRule, input: ComputeInput): ComputedDeadline {
  const result = base(rule, input);
  const anchor = selectAnchor(input.events, rule, input.matter.jurisdiction);
  const label = EVENT_LABELS[rule.anchor.event] ?? rule.anchor.event.replaceAll('_', ' ');
  if (!anchor) return block(result, rule.blockedReason ?? `No ${label} yet`);
  result.anchorEventId = anchor.id;
  result.inputs['anchor'] = anchor.date;
  result.trace.push({ kind: 'anchor', event: anchor.kind, date: anchor.date, eventId: anchor.id });
  if (anchor.kind === 'date_of_death' && compareDates(anchor.date, input.today) > 0) {
    return block(result, `The date of death (${anchor.date}) is in the future`, 'invalid');
  }

  let from = anchor.date;
  const precision = anchor.meta?.['datePrecision'];
  if (precision === 'month' || precision === 'year') {
    // Approximate anchor: use the earliest date it could be, so the deadline is never late.
    const earliest = (
      precision === 'month' ? `${anchor.date.slice(0, 7)}-01` : `${anchor.date.slice(0, 4)}-01-01`
    ) as DateOnly;
    result.approximate = true;
    result.trace.push({ kind: 'approximate', precision, from: anchor.date, earliest });
    from = earliest;
  }

  const offset = applyOffset(rule, from, input, anchor, result.trace, result.inputs);
  if ('reason' in offset) return block(result, offset.reason);
  return finish(result, rule, input, roll(rule, offset.date, input, result.trace));
}

function computeComposite(
  rule: CompositeRule,
  input: ComputeInput,
  results: Map<string, ComputedDeadline>,
): ComputedDeadline {
  const result = base(rule, input);
  const parts = rule.composite.of.map((id) => ({ id, deadline: results.get(id) }));
  const missing = parts.find((p) => !p.deadline || p.deadline.status !== 'computed' || !p.deadline.dueDate);
  if (missing) {
    const reason = missing.deadline?.reason ?? `${missing.id} doesn't apply to this matter`;
    return block(result, `Waiting on ${missing.id}: ${reason}`);
  }
  const inputs = parts.map((p) => ({ ruleId: p.id, date: p.deadline?.dueDate as DateOnly }));
  const sorted = [...inputs].sort((a, b) => compareDates(a.date, b.date));
  const chosen = (rule.composite.op === 'max' ? sorted[sorted.length - 1] : sorted[0]) as { date: DateOnly };
  result.approximate = parts.some((p) => p.deadline?.approximate);
  for (const p of inputs) result.inputs[p.ruleId] = p.date;
  result.trace.push({ kind: 'composite', op: rule.composite.op, inputs, result: chosen.date });
  return finish(result, rule, input, roll(rule, chosen.date, input, result.trace));
}

/**
 * Computes every applicable rule's deadline (Deadline engine & legal rules). Pure and deterministic:
 * the same input always gives the same output. Throws DeadlineEngineError (CALENDAR_MISSING) rather
 * than treating a year without calendar data as all business days.
 */
export function compute(input: ComputeInput): ComputedDeadline[] {
  const results = new Map<string, ComputedDeadline>();
  const applicable = input.ruleSet.rules.filter((rule) => {
    if (!rule.appliesTo.matterTypes.includes(input.matter.type)) return false;
    if (!rule.appliesTo.jurisdictions.includes(input.matter.jurisdiction)) return false;
    return rule.conditions.every((c) => evaluateCondition(c, input.matter.facts).passed);
  });
  // Anchored rules first, so composites can read their parts.
  for (const rule of applicable) if (!('composite' in rule)) results.set(rule.id, computeAnchored(rule, input));
  for (const rule of applicable) if ('composite' in rule) results.set(rule.id, computeComposite(rule, input, results));

  const ordered = applicable.map((rule) => results.get(rule.id) as ComputedDeadline);
  const seenTasks = new Map<string, string>();
  for (const [index, deadline] of ordered.entries()) {
    const rule = applicable[index] as Rule;
    deadline.trace.unshift(...rule.conditions.map((condition) => evaluateCondition(condition, input.matter.facts)));
    if (deadline.task) {
      const keeper = seenTasks.get(deadline.task.dedupeKey);
      if (keeper) {
        deadline.trace.push({ kind: 'dedupe', dedupeKey: deadline.task.dedupeKey, keptBy: keeper });
        delete deadline.task;
      } else {
        seenTasks.set(deadline.task.dedupeKey, deadline.ruleId);
      }
    }
    deadline.trace.push({
      kind: 'rule',
      ruleId: rule.id,
      ruleSetId: input.ruleSet.ruleSetId,
      version: input.ruleSet.version,
      citation: rule.citation,
    });
  }
  return ordered;
}

/** One trace step as a sentence. */
export function renderStep(step: TraceStep): string {
  switch (step.kind) {
    case 'anchor':
      return `anchor ${step.event} = ${step.date} (${weekdayName(step.date)})${step.eventId ? ` · event ${step.eventId}` : ''}`;
    case 'approximate':
      return `approximate date (${step.precision} only): using the earliest possible date ${step.earliest}`;
    case 'condition':
      return `condition ${step.fact} ${step.test}: ${step.passed ? 'yes' : 'no'} (${JSON.stringify(step.actual) ?? 'absent'})`;
    case 'offset':
      return `${step.description} → ${step.to} (${weekdayName(step.to)})`;
    case 'roll':
      if (step.reason === null) return `business day on ${step.calendar} → no roll`;
      if (step.policy === 'none')
        return `${step.from} is ${step.reason} on ${step.calendar} → not rolled (rule says none)`;
      return `${step.from} is ${step.reason} on ${step.calendar} → ${step.policy === 'roll_forward' ? 'rolled forward' : 'rolled back'} to ${step.to} (${weekdayName(step.to)})`;
    case 'composite':
      return `${step.op === 'max' ? 'later' : 'earlier'} of ${step.inputs.map((i) => `${i.ruleId} ${i.date}`).join(' and ')} → ${step.result}`;
    case 'blocked':
      return `blocked: ${step.reason}`;
    case 'invalid':
      return `invalid: ${step.reason}`;
    case 'past':
      return `already past on ${step.today}: needs review (not marked missed)`;
    case 'dedupe':
      return `task "${step.dedupeKey}" already proposed by ${step.keptBy}`;
    case 'rule':
      return `rule ${step.ruleId} · ${step.ruleSetId} v${step.version} · ${step.citation}`;
  }
}

/** The rendered trace, one line per step (DeadlineChip tooltip, deadline detail, Clerk citations). */
export function explain(deadline: ComputedDeadline): string[] {
  return deadline.trace.map(renderStep);
}

/**
 * What changed between two computations, for recompute proposals: nothing is overwritten, each change
 * is proposed to the responsible lawyer (critical ones need a typed confirmation).
 */
export function diff(previous: readonly ComputedDeadline[], next: readonly ComputedDeadline[]): DeadlineChange[] {
  const before = new Map(previous.map((d) => [d.ruleId, d]));
  const after = new Map(next.map((d) => [d.ruleId, d]));
  const changes: DeadlineChange[] = [];
  for (const [ruleId, to] of after) {
    const from = before.get(ruleId);
    if (!from) changes.push({ type: 'added', ruleId, to });
    else if (from.status !== to.status) changes.push({ type: 'status', ruleId, from, to });
    else if (from.dueDate !== to.dueDate) {
      changes.push({
        type: 'moved',
        ruleId,
        from,
        to,
        earlier: compareDates(to.dueDate as DateOnly, from.dueDate as DateOnly) < 0,
      });
    }
  }
  for (const [ruleId, from] of before) if (!after.has(ruleId)) changes.push({ type: 'removed', ruleId, from });
  return changes;
}
