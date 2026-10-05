import { checklistKey } from './checklist-templates';
import type { Priority } from './schemas/enums';
import { TASK_GROUP_MAX, type ChecklistItem } from './schemas/matter-records';
import {
  CHECKLIST_TEMPLATE_DUE_MAX_DAYS,
  CHECKLIST_TEMPLATE_ITEM_MAX,
  CHECKLIST_TEMPLATE_ITEMS_MAX,
  TASK_GROUP_TEMPLATE_NAME_MAX,
  TASK_GROUP_TEMPLATE_TASKS_MAX,
  TASK_GROUP_TEMPLATE_TITLE_MAX,
  type TaskGroupTemplateTask,
} from './schemas/org-records';
import { addDays, type DateOnly } from './values/date-only';
import { newId } from './values/ids';

/**
 * Task group templates (CORE-08f): a reusable group of tasks (`orgs/{orgId}/taskGroupTemplates`),
 * each task with its checklist, applied to a matter's Tasks tab. The tasks land in a group named
 * after the template, after the matter's last task. Templates are written as an outline: one task
 * per line, its checklist items indented (or bulleted further in) beneath it.
 */

export const taskGroupTemplatePath = (orgId: string, templateId?: string) =>
  `orgs/${orgId}/taskGroupTemplates${templateId ? `/${templateId}` : ''}`;

/** What applying and editing need from a template. */
export interface TaskGroupTemplateLike {
  name: string;
  tasks: readonly TaskGroupTemplateTask[];
}

const PRIORITY_WORDS: Readonly<Record<string, Priority>> = {
  urgent: 'urgent',
  urg: 'urgent',
  u: 'urgent',
  high: 'high',
  hi: 'high',
  h: 'high',
  medium: 'medium',
  med: 'medium',
  m: 'medium',
  low: 'low',
  lo: 'low',
  l: 'low',
  none: 'none',
};

/** A list marker at the start of a line: `-`, `*`, `•`, `+`, `1.`, `1)` or a `[ ]` box. */
const BULLET_RE = /^(?:[-*•+]|\d{1,3}[.)]|\[[ xX]?\])\s+/u;
const PRIORITY_RE = /(^|\s)!([a-z]+)(?=\s|$)/giu;
/** `in 3 days`, `due in 2 weeks`, `in 5d`, `in 1w`. */
const DUE_RE = /(^|\s)(?:due\s+)?in\s+(\d{1,4})\s*(d|days?|w|wks?|weeks?)(?=\s|$|[.,;])/iu;

/** Leading whitespace as columns (a tab is 4). */
function indentOf(line: string): number {
  let columns = 0;
  for (const char of /^[ \t]*/u.exec(line)?.[0] ?? '') columns += char === '\t' ? 4 : 1;
  return columns;
}

const oneLine = (text: string) => text.replace(/\s+/gu, ' ').trim();

export interface TaskGroupOutline {
  tasks: TaskGroupTemplateTask[];
  /** Why the outline can't be saved as it is (too many tasks or items, a date too far out). */
  problems: string[];
}

/**
 * Reads an outline (CORE-08f): each line is a task, and lines indented further than the task above
 * them are its checklist items. List markers (`-`, `*`, `1.`, `[ ]`) are dropped. A task line may
 * end with `!priority` (`!high`, `!h`; the last wins) and `in N days` or `in N weeks` (its due date,
 * counted from the day the template is applied). Blank lines and repeated checklist items are
 * skipped; text is cut to the limits.
 */
export function parseTaskGroupOutline(text: string): TaskGroupOutline {
  const tasks: TaskGroupTemplateTask[] = [];
  const problems: string[] = [];
  let current: { task: TaskGroupTemplateTask; indent: number; seen: Set<string> } | null = null;
  for (const raw of text.split(/\r?\n/u)) {
    const content = oneLine(raw.trim().replace(BULLET_RE, ''));
    if (!content) continue;
    const indent = indentOf(raw);
    if (current && indent > current.indent) {
      const item = content.slice(0, CHECKLIST_TEMPLATE_ITEM_MAX).trim();
      const key = checklistKey(item);
      if (!current.seen.has(key)) {
        current.seen.add(key);
        current.task.checklist.push(item);
      }
      continue;
    }
    const task = taskLine(content);
    if (task.dueInDays !== undefined && task.dueInDays > CHECKLIST_TEMPLATE_DUE_MAX_DAYS) {
      problems.push(`“${task.title}” is due more than ${CHECKLIST_TEMPLATE_DUE_MAX_DAYS} days out.`);
    }
    tasks.push(task);
    current = { task, indent, seen: new Set() };
  }
  if (tasks.length > TASK_GROUP_TEMPLATE_TASKS_MAX) {
    problems.push(`A template holds up to ${TASK_GROUP_TEMPLATE_TASKS_MAX} tasks; this has ${tasks.length}.`);
  }
  for (const task of tasks) {
    if (task.checklist.length > CHECKLIST_TEMPLATE_ITEMS_MAX) {
      problems.push(
        `“${task.title}” has ${task.checklist.length} checklist items; a template task holds up to ${CHECKLIST_TEMPLATE_ITEMS_MAX}.`,
      );
    }
  }
  return { tasks, problems };
}

