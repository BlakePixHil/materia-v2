import * as z from 'zod';

import {
  KeyFactIdSchema,
  keyFactValue,
  stageIndex,
  type FactMatter,
  type KeyFactId,
  type MatterStage,
} from './matter-detail';
import { DocIdSchema, NonEmptyString } from './schemas/common';
import {
  EventKindSchema,
  MatterTypeSchema,
  PrioritySchema,
  type EventKind,
  type MatterType,
  type Priority,
} from './schemas/enums';
import { addDays, compareDates, DateOnlySchema, isDateOnly, type DateOnly } from './values/date-only';

/**
 * Matter templates (CORE-07): a matter type's stages, the tasks each stage creates and the deadline
 * rules that apply. System templates ship with the code (`libs/domain/templates/system/*.json`, see
 * system-templates.ts); an org clones one into `orgs/{orgId}/templates/{id}`, edits the draft and
 * publishes immutable versions to `orgs/{orgId}/templates/{id}/versions/{n}`. A matter keeps the
 * version it was given (`templateId` + `templateVersion`). Statutory deadlines are never template
 * tasks: templates only name the deadline rules (`deadlineRuleIds`, CORE-09) that apply.
 */

/** Stage ids and task keys: lower snake case, stable across versions. */
export const TemplateKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, { message: 'Use lower-case letters, digits and underscores' })
  .max(60);

/** What must be true to move into a stage (forward moves only). */
export const StageEntryRequiresSchema = z
  .object({
    /** Key facts that must be recorded (CORE-06 `requires`). */
    facts: z.array(KeyFactIdSchema).optional(),
    /** Matter events that must be known (an event, or the key fact standing for it). */
    events: z.array(EventKindSchema).optional(),
    /** Template task keys that must be done. */
    tasksDone: z.array(TemplateKeySchema).optional(),
  })
  .strict();
export type StageEntryRequires = z.infer<typeof StageEntryRequiresSchema>;

export const TemplateStageSchema = z
  .object({
    id: TemplateKeySchema,
    name: NonEmptyString.max(80),
    order: z.number().int().min(0),
    /** What finishes the stage (the stepper's tooltip). */
    criteria: z.string().trim().max(240).optional(),
    entryRequires: StageEntryRequiresSchema.optional(),
    /** The matter's work is finished here (Closed). */
    terminal: z.boolean().optional(),
  })
  .strict();
export type TemplateStage = z.infer<typeof TemplateStageSchema>;

/** When a task falls due: days after a matter event, or days after its stage is entered. */
export const TemplateTaskDueSchema = z.union([
  z.object({ fromEvent: EventKindSchema, offsetDays: z.number().int().min(-3650).max(3650) }).strict(),
  z.object({ fromStageEntry: z.number().int().min(0).max(3650) }).strict(),
]);
export type TemplateTaskDue = z.infer<typeof TemplateTaskDueSchema>;

export const TemplateAssignToSchema = z.enum(['responsible', 'role:paralegal']).nullable();
export type TemplateAssignTo = z.infer<typeof TemplateAssignToSchema>;

export const TemplateTaskSchema = z
  .object({
    key: TemplateKeySchema,
    title: NonEmptyString.max(200),
    stageId: TemplateKeySchema,
    /** `responsible`: the matter's responsible person; `role:paralegal`: the first active paralegal; null: unassigned. */
    assignTo: TemplateAssignToSchema,
    due: TemplateTaskDueSchema.optional(),
    priority: PrioritySchema,
    checklist: z.array(NonEmptyString.max(200)).max(30).optional(),
  })
  .strict();
export type TemplateTask = z.infer<typeof TemplateTaskSchema>;

/** Where an org template came from: a system template or another org template, and its version. */
export const TemplateBasedOnSchema = z.object({ templateId: DocIdSchema, version: z.number().int().min(1) }).strict();

/** The editable content of a template (an org draft, a published version or a system template). */
export const templateContentShape = {
  matterType: MatterTypeSchema,
  name: NonEmptyString.max(120),
  stages: z.array(TemplateStageSchema).min(1).max(30),
  tasks: z.array(TemplateTaskSchema).max(200),
  deadlineRuleIds: z.array(NonEmptyString.max(120)).max(50),
};

