import { domain } from '../domain.ts';
import { legacyCalendar } from './checklists.ts';
import { richText } from './comments.ts';
import { fit, migratedMeta, type TransformContext, type TransformedRecord } from './context.ts';
import { personalTaskPath, UNTITLED_TASK } from './dashboard.ts';
import { createdAndUpdated, dueDate, instantOr } from './dates.ts';
import { escapeText } from './html.ts';
import { cleanText, priorityOf } from './values.ts';
import type { WorkflowPlan } from './workflow.ts';
import { byCodeUnit } from '../export/jsonl.ts';
import type { ExportRecord } from '../export/jsonl.ts';
import { arr, obj, str } from '../legacy/snapshot.ts';

const { TASK_CHECKLIST_MAX, TASK_GROUP_MAX, TASK_TITLE_MAX, dateOnlyAt } = domain;

/**
 * Cards on a `personal_tasks` board (Business development, Non-billable) → the user's personal
 * tasks, grouped by their column (Blake, 2026-10-04). The description and comments become the
 * task's description, the checklists its checklist (up to 100 items). A card in the board's done
 * column, or archived, is done. A personal task has no matter, so the card's attachments and any
 * images its description embedded don't migrate (`MIG_W_ATTACHMENT_NOT_MIGRATED`); its labels,
 * fee and history are dropped.
 */

const ORDER_STEP = 1000;
const CHECKLIST_TEXT_MAX = 500;

export function mapPersonalCards(
  ctx: TransformContext,
  plan: WorkflowPlan,
  cards: readonly ExportRecord[],
  attachments: ReadonlyMap<string, readonly ExportRecord[]>,
  subjectName: string,
): TransformedRecord[] {
  const laneIndex = new Map([...plan.lanes.keys()].map((id, index) => [id, index]));
  const position = (card: ExportRecord) => {
    const lane = laneIndex.get(str(card.data?.['swimlaneId']) ?? '') ?? plan.lanes.size;
    const order = card.data?.['order'];
    return [lane, typeof order === 'number' && Number.isFinite(order) ? order : Number.MAX_SAFE_INTEGER] as const;
  };
  const sorted = cards
    .filter((card) => card.data)
    .sort((a, b) => {
      const [laneA, orderA] = position(a);
      const [laneB, orderB] = position(b);
      return laneA - laneB || orderA - orderB || byCodeUnit(a.path, b.path);
    });
  return sorted.map((card, index) => {
    for (const attachment of attachments.get(card.path) ?? []) {
      ctx.warnings.add('MIG_W_ATTACHMENT_NOT_MIGRATED', attachment.path);
    }
    return personalTask(ctx, plan, card, (index + 1) * ORDER_STEP, subjectName);
  });
}

function personalTask(
  ctx: TransformContext,
  plan: WorkflowPlan,
  card: ExportRecord,
  order: number,
  subjectName: string,
): TransformedRecord {
  const data = card.data ?? {};
  const path = card.path;
  let title = cleanText(data['title']);
  if (!title) {
    ctx.warnings.add('MIG_W_UNTITLED', path);
    title = UNTITLED_TASK;
  }
  const lane = plan.lanes.get(str(data['swimlaneId']) ?? '');
  if (!lane) ctx.warnings.add('MIG_W_SWIMLANE_UNKNOWN', path);
  const { createdAt, updatedAt } = createdAndUpdated(ctx, data, path);
  const done = data['archived'] === true || lane?.done === true;
  const due = dueDate(ctx, data['dueDate'], path);
  const descriptionMd = description(ctx, data, path, subjectName);
  const group = lane?.title ? fit(ctx, lane.title, TASK_GROUP_MAX, path) : '';
  return {
    entity: 'personal-tasks',
    path: personalTaskPath(ctx, path),
    legacyPath: path,
    data: {
      orgId: ctx.orgId,
      matterId: null,
      title: fit(ctx, title, TASK_TITLE_MAX, path),
      ...(descriptionMd ? { descriptionMd } : {}),
      status: done ? 'done' : 'todo',
      priority: priorityOf(ctx, data['priority'], path),
      assigneeUid: ctx.uid,
      ...(due ? { dueDate: due } : {}),
      ...(group ? { group } : {}),
      checklist: checklist(ctx, data['checklists'], path),
      order,
      source: 'migration',
      ...(done ? { completedAt: updatedAt } : {}),
      search: [],
      ...migratedMeta(ctx, { legacyPath: path, createdAt, updatedAt, by: ctx.uid }),
    },
  };
}

/** The card's description, then its comments, each headed by its author and day. */
function description(ctx: TransformContext, data: Record<string, unknown>, path: string, subjectName: string): string {
  const parts: string[] = [];
  let dropped = false;
  const { markdown } = richText(ctx, data['description'], path, () => {
    dropped = true;
    return '[Image not migrated]';
  });
  if (markdown) parts.push(markdown);
  const comments: string[] = [];
  arr(data['comments']).forEach((raw, index) => {
    const comment = obj(raw);
    if (!comment) return;
    const legacyPath = `${path}#comment/${str(comment['id']) || index}`;
    const text = richText(ctx, comment['comment'], legacyPath, () => {
      dropped = true;
      return '[Image not migrated]';
    }).markdown;
    if (!text) return;
    const author = str(comment['uid']) ?? '';
    const name = author === ctx.uid ? subjectName : ctx.people.get(author) || 'A former colleague';
    const day = dateOnlyAt(instantOr(ctx, comment['date'], legacyPath), ctx.timeZone);
    comments.push(`**${escapeText(name)}, ${day}**\n\n${text}`);
  });
  if (dropped) ctx.warnings.add('MIG_W_ATTACHMENT_NOT_MIGRATED', path);
  if (comments.length) parts.push(`**Comments (imported)**\n\n${comments.join('\n\n')}`);
  return parts.join('\n\n');
}

/** Every checklist's items in order (named by their checklist when there are several), up to 100. */
function checklist(ctx: TransformContext, checklists: unknown, path: string) {
  const lists = arr(checklists).flatMap((raw) => (obj(raw) ? [obj(raw) as Record<string, unknown>] : []));
  const items: { id: string; text: string; done: boolean }[] = [];
  const ids = new Set<string>();
  let calendar = false;
  lists.forEach((list, listIndex) => {
    const heading = lists.length > 1 ? cleanText(list['title']) : '';
    arr(list['items']).forEach((raw, itemIndex) => {
      const item = obj(raw);
      const name = cleanText(item?.['name']);
      if (!item || !name) return;
      if (legacyCalendar(item, ctx.uid).length) calendar = true;
      let id = str(item['id']) || `${listIndex}-${itemIndex}`;
      if (ids.has(id)) id = `${id}-${listIndex}-${itemIndex}`;
      ids.add(id);
      const text = heading ? `${heading}: ${name}` : name;
      items.push({ id, text: fit(ctx, text, CHECKLIST_TEXT_MAX, path), done: item['checked'] === true });
    });
  });
  if (calendar) ctx.warnings.add('MIG_W_CALENDAR_EVENTS_EXIST', path);
  if (items.length > TASK_CHECKLIST_MAX) ctx.warnings.add('MIG_W_CHECKLIST_TRUNCATED', path);
  return items.slice(0, TASK_CHECKLIST_MAX);
}
