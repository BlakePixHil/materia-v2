import {
  BoardWipLimitsSchema,
  boardWipStageKey,
  boardWipState,
  boardWipStatusKey,
  compareBoardOrder,
  MATTER_BOARD_REBALANCE_MAX,
  MATTER_BOARD_WIP_LIMITS_MAX,
  parseBoardWipLimit,
  planBoardMove,
  RebalanceBoardInput,
  rebalanceBoardOrders,
  type BoardOrdered,
  withBoardWipLimit,
} from './matter-board';
import { Org } from './schemas/tenancy';
import { ORDER_MIN_GAP, ORDER_STEP } from './tasks';

const card = (id: string, boardOrder?: number, lastActivity?: number): BoardOrdered => ({
  id,
  ...(boardOrder === undefined ? {} : { boardOrder }),
  ...(lastActivity === undefined ? {} : { lastActivity }),
});

describe('board order', () => {
  it('sorts placed cards by order (ties by id), then unplaced cards most recently active first', () => {
    const cards = [card('e', undefined, 5), card('b', 2048), card('a', 2048), card('c', 1024), card('d', undefined, 9)];
    expect([...cards].sort(compareBoardOrder).map((c) => c.id)).toEqual(['c', 'a', 'b', 'd', 'e']);
    expect([card('y'), card('x')].sort(compareBoardOrder).map((c) => c.id)).toEqual(['x', 'y']);
    expect([card('x', NaN), card('y', 1)].sort(compareBoardOrder).map((c) => c.id)).toEqual(['y', 'x']);
  });
});

describe('planBoardMove', () => {
  const column = [card('a', 1024), card('b', 2048), card('c', 3072)];

  it('takes the midpoint of the new neighbours', () => {
    expect(planBoardMove(column, 'x', 1)).toEqual({ kind: 'order', id: 'x', order: 1536 });
    expect(planBoardMove(column, 'c', 0)).toEqual({ kind: 'order', id: 'c', order: 1024 - ORDER_STEP });
  });

  it('steps past the ends, and starts an empty column at one step', () => {
    expect(planBoardMove(column, 'x', 0)).toEqual({ kind: 'order', id: 'x', order: 0 });
    expect(planBoardMove(column, 'x', 99)).toEqual({ kind: 'order', id: 'x', order: 3072 + ORDER_STEP });
    expect(planBoardMove([], 'x', 0)).toEqual({ kind: 'order', id: 'x', order: ORDER_STEP });
    expect(planBoardMove(column, 'x', -3)).toEqual({ kind: 'order', id: 'x', order: 0 });
  });

  it('moves a card within its own column (Alt+Down) without counting itself', () => {
    // a, b, c → b, a, c: a goes between b and c.
    expect(planBoardMove(column, 'a', 1)).toEqual({ kind: 'order', id: 'a', order: 2560 });
  });

  it('rebalances the column when precision runs out, keeping the order on screen', () => {
    const tight = [card('a', 1), card('b', 1 + ORDER_MIN_GAP / 2), card('c', 5)];
    expect(planBoardMove(tight, 'x', 1)).toEqual({ kind: 'rebalance', ids: ['a', 'x', 'b', 'c'] });
  });

  it('rebalances when a neighbour was never placed', () => {
    const mixed = [card('a', 1024), card('n1', undefined, 9), card('n2', undefined, 3)];
    expect(planBoardMove(mixed, 'x', 2)).toEqual({ kind: 'rebalance', ids: ['a', 'n1', 'x', 'n2'] });
    expect(planBoardMove(mixed, 'x', 1)).toEqual({ kind: 'rebalance', ids: ['a', 'x', 'n1', 'n2'] });
  });

  it('survives many midpoint inserts at the same spot, then rebalances', () => {
    let cards = [card('a', 1024), card('b', 2048)];
    let inserts = 0;
    for (; inserts < 200; inserts++) {
      const plan = planBoardMove(cards, `x${inserts}`, 1);
      if (plan.kind === 'rebalance') {
        expect(plan.ids[0]).toBe('a');
        expect(plan.ids[1]).toBe(`x${inserts}`);
        expect(plan.ids.at(-1)).toBe('b');
        const orders = rebalanceBoardOrders(plan.ids);
        expect(orders.map((o) => o.boardOrder)).toEqual(plan.ids.map((_, i) => (i + 1) * ORDER_STEP));
        break;
      }
      cards = [...cards, card(plan.id, plan.order)].sort(compareBoardOrder);
    }
    expect(inserts).toBeGreaterThan(20);
    expect(inserts).toBeLessThan(200);
  });
});

