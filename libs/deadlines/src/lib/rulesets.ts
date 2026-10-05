import { ruleSetFlagKey, type DeadlineBlockedCode, type Jurisdiction } from '@materia/domain';

import { VIC_RULESET_V1 } from './data';
import { compute, evaluateCondition, explain } from './engine';
import {
  type ComputedDeadline,
  type ComputeInput,
  DeadlineEngineError,
  type Rule,
  type RuleSet,
  RuleSetSchema,
} from './model';

/**
 * Which rule set applies and which of its rules run (CORE-10). Published rule-set versions ship in
 * the code (`data/rulesets`, hash-locked); later versions may also be published as
 * `ruleSets/{ruleSetId}/versions/{n}` documents, which `fromRuleSetDoc` reads back.
 */

/** Rule sets bundled with the code. */
export const BUNDLED_RULE_SETS: readonly RuleSet[] = [VIC_RULESET_V1];

/** The rule set for a matter's jurisdiction (others have none yet). */
export const RULE_SET_FOR_JURISDICTION: Partial<Record<Jurisdiction, string>> = { VIC: 'vic' };

const DEFAULT_DISCLAIMER = 'Illustrative until a practising lawyer signs it off.';

/**
 * A stored rule-set version (`toRuleSetDoc`'s shape) as a validated RuleSet. Throws a ZodError
 * when it doesn't validate. Without a stored flag, the flag prefix is `deadlines.ruleset.{id}`.
 */
export function fromRuleSetDoc(doc: Record<string, unknown>): RuleSet {
  const rules = Array.isArray(doc['rules']) ? (doc['rules'] as Record<string, unknown>[]) : [];
  return RuleSetSchema.parse({
    ruleSetId: doc['ruleSetId'],
    version: doc['version'],
    jurisdiction: doc['jurisdiction'],
    published: doc['published'],
    practitionerReviewed: doc['practitionerReviewed'] ?? false,
    flag: typeof doc['flag'] === 'string' ? doc['flag'] : `deadlines.ruleset.${String(doc['ruleSetId'])}`,
    disclaimer: typeof doc['disclaimer'] === 'string' ? doc['disclaimer'] : DEFAULT_DISCLAIMER,
    rules: rules.map((rule) => ({
      ...(rule['definition'] as Record<string, unknown>),
      id: rule['id'],
      title: rule['title'],
      citation: rule['citation'],
    })),
  });
}

/** The latest published version among `candidates` for a rule set id (bundled ones included). */
export function latestRuleSet(ruleSetId: string, candidates: readonly RuleSet[] = []): RuleSet | undefined {
  return [...BUNDLED_RULE_SETS, ...candidates]
    .filter((set) => set.ruleSetId === ruleSetId && set.published)
    .sort((a, b) => b.version - a.version)[0];
}

/** The feature flag gating a rule set version's statutory rules (`deadlines.ruleset.vic.v1`). */
export function statutoryFlagKey(ruleSet: Pick<RuleSet, 'flag' | 'version'>): string {
  return ruleSetFlagKey(ruleSet.flag, ruleSet.version);
}

export interface RuleSelection {
  ruleSet: RuleSet;
  /** Rules not evaluated (statutory rules with their flag off): their deadlines are left alone. */
  skipped: Set<string>;
}

/**
 * The rules a recompute runs: without `statutoryEnabled`, statutory rules (and composites built on
 * them) are skipped, not removed; with `ruleIds` (the matter template's `deadlineRuleIds`), only
 * those rules apply, so deadlines of other rules are proposed for removal.
 */
export function selectRules(
  ruleSet: RuleSet,
  options: { statutoryEnabled: boolean; ruleIds?: readonly string[] | undefined },
): RuleSelection {
  const skipped = new Set<string>();
  if (!options.statutoryEnabled) {
    for (const rule of ruleSet.rules) if (rule.kind === 'statutory') skipped.add(rule.id);
    for (const rule of ruleSet.rules) {
      if ('composite' in rule && rule.composite.of.some((id) => skipped.has(id))) skipped.add(rule.id);
    }
  }
  const listed = options.ruleIds ? new Set(options.ruleIds) : undefined;
  const rules = ruleSet.rules.filter((rule) => !skipped.has(rule.id) && (!listed || listed.has(rule.id)));
  return { ruleSet: { ...ruleSet, rules }, skipped };
}