export interface TemplateContent {
  matterType: MatterType;
  name: string;
  stages: TemplateStage[];
  tasks: TemplateTask[];
  deadlineRuleIds: string[];
}

export interface TemplateProblem {
  path: (string | number)[];
  message: string;
}

/**
 * What is wrong with a template beyond its field types: unique, ordered stages; unique task keys
 * on known stages; no requirements on the first stage (matters start there); `tasksDone` naming
 * tasks of an earlier stage; no duplicate deadline rules. Empty when valid.
 */
export function templateProblems(content: TemplateContent): TemplateProblem[] {
  const problems: TemplateProblem[] = [];
  const stageAt = new Map<string, number>();
  content.stages.forEach((stage, i) => {
    if (stageAt.has(stage.id)) problems.push({ path: ['stages', i, 'id'], message: 'Stage ids must be unique' });
    else stageAt.set(stage.id, i);
    const previous = content.stages[i - 1];
    if (previous && stage.order <= previous.order) {
      problems.push({ path: ['stages', i, 'order'], message: 'Stages must be listed in increasing order' });
    }
  });
  const first = content.stages[0];
  if (first?.entryRequires && Object.values(first.entryRequires).some((list) => list?.length)) {
    problems.push({ path: ['stages', 0, 'entryRequires'], message: 'The first stage cannot have requirements' });
  }
  const taskStage = new Map<string, number>();
  content.tasks.forEach((task, i) => {
    if (taskStage.has(task.key)) problems.push({ path: ['tasks', i, 'key'], message: 'Task keys must be unique' });
    const at = stageAt.get(task.stageId);
    if (at === undefined) problems.push({ path: ['tasks', i, 'stageId'], message: 'Choose one of the stages' });
    else if (!taskStage.has(task.key)) taskStage.set(task.key, at);
  });
  content.stages.forEach((stage, i) => {
    (stage.entryRequires?.tasksDone ?? []).forEach((key, j) => {
      const at = taskStage.get(key);
      if (at === undefined || at >= i) {
        problems.push({
          path: ['stages', i, 'entryRequires', 'tasksDone', j],
          message: 'Name a task of an earlier stage',
        });
      }
    });
  });
  if (new Set(content.deadlineRuleIds).size !== content.deadlineRuleIds.length) {
    problems.push({ path: ['deadlineRuleIds'], message: 'Deadline rules must be unique' });
  }
  return problems;
}

function refineTemplate(content: TemplateContent, ctx: z.RefinementCtx): void {
  for (const problem of templateProblems(content)) {
    ctx.addIssue({ code: 'custom', path: problem.path, message: problem.message });
  }
}

/** A template's content, validated (`templates-save` checks drafts with it). */
export const TemplateContentSchema = z.object(templateContentShape).strict().superRefine(refineTemplate);

/** A system template as bundled in `libs/domain/templates/system/{matterType}.json`. */
export const SystemTemplateSchema = z
  .object({
    id: z.string().regex(/^system-[a-z]+$/),
    source: z.literal('system'),
    version: z.number().int().min(1),
    published: z.literal(true),
    publishedAt: DateOnlySchema,
    ...templateContentShape,
  })
  .strict()
  .superRefine((template, ctx) => {
    if (template.id !== systemTemplateId(template.matterType)) {
      ctx.addIssue({ code: 'custom', path: ['id'], message: `Expected ${systemTemplateId(template.matterType)}` });
    }
    refineTemplate(template, ctx);
  });
export type SystemTemplate = z.infer<typeof SystemTemplateSchema>;

/** A template as matters use it: system or org, at one version. */
export interface Template extends TemplateContent {
  id: string;
  version: number;
  source: 'system' | 'org';
  basedOn?: { templateId: string; version: number } | undefined;
}

/** The id matters use for a matter type's system template. */
export function systemTemplateId(type: MatterType): string {
  return `system-${type}`;
}

export function isSystemTemplateId(id: string): boolean {
  return /^system-[a-z]+$/.test(id);
}

// ---------- anchors and due dates ----------

/** A matter event as anchoring reads it. Soft-deleted events are left out by the caller. */
export interface AnchorEvent {
  kind: EventKind;
  date: string;
}

/** What due dates and requirements are computed from: the matter's key facts and its events. */
export interface AnchorContext {
  matter: FactMatter;
  events: readonly AnchorEvent[];
}

