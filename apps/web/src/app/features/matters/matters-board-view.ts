import type { MatterListFilters } from '@materia/data-access/repository';
import {
  compareBoardOrder,
  MATTER_BOARD_CLOSED_DAYS,
  MATTER_BOARD_STATUSES,
  MATTER_STATUS_LABELS,
  matterStages,
  systemTemplate,
  type MatterStatus,
  type MatterType,
} from '@materia/domain';
import type { MtStatusKind } from '@materia/ui';

import type { MatterRow } from './matters-view';

/**
 * The Matters board (CORE-04) as data: which columns it has, which column each matter is in, and
 * the cards in each column in board order. The board component draws it and moves cards.
 */

/** A board by status (mixed types) or by the stages of the one matter type filtered. */
export type BoardKind = 'status' | 'stage';

export interface BoardColumn {
  /** `status:open`, `stage:notice` or `stage:` + OTHER_STAGE. */
  id: string;
  title: string;
  kind: BoardKind;
  status?: MatterStatus;
  stageId?: string;
  /** What the column means, for its tooltip (a stage's completion criteria). */
  description?: string;
  /** Cards can be moved here (not "Other stages"). */
  droppable: boolean;
}

/** The column for matters whose stage isn't one of the type's stages (an older org template). */
export const OTHER_STAGE = '__other';

/** The status glyph a matter shows on its card. */
export const STATUS_KIND: Readonly<Record<MatterStatus, MtStatusKind>> = {
  lead: 'draft',
  open: 'active',
  on_hold: 'blocked',
  closed: 'done',
  archived: 'done',
};

/** The board's kind for the view's filters: by stage when exactly one type is filtered. */
export function boardKind(filters: Pick<MatterListFilters, 'type'>): BoardKind {
  return filters.type?.length === 1 ? 'stage' : 'status';
}

/**
 * The columns: Lead, Open, On hold and Closed (in the last 30 days) for a status board; the matter
 * type's stages for a stage board (its system template's when templates are on, else the type's
 * defaults), plus "Other stages" when a matter is on a stage the type doesn't have.
 */
export function boardColumns(type: MatterType | null, templatesOn: boolean): BoardColumn[] {
  if (!type) {
    return MATTER_BOARD_STATUSES.map((status) => ({
      id: `status:${status}`,
      title: MATTER_STATUS_LABELS[status],
      kind: 'status',
      status,
      droppable: true,
      ...(status === 'closed' ? { description: `Closed in the last ${MATTER_BOARD_CLOSED_DAYS} days` } : {}),
    }));
  }
  const template = templatesOn ? systemTemplate(`system-${type}`) : undefined;
  return [
    ...matterStages(type, template?.stages).map((stage): BoardColumn => ({
      id: `stage:${stage.id}`,
      title: stage.title,
      kind: 'stage',
      stageId: stage.id,
      droppable: true,
      ...(stage.criteria ? { description: stage.criteria } : {}),
    })),
    {
      id: `stage:${OTHER_STAGE}`,
      title: 'Other stages',
      kind: 'stage',
      droppable: false,
      description: 'Matters on a stage this type’s template doesn’t have. Move them from the matter.',
    },
  ];
}

/**
 * The filters the board reads with. A status board shows every board status as a column, so the
 * view's status filter (and "closed within") gives way to its own; a stage board keeps the view's
 * statuses, or shows live work (lead, open, on hold) when the view has none.
 */
export function boardFilters(filters: MatterListFilters, kind: BoardKind): MatterListFilters {
  if (kind === 'status') {
    const rest: MatterListFilters = { ...filters, status: [...MATTER_BOARD_STATUSES] };
    delete rest.closedWithinDays;
    return rest;
  }
  return filters.status?.length ? filters : { ...filters, status: ['lead', 'open', 'on_hold'] };
}

/** Whether a matter the board read belongs on it: closed matters only for the last 30 days. */
export function onBoard(row: MatterRow, kind: BoardKind, now: Date): boolean {
  if (kind !== 'status' || row.status !== 'closed') return true;
  const since = now.getTime() - MATTER_BOARD_CLOSED_DAYS * 86_400_000;
  return !!row.closedAt && row.closedAt.getTime() >= since;
}

/** The column a matter is in: its status, or its stage (the first stage when it has none yet). */
export function columnOf(row: Pick<MatterRow, 'status' | 'stageId'>, columns: readonly BoardColumn[]): string {
  const first = columns[0];
  if (first?.kind === 'status') return `status:${row.status}`;
  if (!row.stageId) return first?.id ?? `stage:${OTHER_STAGE}`;
  const id = `stage:${row.stageId}`;
  return columns.some((column) => column.id === id) ? id : `stage:${OTHER_STAGE}`;
}

/** A card where the board shows it: its column and order, after any move still being saved. */
export interface BoardCard {
  row: MatterRow;
  column: string;
  boardOrder: number | undefined;
}

/** A move the board shows before the server confirms it. */
export interface PendingPlacement {
  column?: string;
  boardOrder?: number;
}

