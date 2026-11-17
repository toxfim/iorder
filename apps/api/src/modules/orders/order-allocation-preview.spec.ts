import { describe, expect, it } from 'vitest';
import { Prisma } from '../../generated/prisma/client.js';
import { judgePlan, type SupplyLine } from '../pricing/index.js';
import { buildAllocationPreview, demandOf, trackedProductIds } from './order-allocation-preview.js';
import type { OrderItemRecord } from './orders.repository.js';

const dec = (value: string): Prisma.Decimal => new Prisma.Decimal(value);

function item(
  id: string,
  productId: string,
  quantity: string,
  stockTracked: boolean,
): OrderItemRecord {
  return {
    id,
    productId,
    productCodeSnapshot: stockTracked ? 'KB-15' : 'IO-000001',
    nameSnapshot: 'x',
    unitSnapshot: 'PIECE',
    quantity: dec(quantity),
    unitPrice: dec('1'),
    lineTotal: dec(quantity),
    fullUnitPrice: dec('1'),
    deferredUnitPrice: null,
    fullUnitPriceUsd: null,
    deferredUnitPriceUsd: null,
    stockTracked,
  };
}

const line: SupplyLine = {
  id: 'line-1',
  productId: 'p-sheet',
  deliveryRef: 'REF-1',
  deliveredAt: new Date('2026-09-01T00:00:00Z'),
  availableQuantity: dec('10'),
  heldQuantity: dec('0'),
  removed: false,
};

// A staff-added product without a sheet code is outside the plan [C, 2026-11-09].
describe('demandOf with products outside the plan', () => {
  const items = [item('i-sheet', 'p-sheet', '2', true), item('i-manual', 'p-manual', '3', false)];

  it('asks nothing for an untracked line and reads no stock for its product', () => {
    expect(demandOf(items)).toEqual([
      { orderItemId: 'i-sheet', productId: 'p-sheet', quantity: dec('2') },
    ]);
    expect(trackedProductIds(items)).toEqual(['p-sheet']);
  });

  it('an order of only untracked lines is a plan of nothing: accepted with no holds, never short', () => {
    const demand = demandOf([item('i-manual', 'p-manual', '3', false)]);
    expect(demand).toEqual([]);
    expect(judgePlan(demand, [], 'FIFO', [])).toEqual({ outcome: 'ACCEPTED', holds: [] });
    expect(judgePlan(demand, [], 'MANUAL', [])).toEqual({ outcome: 'ACCEPTED', holds: [] });
  });

  it('a mixed order is judged on its tracked lines only', () => {
    const demand = demandOf(items);
    const fifo = [{ orderItemId: 'i-sheet', supplyLineId: 'line-1', quantity: dec('2') }];
    expect(judgePlan(demand, [line], 'FIFO', fifo)).toEqual({ outcome: 'ACCEPTED', holds: fifo });
    // No stock for the sheet product: still short, the manual line does not hide it.
    expect(judgePlan(demand, [], 'FIFO', [])).toEqual({ outcome: 'STOCK_INSUFFICIENT' });
  });
});

describe('buildAllocationPreview with products outside the plan', () => {
  it('shows the untracked line with empty plan fields and stockTracked false', () => {
    const preview = buildAllocationPreview(
      {
        id: 'o-1',
        status: 'SUBMITTED',
        rowVersion: 1,
        items: [item('i-sheet', 'p-sheet', '2', true), item('i-manual', 'p-manual', '3', false)],
      },
      { lines: [line], own: [], everAllocated: false, lastSheetChangeAt: null },
      new Map([['p-manual', { orders: 9, quantity: dec('9') }]]),
    );
    expect(preview.feasible).toBe(true);
    const manual = preview.items.find((i) => i.orderItemId === 'i-manual');
    expect(manual).toEqual({
      orderItemId: 'i-manual',
      productId: 'p-manual',
      productCode: 'IO-000001',
      name: 'x',
      quantity: '3.000',
      stockTracked: false,
      lines: [],
      fifo: [],
      shortQuantity: '0.000',
      earlierDemand: { orders: 0, quantity: '0.000' },
      current: [],
    });
    const sheet = preview.items.find((i) => i.orderItemId === 'i-sheet');
    expect(sheet).toMatchObject({
      stockTracked: true,
      fifo: [{ supplyLineId: 'line-1', quantity: '2.000' }],
    });
  });
});