/** Events a key fact stands for: a recorded date of death or grant date makes the event known. */
export const EVENT_KEY_FACTS: Partial<Record<EventKind, KeyFactId>> = {
  date_of_death: 'dateOfDeath',
  grant_issued: 'grantDate',
};

/**
 * The events whose key fact a matter write set or changed to a date (CORE-07b): `date_of_death`
 * for `deceased.dateOfDeath`, `grant_issued` for `estate.grantDate`. Removing a fact sets nothing.
 */
export function keyFactEventsSet(before: FactMatter | undefined, after: FactMatter): EventKind[] {
  return (Object.entries(EVENT_KEY_FACTS) as [EventKind, KeyFactId][]).flatMap(([kind, fact]) => {
    const value = keyFactValue(after, fact);
    return isDateOnly(value) && value !== (before ? keyFactValue(before, fact) : undefined) ? [kind] : [];
  });
}

/**
 * The date of a matter event: the earliest live event of that kind, else the key fact standing
 * for it (date of death, grant date). Undefined while unknown.
 */
export function knownEventDate(kind: EventKind, ctx: AnchorContext): DateOnly | undefined {
  const dates = ctx.events
    .filter((event) => event.kind === kind && isDateOnly(event.date))
    .map((event) => event.date as DateOnly)
    .sort(compareDates);
  if (dates[0]) return dates[0];
  const fact = EVENT_KEY_FACTS[kind];
  const value = fact ? keyFactValue(ctx.matter, fact) : undefined;
  return isDateOnly(value) ? value : undefined;
}

/**
 * A template task's due date: `offsetDays` after its anchor event, or `fromStageEntry` days after
 * the stage was entered (`stageEnteredOn`, a date in the org's time zone). An unknown event gives
 * `duePending` (the event kind) instead, so the task shows "due date pending".
 */
export function templateTaskDue(
  task: Pick<TemplateTask, 'due'>,
  ctx: AnchorContext,
  stageEnteredOn: DateOnly,
): { dueDate?: DateOnly; duePending?: EventKind } {
  const due = task.due;
  if (!due) return {};
  if ('fromStageEntry' in due) return { dueDate: addDays(stageEnteredOn, due.fromStageEntry) };
  const anchor = knownEventDate(due.fromEvent, ctx);
  return anchor ? { dueDate: addDays(anchor, due.offsetDays) } : { duePending: due.fromEvent };
}

/** The stored fields of a matter task that decide whether its pending due date can be filled. */
export interface PendingTaskLike {
  status?: unknown;
  dueDate?: unknown;
  duePending?: unknown;
  deletedAt?: unknown;
}

/**
 * The due date to fill on a template task waiting on `kind` now that the event is known
 * (CORE-07b), from its template task's due rule; undefined to leave the task alone. Only a live,
 * open task (not done or cancelled) still `duePending` on `kind` and without a `dueDate` is
 * filled: a filled task loses `duePending`, and a date set by hand is a `dueDate` (clients can't
 * clear the server-owned `duePending`), so neither ever changes again.
 */
export function pendingTaskDue(
  task: PendingTaskLike,
  definition: Pick<TemplateTask, 'due'> | undefined,
  kind: EventKind,
  ctx: AnchorContext,
  stageEnteredOn: DateOnly,
): DateOnly | undefined {
  if (task.duePending !== kind || (task.deletedAt !== undefined && task.deletedAt !== null)) return undefined;
  if (task.status === 'done' || task.status === 'cancelled') return undefined;
  if (typeof task.dueDate === 'string' && task.dueDate) return undefined;
  if (!definition) return undefined;
  return templateTaskDue(definition, ctx, stageEnteredOn).dueDate;
}

// ---------- task generation ----------

/** A template task's document id under the matter: one task per (matter, template task key). */
export function templateTaskDocId(key: string): string {
  return `tpl-${key}`;
}

/** The template task key of a task document id, or undefined for other tasks. */
export function templateTaskKeyOf(docId: string): string | undefined {
  return docId.startsWith('tpl-') ? docId.slice(4) : undefined;
}

/**
 * The template tasks to create when a matter is at `stageId`: that stage's tasks, plus (with
 * `knownAnchors`) the tasks of that stage or later ones whose anchor event is already known, so
 * their due dates show early. Earlier stages never get tasks. Unknown stages give none.
 */