export function placeCards(
  rows: readonly MatterRow[],
  columns: readonly BoardColumn[],
  pending: ReadonlyMap<string, PendingPlacement>,
): BoardCard[] {
  return rows.map((row) => {
    const moved = pending.get(row.id);
    return {
      row,
      column: moved?.column ?? columnOf(row, columns),
      boardOrder: moved?.boardOrder ?? row.boardOrder,
    };
  });
}

/** Board order for cards (see `compareBoardOrder`). */
export function sortCards(cards: readonly BoardCard[]): BoardCard[] {
  return [...cards].sort((a, b) =>
    compareBoardOrder(
      { id: a.row.id, boardOrder: a.boardOrder, lastActivity: a.row.lastActivityAt?.getTime() },
      { id: b.row.id, boardOrder: b.boardOrder, lastActivity: b.row.lastActivityAt?.getTime() },
    ),
  );
}

export interface BoardCell {
  column: BoardColumn;
  cards: BoardCard[];
}

/** A swimlane: one responsible person's matters across the columns (or the whole board). */
export interface BoardLane {
  key: string;
  label: string;
  cells: BoardCell[];
  count: number;
}

/**
 * The board's lanes: one lane holding every card, or (swimlanes on) one per responsible person,
 * ordered by name. "Other stages" shows only when a card is in it.
 */
export function buildLanes(
  cards: readonly BoardCard[],
  columns: readonly BoardColumn[],
  lanes: ((row: MatterRow) => { key: string; label: string }) | null,
): BoardLane[] {
  const shown = columns.filter((column) => column.droppable || cards.some((card) => card.column === column.id));
  const lane = (key: string, label: string, laneCards: readonly BoardCard[]): BoardLane => ({
    key,
    label,
    count: laneCards.length,
    cells: shown.map((column) => ({
      column,
      cards: sortCards(laneCards.filter((card) => card.column === column.id)),
    })),
  });
  if (!lanes) return [lane('all', 'All matters', cards)];
  const groups = new Map<string, { label: string; cards: BoardCard[] }>();
  for (const card of cards) {
    const { key, label } = lanes(card.row);
    const group = groups.get(key) ?? { label, cards: [] };
    group.cards.push(card);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort(([, a], [, b]) => a.label.localeCompare(b.label))
    .map(([key, group]) => lane(key, group.label, group.cards));
}

/**
 * Where a card dropped at `laneIndex` of a lane's cell lands in the whole column (the order is
 * shared by every lane): straight after the lane card before it, else straight before the lane
 * card after it, else at the end of the column.
 */
export function columnIndex(
  column: readonly BoardCard[],
  laneCards: readonly BoardCard[],
  movingId: string,
  laneIndex: number,
): number {
  const rest = column.filter((card) => card.row.id !== movingId);
  const lane = laneCards.filter((card) => card.row.id !== movingId);
  const before = lane[laneIndex - 1];
  if (before) return rest.findIndex((card) => card.row.id === before.row.id) + 1;
  const after = lane[laneIndex];
  if (after)
    return Math.max(
      0,
      rest.findIndex((card) => card.row.id === after.row.id),
    );
  return rest.length;
}

/** A card's place in the server's data, to spot someone else moving it. */
export interface CardSpot {
  column: string;
  before: string | null;
  after: string | null;
  boardOrder: number | undefined;
}

/** Every card's column and neighbours, as the server has them. */
export function cardSpots(rows: readonly MatterRow[], columns: readonly BoardColumn[]): Map<string, CardSpot> {
  const cards = sortCards(placeCards(rows, columns, new Map()));
  const spots = new Map<string, CardSpot>();
  const byColumn = new Map<string, BoardCard[]>();
  for (const card of cards) byColumn.set(card.column, [...(byColumn.get(card.column) ?? []), card]);
  for (const [column, list] of byColumn) {
    list.forEach((card, i) =>
      spots.set(card.row.id, {
        column,
        before: list[i - 1]?.row.id ?? null,
        after: list[i + 1]?.row.id ?? null,
        boardOrder: card.boardOrder,
      }),
    );
  }
  return spots;
}

/**
 * Cards someone else moved between two snapshots: a new column, or a new order that changed its
 * neighbours (a rebalance keeps neighbours, so it doesn't count).
 */
export function movedCards(previous: ReadonlyMap<string, CardSpot>, next: ReadonlyMap<string, CardSpot>): string[] {
  const moved: string[] = [];
  for (const [id, spot] of next) {
    const was = previous.get(id);
    if (!was) continue;
    if (was.column !== spot.column) moved.push(id);
    else if (was.boardOrder !== spot.boardOrder && (was.before !== spot.before || was.after !== spot.after)) {
      moved.push(id);
    }
  }
  return moved;
}

/** "Moved M-2026-0001 to Open, 2 of 5." for screen readers. */
export function moveAnnouncement(number: string, column: string, position: number, total: number): string {
  return `Moved ${number} to ${column}, ${position} of ${total}.`;
}
