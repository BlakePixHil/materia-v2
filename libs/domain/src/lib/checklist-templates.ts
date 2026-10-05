import type { Priority } from './schemas/enums';
import type { ChecklistItem } from './schemas/matter-records';
import { TASK_CHECKLIST_MAX } from './schemas/matter-records';
import {
  CHECKLIST_TEMPLATE_ITEM_MAX,
  CHECKLIST_TEMPLATE_ITEMS_MAX,
  CHECKLIST_TEMPLATE_NAME_MAX,
} from './schemas/org-records';
import { addDays, type DateOnly } from './values/date-only';
import { newId } from './values/ids';

/**
 * Checklist templates (CORE-08d): reusable checklists (`orgs/{orgId}/checklistTemplates`) applied
 * to a task from its details. Applying adds the items the task doesn't have yet and fills in an
 * empty priority and due date; it never changes what the task already has.
 */

export const checklistTemplatePath = (orgId: string, templateId?: string) =>
  `orgs/${orgId}/checklistTemplates${templateId ? `/${templateId}` : ''}`;

/** What applying needs from a template. */
export interface ChecklistTemplateLike {
  name: string;
  items: readonly string[];
  priority?: Priority | undefined;
  dueInDays?: number | undefined;
}

/** What applying needs from a task. */
export interface ChecklistTaskLike {
  checklist?: readonly ChecklistItem[] | undefined;
  priority?: Priority | undefined;
  dueDate?: DateOnly | string | undefined | null;
}

export interface ApplyChecklistTemplateOptions {
  /** Today in the org's time zone (`today(org.timezone)`): `dueInDays` counts from it. */
  today: DateOnly;
  /** Makes item ids (tests pass a counter); defaults to random ids. */
  newId?: () => string;
}

/** The task's new fields: always the checklist; priority and due date only when they were empty. */
export interface ChecklistTemplatePatch {
  checklist: ChecklistItem[];
  priority?: Priority;
  dueDate?: DateOnly;
}

export interface ApplyChecklistTemplateResult {
  patch: ChecklistTemplatePatch;
  /** Items added to the checklist, unticked. */
  added: number;
  /** Template items left out: already on the checklist (`duplicates`) or past the limit (`overLimit`). */
  skipped: number;
  duplicates: number;
  overLimit: number;
  /** Anything to write (items added, or a priority or due date filled in). */
  changed: boolean;
}

/** The comparison key of a checklist line: trimmed, spaces collapsed, case-insensitive. */
export function checklistKey(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-AU');
}

/**
 * Applies a template to a task (CORE-08d). The checklist keeps its items and gains the template's
 * items it doesn't already have (a case-insensitive match on the trimmed text), unticked, with new
 * ids, up to `TASK_CHECKLIST_MAX` items. The template's priority is used only when the task has
 * none, and its due date (`today + dueInDays`) only when the task has no due date.
 */
export function applyChecklistTemplate(
  task: ChecklistTaskLike,
  template: ChecklistTemplateLike,
  options: ApplyChecklistTemplateOptions,
): ApplyChecklistTemplateResult {
  const existing = [...(task.checklist ?? [])];
  const seen = new Set(existing.map((item) => checklistKey(item.text)));
  const ids = new Set(existing.map((item) => item.id));
  const makeId = options.newId ?? newId;
  const freshId = () => {
    let id = makeId();
    while (ids.has(id)) id = makeId();
    ids.add(id);
    return id;
  };

  const checklist = existing;
  let added = 0;
  let duplicates = 0;
  let overLimit = 0;
  for (const raw of template.items) {
    const text = raw.trim();
    const key = checklistKey(text);
    if (!key) continue;
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    if (checklist.length >= TASK_CHECKLIST_MAX) {
      overLimit++;
      continue;
    }
    seen.add(key);
    checklist.push({ id: freshId(), text, done: false });
    added++;
  }

  const patch: ChecklistTemplatePatch = { checklist };
  if (template.priority && template.priority !== 'none' && (task.priority ?? 'none') === 'none') {
    patch.priority = template.priority;
  }
  if (typeof template.dueInDays === 'number' && !task.dueDate) {
    patch.dueDate = addDays(options.today, template.dueInDays);
  }
  return {
    patch,
    added,
    skipped: duplicates + overLimit,
    duplicates,
    overLimit,
    changed: added > 0 || patch.priority !== undefined || patch.dueDate !== undefined,
  };
}

/**
 * The lines of a "one item per line" field as template items: trimmed, blank lines and repeats
 * (case-insensitive) dropped, each cut to `CHECKLIST_TEMPLATE_ITEM_MAX` characters. Not capped at
 * `CHECKLIST_TEMPLATE_ITEMS_MAX`: the form says when there are too many.
 */
export function checklistTemplateLines(text: string): string[] {
  return uniqueItems(text.split(/\r?\n/));
}

/** A template's items from a task's checklist ("Save as a template"), at most 30. */
export function checklistTemplateItemsFromTask(checklist: readonly { text: string }[]): string[] {
  return uniqueItems(checklist.map((item) => item.text)).slice(0, CHECKLIST_TEMPLATE_ITEMS_MAX);
}

function uniqueItems(lines: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const text = line.replace(/\s+/g, ' ').trim().slice(0, CHECKLIST_TEMPLATE_ITEM_MAX).trim();
    const key = checklistKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

/** A name for a template saved from a task: the task's title, cut to the name limit. */
export function checklistTemplateNameFromTask(title: string): string {
  return title.trim().slice(0, CHECKLIST_TEMPLATE_NAME_MAX).trim();
}

/** Templates whose name contains every word of the query (case-insensitive), by name. */
export function filterChecklistTemplates<T extends { name: string }>(templates: readonly T[], query: string): T[] {
  const words = checklistKey(query).split(' ').filter(Boolean);
  return templates
    .filter((template) => {
      const name = checklistKey(template.name);
      return words.every((word) => name.includes(word));
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'en-AU', { sensitivity: 'base' }));
}