export function templateTasksFor(
  template: Pick<TemplateContent, 'stages' | 'tasks'>,
  stageId: string,
  ctx: AnchorContext,
  { knownAnchors }: { knownAnchors: boolean },
): TemplateTask[] {
  const at = template.stages.findIndex((stage) => stage.id === stageId);
  if (at < 0) return [];
  const later = new Set(template.stages.slice(at).map((stage) => stage.id));
  return template.tasks.filter(
    (task) =>
      task.stageId === stageId ||
      (knownAnchors &&
        later.has(task.stageId) &&
        !!task.due &&
        'fromEvent' in task.due &&
        knownEventDate(task.due.fromEvent, ctx) !== undefined),
  );
}

/** Who a template task goes to: the responsible person, the first active paralegal (else responsible), or nobody. */
export function templateAssignee(
  assignTo: TemplateAssignTo,
  people: { responsibleUid: string; paralegalUid?: string | undefined },
): string | undefined {
  if (assignTo === 'responsible') return people.responsibleUid;
  if (assignTo === 'role:paralegal') return people.paralegalUid ?? people.responsibleUid;
  return undefined;
}

/** The fields of a new matter task made from a template task (without ids and meta). */
export interface TemplateTaskFields {
  title: string;
  status: 'todo';
  priority: Priority;
  assigneeUid?: string;
  dueDate?: DateOnly;
  duePending?: EventKind;
  group: string;
  checklist: { id: string; text: string; done: false }[];
  order: number;
  source: 'template';
  templateTaskKey: string;
}

/** A template task as a matter task: its stage's name as the group, its template position as the order. */
export function templateTaskFields(
  template: Pick<TemplateContent, 'stages' | 'tasks'>,
  task: TemplateTask,
  ctx: AnchorContext,
  options: { stageEnteredOn: DateOnly; responsibleUid: string; paralegalUid?: string | undefined },
): TemplateTaskFields {
  const assigneeUid = templateAssignee(task.assignTo, options);
  const due = templateTaskDue(task, ctx, options.stageEnteredOn);
  return {
    title: task.title,
    status: 'todo',
    priority: task.priority,
    ...(assigneeUid ? { assigneeUid } : {}),
    ...due,
    group: template.stages.find((stage) => stage.id === task.stageId)?.name ?? task.stageId,
    checklist: (task.checklist ?? []).map((text, i) => ({ id: `c${i + 1}`, text, done: false as const })),
    order: template.tasks.indexOf(task) + 1,
    source: 'template',
    templateTaskKey: task.key,
  };
}

// ---------- stage requirements ----------

export interface StageEntryContext extends AnchorContext {
  /** Template task keys whose task is done (or cancelled: `meetsTasksDone`). */
  doneTaskKeys: ReadonlySet<string>;
}

/**
 * Whether a task's status meets a stage's `tasksDone` requirement: done, or cancelled (CORE-07b),
 * since a task the practice decided not to do shouldn't hold the matter back.
 */
export function meetsTasksDone(status: unknown): boolean {
  return status === 'done' || status === 'cancelled';
}

/** What a forward move is missing: key facts (CORE-06 `requirements`), events and template tasks. */
export interface UnmetStageEntry {
  requirements: KeyFactId[];
  events: EventKind[];
  tasks: string[];
}

/**
 * Everything missing to move from `fromId` to `toId`: the requirements of every stage passed into
 * on the way (a forward move, skips included). Moving back, or staying, has none.
 */
export function unmetStageEntry(
  stages: readonly MatterStage[],
  fromId: string | undefined,
  toId: string,
  ctx: StageEntryContext,
): UnmetStageEntry {
  const from = stageIndex(stages, fromId);
  const to = stages.findIndex((stage) => stage.id === toId);
  const none: UnmetStageEntry = { requirements: [], events: [], tasks: [] };
  if (to <= from) return none;
  const passed = stages.slice(from + 1, to + 1);
  const requirements = [...new Set(passed.flatMap((stage) => stage.requires ?? []))].filter((id) => {
    const value = keyFactValue(ctx.matter, id);
    return value === undefined || value === '';
  });
  const events = [...new Set(passed.flatMap((stage) => stage.events ?? []))].filter(
    (kind) => knownEventDate(kind, ctx) === undefined,
  );
  const tasks = [...new Set(passed.flatMap((stage) => stage.tasksDone ?? []))].filter(
    (key) => !ctx.doneTaskKeys.has(key),
  );
  return { requirements, events, tasks };
}

