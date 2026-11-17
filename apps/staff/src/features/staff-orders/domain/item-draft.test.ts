import { describe, expect, it } from 'vitest';
import { effectiveQuantity, stageQuantity, summarizeDraft, type DraftItem } from './item-draft';

const item = (id: string, name: string, unitPrice: string, quantity: string): DraftItem => ({
  id,
  productId: `product-${id}`,
  productCode: `P-${id}`,
  allocations: [],
  stockTracked: true,
  name,
  unit: 'dona',
  quantity,
  unitPrice,
  lineTotal: '0.00',
  fullUnitPrice: '0.00',
  deferredUnitPrice: null,
});

const items: DraftItem[] = [
  item('a', 'Phone', '1690000.00', '10'),
  item('b', 'Charger', '75000.50', '4'),
];
const [phone, charger] = items as [DraftItem, DraftItem];

describe('item draft', () => {
  it('stages a quantity, and a quantity equal to the saved one is no change', () => {
    const staged = stageQuantity(new Map(), items, 'a', '12');
    expect(effectiveQuantity(phone, staged)).toBe('12');
    expect(stageQuantity(staged, items, 'a', '10').size).toBe(0);
    // the same value written another way is still no change
    expect(stageQuantity(staged, items, 'a', '10.0').size).toBe(0);
    expect(stageQuantity(staged, items, 'unknown', '1')).toBe(staged);
  });

  it('removes a line with null or zero', () => {
    expect(effectiveQuantity(phone, stageQuantity(new Map(), items, 'a', null))).toBeNull();
    expect(stageQuantity(new Map(), items, 'a', '0').get('a')).toBeNull();
  });

  it('keeps fractional quantities exact (3 fraction digits)', () => {
    const draft = stageQuantity(new Map(), items, 'b', '2.5');
    expect(effectiveQuantity(charger, draft)).toBe('2.5');
    // 16 900 000.00 + 2.5 x 75 000.50 = 17 087 501.25
    expect(summarizeDraft(items, draft).newTotal).toBe('17087501.25');
  });

  it('sums old and new totals and the signed difference in cents, never with floats', () => {
    const draft = stageQuantity(stageQuantity(new Map(), items, 'a', '12'), items, 'b', '3');
    const summary = summarizeDraft(items, draft);
    expect(summary.oldTotal).toBe('17200002.00');
    expect(summary.newTotal).toBe('20505001.50');
    expect(summary.difference).toBe('3304999.50');
    expect(summary.changes).toEqual([
      { itemId: 'a', name: 'Phone', from: '10', to: '12' },
      { itemId: 'b', name: 'Charger', from: '4', to: '3' },
    ]);
    const removed = summarizeDraft(items, stageQuantity(new Map(), items, 'a', null));
    expect(removed.difference).toBe('-16900000.00');
    expect(removed.changes[0]?.to).toBeNull();
  });

  it('keeps huge amounts exact', () => {
    const big = [item('x', 'Big', '9007199254740993.00', '1')];
    const summary = summarizeDraft(big, stageQuantity(new Map(), big, 'x', '2'));
    expect(summary.newTotal).toBe('18014398509481986.00');
    expect(summary.difference).toBe('9007199254740993.00');
  });
});
