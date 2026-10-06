import { domain } from '../domain.ts';
import type { MatterRef } from './comments.ts';
import { fit, migratedMeta, migId, type TransformContext, type TransformedRecord } from './context.ts';
import { dueDate, optionalInstant } from './dates.ts';
import { cleanText, priorityOf } from './values.ts';
import { arr, isPlainObject, obj, str } from '../legacy/snapshot.ts';

const { TASK_GROUP_MAX, TASK_TITLE_MAX } = domain;

/**
 * A card's `checklists[].items[]` → matter tasks (CORE-08), grouped by the checklist's title:
 * `name` → title, `checked` → done (with `doneOnDate` as `completedAt`), the due date as the
 * Melbourne day, priority 1 → high and 0 → none. A `templateExists` flag on a checklist is
 * app state and is dropped. Items that had a calendar event keep it in `legacyCalendar` for
 * INT-02, since the event is still in the user's calendar.
 */

/** Tasks keep legacy order, 1000 apart so later moves have room (CORE-08 `orderBetween`). */
const ORDER_STEP = 1000;
const LIST_STEP = 1_000_000;

export function mapChecklists(ctx: TransformContext, matter: MatterRef, checklists: unknown): TransformedRecord[] {
  const tasks: TransformedRecord[] = [];
  arr(checklists).forEach((rawList, listIndex) => {
    const list = obj(rawList);
    if (!list) return;
    const listKey = str(list['id']) || String(listIndex);
    const group = cleanText(list['title']);
    arr(list['items']).forEach((rawItem, itemIndex) => {
      const item = obj(rawItem);
      if (!item) return;
      const legacyPath = `${matter.cardPath}#checklist/${listKey}/item/${str(item['id']) || itemIndex}`;
      tasks.push(
        checklistTask(ctx, matter, item, {
          legacyPath,
          group,
          order: listIndex * LIST_STEP + (itemIndex + 1) * ORDER_STEP,
        }),
      );
    });
  });
  return tasks;
}

function checklistTask(
  ctx: TransformContext,
  matter: MatterRef,
  item: Record<string, unknown>,
  { legacyPath, group, order }: { legacyPath: string; group: string; order: number },
): TransformedRecord {
  let title = cleanText(item['name']);
  if (!title) {
    ctx.warnings.add('MIG_W_UNTITLED', legacyPath);
    title = 'Untitled task (imported)';
  }
  const done = item['checked'] === true;
  // Done without a `doneOnDate`: the card's last update, so the task trigger doesn't stamp the load time.
  const completedAt = done ? (optionalInstant(ctx, item['doneOnDate'], legacyPath) ?? matter.updatedAt) : undefined;
  const due = dueDate(ctx, item['dueDate'], legacyPath);
  const calendar = legacyCalendar(item, ctx.uid);
  if (calendar.length) ctx.warnings.add('MIG_W_CALENDAR_EVENTS_EXIST', legacyPath);
  return {
    entity: 'tasks',
    path: `orgs/${matter.orgId}/matters/${matter.matterId}/tasks/${migId(legacyPath)}`,
    legacyPath,
    data: {
      orgId: matter.orgId,
      matterId: matter.matterId,
      title: fit(ctx, title, TASK_TITLE_MAX, legacyPath),
      status: done ? 'done' : 'todo',
      priority: priorityOf(ctx, item['priority'], legacyPath),
      assigneeUid: ctx.uid,
      ...(due ? { dueDate: due } : {}),
      ...(group ? { group: fit(ctx, group, TASK_GROUP_MAX, legacyPath) } : {}),
      checklist: [],
      order,
      source: 'migration',
      ...(completedAt ? { completedAt } : {}),
      search: [],
      // tasks-onWrite counts the open ones into the matter's openTaskCount.
      countedOpen: false,
      ...(calendar.length ? { legacyCalendar: calendar } : {}),
      // Checklist items have no dates of their own: the card's stand in.
      ...migratedMeta(ctx, { legacyPath, createdAt: matter.createdAt, updatedAt: matter.updatedAt, by: ctx.uid }),
    },
  };
}

/**
 * The calendar events a checklist item had: `calendarSyncByUser[uid]` entries, or the older single
 * `calendarSync`, that were linked. Only the user's own: other people's calendars aren't theirs.
 */
export function legacyCalendar(item: Record<string, unknown>, uid: string): { provider: string; eventId?: string }[] {
  const entries: unknown[] = [];
  const own = obj(item['calendarSyncByUser'])?.[uid];
  if (own !== undefined) entries.push(own);
  if (isPlainObject(item['calendarSync'])) entries.push(item['calendarSync']);
  return entries.flatMap((raw) => {
    const sync = obj(raw);
    if (sync?.['isLinkedToCalendar'] !== true) return [];
    const provider = str(sync['calendarProvider'])?.trim() || 'unknown';
    const eventId = str(sync['calendarEventId'])?.trim();
    return [{ provider: provider.slice(0, 40), ...(eventId ? { eventId: eventId.slice(0, 1024) } : {}) }];
  });
}