/** One rule's outcome: the engine's deadline, why it is blocked, and a missing calendar year. */
export interface EngineResult {
  deadline: ComputedDeadline;
  blockedCode?: DeadlineBlockedCode;
  calendarMissing?: { calendarId: string; year: number };
}

function blockedCodeOf(deadline: ComputedDeadline): DeadlineBlockedCode | undefined {
  if (deadline.status === 'invalid') return 'invalid_input';
  if (deadline.status === 'blocked') return deadline.anchorEventId ? 'invalid_input' : 'anchor_missing';
  return undefined;
}

function calendarBlocked(rule: Rule, input: ComputeInput, error: DeadlineEngineError): EngineResult {
  const calendarId = String(error.details['calendarId'] ?? rule.calendar);
  const year = Number(error.details['year'] ?? 0);
  const reason =
    error.code === 'CALENDAR_MISSING'
      ? `No ${calendarId} calendar data for ${year}`
      : `No calendar ${calendarId}: the rule can't be computed`;
  return {
    deadline: {
      ruleId: rule.id,
      ruleSetId: input.ruleSet.ruleSetId,
      ruleSetVersion: input.ruleSet.version,
      title: rule.title,
      citation: rule.citation,
      explain: rule.explain,
      kind: rule.kind,
      critical: rule.critical,
      status: 'blocked',
      reason,
      inputs: {},
      reminders: [],
      approximate: false,
      pastOnCreation: false,
      verify: rule.verify,
      trace: [
        { kind: 'blocked', reason },
        {
          kind: 'rule',
          ruleId: rule.id,
          ruleSetId: input.ruleSet.ruleSetId,
          version: input.ruleSet.version,
          citation: rule.citation,
        },
      ],
    },
    blockedCode: 'calendar_missing',
    calendarMissing: { calendarId, year },
  };
}

/**
 * `compute`, but a missing calendar year blocks only the rules that need it (status `blocked`,
 * code `calendar_missing`) instead of failing the whole matter. Other engine errors still throw.
 */
export function computeSafely(input: ComputeInput): EngineResult[] {
  try {
    return compute(input).map((deadline) => {
      const blockedCode = blockedCodeOf(deadline);
      return blockedCode ? { deadline, blockedCode } : { deadline };
    });
  } catch (error) {
    if (!(error instanceof DeadlineEngineError) || error.code === 'RULE_UNKNOWN') throw error;
  }
  // Rule by rule (a composite with its parts), then drop duplicate tasks as compute does.
  const results: EngineResult[] = [];
  const seenTasks = new Set<string>();
  for (const rule of input.ruleSet.rules) {
    const parts =
      'composite' in rule ? input.ruleSet.rules.filter((r) => rule.composite.of.includes(r.id) || r === rule) : [rule];
    let result: EngineResult;
    try {
      const all = compute({ ...input, ruleSet: { ...input.ruleSet, rules: parts } });
      const deadline = all.find((d) => d.ruleId === rule.id);
      if (!deadline) continue; // not applicable to this matter
      const blockedCode = blockedCodeOf(deadline);
      result = blockedCode ? { deadline, blockedCode } : { deadline };
    } catch (error) {
      if (!(error instanceof DeadlineEngineError) || error.code === 'RULE_UNKNOWN') throw error;
      const applies =
        rule.appliesTo.matterTypes.includes(input.matter.type) &&
        rule.appliesTo.jurisdictions.includes(input.matter.jurisdiction) &&
        rule.conditions.every((condition) => evaluateCondition(condition, input.matter.facts).passed);
      if (!applies) continue;
      result = calendarBlocked(rule, input, error);
    }
    const task = result.deadline.task;
    if (task) {
      if (seenTasks.has(task.dedupeKey)) delete result.deadline.task;
      else seenTasks.add(task.dedupeKey);
    }
    results.push(result);
  }
  return results;
}

/** The rendered trace a deadline stores: `explain` without the "already past" step (a flag says that). */
export function storedTrace(deadline: ComputedDeadline): string[] {
  return explain({ ...deadline, trace: deadline.trace.filter((step) => step.kind !== 'past') });
}
