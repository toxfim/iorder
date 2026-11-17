import { describe, expect, it } from 'vitest';
import { Prisma } from '../../../generated/prisma/client.js';
import {
  freeOf,
  judgePlan,
  planFifo,
  roomFor,
  samePlan,
  shapeIssues,
  type DemandLine,
  type PlannedHold,
  type SupplyLine,
} from './fifo.js';

const d = (value: string): Prisma.Decimal => new Prisma.Decimal(value);

function line(
  id: string,
  day: number,
  available: string,
  held = '0',
  productId = 'p1',
): SupplyLine {
  return {
    id,
    productId,
    deliveryRef: `ref-${id}`,
    deliveredAt: new Date(Date.UTC(2026, 9, day)),
    availableQuantity: d(available),
    heldQuantity: d(held),
    removed: false,
  };
}
const demand = (quantity: string, productId = 'p1', orderItemId = 'i1'): DemandLine => ({
  orderItemId,
  productId,
  quantity: d(quantity),
});
const hold = (supplyLineId: string, quantity: string, orderItemId = 'i1'): PlannedHold => ({
  orderItemId,
  supplyLineId,
  quantity: d(quantity),
});
const shown = (holds: readonly PlannedHold[]): string[] =>
  holds.map((h) => `${h.orderItemId}:${h.supplyLineId}:${h.quantity.toFixed(0)}`);

describe('whole pieces', () => {
  it('250.5 available, 251 wanted: short by one, not a plan nobody can submit', () => {
    const plan = planFifo([demand('251')], [line('a', 1, '250.5')]);
    expect(plan.holds.map((h) => h.quantity.toFixed(3))).toEqual(['250.000']);
    expect(plan.short.get('i1')?.toFixed(3)).toBe('1.000');
    expect(judgePlan([demand('251')], [line('a', 1, '250.5')], 'FIFO', plan.holds).outcome).toBe(
      'STOCK_INSUFFICIENT',
    );
  });

  it('250.5 available, 250 wanted: enough', () => {
    const plan = planFifo([demand('250')], [line('a', 1, '250.5')]);
    expect(plan.short.size).toBe(0);
    expect(plan.holds[0]?.quantity.toFixed(3)).toBe('250.000');
  });

  it('0.5 + 0.5 is not one piece', () => {
    const lines = [line('a', 1, '0.5'), line('b', 2, '0.5')];
    const plan = planFifo([demand('1')], lines);
    expect(plan.holds).toEqual([]);
    expect(plan.short.get('i1')?.toFixed(3)).toBe('1.000');
  });

  it('a fraction left by a hold does not count either', () => {
    const plan = planFifo([demand('3')], [line('a', 1, '5', '2.5'), line('b', 2, '1')]);
    expect(plan.holds.map((h) => [h.supplyLineId, h.quantity.toFixed(3)])).toEqual([
      ['a', '2.000'],
      ['b', '1.000'],
    ]);
  });

  it('a legacy fractional line takes exact fractions and is accepted', () => {
    const lines = [line('a', 1, '1'), line('b', 2, '0.5')];
    const plan = planFifo([demand('1.5')], lines);
    expect(plan.holds.map((h) => [h.supplyLineId, h.quantity.toFixed(3)])).toEqual([
      ['a', '1.000'],
      ['b', '0.500'],
    ]);
    expect(judgePlan([demand('1.5')], lines, 'FIFO', plan.holds).outcome).toBe('ACCEPTED');
    expect(judgePlan([demand('1.5')], lines, 'MANUAL', plan.holds).outcome).toBe('ACCEPTED');
  });

  it('whole lines plan first, so a legacy line cannot split the room they need', () => {
    const lines = [line('a', 1, '1'), line('b', 2, '0.5')];
    const plan = planFifo([demand('0.5', 'p1', 'legacy'), demand('1', 'p1', 'whole')], lines);
    expect(plan.short.size).toBe(0);
  });

  it('a manual plan may not hold a fraction for a whole line', () => {
    const lines = [line('a', 1, '1.5'), line('b', 2, '1.5')];
    const verdict = judgePlan([demand('2')], lines, 'MANUAL', [hold('a', '1.5'), hold('b', '0.5')]);
    expect(verdict.outcome).toBe('INVALID');
  });

  it('roomFor is what the preview shows', () => {
    expect(roomFor(d('250.5'), d('251')).toFixed(3)).toBe('250.000');
    expect(roomFor(d('1.5'), d('1.5')).toFixed(3)).toBe('1.500');
  });
});

