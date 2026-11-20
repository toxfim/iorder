import { describe, expect, it } from 'vitest';
import { ApiConflictError } from '@core/lib/api-errors';
import type { NewOrderCatalogItem, NewOrderCustomer } from '@iorder/shared/staff-orders';
import {
  afterRefusal,
  offeredInStep2,
  createRequestOf,
  deferredPossible,
  distinctOf,
  filterCatalog,
  implicitMember,
  newOrderKey,
  pieceCount,
  stockWarning,
  totalOf,
  withQuantity,
} from './new-order';

const item = (overrides: Partial<NewOrderCatalogItem> = {}): NewOrderCatalogItem => ({
  productId: 'p1',
  productCode: '40799',
  name: 'Air Fryer 7L',
  category: 'Aerogrill',
  brand: 'Xiaomi',
  imageUrl: null,
  imageLargeUrl: null,
  unitPrice: '1500.00',
  deferredUnitPrice: '1650.50',
  stock: 7,
  ...overrides,
});
const p1 = item();
const p2 = item({
  productId: 'p2',
  productCode: '40645',
  name: 'HUAWEI FreeClip',
  category: 'Naushniki',
  brand: 'Huawei',
  unitPrice: '750.25',
  deferredUnitPrice: null,
  stock: null,
});
const catalog = new Map([
  [p1.productId, p1],
  [p2.productId, p2],
]);

const person: NewOrderCustomer = {
  organizationId: 'org-1',
  name: 'Madina',
  type: 'PERSON',
  label: 'PARTNER',
  members: [{ userId: 'u-1', fullName: 'Madina', phone: null }],
};

describe('the new order cart', () => {
  it('adds, changes and removes lines; 0 removes', () => {
    let lines = withQuantity([], 'p1', 1);
    lines = withQuantity(lines, 'p2', 3);
    lines = withQuantity(lines, 'p1', 4);
    expect(lines).toEqual([
      { productId: 'p1', quantity: 4 },
      { productId: 'p2', quantity: 3 },
    ]);
    expect(pieceCount(lines)).toBe(7);
    expect(withQuantity(lines, 'p1', 0)).toEqual([{ productId: 'p2', quantity: 3 }]);
  });

  it('totals exactly (fixed point) with the sale price until DEFERRED is chosen', () => {
    const lines = [
      { productId: 'p1', quantity: 3 },
      { productId: 'p2', quantity: 1 },
    ];
    expect(totalOf(lines, catalog, null)).toBe('5250.25');
    expect(totalOf(lines, catalog, 'FULL')).toBe('5250.25');
    // A line without a deferred price makes DEFERRED impossible (the server refuses it too).
    expect(deferredPossible(lines, catalog)).toBe(false);
    expect(deferredPossible([{ productId: 'p1', quantity: 3 }], catalog)).toBe(true);
    expect(totalOf([{ productId: 'p1', quantity: 3 }], catalog, 'DEFERRED')).toBe('4951.50');
  });

  it('warns above the free stock but never caps; an untracked product never warns [P]', () => {
    expect(stockWarning(p1, 7)).toBeNull();
    expect(stockWarning(p1, 9)).toBe(7);
    expect(stockWarning(p2, 1000)).toBeNull();
    expect(withQuantity([], 'p1', 9)).toEqual([{ productId: 'p1', quantity: 9 }]);
  });

  it('filters by code or name, category and brand', () => {
    const all = [p1, p2];
    expect(filterCatalog(all, { text: 'free', category: null, brand: null })).toEqual([p2]);
    expect(filterCatalog(all, { text: '4079', category: null, brand: null })).toEqual([p1]);
    expect(filterCatalog(all, { text: '', category: 'Naushniki', brand: null })).toEqual([p2]);
    expect(filterCatalog(all, { text: '', category: null, brand: 'Xiaomi' })).toEqual([p1]);
    expect(distinctOf(all, 'brand')).toEqual(['Huawei', 'Xiaomi']);
  });
});

describe('the create request', () => {
  it('names the member, the plan, whole-number lines, the trimmed comment and the shown total', () => {
    const member = implicitMember(person);
    expect(member?.userId).toBe('u-1');
    if (!member) throw new Error('expected the person');
    expect(
      createRequestOf({
        customer: person,
        member,
        lines: [
          { productId: 'p1', quantity: 2 },
          { productId: 'gone', quantity: 1 },
        ],
        catalog,
        plan: 'DEFERRED',
        comment: '  Ertaga  ',
      }),
    ).toEqual({
      organizationId: 'org-1',
      placedByUserId: 'u-1',
      paymentPlan: 'DEFERRED',
      lines: [{ productId: 'p1', quantity: '2' }],
      comment: 'Ertaga',
      expectedTotalAmount: '3301.00',
    });
  });

  it('a group has no implicit member; keys are new each time and fit the api', () => {
    expect(implicitMember({ ...person, type: 'GROUP' })).toBeNull();
    const key = newOrderKey();
    expect(key).toMatch(/^order-[0-9a-f]{32}$/);
    expect(newOrderKey()).not.toBe(key);
  });
});

describe('after a refused create', () => {
  const conflict = (reason: string) =>
    new ApiConflictError('refused', 'CONFLICT', undefined, reason as never);

  it('sends the manager back to the customer when the server refused the customer', () => {
    expect(afterRefusal(conflict('PLACER_NOT_MEMBER'))).toBe('CHOOSE_CUSTOMER');
    expect(afterRefusal(conflict('ORDERING_ORGANIZATION_INACTIVE'))).toBe('CHOOSE_CUSTOMER');
  });

  it('reads the catalog again only for the price and offer conflicts', () => {
    for (const reason of [
      'CART_TOTAL_CHANGED',
      'PRODUCT_NOT_ORDERABLE',
      'DEFERRED_PRICE_UNAVAILABLE',
      'NO_PUBLISHED_VERSION',
    ]) {
      expect(afterRefusal(conflict(reason))).toBe('RELOAD_CATALOG');
    }
    expect(afterRefusal(conflict('CURRENCY_CONVERSION_UNAVAILABLE'))).toBe('STAY');
    expect(afterRefusal(new Error('network'))).toBe('STAY');
  });

  it('step 2 does not show products with no free stock; untracked and unknown stay [P]', () => {
    expect(
      offeredInStep2([p1, item({ productId: 'p0', stock: 0 }), p2]).map((i) => i.productId),
    ).toEqual(['p1', 'p2']);
  });
});
