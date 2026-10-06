import { domain } from '../domain.ts';
import { fit, migratedMeta, migId, type TransformContext, type TransformedRecord } from './context.ts';
import { createdAndUpdated, dueDate, optionalInstant } from './dates.ts';
import { cleanText, priorityOf } from './values.ts';
import { byCodeUnit } from '../export/jsonl.ts';
import type { ExportRecord } from '../export/jsonl.ts';

const { TASK_TITLE_MAX } = domain;

/**
 * `profiles/{U}/dashboard-checklist-items/*` → the user's personal tasks
 * (`orgs/{O}/members/{U}/tasks`, CORE-08): `name` → title, `checked` → done with `doneOnDate` as
 * `completedAt`, the due date as the Melbourne day, priority 0 none, 1 high, 2 medium, 3 low. They
 * keep the dashboard's order.
 */

export const UNTITLED_TASK = 'Untitled task (imported)';
const ORDER_STEP = 1000;

export function personalTaskPath(ctx: TransformContext, legacyPath: string): string {
  return `orgs/${ctx.orgId}/members/${ctx.uid}/tasks/${migId(legacyPath)}`;
}

export function mapDashboardItems(ctx: TransformContext, items: readonly ExportRecord[]): TransformedRecord[] {
  const order = (record: ExportRecord) => {
    const value = record.data?.['order'];
    return typeof value === 'number' && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
  };
  const sorted = items.filter((item) => item.data).sort((a, b) => order(a) - order(b) || byCodeUnit(a.path, b.path));
  return sorted.map((item, index) => {
    const data = item.data ?? {};
    const path = item.path;
    let title = cleanText(data['name']);
    if (!title) {
      ctx.warnings.add('MIG_W_UNTITLED', path);
      title = UNTITLED_TASK;
    }
    const done = data['checked'] === true;
    const due = dueDate(ctx, data['dueDate'], path);
    const { createdAt, updatedAt } = createdAndUpdated(ctx, data, path);
    // Done without a `doneOnDate`: its last update, so the task trigger doesn't stamp the load time.
    const completedAt = done ? (optionalInstant(ctx, data['doneOnDate'], path) ?? updatedAt) : undefined;
    return {
      entity: 'personal-tasks',
      path: personalTaskPath(ctx, path),
      legacyPath: path,
      data: {
        orgId: ctx.orgId,
        matterId: null,
        title: fit(ctx, title, TASK_TITLE_MAX, path),
        status: done ? 'done' : 'todo',
        priority: priorityOf(ctx, data['priority'], path),
        assigneeUid: ctx.uid,
        ...(due ? { dueDate: due } : {}),
        checklist: [],
        order: (index + 1) * ORDER_STEP,
        source: 'migration',
        ...(completedAt ? { completedAt } : {}),
        search: [],
        ...migratedMeta(ctx, { legacyPath: path, createdAt, updatedAt, by: ctx.uid }),
      },
    } satisfies TransformedRecord;
  });
}