describe('RebalanceBoardInput', () => {
  const requestId = crypto.randomUUID();
  it('takes 1 to 500 distinct matter ids', () => {
    expect(RebalanceBoardInput.safeParse({ requestId, matterIds: ['m1', 'm2'] }).success).toBe(true);
    expect(RebalanceBoardInput.safeParse({ requestId, matterIds: [] }).success).toBe(false);
    expect(RebalanceBoardInput.safeParse({ requestId, matterIds: ['m1', 'm1'] }).success).toBe(false);
    const many = Array.from({ length: MATTER_BOARD_REBALANCE_MAX + 1 }, (_, i) => `m${i}`);
    expect(RebalanceBoardInput.safeParse({ requestId, matterIds: many }).success).toBe(false);
  });
});

describe('WIP limits (CORE-04a)', () => {
  it('keys status columns by status and stage columns by type and stage', () => {
    expect(boardWipStatusKey('on_hold')).toBe('status:on_hold');
    expect(boardWipStageKey('probate', 'grant_application')).toBe('stage:probate:grant_application');
    expect(BoardWipLimitsSchema.safeParse({ 'status:open': 5, 'stage:probate:intake': 3 }).success).toBe(true);
    // Not a column key, not a whole number from 1, or too many.
    expect(BoardWipLimitsSchema.safeParse({ open: 5 }).success).toBe(false);
    expect(BoardWipLimitsSchema.safeParse({ 'status:open': 0 }).success).toBe(false);
    expect(BoardWipLimitsSchema.safeParse({ 'status:open': 2.5 }).success).toBe(false);
    expect(BoardWipLimitsSchema.safeParse({ 'stage:probate:Intake': 2 }).success).toBe(false);
    const many = Object.fromEntries(
      Array.from({ length: MATTER_BOARD_WIP_LIMITS_MAX + 1 }, (_, i) => [`stage:probate:s${i}`, 1]),
    );
    expect(BoardWipLimitsSchema.safeParse(many).success).toBe(false);
  });

  it('is kept in the org’s settings beside Clerk’s and the referral settings', () => {
    const settings = {
      clerk: { enabled: true },
      referrals: { thankYouTask: true },
      board: { wipLimits: { 'status:open': 5 } },
    };
    expect(Org.update.parse({ settings }).settings).toEqual(settings);
    expect(Org.update.safeParse({ settings: { board: { wipLimits: { 'status:open': -1 } } } }).success).toBe(false);
  });

  it('sets and clears one limit, leaving the others', () => {
    expect(withBoardWipLimit(undefined, 'status:open', 5)).toEqual({ 'status:open': 5 });
    const limits = { 'status:open': 5, 'status:lead': 2 };
    expect(withBoardWipLimit(limits, 'status:open', 7)).toEqual({ 'status:open': 7, 'status:lead': 2 });
    expect(withBoardWipLimit(limits, 'status:open', null)).toEqual({ 'status:lead': 2 });
    expect(limits).toEqual({ 'status:open': 5, 'status:lead': 2 });
  });

  it('says where a column stands against its limit', () => {
    expect(boardWipState(9, undefined)).toBe('none');
    expect(boardWipState(4, 5)).toBe('under');
    expect(boardWipState(5, 5)).toBe('full');
    expect(boardWipState(6, 5)).toBe('over');
  });

  it('reads a typed limit: a whole number from 1 to 999', () => {
    expect(parseBoardWipLimit(' 5 ')).toEqual({ limit: 5 });
    expect(parseBoardWipLimit('999')).toEqual({ limit: 999 });
    expect(parseBoardWipLimit('')).toEqual({ error: 'Enter a whole number, like 5.' });
    expect(parseBoardWipLimit('2.5')).toEqual({ error: 'Enter a whole number, like 5.' });
    expect(parseBoardWipLimit('-1')).toEqual({ error: 'Enter a whole number, like 5.' });
    expect(parseBoardWipLimit('0')).toEqual({ error: 'Use 1 or more. To have no limit, remove it instead.' });
    expect(parseBoardWipLimit('1000')).toEqual({ error: 'Use 999 or fewer.' });
  });
});
