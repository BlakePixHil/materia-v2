import { z } from 'zod';

import { DocIdSchema } from './schemas/common';
import type { MatterStatus } from './schemas/enums';
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
