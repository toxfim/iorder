import { byOrderProductsResponseSchema } from '@iorder/shared/staff-cost';
import { describe, expect, it } from 'vitest';
import { Prisma } from '../../generated/prisma/client.js';
import type { ProductView } from '../catalog/index.js';
import type { OpenDemandLine } from '../orders/index.js';
import type { ItemView } from '../pricing/index.js';
import { findForbiddenKeys } from '../../../test/support/forbidden-fields.js';
import { buildByOrderProducts } from './by-order-products.js';
import { toByOrderProductsResponse } from './dto/by-order-products.response.js';

// The "by order" list: what open orders wait for is counted per product, the products that are
// needed now come first, and the DTO names every field it sends.

const id = (n: number): string => `019a0000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const product = (n: number, name: string, over: Partial<ProductView> = {}): ProductView => ({
  id: id(n),
  productCode: `IO-${String(n).padStart(6, '0')}`,
  category: null,
  categoryId: null,
  trackingType: 'NONE',
  markingRequired: false,
  codeRuleConfigured: false,
  isActive: true,
  codeGenerated: true,
  mergedIntoProductId: null,
  brandId: null,
  createdAt: new Date('2026-11-01T00:00:00Z'),
  updatedAt: new Date('2026-11-01T00:00:00Z'),
  translations: [{ lang: 'UZ', name, description: 'staff note' }],
  ...over,
});

const line = (
  productNo: number,
  orderNo: number,
  quantity: string,
  submittedAt: string,
  over: Partial<OpenDemandLine> = {},
): OpenDemandLine => ({
  productId: id(productNo),
  orderId: id(1000 + orderNo),
  orderNumber: `IO-${10_000 + orderNo}`,
  organizationName: 'Orion Mobile',
  status: 'SUBMITTED',
  quantity: new Prisma.Decimal(quantity),
  submittedAt: new Date(submittedAt),
  ...over,
});

const item = (productNo: number, base: string, deferred: string | null = null): ItemView => ({
  productId: id(productNo),
  basePrice: new Prisma.Decimal(base),
  deferredPrice: deferred === null ? null : new Prisma.Decimal(deferred),
  rrp: null,
  wholesalePrice: null,
  wholesaleDeferredPrice: null,
  alifPrice: null,
  alifDeferredPrice: null,
  currency: 'USD',
});

describe('buildByOrderProducts', () => {
  const products = [product(1, 'Zaryadlovchi'), product(2, 'Quloqchin'), product(3, 'adapter')];

  it('sums the pieces and counts the orders per product, across organizations', () => {
    const rows = buildByOrderProducts({
      products,
      brands: new Map(),
      publishedItems: [],
      lines: [
        line(2, 1, '3', '2026-11-08T05:00:00Z'),
        line(2, 2, '4', '2026-11-09T05:00:00Z', {
          organizationName: 'Click Store',
          status: 'ACCOUNTING_CLEARED',
        }),
        line(1, 2, '1', '2026-11-09T05:00:00Z', { organizationName: 'Click Store' }),
      ],
    });
    const quloqchin = rows.find((row) => row.name === 'Quloqchin');
    expect(quloqchin?.openQuantity.toFixed(3)).toBe('7.000');
    expect(quloqchin?.orders.map((o) => [o.orderNumber, o.organizationName])).toEqual([
      ['IO-10001', 'Orion Mobile'],
      ['IO-10002', 'Click Store'],
    ]);
    const idle = rows.find((row) => row.name === 'adapter');
    expect(idle?.openQuantity.toFixed(3)).toBe('0.000');
    expect(idle?.orders).toEqual([]);
  });

  it('puts the products needed now first, the longest wait at the top, then the rest by name', () => {
    const rows = buildByOrderProducts({
      products: [...products, product(4, 'Bluetooth kolonka')],
      brands: new Map(),
      publishedItems: [],
      lines: [line(1, 1, '1', '2026-11-07T05:00:00Z'), line(2, 2, '1', '2026-11-05T05:00:00Z')],
    });
    // Quloqchin waits since the 5th, Zaryadlovchi since the 7th; the idle ones ignore letter case.
    expect(rows.map((row) => row.name)).toEqual([
      'Quloqchin',
      'Zaryadlovchi',
      'adapter',
      'Bluetooth kolonka',
    ]);
  });

  it('takes the price from the published list and the brand from the resolver; none is null', () => {
    const rows = buildByOrderProducts({
      products,
      brands: new Map([[id(2), { id: id(50), name: 'Xiaomi' }]]),
      publishedItems: [item(2, '2', '2.5'), item(99, '7')],
      lines: [],
    });
    const priced = rows.find((row) => row.name === 'Quloqchin');
    expect(priced?.brandName).toBe('Xiaomi');
    expect(priced?.price?.basePrice.toFixed(2)).toBe('2.00');
    expect(priced?.price?.deferredPrice?.toFixed(2)).toBe('2.50');
    const unpriced = rows.find((row) => row.name === 'adapter');
    expect(unpriced?.price).toBeNull();
    expect(unpriced?.brandName).toBeNull();
  });
});

describe('toByOrderProductsResponse', () => {
  it('names every field: strings for money and pieces, the open orders, nothing else', () => {
    const merged = product(2, 'Quloqchin', {
      category: 'Audio',
      isActive: false,
      mergedIntoProductId: id(77),
    });
    const dto = toByOrderProductsResponse(
      buildByOrderProducts({
        products: [product(1, 'Zaryadlovchi'), merged],
        brands: new Map([[id(2), { id: id(50), name: 'Xiaomi' }]]),
        publishedItems: [item(1, '4.1')],
        lines: [line(2, 1, '3', '2026-11-08T05:00:00Z', { status: 'MANAGER_APPROVED' })],
      }),
    );
    expect(byOrderProductsResponseSchema.parse(dto)).toEqual({
      items: [
        {
          productId: id(2),
          productCode: 'IO-000002',
          name: 'Quloqchin',
          brandName: 'Xiaomi',
          category: 'Audio',
          isActive: false,
          basePrice: null,
          deferredPrice: null,
          currency: null,
          openQuantity: '3.000',
          openOrderCount: 1,
          orders: [
            {
              orderId: id(1001),
              orderNumber: 'IO-10001',
              organizationName: 'Orion Mobile',
              status: 'MANAGER_APPROVED',
              quantity: '3.000',
              submittedAt: '2026-11-08T05:00:00.000Z',
            },
          ],
        },
        {
          productId: id(1),
          productCode: 'IO-000001',
          name: 'Zaryadlovchi',
          brandName: null,
          category: null,
          isActive: true,
          basePrice: '4.10',
          deferredPrice: null,
          currency: 'USD',
          openQuantity: '0.000',
          openOrderCount: 0,
          orders: [],
        },
      ],
    });
    // No cost-class key under any name, and nothing of the catalog row that was not asked for.
    expect(findForbiddenKeys(dto)).toEqual([]);
    expect(JSON.stringify(dto)).not.toContain('staff note');
    expect(JSON.stringify(dto)).not.toContain(id(77));
  });
});
