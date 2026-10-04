import { z } from 'zod';

import { DateOnlySchema, EventKindSchema, JurisdictionSchema, MatterTypeSchema } from '@materia/domain';
import type { DateOnly, EventKind, Jurisdiction, MatterType } from '@materia/domain';

/**
 * The deadline engine's data model (Deadline engine & legal rules). Rule sets and calendars are data,
 * validated with these schemas when loaded; the engine itself never touches `Date`.
 */

const TimeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'Expected HH:MM (24h)' });

/** A number, or a value read from a matter fact or the anchor event's meta (with a default). */
export const AmountSchema = z.union([
  z.number().int().min(0),
  z.object({ fact: z.string().min(1), default: z.number().int().min(0) }).strict(),
  z.object({ eventMeta: z.string().min(1), default: z.number().int().min(0).optional() }).strict(),
]);
export type Amount = z.infer<typeof AmountSchema>;

export const OffsetSchema = z.union([
  z.object({ days: AmountSchema }).strict(),
  z.object({ businessDays: AmountSchema }).strict(),
  z.object({ months: AmountSchema }).strict(),
  z.object({ years: AmountSchema }).strict(),
  /** A fixed day of the year after the end of the financial year containing the anchor (31 Oct for tax returns). */
  z
    .object({
      afterFyEnd: z
        .object({
          month: z.number().int().min(1).max(12),
          day: z.number().int().min(1).max(31),
          fyStartMonth: z.number().int().min(1).max(12),
        })
        .strict(),
    })
    .strict(),
]);
export type Offset = z.infer<typeof OffsetSchema>;

export const ConditionSchema = z.union([
  z.object({ fact: z.string().min(1), eq: z.union([z.string(), z.number(), z.boolean()]) }).strict(),
  z.object({ fact: z.string().min(1), in: z.array(z.union([z.string(), z.number(), z.boolean()])).min(1) }).strict(),
  z.object({ fact: z.string().min(1), exists: z.boolean() }).strict(),
]);
export type Condition = z.infer<typeof ConditionSchema>;

const RuleBase = {
  id: z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/, { message: 'Rule ids look like vic.fp.limitation' }),
  title: z.string().min(1),
  citation: z.string().min(1),
  explain: z.string().min(1),
  appliesTo: z
    .object({ matterTypes: z.array(MatterTypeSchema).min(1), jurisdictions: z.array(JurisdictionSchema).min(1) })
    .strict(),
  conditions: z.array(ConditionSchema).default([]),
  nonBusinessDay: z.enum(['roll_forward', 'roll_back', 'none']),
  calendar: z.string().min(1),
  kind: z.enum(['statutory', 'court', 'contractual', 'internal']),
  critical: z.boolean(),
  dueTime: TimeOfDay.optional(),
  /** Days before the due date to remind (dated on the org's locality calendar). */
  reminders: z.array(z.number().int().min(0)).default([]),
  createsTask: z
    .object({ title: z.string().min(1), stage: z.string().optional(), dedupeKey: z.string().min(1) })
    .strict()
    .optional(),
  /** Shown when the anchor is missing ("No grant yet"). */
  blockedReason: z.string().optional(),
  /** Rules marked verify: true need practitioner confirmation before their flag is turned on. */
  verify: z.boolean().default(false),
};

export const AnchoredRuleSchema = z
  .object({
    ...RuleBase,
    anchor: z.object({ event: EventKindSchema }).strict(),
    offset: OffsetSchema,
    direction: z.enum(['after', 'before']),
    counting: z.enum(['exclude_anchor_day', 'include_anchor_day']),
    monthEnd: z.literal('clamp'),
  })
  .strict();

export const CompositeRuleSchema = z
  .object({
    ...RuleBase,
    composite: z.object({ op: z.enum(['max', 'min']), of: z.array(z.string()).min(2) }).strict(),
  })
  .strict();

export const RuleSchema = z.union([AnchoredRuleSchema, CompositeRuleSchema]);
export type AnchoredRule = z.infer<typeof AnchoredRuleSchema>;
export type CompositeRule = z.infer<typeof CompositeRuleSchema>;
export type Rule = z.infer<typeof RuleSchema>;

export const RuleSetSchema = z
  .object({
    ruleSetId: z.string().min(1),
    version: z.number().int().min(1),
    jurisdiction: JurisdictionSchema,
    published: z.boolean(),
    practitionerReviewed: z.boolean(),
    /** Feature flag that gates the rule set until sign-off (deadlines.ruleset.<id>). */
    flag: z.string().min(1),
    disclaimer: z.string().min(1),
    rules: z.array(RuleSchema).min(1),
  })
  .strict()
  .superRefine((set, ctx) => {
    const ids = new Set<string>();
    for (const rule of set.rules) {
      if (ids.has(rule.id)) ctx.addIssue({ code: 'custom', message: `Duplicate rule id ${rule.id}` });
      ids.add(rule.id);
    }
    for (const rule of set.rules) {
      if ('composite' in rule) {
        for (const ref of rule.composite.of) {
          if (!ids.has(ref)) ctx.addIssue({ code: 'custom', message: `${rule.id} refers to unknown rule ${ref}` });
          const target = set.rules.find((r) => r.id === ref);
          if (target && 'composite' in target)
            ctx.addIssue({ code: 'custom', message: `${rule.id}: composite rules can't nest (${ref})` });
        }
      }
    }
  });
