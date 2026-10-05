import * as z from 'zod';

import {
  DomainError,
  EventKindSchema,
  templateContentShape,
  templateProblems,
  type EventKind,
  type KeyFactId,
  type MatterType,
  type Priority,
  type TemplateContent,
  type TemplateStage,
  type TemplateTask,
} from '@materia/domain';

/**
 * Settings → Templates (CORE-07): the editor's form model and its conversions. The form keeps
 * strings for what people type (offset days, checklist lines, deadline rule ids), and turns into
 * template content to validate and save. Errors are keyed by field path (`stages.2.id`), as the
 * domain's `templateProblems` and `templates-save` name them.
 */

export interface StageDraft {
  id: string;
  name: string;
  criteria: string;
  facts: KeyFactId[];
  events: EventKind[];
  tasksDone: string[];
  terminal: boolean;
}

export type DueKind = 'none' | 'event' | 'stage';
export type AssignToDraft = 'responsible' | 'role:paralegal' | 'nobody';

export interface TaskDraft {
  key: string;
  title: string;
  stageId: string;
  assignTo: AssignToDraft;
  dueKind: DueKind;
  dueEvent: EventKind;
  /** Days after the event (may be negative) or after the stage is entered, as typed. */
  offsetDays: string;
  priority: Priority;
  /** One checklist line per line. */
  checklist: string;
}

export interface TemplateDraft {
  matterType: MatterType;
  name: string;
  stages: StageDraft[];
  tasks: TaskDraft[];
  /** One deadline rule id per line. */
  deadlineRuleIds: string;
}

/** Field path (`tasks.3.title`) → the message to show there. */
export type FieldErrors = Record<string, string>;

export function stageDraft(stage: TemplateStage): StageDraft {
  return {
    id: stage.id,
    name: stage.name,
    criteria: stage.criteria ?? '',
    facts: [...(stage.entryRequires?.facts ?? [])],
    events: [...(stage.entryRequires?.events ?? [])],
    tasksDone: [...(stage.entryRequires?.tasksDone ?? [])],
    terminal: !!stage.terminal,
  };
}

export function taskDraft(task: TemplateTask): TaskDraft {
  const due = task.due;
  return {
    key: task.key,
    title: task.title,
    stageId: task.stageId,
    assignTo: task.assignTo ?? 'nobody',
    dueKind: !due ? 'none' : 'fromEvent' in due ? 'event' : 'stage',
    dueEvent: due && 'fromEvent' in due ? due.fromEvent : 'date_of_death',
    offsetDays: !due ? '' : String('fromEvent' in due ? due.offsetDays : due.fromStageEntry),
    priority: task.priority,
    checklist: (task.checklist ?? []).join('\n'),
  };
}

export function templateDraft(content: TemplateContent): TemplateDraft {
  return {
    matterType: content.matterType,
    name: content.name,
    stages: content.stages.map(stageDraft),
    tasks: content.tasks.map(taskDraft),
    deadlineRuleIds: content.deadlineRuleIds.join('\n'),
  };
}

const lines = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

