import type { AllocationPreview } from '@iorder/shared/staff-orders';
import { describe, expect, it } from 'vitest';
import {
  checkItem,
  currentDraft,
  draftIsValid,
  draftRows,
  fifoChoice,
  fifoDraft,
  modeOf,
  previewOfConflict,
} from './allocation-plan';

const ID = (n: number): string => `00000000-0000-4000-8000-00000000000${n}`;

const preview: AllocationPreview = {
  orderId: ID(1),
  status: 'SUBMITTED',
  rowVersion: 1,
  feasible: true,
  attention: false,
  notAllocated: false,
  lastSheetChangeAt: null,
  items: [
    {
      orderItemId: ID(2),
      productId: ID(3),
      productCode: 'P-1',
      name: 'Olma',
      quantity: '3.000',
      stockTracked: true,
      lines: [
        {
          supplyLineId: ID(4),
          deliveryRef: 'OLD',
          deliveredAt: '2026-10-01T00:00:00.000Z',
          availableQuantity: '2.000',
          heldQuantity: '0.000',
          freeQuantity: '2.000',
        },
        {
          supplyLineId: ID(5),
          deliveryRef: 'NEW',
          deliveredAt: '2026-10-02T00:00:00.000Z',
          availableQuantity: '9.000',
          heldQuantity: '1.000',
          freeQuantity: '8.000',
        },
      ],
      fifo: [
        { supplyLineId: ID(4), deliveryRef: 'OLD', quantity: '2.000' },
        { supplyLineId: ID(5), deliveryRef: 'NEW', quantity: '1.000' },
      ],
      shortQuantity: '0.000',
      earlierDemand: { orders: 0, quantity: '0.000' },
      current: [{ supplyLineId: ID(5), deliveryRef: 'NEW', quantity: '3.000', attention: null }],
    },
  ],
};
const item = preview.items[0];
if (item === undefined) throw new Error('no item');
const draftOf = (old: string, fresh: string) => ({ [ID(2)]: { [ID(4)]: old, [ID(5)]: fresh } });

describe('allocation plan draft', () => {
  it('starts from the proposal and from the current holds', () => {
    expect(fifoDraft(preview)).toEqual(draftOf('2', '1'));
    expect(currentDraft(preview)).toEqual({ [ID(2)]: { [ID(5)]: '3' } });
  });

  it.each([
    ['2', '1', 'OK'],
    ['0', '3', 'OK'],
    ['', '3', 'OK'],
    ['1', '1', 'TOO_LITTLE'],
    ['2', '2', 'TOO_MUCH'],
    ['3', '0', 'OVER_LINE'],
    ['x', '0', 'NOT_A_NUMBER'],
    ['1.5', '1.5', 'NOT_A_NUMBER'],
    ['-1', '4', 'NOT_A_NUMBER'],
  ])('old %s + new %s is %s', (old, fresh, expected) => {
    expect(checkItem(item, draftOf(old, fresh))).toBe(expected);
  });

  it('leaves lines at zero out of the request', () => {
    expect(draftRows(preview, draftOf('0', '3'))).toEqual([
      { orderItemId: ID(2), supplyLineId: ID(5), quantity: '3' },
    ]);
  });

  it('a short item never validates', () => {
    const short = { ...preview, items: [{ ...item, lines: [] }] };
    expect(draftIsValid(short, fifoDraft(short))).toBe(false);
  });

  it('names the mode by whether the rows are the proposal', () => {
    expect(modeOf(preview, draftOf('2', '1'))).toBe('FIFO');
    expect(modeOf(preview, draftOf('1', '2'))).toBe('MANUAL');
    expect(modeOf(preview, draftOf('0', '3'))).toBe('MANUAL');
    expect(fifoChoice(preview).allocationMode).toBe('FIFO');
    expect(fifoChoice(preview).allocations).toHaveLength(2);
  });

  it('reads the plan of a conflict, and nothing from a malformed one', () => {
    expect(previewOfConflict({ preview })?.orderId).toBe(ID(1));
    expect(previewOfConflict({ preview: { cost: 1 } })).toBeNull();
    expect(previewOfConflict(null)).toBeNull();
  });
});

describe('legacy fractional order lines', () => {
  const legacy = {
    ...preview,
    items: preview.items.map((item) => ({ ...item, quantity: '1.500' })),
  };
  const [item] = legacy.items;
  const [first] = item?.lines ?? [];

  it('a fraction is fine on a fractional order line', () => {
    if (!item || !first) throw new Error('fixture');
    const draft = { [item.orderItemId]: { [first.supplyLineId]: '1.5' } };
    expect(checkItem(item, draft)).toBe('OK');
  });

  it('a fraction stays wrong on a whole order line', () => {
    const whole = preview.items[0];
    if (!whole) throw new Error('fixture');
    const draft = { [whole.orderItemId]: { [whole.lines[0]?.supplyLineId ?? '']: '1.5' } };
    expect(checkItem(whole, draft)).toBe('NOT_A_NUMBER');
  });
});

describe('a product outside the plan (no sheet product code)', () => {
  const untracked = {
    ...item,
    orderItemId: ID(7),
    productCode: 'IO-000001',
    stockTracked: false,
    lines: [],
    fifo: [],
    current: [],
    shortQuantity: '0.000',
  };
  const mixed = { ...preview, items: [item, untracked] };

  it('never blocks the plan: no lines to cover, nothing to check', () => {
    expect(checkItem(untracked, {})).toBe('OK');
    expect(draftIsValid(mixed, fifoDraft(mixed))).toBe(true);
    expect(fifoChoice(mixed).allocations.every((row) => row.orderItemId === ID(2))).toBe(true);
  });
});