describe('planFifo', () => {
  it('takes the oldest delivery first and spills to the next', () => {
    const plan = planFifo([demand('7')], [line('new', 20, '10'), line('old', 1, '5')]);
    expect(shown(plan.holds)).toEqual(['i1:old:5', 'i1:new:2']);
    expect(plan.short.size).toBe(0);
  });

  it('breaks a delivery date tie by the ref, whatever the input order', () => {
    const a = line('a', 5, '5');
    const b = line('b', 5, '5');
    expect(shown(planFifo([demand('1')], [b, a]).holds)).toEqual(['i1:a:1']);
    expect(shown(planFifo([demand('1')], [a, b]).holds)).toEqual(['i1:a:1']);
  });

  it('counts the holds of other orders, and an overdrawn line has no room', () => {
    const plan = planFifo(
      [demand('3')],
      [line('over', 1, '2', '5'), line('part', 2, '5', '4'), line('rest', 3, '9')],
    );
    expect(shown(plan.holds)).toEqual(['i1:part:1', 'i1:rest:2']);
    expect(freeOf(line('over', 1, '2', '5')).toFixed(0)).toBe('0');
  });

  it('skips a removed line and other products', () => {
    const removed = { ...line('gone', 1, '50'), removed: true };
    const plan = planFifo(
      [demand('2')],
      [removed, line('other', 1, '9', '0', 'p2'), line('ok', 2, '9')],
    );
    expect(shown(plan.holds)).toEqual(['i1:ok:2']);
  });

  it('reports what is short, and zero stock as the whole quantity', () => {
    expect(
      planFifo([demand('7')], [line('a', 1, '5')])
        .short.get('i1')
        ?.toFixed(0),
    ).toBe('2');
    expect(
      planFifo([demand('7')], [])
        .short.get('i1')
        ?.toFixed(0),
    ).toBe('7');
  });

  it('does not count one line twice for two order lines of one product', () => {
    const plan = planFifo([demand('3', 'p1', 'i1'), demand('3', 'p1', 'i2')], [line('a', 1, '4')]);
    expect(shown(plan.holds)).toEqual(['i1:a:3', 'i2:a:1']);
    expect(plan.short.get('i2')?.toFixed(0)).toBe('2');
  });

  it('keeps fixed-point precision (0.1 + 0.2 is exactly 0.3)', () => {
    const plan = planFifo([demand('0.3')], [line('a', 1, '0.1'), line('b', 2, '0.2')]);
    expect(plan.short.size).toBe(0);
    expect(plan.holds.reduce((sum, h) => sum.plus(h.quantity), d('0')).equals(d('0.3'))).toBe(true);
  });
});

describe('samePlan', () => {
  it('ignores the row order and the spelling of a number', () => {
    expect(
      samePlan([hold('a', '2'), hold('b', '1')], [hold('b', '1.000'), hold('a', '2.000')]),
    ).toBe(true);
    expect(samePlan([hold('a', '2')], [hold('a', '3')])).toBe(false);
    expect(samePlan([hold('a', '2')], [hold('a', '2'), hold('b', '1')])).toBe(false);
  });
});

describe('shapeIssues', () => {
  const lines = [line('a', 1, '5'), line('other', 1, '5', '0', 'p2')];
  it('accepts rows that add up', () => {
    expect(shapeIssues([demand('2')], lines, [hold('a', '2')])).toEqual([]);
  });
  it.each([
    ['a line of another product', [hold('other', '2')]],
    ['an unknown line', [hold('nope', '2')]],
    ['an unknown order line', [hold('a', '2'), hold('a', '2', 'nope')]],
    ['a repeated row', [hold('a', '1'), hold('a', '1')]],
    ['too little', [hold('a', '1')]],
    ['too much', [hold('a', '3')]],
    ['nothing', []],
  ])('refuses %s', (_name, requested) => {
    expect(shapeIssues([demand('2')], lines, requested).length).toBeGreaterThan(0);
  });
});

describe('judgePlan', () => {
  const lines = [line('old', 1, '5'), line('new', 2, '5')];

  it('accepts the fresh FIFO', () => {
    expect(judgePlan([demand('2')], lines, 'FIFO', [hold('old', '2')]).outcome).toBe('ACCEPTED');
  });

  it('calls a FIFO plan changed when an older line appeared, even though it still fits', () => {
    const synced = [line('older', 0, '9'), ...lines];
    expect(judgePlan([demand('2')], synced, 'FIFO', [hold('old', '2')]).outcome).toBe(
      'ALLOCATION_CHANGED',
    );
  });

  it('lets a manual plan stand on a newer line', () => {
    expect(judgePlan([demand('2')], lines, 'MANUAL', [hold('new', '2')]).outcome).toBe('ACCEPTED');
  });

  it('refuses a manual plan over the line limit as changed, with the total still enough', () => {
    expect(judgePlan([demand('6')], lines, 'MANUAL', [hold('old', '6')]).outcome).toBe(
      'ALLOCATION_CHANGED',
    );
  });

  it('refuses a manual plan on a removed line as changed', () => {
    const synced = [{ ...line('old', 1, '5'), removed: true }, line('new', 2, '5')];
    expect(judgePlan([demand('2')], synced, 'MANUAL', [hold('old', '2')]).outcome).toBe(
      'ALLOCATION_CHANGED',
    );
  });

  it('calls a malformed manual plan invalid', () => {
    expect(judgePlan([demand('2')], lines, 'MANUAL', [hold('old', '1')]).outcome).toBe('INVALID');
  });

  it('answers short stock first, also to an empty plan and to zero stock', () => {
    for (const mode of ['FIFO', 'MANUAL'] as const) {
      expect(judgePlan([demand('11')], lines, mode, []).outcome).toBe('STOCK_INSUFFICIENT');
      expect(judgePlan([demand('1')], [], mode, []).outcome).toBe('STOCK_INSUFFICIENT');
    }
  });
});