export function hasUnmetStageEntry(unmet: UnmetStageEntry): boolean {
  return unmet.requirements.length + unmet.events.length + unmet.tasks.length > 0;
}

// ---------- versions ----------

/**
 * The stage ids of `previous` that `next` drops (publishing a version without them). Matters in
 * such a stage need a mapping to a stage of `next` before the version can be published.
 */
export function removedStageIds(
  previous: Pick<TemplateContent, 'stages'>,
  next: Pick<TemplateContent, 'stages'>,
): string[] {
  const kept = new Set(next.stages.map((stage) => stage.id));
  return previous.stages.map((stage) => stage.id).filter((id) => !kept.has(id));
}

/**
 * Where a matter's stage lands in a later version: itself when the version keeps it, else the
 * mappings recorded by each version published since, followed in order. Undefined when unmapped.
 */
export function mapStageAcrossVersions(
  stageId: string,
  versions: readonly { stages: readonly { id: string }[]; stageMapping?: Record<string, string> | undefined }[],
): string | undefined {
  let current: string | undefined = stageId;
  for (const version of versions) {
    if (current === undefined) return undefined;
    if (!version.stages.some((stage) => stage.id === current)) current = version.stageMapping?.[current];
  }
  return current;
}

// ---------- callable inputs ----------

const RequestId = z.uuid();
const StageMappingSchema = z.record(TemplateKeySchema, TemplateKeySchema);

/** `templates-apply` (matter.edit): gives a matter a template version and creates its tasks. */
export const ApplyTemplateInput = z.object({
  requestId: RequestId,
  matterId: DocIdSchema,
  templateId: DocIdSchema,
  version: z.number().int().min(1),
});
export type ApplyTemplateInput = z.infer<typeof ApplyTemplateInput>;

export interface ApplyTemplateResult {
  matterId: string;
  templateId: string;
  version: number;
  stageId: string;
  /** Task ids created by this call (already existing template tasks are left alone). */
  createdTaskIds: string[];
}

/** `templates-clone` (org.settings): a new org draft from a system or org template. */
export const CloneTemplateInput = z.object({
  requestId: RequestId,
  sourceTemplateId: DocIdSchema,
  /** The source's version; defaults to its latest published version. */
  version: z.number().int().min(1).optional(),
  name: NonEmptyString.max(120).optional(),
});
export type CloneTemplateInput = z.infer<typeof CloneTemplateInput>;

export interface CloneTemplateResult {
  templateId: string;
}

/** `templates-save` (org.settings): replaces fields of an org template's draft. The type never changes. */
export const SaveTemplateInput = z.object({
  requestId: RequestId,
  templateId: DocIdSchema,
  name: templateContentShape.name.optional(),
  stages: templateContentShape.stages.optional(),
  tasks: templateContentShape.tasks.optional(),
  deadlineRuleIds: templateContentShape.deadlineRuleIds.optional(),
});
export type SaveTemplateInput = z.infer<typeof SaveTemplateInput>;

export interface SaveTemplateResult {
  templateId: string;
}

/**
 * `templates-publish` (org.settings): the draft becomes the next immutable version. Dropping a
 * stage that matters are in needs `stageMapping` (removed stage id → a stage of the new version).
 */
export const PublishTemplateInput = z.object({
  requestId: RequestId,
  templateId: DocIdSchema,
  stageMapping: StageMappingSchema.optional(),
});
export type PublishTemplateInput = z.infer<typeof PublishTemplateInput>;

export interface PublishTemplateResult {
  templateId: string;
  version: number;
}

/** `matters-upgradeTemplate` (matter.edit): moves a matter to a later version of its template. */
export const UpgradeMatterTemplateInput = z.object({
  requestId: RequestId,
  matterId: DocIdSchema,
  version: z.number().int().min(1),
});
export type UpgradeMatterTemplateInput = z.infer<typeof UpgradeMatterTemplateInput>;

export interface UpgradeMatterTemplateResult {
  matterId: string;
  templateId: string;
  version: number;
  stageId: string;
  createdTaskIds: string[];
}