export type RuleSet = z.infer<typeof RuleSetSchema>;

export const CalendarYearSchema = z
  .object({
    calendarId: z.string().regex(/^[A-Z][A-Z0-9_]+$/),
    year: z.number().int().min(2000).max(2100),
    kind: z.enum(['court', 'locality']),
    jurisdiction: JurisdictionSchema,
    holidays: z.array(
      z.object({ date: DateOnlySchema, name: z.string().min(1), provisional: z.boolean().optional() }).strict(),
    ),
    closures: z
      .array(z.object({ from: DateOnlySchema, to: DateOnlySchema, name: z.string().min(1) }).strict())
      .default([]),
    source: z.string().min(1),
    /** True once a person has checked the dates against the official sources. */
    verified: z.boolean(),
  })
  .strict()
  .superRefine((cal, ctx) => {
    for (const h of cal.holidays) {
      if (!h.date.startsWith(`${cal.year}-`))
        ctx.addIssue({ code: 'custom', message: `${cal.calendarId}-${cal.year}: ${h.date} is outside the year` });
    }
    for (const c of cal.closures) {
      if (c.to < c.from)
        ctx.addIssue({
          code: 'custom',
          message: `${cal.calendarId}-${cal.year}: closure ${c.name} ends before it starts`,
        });
    }
  });
export type CalendarYear = z.infer<typeof CalendarYearSchema>;

/** Calendars by id, then by year. */
export type CalendarSet = Readonly<Record<string, Readonly<Record<number, CalendarYear>>>>;

/** An anchor fact. `meta.datePrecision` of `month` or `year` marks an approximate date. */
export interface EngineEvent {
  id?: string | undefined;
  kind: EventKind;
  date: DateOnly;
  meta?: Readonly<Record<string, string | number | boolean | null>> | undefined;
  deleted?: boolean | undefined;
}

export interface EngineMatter {
  type: MatterType;
  jurisdiction: Jurisdiction;
  facts: Readonly<Record<string, unknown>>;
}

export interface ComputeInput {
  matter: EngineMatter;
  events: readonly EngineEvent[];
  ruleSet: RuleSet;
  calendars: CalendarSet;
  /** The org's locality calendar for reminders (org.holidayLocality), e.g. VIC_GREATER_GEELONG. */
  localityCalendar?: string | undefined;
  today: DateOnly;
}

export type TraceStep =
  | { kind: 'anchor'; event: EventKind; date: DateOnly; eventId?: string | undefined }
  | { kind: 'approximate'; precision: string; from: DateOnly; earliest: DateOnly }
  | { kind: 'condition'; fact: string; test: string; actual: unknown; passed: boolean }
  | { kind: 'offset'; description: string; from: DateOnly; to: DateOnly; clamped: boolean }
  | {
      kind: 'roll';
      calendar: string;
      policy: 'roll_forward' | 'roll_back' | 'none';
      from: DateOnly;
      to: DateOnly;
      reason: string | null;
    }
  | { kind: 'composite'; op: 'max' | 'min'; inputs: { ruleId: string; date: DateOnly }[]; result: DateOnly }
  | { kind: 'blocked'; reason: string }
  | { kind: 'invalid'; reason: string }
  | { kind: 'past'; today: DateOnly }
  | { kind: 'dedupe'; dedupeKey: string; keptBy: string }
  | { kind: 'rule'; ruleId: string; ruleSetId: string; version: number; citation: string };

export interface ComputedReminder {
  offsetDays: number;
  date: DateOnly;
}

export interface ComputedDeadline {
  ruleId: string;
  ruleSetId: string;
  ruleSetVersion: number;
  title: string;
  citation: string;
  explain: string;
  kind: Rule['kind'];
  critical: boolean;
  /** `computed` has a date; `blocked` is waiting on a fact; `invalid` has a bad input. */
  status: 'computed' | 'blocked' | 'invalid';
  dueDate?: DateOnly | undefined;
  dueTime?: string | undefined;
  reason?: string | undefined;
  anchorEventId?: string | undefined;
  inputs: Record<string, string | number | boolean>;
  reminders: ComputedReminder[];
  task?: { title: string; stage?: string | undefined; dedupeKey: string } | undefined;
  /** The anchor was approximate: this is the earliest possible date. */
  approximate: boolean;
  /** Already past on computation: goes to the review queue instead of being marked missed. */
  pastOnCreation: boolean;
  verify: boolean;
  trace: TraceStep[];
}

export type DeadlineChange =
  | { type: 'added'; ruleId: string; to: ComputedDeadline }
  | { type: 'removed'; ruleId: string; from: ComputedDeadline }
  | { type: 'moved'; ruleId: string; from: ComputedDeadline; to: ComputedDeadline; earlier: boolean }
  | { type: 'status'; ruleId: string; from: ComputedDeadline; to: ComputedDeadline };

export type DeadlineErrorCode = 'CALENDAR_MISSING' | 'CALENDAR_UNKNOWN' | 'RULE_UNKNOWN';

export class DeadlineEngineError extends Error {
  override readonly name = 'DeadlineEngineError';
  constructor(
    readonly code: DeadlineErrorCode,
    message: string,
    readonly details: Readonly<Record<string, string | number>> = {},
  ) {
    super(`${code}: ${message}`);
  }
}
