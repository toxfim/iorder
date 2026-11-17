import type { ByOrderOpenOrder, ByOrderProduct } from '@iorder/shared/staff-cost';
import { describe, expect, it } from 'vitest';
import { staffCostMessages } from '@/features/staff-cost/messages';
import { staffOrdersMessages } from '@/features/staff-orders/messages';
import { en } from '@/i18n/messages/en';
import { ru } from '@/i18n/messages/ru';
import { uz } from '@/i18n/messages/uz';
import { byOrderSummary, matchesByOrderSearch } from './by-order';

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const order = (n: number, quantity: string): ByOrderOpenOrder => ({
  orderId: id(100 + n),
  orderNumber: `IO-${10_000 + n}`,
  organizationName: 'Orion Mobile',
  status: 'SUBMITTED',
  quantity,
  submittedAt: '2026-11-09T05:00:00.000Z',
});

const product = (n: number, name: string, orders: ByOrderOpenOrder[] = []): ByOrderProduct => ({
  productId: id(n),
  productCode: `IO-${String(n).padStart(6, '0')}`,
  name,
  brandName: null,
  category: null,
  isActive: true,
  basePrice: '2.00',
  deferredPrice: null,
  currency: 'USD',
  openQuantity: `${orders.reduce((sum, o) => sum + Number(o.quantity), 0)}.000`,
  openOrderCount: orders.length,
  orders,
});

describe('by-order search', () => {
  const item = product(7, 'Ugreen HiTune T6');

  it('matches a part of the name or of the code, ignoring case and outer spaces', () => {
    expect(matchesByOrderSearch(item, '')).toBe(true);
    expect(matchesByOrderSearch(item, '   ')).toBe(true);
    expect(matchesByOrderSearch(item, ' hitune ')).toBe(true);
    expect(matchesByOrderSearch(item, 'io-0000')).toBe(true);
    expect(matchesByOrderSearch(item, '000007')).toBe(true);
  });

  it('does not match anything else', () => {
    expect(matchesByOrderSearch(item, 'baseus')).toBe(false);
    expect(matchesByOrderSearch(item, 'IO-000008')).toBe(false);
  });
});

describe('by-order summary', () => {
  it('counts the products to bring, their pieces, and each open order once', () => {
    const shared = order(1, '3.000');
    const summary = byOrderSummary([
      product(1, 'Quloqchin', [shared, order(2, '4.000')]),
      // The same order waits for two products: it is one order.
      product(2, 'Kabel', [{ ...shared, quantity: '1.000' }]),
      product(3, 'Adapter'),
    ]);
    expect(summary).toEqual({ products: 2, pieces: '8.000', orders: 2 });
  });

  it('is zero when nothing waits', () => {
    expect(byOrderSummary([product(1, 'Quloqchin')])).toEqual({
      products: 0,
      pieces: '0.000',
      orders: 0,
    });
    expect(byOrderSummary([])).toEqual({ products: 0, pieces: '0.000', orders: 0 });
  });
});

// One word for one thing [C, owner 2026-11-09]: wherever a staff member meets a staff-added
// product (the menu, the page, an order line, the plan, the price list badge and tab, the merge
// dialog) it is called "by order" in that language.
describe('the staff vocabulary of a by-order product', () => {
  const nav = { uz, ru, en };

  it.each(['uz', 'ru', 'en'] as const)('%s: one name everywhere', (lang) => {
    const cost = staffCostMessages[lang];
    const names = [
      nav[lang].nav.staff.byOrder,
      cost.byOrder.title,
      cost.manual.badge,
      cost.manual.tab,
      cost.manual.stockCard.value,
      cost.merge.manualPill,
      staffOrdersMessages[lang].supplies.untracked,
    ];
    expect(new Set(names).size).toBe(1);
  });

  it('is "Buyurtma orqali", "Под заказ" and "By order"', () => {
    expect(uz.nav.staff.byOrder).toBe('Buyurtma orqali');
    expect(ru.nav.staff.byOrder).toBe('Под заказ');
    expect(en.nav.staff.byOrder).toBe('By order');
  });
});