/** An integer as typed, or NaN (left for validation to report). */
function days(text: string): number {
  const trimmed = text.trim();
  return /^-?\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

function stageContent(stage: StageDraft, i: number): TemplateStage {
  const requires = {
    ...(stage.facts.length ? { facts: stage.facts } : {}),
    ...(stage.events.length ? { events: stage.events } : {}),
    ...(stage.tasksDone.length ? { tasksDone: stage.tasksDone } : {}),
  };
  return {
    id: stage.id.trim(),
    name: stage.name.trim(),
    // Stages are ordered as listed; gaps leave room for inserting one later.
    order: (i + 1) * 10,
    ...(stage.criteria.trim() ? { criteria: stage.criteria.trim() } : {}),
    ...(Object.keys(requires).length ? { entryRequires: requires } : {}),
    ...(stage.terminal ? { terminal: true } : {}),
  };
}

function taskContent(task: TaskDraft): TemplateTask {
  const checklist = lines(task.checklist);
  const due =
    task.dueKind === 'event'
      ? { due: { fromEvent: task.dueEvent, offsetDays: days(task.offsetDays) } }
      : task.dueKind === 'stage'
        ? { due: { fromStageEntry: days(task.offsetDays) } }
        : {};
  return {
    key: task.key.trim(),
    title: task.title.trim(),
    stageId: task.stageId,
    assignTo: task.assignTo === 'nobody' ? null : task.assignTo,
    ...due,
    priority: task.priority,
    ...(checklist.length ? { checklist } : {}),
  };
}

/** The draft as template content (what `templates-save` takes). */
export function draftContent(draft: TemplateDraft): TemplateContent {
  return {
    matterType: draft.matterType,
    name: draft.name.trim(),
    stages: draft.stages.map(stageContent),
    tasks: draft.tasks.map(taskContent),
    deadlineRuleIds: lines(draft.deadlineRuleIds),
  };
}

const ContentShape = /* @__PURE__ */ z.object(templateContentShape);

/** A due-date error names the whole "due" field, whichever of its parts is wrong. */
function fieldKey(path: readonly PropertyKey[]): string {
  const key = path.map(String).join('.');
  return key.replace(/^(tasks\.\d+\.due)\..*$/, '$1');
}

/**
 * What is wrong with the draft before it is sent: field types and lengths (the domain schema) and
 * the template rules (`templateProblems`: unique ids, known stages, requirements). Empty when valid.
 */
export function draftProblems(draft: TemplateDraft): FieldErrors {
  const content = draftContent(draft);
  const errors: FieldErrors = {};
  const add = (path: readonly PropertyKey[], message: string) => (errors[fieldKey(path)] ??= message);
  draft.tasks.forEach((task, i) => {
    if (task.dueKind !== 'none' && Number.isNaN(days(task.offsetDays))) {
      add(['tasks', i, 'due'], 'Enter a whole number of days');
    }
  });
  const parsed = ContentShape.safeParse(content);
  if (!parsed.success) for (const issue of parsed.error.issues) add(issue.path, issue.message);
  for (const problem of templateProblems(content)) add(problem.path, problem.message);
  return errors;
}

/** The field errors `templates-save` or `templates-publish` returned (`details.fields`), or null. */
export function serverFieldErrors(error: unknown): FieldErrors | null {
  if (!(error instanceof DomainError) || error.code !== 'INVALID_ARGUMENT') return null;
  const fields = error.details?.['fields'];
  if (!fields || typeof fields !== 'object') return null;
  const errors: FieldErrors = {};
  for (const [path, messages] of Object.entries(fields as Record<string, unknown>)) {
    const message = Array.isArray(messages) ? String(messages[0] ?? '') : String(messages);
    errors[fieldKey(path.split('.'))] ??= message || 'Check this field';
  }
  return Object.keys(errors).length ? errors : null;
}

/** The error at a field, or the first one inside it (`stages.1.entryRequires.tasksDone.0` for `stages.1.entryRequires`). */
export function errorAt(errors: FieldErrors, path: string): string | undefined {
  if (errors[path]) return errors[path];
  const inside = Object.keys(errors).find((key) => key.startsWith(`${path}.`));
  return inside ? errors[inside] : undefined;
}

const FIELD_NAMES: Record<string, string> = {
  id: 'id',
  name: 'name',
  order: 'order',
  criteria: 'criteria',
  entryRequires: 'requirements',
  key: 'key',
  title: 'title',
  stageId: 'stage',
  assignTo: 'assignee',
  due: 'due date',
  priority: 'priority',
  checklist: 'checklist',
};

/** A field path in words: `stages.2.id` → "Stage 3 id", `deadlineRuleIds` → "Deadline rules". */
export function fieldLabel(path: string): string {
  const [list, index, field] = path.split('.');
  if (list === 'name') return 'Name';
  if (list === 'deadlineRuleIds') return 'Deadline rules';
  const what = list === 'stages' ? 'Stage' : list === 'tasks' ? 'Task' : list;
  const n = Number(index);
  const name = field ? (FIELD_NAMES[field] ?? field) : '';
  return [`${what}${Number.isInteger(n) ? ` ${n + 1}` : ''}`, name].filter(Boolean).join(' ');
}

/** A stage or task key that isn't taken yet: `stage_4`, `task_12`. */
export function nextKey(prefix: string, taken: readonly string[]): string {
  let n = taken.length + 1;
  while (taken.includes(`${prefix}_${n}`)) n++;
  return `${prefix}_${n}`;
}

export const EVENT_KINDS: readonly EventKind[] = EventKindSchema.options;
