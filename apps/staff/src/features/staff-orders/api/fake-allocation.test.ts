import { describe, expect, it } from 'vitest';
import { ApiConflictError, ApiValidationError } from '@core/lib/api-errors';
import {
  createFakeAllocation,
  type AllocatableOrder,
  type FakeSupplyLine,
} from './fake-allocation';

const line = (id: string, day: number, available: bigint): FakeSupplyLine => ({
  id,
  productId: 'p1',
  deliveryRef: `REF-${id}`,
  deliveredAt: `2026-10-0${day}T00:00:00.000Z`,
  available,
  removed: false,
});
const order = (id: string, quantity: string): AllocatableOrder => ({
  id,
  status: 'SUBMITTED',
  rowVersion: 1,
  items: [{ id: `${id}-i`, productId: 'p1', productCode: 'P-1', name: 'Olma', quantity }],
});
const make = () => createFakeAllocation(() => [line('new', 2, 5000n), line('old', 1, 2000n)]);
const reasonOf = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (caught) {
    return caught instanceof ApiConflictError ? caught.reason : 'OTHER';
  }
  return undefined;
};

describe('the fake holds follow the api rules', () => {
  it('proposes the oldest first and names the shortage', () => {
    const a = make();
    expect(
      a.preview(order('o1', '3')).items[0]?.fifo.map((r) => [r.deliveryRef, r.quantity]),
    ).toEqual([
      ['REF-old', '2.000'],
      ['REF-new', '1.000'],
    ]);
    const short = a.preview(order('o2', '9'));
    expect(short.feasible).toBe(false);
    expect(short.items[0]?.shortQuantity).toBe('2.000');
  });

  it('a FIFO plan that is not the fresh FIFO is ALLOCATION_CHANGED; zero room is STOCK_INSUFFICIENT', () => {
    const a = make();
    const o = order('o1', '1');
    const row = { orderItemId: 'o1-i', supplyLineId: 'new', quantity: '1' };
    expect(reasonOf(() => a.judge(o, 'FIFO', [row]))).toBe('ALLOCATION_CHANGED');
    expect(reasonOf(() => a.judge(order('o2', '9'), 'FIFO', []))).toBe('STOCK_INSUFFICIENT');
    expect(a.judge(o, 'MANUAL', [row])).toHaveLength(1);
  });

  it('a manual plan over a line is refused, one that does not add up is invalid', () => {
    const a = make();
    const o = order('o1', '3');
    expect(
      reasonOf(() =>
        a.judge(o, 'MANUAL', [{ orderItemId: 'o1-i', supplyLineId: 'old', quantity: '3' }]),
      ),
    ).toBe('ALLOCATION_CHANGED');
    expect(() =>
      a.judge(o, 'MANUAL', [{ orderItemId: 'o1-i', supplyLineId: 'old', quantity: '1' }]),
    ).toThrow(ApiValidationError);
  });

  it('holds count against other orders, end with the order, and flag a shrunken line', () => {
    const a = make();
    const first = order('o1', '2');
    a.store(
      'o1',
      a.judge(first, 'FIFO', [{ orderItemId: 'o1-i', supplyLineId: 'old', quantity: '2' }]),
    );
    expect(a.preview(order('o2', '1')).items[0]?.fifo[0]?.deliveryRef).toBe('REF-new');

    a.setAvailable('p1', 'REF-old', '1');
    const approved = { ...first, status: 'MANAGER_APPROVED' as const };
    const view = a.preview(approved);
    expect(view.attention).toBe(true);
    expect(view.items[0]?.current[0]?.attention).toBe('LINE_SHORT');

    a.end('o1');
    expect(a.preview(approved).items[0]?.current).toEqual([]);
    expect(a.preview(order('o2', '1')).items[0]?.fifo[0]?.deliveryRef).toBe('REF-old');
  });

  it('an approved order never allocated reads as not allocated', () => {
    expect(make().preview({ ...order('o1', '1'), status: 'ACCOUNTING_CLEARED' }).notAllocated).toBe(
      true,
    );
  });
});

describe('a product outside the plan (no sheet product code)', () => {
  const mixed = (): AllocatableOrder => ({
    ...order('o1', '3'),
    items: [
      { id: 'o1-i', productId: 'p1', productCode: 'P-1', name: 'Olma', quantity: '3' },
      {
        id: 'o1-u',
        productId: 'p-manual',
        productCode: 'IO-000001',
        name: "Qo'lda",
        quantity: '5',
        stockTracked: false,
      },
    ],
  });

  it('is never short, has no lines and takes no rows, so the order stays feasible', () => {
    const a = make();
    const view = a.preview(mixed());
    expect(view.feasible).toBe(true);
    const line = view.items.find((i) => i.orderItemId === 'o1-u');
    expect(line).toMatchObject({
      stockTracked: false,
      shortQuantity: '0.000',
      lines: [],
      fifo: [],
    });
    const rows = view.items.flatMap((i) =>
      i.fifo.map((r) => ({
        orderItemId: i.orderItemId,
        supplyLineId: r.supplyLineId,
        quantity: r.quantity,
      })),
    );
    expect(rows.every((r) => r.orderItemId === 'o1-i')).toBe(true);
    expect(a.judge(mixed(), 'FIFO', rows)).toHaveLength(2);
    expect(a.judge(mixed(), 'MANUAL', rows)).toHaveLength(2);
    expect(a.allocationsOf('o1', { id: 'o1-u', productId: 'p-manual' })).toEqual([]);
  });
});
