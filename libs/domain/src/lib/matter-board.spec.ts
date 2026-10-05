import {
  compareBoardOrder,
  MATTER_BOARD_REBALANCE_MAX,
  planBoardMove,
  RebalanceBoardInput,
  rebalanceBoardOrders,
  type BoardOrdered,
} from './matter-board';
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
