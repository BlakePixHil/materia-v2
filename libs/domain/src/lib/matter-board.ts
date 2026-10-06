import * as z from 'zod';

import { DocIdSchema } from './schemas/common';
import type { MatterStatus, MatterType } from './schemas/enums';
import { ORDER_STEP, orderBetween } from './tasks';

/**
 * The Matters board (CORE-04): columns by status, or by stage when one matter type is filtered,
 * with cards in a stable order. `boardOrder` on the matter is a fractional sort key: a move writes
 * the midpoint of its new neighbours (`orderBetween`, shared with tasks), and when precision runs
 * out, or a neighbour has no order yet, the column is rebalanced by `matters-rebalanceBoard`.
 */

/** The status board's columns, in lifecycle order. Closed shows only recently closed matters. */
export const MATTER_BOARD_STATUSES: readonly MatterStatus[] = ['lead', 'open', 'on_hold', 'closed'];

/** The status board's Closed column shows matters closed within this many days. */
export const MATTER_BOARD_CLOSED_DAYS = 30;

/** Cards a board column shows before "Show more" (each press shows this many more). */
export const MATTER_BOARD_COLUMN_PAGE = 50;

/** A card as the board orders it. */
export interface BoardOrdered {
  id: string;
  boardOrder?: number | null | undefined;
  /** Most recent first among cards with no order yet (milliseconds). */
  lastActivity?: number | undefined;
}

const hasOrder = (card: BoardOrdered): card is BoardOrdered & { boardOrder: number } =>
  typeof card.boardOrder === 'number' && Number.isFinite(card.boardOrder);

/**
 * Board order: cards with a `boardOrder` first, ascending, ties by id (so everyone sees the same
 * order); then cards never placed, most recently active first.
 */
export function compareBoardOrder(a: BoardOrdered, b: BoardOrdered): number {
  const aHas = hasOrder(a);
  const bHas = hasOrder(b);
  if (aHas && bHas) return a.boardOrder - b.boardOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (aHas !== bHas) return aHas ? -1 : 1;
  return (b.lastActivity ?? 0) - (a.lastActivity ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** What a board move writes: one card's new order, or evenly spaced orders for the whole column. */
export type BoardMovePlan = { kind: 'order'; id: string; order: number } | { kind: 'rebalance'; ids: string[] };

/**
 * Plans placing card `id` at `toIndex` of `column` (the target column's cards in display order,
 * with or without the moving card). The card gets the midpoint of its new neighbours; when a
 * neighbour has no order yet, or the gap is too small for a midpoint, the whole column (in its new
 * order) is rebalanced instead, which leaves every card where it shows.
 */
export function planBoardMove(column: readonly BoardOrdered[], id: string, toIndex: number): BoardMovePlan {
  const rest = column.filter((card) => card.id !== id);
  const index = Math.max(0, Math.min(Math.trunc(toIndex), rest.length));
  const before = rest[index - 1];
  const after = rest[index];
  const finalIds = [...rest.slice(0, index).map((card) => card.id), id, ...rest.slice(index).map((card) => card.id)];
  if ((before && !hasOrder(before)) || (after && !hasOrder(after))) return { kind: 'rebalance', ids: finalIds };
  const order = orderBetween(before?.boardOrder, after?.boardOrder);
  return order === null ? { kind: 'rebalance', ids: finalIds } : { kind: 'order', id, order };
}

/** The orders a rebalance writes: `ORDER_STEP` apart, in the given order. */
export function rebalanceBoardOrders(ids: readonly string[]): { id: string; boardOrder: number }[] {
  return ids.map((id, i) => ({ id, boardOrder: (i + 1) * ORDER_STEP }));
}

/** At most this many matters in one rebalance (a Firestore batch takes 500 writes). */
export const MATTER_BOARD_REBALANCE_MAX = 500;

/**
 * `matters-rebalanceBoard` (matter.edit): evenly spaced `boardOrder`s for a board column's matters,
 * in the order given. Matters the caller can't see are skipped.
 */
export const RebalanceBoardInput = z.object({
  requestId: z.uuid(),
  matterIds: z
    .array(DocIdSchema)
    .min(1)
    .max(MATTER_BOARD_REBALANCE_MAX)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'Each matter once' }),
});
export type RebalanceBoardInput = z.infer<typeof RebalanceBoardInput>;

export interface RebalanceBoardResult {
  /** How many matters got a new order. */
  updated: number;
  /** Ids skipped: missing, deleted, or privileged for a role that can't see them. */
  skipped: string[];
}

/**
 * WIP limits (CORE-04a): owners and admins cap how many matters a board column should hold. The
 * board still takes a card past the limit, but counts it against the limit in a warning tone and
 * warns once. Kept on the org (`settings.board.wipLimits`), keyed by `boardWipKey`.
 */
export const MATTER_BOARD_WIP_LIMIT_MAX = 999;

/** At most this many limits per org (every status and every stage of every type fits). */
export const MATTER_BOARD_WIP_LIMITS_MAX = 200;

/** `status:{status}` for a status column; `stage:{type}:{stageId}` for a stage (stage ids repeat across types). */
export const BoardWipKeySchema = z
  .string()
  .max(140)
  .regex(/^(status:[a-z_]+|stage:[a-z_]+:[a-z][a-z0-9_]*)$/);

export const BoardWipLimitSchema = z.number().int().min(1).max(MATTER_BOARD_WIP_LIMIT_MAX);

export const BoardWipLimitsSchema = z
  .record(BoardWipKeySchema, BoardWipLimitSchema)
  .refine((limits) => Object.keys(limits).length <= MATTER_BOARD_WIP_LIMITS_MAX, {
    message: `At most ${MATTER_BOARD_WIP_LIMITS_MAX} limits`,
  });
export type BoardWipLimits = z.infer<typeof BoardWipLimitsSchema>;

/** A status column's key. */
export function boardWipStatusKey(status: MatterStatus): string {
  return `status:${status}`;
}

/** A stage column's key: the matter type and the stage. */
export function boardWipStageKey(type: MatterType, stageId: string): string {
  return `stage:${type}:${stageId}`;
}

/** The limits with one set (a whole number from 1) or, `null`, cleared. */
export function withBoardWipLimit(
  limits: Readonly<BoardWipLimits> | undefined,
  key: string,
  limit: number | null,
): BoardWipLimits {
  const rest = Object.fromEntries(Object.entries(limits ?? {}).filter(([k]) => k !== key));
  return limit === null ? rest : { ...rest, [key]: limit };
}

/** Where a column stands against its limit: none set, under it, at it (full), or over it. */
export type BoardWipState = 'none' | 'under' | 'full' | 'over';

export function boardWipState(count: number, limit: number | undefined): BoardWipState {
  if (!limit) return 'none';
  return count > limit ? 'over' : count === limit ? 'full' : 'under';
}

/** A limit typed into the column menu: a whole number from 1, or an error to show. */
export function parseBoardWipLimit(text: string): { limit: number } | { error: string } {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return { error: 'Enter a whole number, like 5.' };
  const limit = Number(trimmed);
  if (limit < 1) return { error: 'Use 1 or more. To have no limit, remove it instead.' };
  if (limit > MATTER_BOARD_WIP_LIMIT_MAX) return { error: `Use ${MATTER_BOARD_WIP_LIMIT_MAX} or fewer.` };
  return { limit };
}