/** A task line: its title, and the `!priority` and `in N days` it carries. */
function taskLine(content: string): TaskGroupTemplateTask {
  let priority: Priority | undefined;
  let rest = content.replace(PRIORITY_RE, (match, lead: string, word: string) => {
    const found = PRIORITY_WORDS[word.toLowerCase()];
    if (!found) return match;
    priority = found;
    return lead;
  });
  let dueInDays: number | undefined;
  const due = DUE_RE.exec(rest);
  if (due) {
    const n = Number(due[2]);
    dueInDays = /^w/iu.test(due[3] ?? '') ? n * 7 : n;
    rest = rest.slice(0, due.index) + (due[1] ?? '') + rest.slice(due.index + due[0].length);
  }
  const title =
    oneLine(rest).slice(0, TASK_GROUP_TEMPLATE_TITLE_MAX).trim() || content.slice(0, TASK_GROUP_TEMPLATE_TITLE_MAX);
  return {
    title,
    checklist: [],
    ...(priority && priority !== 'none' ? { priority } : {}),
    ...(dueInDays !== undefined ? { dueInDays } : {}),
  };
}

/** A template as an outline to edit: the reverse of `parseTaskGroupOutline`. */
export function taskGroupOutline(tasks: readonly TaskGroupTemplateTask[]): string {
  return tasks
    .map((task) => {
      let line = task.title;
      if (task.priority && task.priority !== 'none') line += ` !${task.priority}`;
      if (task.dueInDays !== undefined) line += ` in ${task.dueInDays} ${task.dueInDays === 1 ? 'day' : 'days'}`;
      return [line, ...task.checklist.map((item) => `  - ${item}`)].join('\n');
    })
    .join('\n');
}

/** What saving a group as a template needs from each of its tasks. */
export interface TaskGroupSourceTask {
  title: string;
  checklist?: readonly { text: string }[] | undefined;
  priority?: Priority | undefined;
}

/**
 * A template's tasks from a group on a matter ("Save as a template"): titles on one line, checklist
 * texts (unticked, repeats dropped, at most 30) and priorities; due dates aren't carried over. At
 * most 50 tasks.
 */
export function taskGroupTemplateTasks(tasks: readonly TaskGroupSourceTask[]): TaskGroupTemplateTask[] {
  return tasks.slice(0, TASK_GROUP_TEMPLATE_TASKS_MAX).flatMap((task) => {
    const title = oneLine(task.title).slice(0, TASK_GROUP_TEMPLATE_TITLE_MAX).trim();
    if (!title) return [];
    const seen = new Set<string>();
    const checklist: string[] = [];
    for (const item of task.checklist ?? []) {
      const text = oneLine(item.text).slice(0, CHECKLIST_TEMPLATE_ITEM_MAX).trim();
      const key = checklistKey(text);
      if (!key || seen.has(key) || checklist.length >= CHECKLIST_TEMPLATE_ITEMS_MAX) continue;
      seen.add(key);
      checklist.push(text);
    }
    return [{ title, checklist, ...(task.priority && task.priority !== 'none' ? { priority: task.priority } : {}) }];
  });
}

/** A template name from a group name, cut to the limit. */
export function taskGroupTemplateName(group: string): string {
  return oneLine(group).slice(0, TASK_GROUP_TEMPLATE_NAME_MAX).trim();
}

export interface PlanTaskGroupOptions {
  /** Today in the org's time zone (`today(org.timezone)`): `dueInDays` counts from it. */
  today: DateOnly;
  /** The order of the first new task (after the matter's last, `orderAfterLast`); the rest follow 1024 apart. */
  firstOrder: number;
  /** Makes checklist item ids (tests pass a counter); defaults to random ids. */
  newId?: () => string;
}

/** A task to create on the matter. */
export interface PlannedGroupTask {
  title: string;
  group: string;
  checklist: ChecklistItem[];
  priority: Priority;
  dueDate?: DateOnly;
  order: number;
}

/**
 * The tasks applying a template creates (CORE-08f): one per template task, in order, in the group
 * named after the template, unticked checklists with new ids, the template's priority (or none) and
 * `today + dueInDays` as the due date.
 */
export function planTaskGroup(template: TaskGroupTemplateLike, options: PlanTaskGroupOptions): PlannedGroupTask[] {
  const group = oneLine(template.name).slice(0, TASK_GROUP_MAX).trim();
  const makeId = options.newId ?? newId;
  return template.tasks.map((task, index) => {
    const ids = new Set<string>();
    const checklist = task.checklist.map((text) => {
      let id = makeId();
      while (ids.has(id)) id = makeId();
      ids.add(id);
      return { id, text, done: false };
    });
    return {
      title: task.title,
      group,
      checklist,
      priority: task.priority ?? 'none',
      ...(task.dueInDays !== undefined ? { dueDate: addDays(options.today, task.dueInDays) } : {}),
      order: options.firstOrder + index * 1024,
    };
  });
}
